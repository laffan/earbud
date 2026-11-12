import EarbudLink
import Foundation
import SwiftUI
import WatchKit

/// Records, keeps recordings on the Watch, and sends them to the device paired with a code
/// (the Woods Whisper protocol): Wi-Fi or Bluetooth straight to that device, or through the
/// Watch's paired iPhone when that iPhone is the same device.
@MainActor
final class WatchModel: ObservableObject {
    enum PairingState: Equatable {
        case idle
        case searching(tried: Int, total: Int)
        case paired(String)
        case failed(String)
    }

    @Published private(set) var link: DeviceLink?
    /// Earbud on the paired iPhone, if it has announced itself.
    @Published private(set) var phoneReceiver: ReceiverAnnouncement?
    @Published var pairing: PairingState = .idle
    @Published var message: String?
    @Published private(set) var log: [String] = []
    @Published var autoSend: Bool {
        didSet { UserDefaults.standard.set(autoSend, forKey: Keys.autoSend) }
    }
    @Published var quality: RecordingQuality {
        didSet { UserDefaults.standard.set(quality.rawValue, forKey: Keys.quality) }
    }

    let store = RecordingStore()
    let recorder = AudioRecorder()
    private let phone = PhoneSessionLink.shared
    private var sendTasks: [UUID: Task<Void, Never>] = [:]
    private var pairingTask: Task<Void, Never>?
    private var recordingStartedAt: Date?
    private var recordingID: UUID?

    private enum Keys {
        static let link = "deviceLink"
        static let autoSend = "autoSend"
        static let quality = "quality"
    }

    init() {
        let defaults = UserDefaults.standard
        autoSend = defaults.object(forKey: Keys.autoSend) as? Bool ?? true
        quality = RecordingQuality(rawValue: defaults.string(forKey: Keys.quality) ?? "") ?? .full
        if let data = defaults.data(forKey: Keys.link) {
            link = try? JSONDecoder().decode(DeviceLink.self, from: data)
        }

        // Called from the transports' queues.
        LinkLog.handler = { @Sendable [weak self] line in
            Task { @MainActor in self?.appendLog(line) }
        }
        recorder.onUnexpectedStop = { [weak self] url, duration in
            self?.saveRecording(url: url, duration: duration, note: "Recording stopped (interrupted). Saved.")
        }
        phone.onReceiverChange = { [weak self] receiver in
            self?.phoneReceiver = receiver
            self?.reconcileQueued()
        }
        phone.onTransferFinished = { [weak self] id, error in
            self?.phoneTransferFinished(id, error: error)
        }
        phone.activate()
        phoneReceiver = phone.receiver
    }

    static var watchName: String { WKInterfaceDevice.current().name }

    var unsentCount: Int {
        store.recordings.filter { !$0.delivery.isSent && !$0.delivery.isInFlight }.count
    }

    // MARK: Recording

    func toggleRecording() async {
        if recorder.isRecording {
            finishRecording()
        } else {
            await startRecording()
        }
    }

    private func startRecording() async {
        guard await recorder.requestPermission() else {
            message = "Earbud needs the microphone. Allow it in the Watch's Settings → Privacy & Security."
            return
        }
        let id = UUID()
        do {
            try recorder.start(url: store.newFileURL(for: id), quality: quality)
            recordingID = id
            recordingStartedAt = Date()
            message = nil
            WKInterfaceDevice.current().play(.start)
        } catch {
            message = error.localizedDescription
        }
    }

    private func finishRecording() {
        guard let result = recorder.stop() else { return }
        WKInterfaceDevice.current().play(.stop)
        saveRecording(url: result.url, duration: result.duration, note: nil)
    }

    private func saveRecording(url: URL, duration: TimeInterval, note: String?) {
        let id = recordingID ?? UUID()
        let createdAt = recordingStartedAt ?? Date().addingTimeInterval(-duration)
        recordingID = nil
        recordingStartedAt = nil
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0, duration > 0.3 else {
            try? FileManager.default.removeItem(at: url)
            message = "Nothing was recorded."
            return
        }
        let recording = WatchRecording(id: id, createdAt: createdAt, duration: duration,
                                       fileName: url.lastPathComponent, byteCount: size,
                                       delivery: .notSent)
        store.add(recording)
        if let note { message = note }
        if autoSend, link != nil { send(id) }
    }

    // MARK: Sending

