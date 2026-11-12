import AVFoundation
import Foundation

enum RecordingQuality: String, CaseIterable, Identifiable {
    /// 44.1 kHz mono AAC, high quality: about 1 MB a minute.
    case full
    /// 22.05 kHz mono AAC, medium quality: about a third of the size; quicker over Bluetooth.
    /// 22.05 kHz is the rate Earbud transcribes at, so transcription is unaffected.
    case compact

    var id: String { rawValue }

    var label: String {
        switch self {
        case .full: return "Full"
        case .compact: return "Compact"
        }
    }

    var settings: [String: Any] {
        switch self {
        case .full:
            return [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
        case .compact:
            return [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 22_050,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
        }
    }
}

/// Microphone → AAC `.m4a` with AVAudioRecorder. With the `audio` background mode, recording
/// continues when the wrist is lowered and the screen turns off.
@MainActor
final class AudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var isRecording = false
    /// 0…1, for the level meter.
    @Published private(set) var level: Float = 0
    @Published private(set) var elapsed: TimeInterval = 0

    /// Called when recording stops by itself (interruption, encoder error), with what was saved.
    var onUnexpectedStop: ((URL, TimeInterval) -> Void)?

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var startedAt: Date?
    private var interruptionObserver: NSObjectProtocol?

    func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
    }

    func start(url: URL, quality: RecordingQuality) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [])
        try session.setActive(true)

        let recorder = try AVAudioRecorder(url: url, settings: quality.settings)
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw RecorderError.couldNotStart
        }
        self.recorder = recorder
        startedAt = Date()
        elapsed = 0
        isRecording = true
        startTimer()
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: session, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor in self?.stopUnexpectedly() }
        }
    }

    /// Stop and return the file and its duration.
    @discardableResult
    func stop() -> (url: URL, duration: TimeInterval)? {
        guard let recorder else { return nil }
        let duration = recorder.currentTime
        let url = recorder.url
        recorder.stop()
        cleanUp()
        return (url, duration)
    }

    private func stopUnexpectedly() {
        guard let result = stop() else { return }
        onUnexpectedStop?(result.url, result.duration)
    }

    private func cleanUp() {
        timer?.invalidate()
        timer = nil
        if let interruptionObserver { NotificationCenter.default.removeObserver(interruptionObserver) }
        interruptionObserver = nil
        recorder = nil
        isRecording = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startTimer() {
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func tick() {
        guard let recorder, let startedAt else { return }
        recorder.updateMeters()
        let power = recorder.averagePower(forChannel: 0) // dBFS
        level = power < -60 ? 0 : min(1, (power + 60) / 60)
        elapsed = Date().timeIntervalSince(startedAt)
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor in self.stopUnexpectedly() }
    }

    enum RecorderError: LocalizedError {
        case couldNotStart

        var errorDescription: String? { "The microphone could not start recording." }
    }
}
