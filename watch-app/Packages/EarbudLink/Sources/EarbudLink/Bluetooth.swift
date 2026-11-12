import Foundation
#if canImport(CoreBluetooth)
import CoreBluetooth

// Bluetooth LE transport (adapted from Woods Whisper). Needs no Wi-Fi at all.
//
//  • Receiver (iPhone/iPad running Earbud) = peripheral: advertises the Earbud service, with an
//    RX characteristic the Watch writes to and a TX characteristic it notifies on.
//  • Watch = central: scans for the service, connects, writes one message, waits for the reply.
//
// Messages use the envelope `[type][u32 BE length][body]` (see `Wire`), chunked to the
// connection's write size and reassembled on the other side.

public enum EarbudBLE {
    public static let serviceUUID = CBUUID(string: "0C849000-8B01-4F56-A535-7850AA4E0EAC")
    /// Watch writes here (write without response).
    public static let rxUUID = CBUUID(string: "0C849001-8B01-4F56-A535-7850AA4E0EAC")
    /// Receiver notifies here (acknowledgements, pairing responses).
    public static let txUUID = CBUUID(string: "0C849002-8B01-4F56-A535-7850AA4E0EAC")
}

// MARK: - Watch side (central)

/// Sends one recording over Bluetooth. Returns the Core Bluetooth identifier of the receiver
/// that accepted it, so the next send can go straight to it.
public enum BluetoothClient {
    public static func send(_ transfer: RecordingTransfer, audioURL: URL, to link: DeviceLink,
                            progress: (@Sendable (Double) -> Void)? = nil) async throws -> UUID {
        guard let secret = link.pairingSecret else { throw LinkError.notConfigured }
        let audio = try Data(contentsOf: audioURL)
        var stamped = transfer
        stamped.pairingSecret = secret
        stamped.byteCount = audio.count
        let header = try EarbudJSON.encoder.encode(stamped)
        let outgoing = Wire.envelope(type: MessageType.recording,
                                     body: Wire.recordingBody(header: header, audio: audio))
        // Several Earbud devices may be in range; one that refuses the secret is skipped.
        var excluded = Set<UUID>()
        for _ in 0 ..< 3 {
            let reply = try await BLECentralSession(outgoing: outgoing,
                                                    preferred: link.bluetoothIdentifier,
                                                    preferredName: link.displayName,
                                                    excluding: excluded,
                                                    progress: progress)
                .run(scanTimeout: 8, totalTimeout: 25 + Double(outgoing.count) / 6_000)
            if reply.type == MessageType.ack, reply.body.first == 1 {
                LinkLog.log("Sent “\(transfer.recording.name)” over Bluetooth")
                return reply.peripheral
            }
            excluded.insert(reply.peripheral)
        }
        throw LinkError.rejected
    }
}

/// Pairs over Bluetooth with the receiver showing `code`.
public enum BluetoothPairing {
    public static func pair(code: String, deviceName: String) async throws -> DeviceLink {
        let request = try EarbudJSON.encoder.encode(PairingRequest(code: code, deviceName: deviceName))
        let outgoing = Wire.envelope(type: MessageType.pairing, body: request)
        var excluded = Set<UUID>()
        var sawRejection = false
        for _ in 0 ..< 3 {
            let reply: BLECentralSession.Reply
            do {
                reply = try await BLECentralSession(outgoing: outgoing, preferred: nil, preferredName: nil,
                                                    excluding: excluded, progress: nil)
                    .run(scanTimeout: 12, totalTimeout: 25)
            } catch {
                if sawRejection, !(error is CancellationError) { throw LinkError.rejected }
                throw error
            }
            if reply.type == MessageType.pairingResponse,
               let response = try? EarbudJSON.decoder.decode(PairingResponse.self, from: reply.body) {
                return DeviceLink(transport: .bluetooth,
                                  displayName: response.displayName,
                                  deviceId: response.deviceId,
                                  pairingSecret: response.token,
                                  bluetoothIdentifier: reply.peripheral)
            }
            // Another Earbud device that isn't in pairing mode: try the next one.
            sawRejection = true
            excluded.insert(reply.peripheral)
        }
        throw LinkError.rejected
    }
}

/// One central round trip: find an Earbud receiver, write `outgoing`, return the first message
/// it notifies back. Retains itself while running (Core Bluetooth holds delegates weakly) and
/// honours task cancellation, so a racing transport can stop it.
final class BLECentralSession: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, @unchecked Sendable {
    struct Reply {
        let type: UInt8
        let body: Data
        let peripheral: UUID
    }