    func send(_ id: UUID) {
        guard sendTasks[id] == nil else { return }
        sendTasks[id] = Task { [weak self] in
            await self?.deliver(id)
            self?.sendTasks[id] = nil
        }
    }

    func sendAllUnsent() {
        for recording in store.recordings.reversed() where !recording.delivery.isSent && !recording.delivery.isInFlight {
            send(recording.id)
        }
    }

    func cancelSend(_ id: UUID) {
        sendTasks[id]?.cancel()
    }

    func delete(_ id: UUID) {
        sendTasks[id]?.cancel()
        store.delete(id)
    }

    /// The transports to try, in order: the one that answered the pairing code, then the others
    /// this link can use.
    func routes(for link: DeviceLink) -> [Transport] {
        var result: [Transport] = []
        for transport in [link.transport, .localNetwork, .bluetooth, .phoneSession]
        where !result.contains(transport) && canUse(transport, link) {
            result.append(transport)
        }
        return result
    }

    private func canUse(_ transport: Transport, _ link: DeviceLink) -> Bool {
        switch transport {
        case .localNetwork: return link.host != nil && link.pairingSecret != nil
        case .bluetooth: return link.pairingSecret != nil
        // Only when the paired iPhone *is* the device this Watch is paired with.
        case .phoneSession: return phoneReceiver?.deviceId == link.deviceId
        }
    }

    private func deliver(_ id: UUID) async {
        guard let link else {
            store.setDelivery(id, .failed(message: "Pair with a device running Earbud first."))
            return
        }
        guard let recording = store.recording(id) else { return }
        store.setDelivery(id, .sending(progress: nil))
        let transfer = RecordingTransfer(
            recording: TransferRecording(id: recording.id, name: recording.title,
                                         createdAt: recording.createdAt, duration: recording.duration),
            byteCount: recording.byteCount,
            senderName: Self.watchName)
        let url = store.url(for: recording)
        var lastError: Error = LinkError.notConfigured

        for transport in routes(for: link) {
            if Task.isCancelled { break }
            do {
                switch transport {
                case .localNetwork:
                    try await LocalNetworkClient.send(transfer, audioURL: url, to: link)
                case .bluetooth:
                    let peripheral = try await BluetoothClient.send(transfer, audioURL: url, to: link) { fraction in
                        Task { @MainActor [weak self] in
                            guard let self, case .sending = self.store.recording(id)?.delivery else { return }
                            self.store.setDelivery(id, .sending(progress: fraction))
                        }
                    }
                    rememberBluetoothIdentifier(peripheral, for: link.deviceId)
                case .phoneSession:
                    try phone.queue(transfer, audioURL: url)
                    store.setDelivery(id, .queued(destination: link.displayName))
                    return
                }
                store.setDelivery(id, .sent(destination: link.displayName, via: transport, at: Date()))
                return
            } catch {
                if error is CancellationError || Task.isCancelled { break }
                lastError = error
                appendLog("\(transport.label): \(error.localizedDescription)")
            }
        }
        if Task.isCancelled {
            store.setDelivery(id, .notSent)
        } else {
            store.setDelivery(id, .failed(message: describe(lastError, for: link)))
        }
    }

    private func describe(_ error: Error, for link: DeviceLink) -> String {
        switch error as? LinkError {
        case .rejected?:
            return "\(link.displayName) refused it. Pair again."
        case .notReachable?, .networkUnavailable?, .bluetoothUnavailable?:
            return "\(link.displayName) wasn't reachable. Open Earbud there and keep the devices close."
        default:
            return error.localizedDescription
        }
    }

    private func rememberBluetoothIdentifier(_ identifier: UUID, for deviceId: String) {
        guard var current = link, current.deviceId == deviceId, current.bluetoothIdentifier != identifier else { return }
        current.bluetoothIdentifier = identifier
        saveLink(current)
    }

    private func phoneTransferFinished(_ id: UUID, error: Error?) {
        guard let recording = store.recording(id) else { return }
        let destination: String
        if case .queued(let name) = recording.delivery { destination = name } else { destination = link?.displayName ?? "iPhone" }
        if let error {
            store.setDelivery(id, .failed(message: error.localizedDescription))
        } else {
            store.setDelivery(id, .sent(destination: destination, via: .phoneSession, at: Date()))
        }
    }

