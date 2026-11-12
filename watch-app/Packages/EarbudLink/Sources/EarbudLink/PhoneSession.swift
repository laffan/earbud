import Foundation
#if canImport(WatchConnectivity)
import WatchConnectivity

/// WatchConnectivity, both ends:
///
///  • Watch: `transferFile` to its paired iPhone. watchOS queues the file and delivers it when
///    it can, also while Earbud on the iPhone is not running, and reports completion here.
///  • iPhone: Earbud publishes a `ReceiverAnnouncement` (its name and id) in the application
///    context, so the Watch knows its iPhone runs Earbud, and moves received files into the
///    inbox.
///
/// WCSession has one delegate per process, so this is a singleton.
public final class PhoneSessionLink: NSObject, WCSessionDelegate {
    public static let shared = PhoneSessionLink()

    private let session: WCSession? = WCSession.isSupported() ? WCSession.default : nil

    #if os(iOS)
    /// Where received recordings go. Read on WatchConnectivity's queue.
    public var inbox: (() -> URL)?
    /// Called on WatchConnectivity's queue after a recording reached the inbox.
    public var onReceive: ((InboxEntry) -> Void)?
    #endif

    #if os(watchOS)
    /// Called on the main queue when the iPhone's announcement changes.
    public var onReceiverChange: ((ReceiverAnnouncement?) -> Void)?
    /// Called on the main queue when watchOS finishes (or gives up) delivering a recording.
    public var onTransferFinished: ((UUID, Error?) -> Void)?
    #endif

    private override init() {
        super.init()
    }

    public var isSupported: Bool { session != nil }

    public var isActivated: Bool { session?.activationState == .activated }

    /// Set the delegate and activate. Call once, early (at launch), so files queued while the app
    /// wasn't running are delivered.
    public func activate() {
        guard let session, session.delegate !== self else { return }
        session.delegate = self
        session.activate()
    }

    // MARK: iPhone

    #if os(iOS)
    public var isPaired: Bool { session?.isPaired ?? false }
    public var isWatchAppInstalled: Bool { session?.isWatchAppInstalled ?? false }

    private var announcement: ReceiverAnnouncement?

    /// Tell the Watch this iPhone runs Earbud, under this name (nil: stop announcing).
    public func announce(_ announcement: ReceiverAnnouncement?) {
        self.announcement = announcement
        publishAnnouncement()
    }

    private func publishAnnouncement() {
        guard let session, session.activationState == .activated else { return }
        var context: [String: Any] = [:]
        if let announcement,
           let data = try? EarbudJSON.encoder.encode(announcement) {
            context[ReceiverAnnouncement.contextKey] = data
        }
        do {
            try session.updateApplicationContext(context)
        } catch {
            LinkLog.log("WatchConnectivity: could not publish this device: \(error.localizedDescription)")
        }
    }
    #endif

    // MARK: Watch

    #if os(watchOS)
    /// The iPhone's announcement, if its Earbud has published one.
    public var receiver: ReceiverAnnouncement? {
        guard let data = session?.receivedApplicationContext[ReceiverAnnouncement.contextKey] as? Data else {
            return nil
        }
        return try? EarbudJSON.decoder.decode(ReceiverAnnouncement.self, from: data)
    }

    public var isCompanionAppInstalled: Bool { session?.isCompanionAppInstalled ?? false }

    /// Queue a recording for the paired iPhone. Returns immediately; completion arrives through
    /// `onTransferFinished`.
    public func queue(_ transfer: RecordingTransfer, audioURL: URL) throws {
        guard let session, session.activationState == .activated else { throw LinkError.notReachable }
        let data = try EarbudJSON.encoder.encode(transfer)
        guard let metadata = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LinkError.failed("Could not encode the recording.")
        }
        session.transferFile(audioURL, metadata: ["transfer": metadata])
        LinkLog.log("Queued “\(transfer.recording.name)” for the paired iPhone")
    }

    /// Recordings watchOS is still delivering.
    public var queuedRecordingIDs: Set<UUID> {
        let transfers = session?.outstandingFileTransfers ?? []
        return Set(transfers.compactMap { Self.recordingID(from: $0.file.metadata) })
    }
    #endif

    private static func transfer(from metadata: [String: Any]?) -> RecordingTransfer? {
        guard let wrapper = metadata?["transfer"] as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: wrapper) else { return nil }
        return try? EarbudJSON.decoder.decode(RecordingTransfer.self, from: data)
    }

    private static func recordingID(from metadata: [String: Any]?) -> UUID? {
        transfer(from: metadata)?.recording.id
    }

    // MARK: WCSessionDelegate

    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                        error: Error?) {
        if let error {
            LinkLog.log("WatchConnectivity: activation failed: \(error.localizedDescription)")
        } else {
            LinkLog.log("WatchConnectivity: activated (state \(activationState.rawValue))")
        }
        #if os(iOS)
        publishAnnouncement()
        #endif
        #if os(watchOS)
        let receiver = self.receiver
        DispatchQueue.main.async { self.onReceiverChange?(receiver) }
        #endif
    }

    #if os(iOS)
    public func sessionDidBecomeInactive(_ session: WCSession) {}

    public func sessionDidDeactivate(_ session: WCSession) {
        // The user switched to another watch: activate again for the new one.
        session.activate()
    }

    public func sessionWatchStateDidChange(_ session: WCSession) {
        publishAnnouncement()
    }

    public func session(_ session: WCSession, didReceive file: WCSessionFile) {
        guard let transfer = Self.transfer(from: file.metadata) else {
            LinkLog.log("WatchConnectivity: received a file without recording details")
            return
        }
        guard let inbox = inbox?() else {
            LinkLog.log("WatchConnectivity: no inbox for “\(transfer.recording.name)”")
            return
        }
        do {
            let entry = try InboxWriter.moveIn(file: file.fileURL, transfer: transfer, via: .phoneSession, to: inbox)
            LinkLog.log("Received “\(transfer.recording.name)” from the paired Watch")
            onReceive?(entry)
        } catch {
            LinkLog.log("WatchConnectivity: could not store “\(transfer.recording.name)”: \(error.localizedDescription)")
        }
    }
    #endif

    #if os(watchOS)
    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let receiver = self.receiver
        DispatchQueue.main.async { self.onReceiverChange?(receiver) }
    }

    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard let id = Self.recordingID(from: fileTransfer.file.metadata) else { return }
        if let error {
            LinkLog.log("WatchConnectivity: delivery failed: \(error.localizedDescription)")
        }
        DispatchQueue.main.async { self.onTransferFinished?(id, error) }
    }
    #endif
}
#endif