    /// After the first candidate shows up, how long to wait for the preferred receiver.
    private static let preferenceGrace: TimeInterval = 1.5

    private let outgoing: Data
    private let preferred: UUID?
    private let preferredName: String?
    private let excluded: Set<UUID>
    private let progress: (@Sendable (Double) -> Void)?
    private let queue = DispatchQueue(label: "earbud.link.ble.central")

    // Touched only on `queue`.
    private var manager: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var fallback: CBPeripheral?
    private var graceTimer: DispatchWorkItem?
    private var rx: CBCharacteristic?
    private var tx: CBCharacteristic?
    private var reassembler = MessageReassembler()
    private var pending = Data()
    private var startedWriting = false
    private var lastProgress = -1.0
    private var continuation: CheckedContinuation<Reply, Error>?
    private var finished = false
    private var timers: [DispatchWorkItem] = []
    private var retainSelf: BLECentralSession?

    init(outgoing: Data, preferred: UUID?, preferredName: String?, excluding: Set<UUID>,
         progress: (@Sendable (Double) -> Void)?) {
        self.outgoing = outgoing
        self.preferred = preferred
        self.preferredName = preferredName
        self.excluded = excluding
        self.progress = progress
        super.init()
    }

    func run(scanTimeout: TimeInterval, totalTimeout: TimeInterval) async throws -> Reply {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Reply, Error>) in
                queue.async {
                    guard !self.finished else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    self.continuation = continuation
                    self.retainSelf = self
                    self.schedule(after: scanTimeout) {
                        if self.peripheral == nil { self.finish(.failure(LinkError.notReachable)) }
                    }
                    self.schedule(after: totalTimeout) { self.finish(.failure(LinkError.notReachable)) }
                    self.manager = CBCentralManager(delegate: self, queue: self.queue)
                }
            }
        } onCancel: {
            queue.async { self.finish(.failure(CancellationError())) }
        }
    }

    private func schedule(after delay: TimeInterval, _ block: @escaping () -> Void) {
        let item = DispatchWorkItem(block: block)
        timers.append(item)
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func finish(_ result: Result<Reply, Error>) {
        guard !finished else { return }
        finished = true
        timers.forEach { $0.cancel() }
        graceTimer?.cancel()
        if let manager {
            manager.stopScan()
            if let peripheral { manager.cancelPeripheralConnection(peripheral) }
        }
        let continuation = self.continuation
        self.continuation = nil
        continuation?.resume(with: result)
        retainSelf = nil
    }

    private func connect(_ candidate: CBPeripheral) {
        guard peripheral == nil, let manager else { return }
        graceTimer?.cancel()
        manager.stopScan()
        peripheral = candidate
        candidate.delegate = self
        manager.connect(candidate)
    }

    // MARK: Central

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            central.scanForPeripherals(withServices: [EarbudBLE.serviceUUID])
        case .unauthorized, .unsupported, .poweredOff:
            finish(.failure(LinkError.bluetoothUnavailable))
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover candidate: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard peripheral == nil, !excluded.contains(candidate.identifier) else { return }
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let isPreferred = candidate.identifier == preferred
            || (preferredName != nil && name == preferredName)
        if isPreferred || (preferred == nil && preferredName == nil) {
            connect(candidate)
            return
        }
        // Someone else's Earbud, or ours under a new name: wait briefly for a better match.
        guard fallback == nil else { return }
        fallback = candidate
        let timer = DispatchWorkItem { [weak self] in
            guard let self, let fallback = self.fallback else { return }
            self.connect(fallback)
        }
        graceTimer = timer
        queue.asyncAfter(deadline: .now() + Self.preferenceGrace, execute: timer)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([EarbudBLE.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
                        error: Error?) {
        finish(.failure(LinkError.notReachable))
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
                        error: Error?) {
        finish(.failure(LinkError.notReachable))
    }

    // MARK: Peripheral

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == EarbudBLE.serviceUUID }) else {
            finish(.failure(LinkError.notReachable))
            return
        }
        peripheral.discoverCharacteristics([EarbudBLE.rxUUID, EarbudBLE.txUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService,
                    error: Error?) {
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == EarbudBLE.rxUUID { rx = characteristic }
            if characteristic.uuid == EarbudBLE.txUUID { tx = characteristic }
        }
        guard let tx, rx != nil else {
            finish(.failure(LinkError.notReachable))
            return
        }
        peripheral.setNotifyValue(true, for: tx) // subscribe first, so the reply isn't missed
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard characteristic.uuid == EarbudBLE.txUUID else { return }
        if error != nil {
            finish(.failure(LinkError.notReachable))
            return
        }
        pending = outgoing
        startedWriting = false
        pumpWrites()
    }

    /// Writes without response are pipelined by the controller (many per connection interval);
    /// `canSendWriteWithoutResponse` provides back-pressure, and the receiver's acknowledgement
    /// after reassembly confirms the whole message.
    private func pumpWrites() {
        guard let peripheral, let rx else { return }
        while !pending.isEmpty {
            if startedWriting && !peripheral.canSendWriteWithoutResponse { return }
            startedWriting = true
            let size = max(20, peripheral.maximumWriteValueLength(for: .withoutResponse))
            let chunk = pending.prefix(size)
            pending.removeFirst(chunk.count)
            peripheral.writeValue(Data(chunk), for: rx, type: .withoutResponse)
            reportProgress()
        }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        pumpWrites()
    }

    private func reportProgress() {
        guard let progress, !outgoing.isEmpty else { return }
        let fraction = min(1, Double(outgoing.count - pending.count) / Double(outgoing.count))
        if fraction - lastProgress >= 0.01 || fraction >= 1 {
            lastProgress = fraction
            progress(fraction)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
                    error: Error?) {
        guard characteristic.uuid == EarbudBLE.txUUID, let value = characteristic.value else { return }
        if let message = reassembler.append(value).first {
            finish(.success(Reply(type: message.type, body: message.body, peripheral: peripheral.identifier)))
        }
    }
}