    /// Recordings shown as queued that watchOS no longer has in its queue were delivered while
    /// the app wasn't running.
    private func reconcileQueued() {
        guard phone.isActivated else { return }
        let outstanding = phone.queuedRecordingIDs
        for recording in store.recordings {
            if case .queued(let destination) = recording.delivery, !outstanding.contains(recording.id) {
                store.setDelivery(recording.id, .sent(destination: destination, via: .phoneSession, at: Date()))
            }
        }
    }

    // MARK: Pairing

    /// Find the device showing `code`, over Wi-Fi and Bluetooth at once; the first to answer wins.
    func pair(code: String) {
        pairingTask?.cancel()
        pairing = .searching(tried: 0, total: 0)
        let name = Self.watchName
        let progress: @Sendable (Int, Int) -> Void = { [weak self] tried, total in
            Task { @MainActor in
                guard let self, case .searching = self.pairing else { return }
                self.pairing = .searching(tried: tried, total: total)
            }
        }
        pairingTask = Task { [weak self] in
            let outcome = await withTaskGroup(of: Result<DeviceLink, Error>.self) { group -> Result<DeviceLink, Error> in
                group.addTask {
                    do {
                        return .success(try await PairingClient.pair(code: code, deviceName: name, progress: progress))
                    } catch {
                        return .failure(error)
                    }
                }
                group.addTask {
                    do {
                        return .success(try await BluetoothPairing.pair(code: code, deviceName: name))
                    } catch {
                        return .failure(error)
                    }
                }
                var errors: [Error] = []
                for await result in group {
                    switch result {
                    case .success:
                        group.cancelAll()
                        return result
                    case .failure(let error):
                        errors.append(error)
                    }
                }
                return .failure(Self.mostUseful(errors))
            }
            guard let self, !Task.isCancelled else { return }
            switch outcome {
            case .success(let newLink):
                self.saveLink(self.merged(newLink))
                self.pairing = .paired(newLink.displayName)
                WKInterfaceDevice.current().play(.success)
                if self.autoSend { self.sendAllUnsent() }
            case .failure(let error):
                self.pairing = .failed(Self.pairingMessage(error))
                WKInterfaceDevice.current().play(.failure)
            }
        }
    }

    func cancelPairing() {
        pairingTask?.cancel()
        pairingTask = nil
        pairing = .idle
    }

    private static func mostUseful(_ errors: [Error]) -> Error {
        let link = errors.compactMap { $0 as? LinkError }
        if link.contains(.rejected) { return LinkError.rejected }
        if link.contains(.networkUnavailable) && link.contains(.bluetoothUnavailable) {
            return LinkError.bluetoothUnavailable
        }
        return errors.first ?? LinkError.notReachable
    }

    private static func pairingMessage(_ error: Error) -> String {
        switch error as? LinkError {
        case .rejected?:
            return "Wrong or expired code. Check the code shown in Earbud."
        case .bluetoothUnavailable?:
            return "No Wi-Fi and Bluetooth is off. Turn on Bluetooth and try again."
        default:
            return "No device showed that code. Keep Earbud's pairing code on screen and the devices close."
        }
    }

    /// A new pairing with the same device keeps what the old one knew (its Wi-Fi address after
    /// a Bluetooth pairing, and the other way round).
    private func merged(_ new: DeviceLink) -> DeviceLink {
        guard let old = link, old.deviceId == new.deviceId else { return new }
        var result = new
        if result.host == nil {
            result.host = old.host
            result.port = old.port
        }
        if result.bluetoothIdentifier == nil { result.bluetoothIdentifier = old.bluetoothIdentifier }
        return result
    }

    /// Send to the paired iPhone's Earbud, without a code.
    func usePairedPhone() {
        guard let receiver = phoneReceiver else { return }
        saveLink(DeviceLink(transport: .phoneSession, displayName: receiver.displayName, deviceId: receiver.deviceId))
        if autoSend { sendAllUnsent() }
    }

    func unpair() {
        saveLink(nil)
        pairing = .idle
    }

    private func saveLink(_ newLink: DeviceLink?) {
        link = newLink
        if let newLink, let data = try? JSONEncoder().encode(newLink) {
            UserDefaults.standard.set(data, forKey: Keys.link)
        } else {
            UserDefaults.standard.removeObject(forKey: Keys.link)
        }
    }

    // MARK: Log

    private func appendLog(_ line: String) {
        let time = Self.logFormatter.string(from: Date())
        log = Array((log + ["\(time) \(line)"]).suffix(100))
    }

    private static let logFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}
