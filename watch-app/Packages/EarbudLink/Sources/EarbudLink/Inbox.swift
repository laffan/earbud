import Foundation

/// Writes received recordings into Earbud's inbox folder, in the format the app imports
/// (`src-tauri/src/watch_link/inbox.rs`):
///
///     <sketchID>.m4a    the audio
///     <sketchID>.json   InboxEntry, written last; its presence means the entry is complete
///
/// Files being written start with a dot, so the importer never sees half a recording.
public enum InboxWriter {
    public enum WriteError: Error, LocalizedError {
        case invalid(String)

        public var errorDescription: String? {
            switch self {
            case .invalid(let message): return message
            }
        }
    }

    /// Store `audio` (Bluetooth: the bytes are already in memory).
    public static func write(audio: Data, transfer: RecordingTransfer, via: Transport,
                             to inbox: URL) throws -> InboxEntry {
        guard !audio.isEmpty else { throw WriteError.invalid("The recording is empty.") }
        guard audio.count == transfer.byteCount else {
            throw WriteError.invalid("The recording is incomplete (\(audio.count) of \(transfer.byteCount) bytes).")
        }
        let (fileName, partURL) = try prepare(transfer: transfer, inbox: inbox)
        try audio.write(to: partURL, options: .atomic)
        return try finish(fileName: fileName, partURL: partURL, byteCount: audio.count,
                          transfer: transfer, via: via, inbox: inbox)
    }

    /// Move a received file in (WatchConnectivity deletes its file when the delegate returns,
    /// so this must run synchronously inside `session(_:didReceive:)`).
    public static func moveIn(file: URL, transfer: RecordingTransfer, via: Transport,
                              to inbox: URL) throws -> InboxEntry {
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size > 0 else { throw WriteError.invalid("The recording is empty.") }
        let (fileName, partURL) = try prepare(transfer: transfer, inbox: inbox)
        try FileManager.default.moveItem(at: file, to: partURL)
        return try finish(fileName: fileName, partURL: partURL, byteCount: size,
                          transfer: transfer, via: via, inbox: inbox)
    }

    private static func prepare(transfer: RecordingTransfer, inbox: URL) throws -> (String, URL) {
        let ext = transfer.recording.fileExtension.lowercased()
        guard (1 ... 5).contains(ext.count), ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            throw WriteError.invalid("Unsupported file type “\(ext)”.")
        }
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        let fileName = "\(transfer.recording.sketchID).\(ext)"
        let partURL = inbox.appendingPathComponent(".\(fileName).part")
        try? FileManager.default.removeItem(at: partURL)
        return (fileName, partURL)
    }

    private static func finish(fileName: String, partURL: URL, byteCount: Int,
                               transfer: RecordingTransfer, via: Transport,
                               inbox: URL) throws -> InboxEntry {
        let fileManager = FileManager.default
        let audioURL = inbox.appendingPathComponent(fileName)
        try? fileManager.removeItem(at: audioURL) // the same recording delivered again
        try fileManager.moveItem(at: partURL, to: audioURL)

        let recording = transfer.recording
        let entry = InboxEntry(id: recording.id, name: recording.name, createdAt: recording.createdAt,
                               duration: recording.duration, fileName: fileName,
                               mimeType: recording.mimeType, byteCount: byteCount,
                               receivedVia: via.rawValue, sender: transfer.senderName,
                               receivedAt: Date())
        let sidecar = inbox.appendingPathComponent("\(recording.sketchID).json")
        let sidecarPart = inbox.appendingPathComponent(".\(recording.sketchID).json.part")
        try EarbudJSON.encoder.encode(entry).write(to: sidecarPart, options: .atomic)
        try? fileManager.removeItem(at: sidecar)
        try fileManager.moveItem(at: sidecarPart, to: sidecar)
        return entry
    }

    /// Number of complete entries waiting in `inbox`.
    public static func pendingCount(in inbox: URL) -> Int {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: inbox.path)) ?? []
        return names.filter { $0.hasSuffix(".json") && !$0.hasPrefix(".") }.count
    }
}