// MARK: - Receiver side (peripheral), iOS only

// The peripheral role (CBPeripheralManager) is not available on watchOS.
#if os(iOS)

/// Runs in Earbud on an iPhone or iPad: advertises the Earbud service, answers pairing codes,
/// and writes received recordings into the inbox.
public final class BluetoothReceiver: NSObject, CBPeripheralManagerDelegate {
    public struct Configuration: Equatable {
        public var displayName: String
        public var deviceId: String
        public var secret: String
        public var inbox: URL

        public init(displayName: String, deviceId: String, secret: String, inbox: URL) {
            self.displayName = displayName
            self.deviceId = deviceId
            self.secret = secret
            self.inbox = inbox
        }
    }

    // Called on the receiver's queue.
    public var onReceive: ((InboxEntry) -> Void)?
    public var onPaired: ((String) -> Void)?
    public var onStateChange: ((String) -> Void)?

    private let queue = DispatchQueue(label: "earbud.link.ble.peripheral")

    // Touched only on `queue`.
    private var configuration: Configuration
    private var manager: CBPeripheralManager?
    private var txCharacteristic: CBMutableCharacteristic?
    private var subscriber: CBCentral?
    private var reassembler = MessageReassembler()
    private var outbound = Data()
    private var pairingCode: String?
    private var pairingExpiry: Date?
    private var pairingFailures = 0
    private var stateName = "starting"

    public init(configuration: Configuration) {
        self.configuration = configuration
        super.init()
    }

