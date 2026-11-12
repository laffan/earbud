import EarbudLink
import Foundation

/// Where a recording is in its trip to the paired device.
enum Delivery: Codable, Hashable {
    case notSent
    /// In progress. `progress` is 0…1 over Bluetooth, nil otherwise.
    case sending(progress: Double?)
    /// Handed to watchOS for the paired iPhone; watchOS delivers it when it can.
    case queued(destination: String)
    case sent(destination: String, via: Transport, at: Date)
    case failed(message: String)

    var isSent: Bool {
        if case .sent = self { return true }
        return false
    }

    var isInFlight: Bool {
        switch self {
        case .sending, .queued: return true
        default: return false
        }
    }
}

struct WatchRecording: Codable, Identifiable, Hashable {
    let id: UUID
    var createdAt: Date
    /// Seconds.
    var duration: TimeInterval
    var fileName: String
    var byteCount: Int
    var delivery: Delivery

    var title: String { Self.titleFormatter.string(from: createdAt) }

    static let titleFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMdjmm")
        return formatter
    }()
}

/// Recordings kept on the Watch: audio files plus a small JSON index, in
/// Documents/Recordings. Recordings stay until the user deletes them.
@MainActor
final class RecordingStore: ObservableObject {
    /// Newest first.
    @Published private(set) var recordings: [WatchRecording] = []

    let directory: URL
    private var indexURL: URL { directory.appendingPathComponent("index.json") }

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        directory = documents.appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        load()
    }

    func url(for recording: WatchRecording) -> URL {
        directory.appendingPathComponent(recording.fileName)
    }

    func newFileURL(for id: UUID) -> URL {
        directory.appendingPathComponent("\(id.uuidString).m4a")
    }

    func recording(_ id: UUID) -> WatchRecording? {
        recordings.first { $0.id == id }
    }

    func add(_ recording: WatchRecording) {
        recordings.insert(recording, at: 0)
        save()
    }

    func setDelivery(_ id: UUID, _ delivery: Delivery) {
        guard let index = recordings.firstIndex(where: { $0.id == id }) else { return }
        recordings[index].delivery = delivery
        // Progress ticks are not worth a disk write.
        if case .sending = delivery { return }
        save()
    }

    func delete(_ id: UUID) {
        guard let recording = recording(id) else { return }
        try? FileManager.default.removeItem(at: url(for: recording))
        recordings.removeAll { $0.id == id }
        save()
    }

    func deleteSent() {
        for recording in recordings where recording.delivery.isSent {
            try? FileManager.default.removeItem(at: url(for: recording))
        }
        recordings.removeAll { $0.delivery.isSent }
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: indexURL),
              var loaded = try? JSONDecoder().decode([WatchRecording].self, from: data) else { return }
        // Drop entries whose audio is gone; a send cut short by the app quitting is not sent.
        loaded = loaded.filter { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.fileName).path) }
        for index in loaded.indices {
            if case .sending = loaded[index].delivery { loaded[index].delivery = .notSent }
        }
        recordings = loaded.sorted { $0.createdAt > $1.createdAt }
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(recordings) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }
}