    /// Creating the manager is what asks for Bluetooth permission the first time.
    public func start() {
        queue.async {
            guard self.manager == nil else { return }
            // No system alert when Bluetooth is off: the Watch can still use Wi-Fi.
            self.manager = CBPeripheralManager(delegate: self, queue: self.queue,
                                               options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
        }
    }

    public func stop() {
        queue.async {
            self.manager?.stopAdvertising()
            self.manager?.removeAllServices()
            self.manager?.delegate = nil
            self.manager = nil
            self.subscriber = nil
            self.reassembler.reset()
            self.outbound.removeAll()
            self.setState("off")
        }
    }

    public func update(_ configuration: Configuration) {
        queue.async {
            let renamed = configuration.displayName != self.configuration.displayName
            self.configuration = configuration
            if renamed, let manager = self.manager, manager.state == .poweredOn {
                manager.stopAdvertising()
                self.advertise(manager)
            }
        }
    }

    public func beginPairing(code: String, duration: TimeInterval) {
        queue.async {
            self.pairingCode = code
            self.pairingExpiry = Date().addingTimeInterval(duration)
            self.pairingFailures = 0
        }
    }

    public func endPairing() {
        queue.async {
            self.pairingCode = nil
            self.pairingExpiry = nil
        }
    }

    /// `poweredOn`, `poweredOff`, `unauthorized`, `unsupported`, `resetting`, `starting` or `off`.
    public func currentState(_ completion: @escaping (String) -> Void) {
        queue.async { completion(self.stateName) }
    }

    private func setState(_ name: String) {
        guard name != stateName else { return }
        stateName = name
        onStateChange?(name)
    }

    private func advertise(_ manager: CBPeripheralManager) {
        manager.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [EarbudBLE.serviceUUID],
            CBAdvertisementDataLocalNameKey: configuration.displayName,
        ])
    }

    // MARK: Inbound (on `queue`)

    private func handleInbound(type: UInt8, body: Data) {
        switch type {
        case MessageType.recording:
            guard let parts = Wire.splitRecordingBody(body),
                  let transfer = try? EarbudJSON.decoder.decode(RecordingTransfer.self, from: parts.header)
            else {
                reply(type: MessageType.ack, body: Data([0]))
                return
            }
            guard transfer.pairingSecret == configuration.secret else {
                LinkLog.log("Refused a Bluetooth recording from \(transfer.senderName ?? "a watch"): not paired")
                reply(type: MessageType.ack, body: Data([0]))
                return
            }
            do {
                let entry = try InboxWriter.write(audio: parts.audio, transfer: transfer,
                                                  via: .bluetooth, to: configuration.inbox)
                reply(type: MessageType.ack, body: Data([1]))
                LinkLog.log("Received “\(transfer.recording.name)” over Bluetooth (\(parts.audio.count) bytes)")
                onReceive?(entry)
            } catch {
                LinkLog.log("Could not store a Bluetooth recording: \(error.localizedDescription)")
                reply(type: MessageType.ack, body: Data([0]))
            }

        case MessageType.pairing:
            guard let request = try? EarbudJSON.decoder.decode(PairingRequest.self, from: body) else { return }
            let open = pairingCode != nil && Date() < (pairingExpiry ?? .distantPast)
            guard open, request.code == pairingCode else {
                if open {
                    pairingFailures += 1
                    if pairingFailures >= 20 { pairingCode = nil }
                }
                reply(type: MessageType.ack, body: Data([0]))
                return
            }
            let response = PairingResponse(displayName: configuration.displayName,
                                           token: configuration.secret, port: 0,
                                           deviceId: configuration.deviceId)
            guard let data = try? EarbudJSON.encoder.encode(response) else { return }
            reply(type: MessageType.pairingResponse, body: data)
            pairingCode = nil
            pairingExpiry = nil
            LinkLog.log("Paired with “\(request.deviceName)” over Bluetooth")
            onPaired?(request.deviceName)

        default:
            break
        }
    }

    // MARK: Outbound (on `queue`)

    private func reply(type: UInt8, body: Data) {
        outbound.append(Wire.envelope(type: type, body: body))
        flushOutbound()
    }

    private func flushOutbound() {
        guard let manager, let tx = txCharacteristic, let central = subscriber else { return }
        let size = max(20, central.maximumUpdateValueLength)
        while !outbound.isEmpty {
            let chunk = outbound.prefix(size)
            if manager.updateValue(Data(chunk), for: tx, onSubscribedCentrals: [central]) {
                outbound.removeFirst(chunk.count)
            } else {
                return // resumes in peripheralManagerIsReady(toUpdateSubscribers:)
            }
        }
    }

    // MARK: CBPeripheralManagerDelegate

    public func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            let rx = CBMutableCharacteristic(type: EarbudBLE.rxUUID, properties: [.writeWithoutResponse],
                                             value: nil, permissions: [.writeable])
            let tx = CBMutableCharacteristic(type: EarbudBLE.txUUID, properties: [.notify],
                                             value: nil, permissions: [.readable])
            let service = CBMutableService(type: EarbudBLE.serviceUUID, primary: true)
            service.characteristics = [rx, tx]
            txCharacteristic = tx
            peripheral.removeAllServices()
            peripheral.add(service)
            advertise(peripheral)
            setState("poweredOn")
            LinkLog.log("Bluetooth: advertising as “\(configuration.displayName)”")
        case .poweredOff: setState("poweredOff")
        case .unauthorized: setState("unauthorized")
        case .unsupported: setState("unsupported")
        case .resetting: setState("resetting")
        default: setState("starting")
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        // Write commands (without response): no respond(to:).
        for request in requests {
            guard let value = request.value else { continue }
            for message in reassembler.append(value) {
                handleInbound(type: message.type, body: message.body)
            }
        }
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                                  didSubscribeTo characteristic: CBCharacteristic) {
        subscriber = central
        reassembler.reset()
        outbound.removeAll()
    }

    public func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral,
                                  didUnsubscribeFrom characteristic: CBCharacteristic) {
        if subscriber?.identifier == central.identifier {
            subscriber = nil
            reassembler.reset()
        }
    }

    public func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        flushOutbound()
    }
}

#endif // os(iOS)
#endif // canImport(CoreBluetooth)
