import UIKit
import UniformTypeIdentifiers
import AVFoundation
import CryptoKit

/// Separate process: accepts file representations, copies them while the URL
/// grant is valid, and commits an App Group entry only after validation.
final class ShareViewController: UIViewController {
  private let label = UILabel()
  private var task: Task<Void, Never>?
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    label.numberOfLines = 0; label.textAlignment = .center
    label.text = "Saving audio to Earbud…"; label.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(label)
    NSLayoutConstraint.activate([label.centerYAnchor.constraint(equalTo:view.centerYAnchor),label.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:24),label.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-24)])
    task = Task { await receive() }
  }
  private func fileURL(_ provider: NSItemProvider, type: String) async throws -> URL {
    // The provider's URL is ephemeral: perform the coordinated copy before
    // its completion handler returns, not after resuming the continuation.
    try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier:type) { url, error in
        do {
          if let error = error { throw error }
          guard let url = url else { throw ShareFailure.invalid }
          let scoped = url.startAccessingSecurityScopedResource()
          defer { if scoped { url.stopAccessingSecurityScopedResource() } }
          let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(url.pathExtension)
          var coordinationError: NSError?, copyError: Error?
          NSFileCoordinator().coordinate(readingItemAt:url,options:[],error:&coordinationError) { readable in
            do {
              let size = try readable.resourceValues(forKeys:[.fileSizeKey]).fileSize ?? 0
              guard size > 0, size <= 512 * 1024 * 1024 else { throw ShareFailure.size }
              try FileManager.default.copyItem(at:readable,to:copy)
            } catch { copyError = error }
          }
          if let error = coordinationError ?? (copyError as NSError?) { throw error }
          continuation.resume(returning:copy)
        } catch { continuation.resume(throwing:error) }
      }
    }
  }
  @MainActor private func receive() async {
    do {
      guard let group = Bundle.main.object(forInfoDictionaryKey:"EarbudAppGroup") as? String,
            let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:group) else { throw ShareFailure.group }
      let root = container.appendingPathComponent("MusicInbox",isDirectory:true)
      try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
      let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
      guard !providers.isEmpty, providers.count <= 8 else { throw ShareFailure.invalid }
      var saved = 0
      for provider in providers {
        guard let type = provider.registeredTypeIdentifiers.first(where:{ UTType($0)?.conforms(to:.audio) == true }) else { continue }
        let local = try await fileURL(provider,type:type)
        defer { try? FileManager.default.removeItem(at:local) }
        if Task.isCancelled { throw CancellationError() }
        let asset = AVURLAsset(url:local)
        let duration = CMTimeGetSeconds(asset.duration)
        guard !asset.tracks(withMediaType:.audio).isEmpty, duration.isFinite, duration > 0, duration <= 3600 else { throw ShareFailure.invalid }
        let ext = local.pathExtension.lowercased()
        guard ["mp3","m4a","aac","wav","aif","aiff","caf","flac"].contains(ext) else { throw ShareFailure.invalid }
        let handle = try FileHandle(forReadingFrom:local)
        var hasher = SHA256()
        while let data = try handle.read(upToCount:1024*1024), !data.isEmpty { hasher.update(data:data) }
        try handle.close()
        let hash = hasher.finalize().map { String(format:"%02x",$0) }.joined()
        // Duplicate delivery while an item is pending reuses its inbox entry.
        let duplicate = try FileManager.default.contentsOfDirectory(at:root,includingPropertiesForKeys:nil).contains { dir in
          guard let data = try? Data(contentsOf:dir.appendingPathComponent("metadata.json")),
                let meta = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else { return false }
          return meta["hash"] as? String == hash
        }
        if duplicate { saved += 1; continue }
        let id = UUID().uuidString
        let partial = root.appendingPathComponent(id + ".partial",isDirectory:true)
        try FileManager.default.createDirectory(at:partial,withIntermediateDirectories:false)
        do {
          let filename = "audio." + ext
          try FileManager.default.copyItem(at:local,to:partial.appendingPathComponent(filename))
          let name = provider.suggestedName ?? "Shared audio.\(ext)"
          let metadata: [String:Any] = ["file":filename,"name":name,"hash":hash,"createdAt":Date().timeIntervalSince1970*1000]
          try JSONSerialization.data(withJSONObject:metadata).write(to:partial.appendingPathComponent("metadata.json"),options:.atomic)
          try FileManager.default.moveItem(at:partial,to:root.appendingPathComponent(id,isDirectory:true))
          saved += 1
        } catch { try? FileManager.default.removeItem(at:partial); throw error }
      }
      guard saved > 0 else { throw ShareFailure.invalid }
      label.text = "Audio saved. Open Earbud to choose its MIDI session and import it."
      let done = UIButton(type:.system)
      done.setTitle("Done",for:.normal); done.translatesAutoresizingMaskIntoConstraints = false
      done.addTarget(self,action:#selector(finish),for:.touchUpInside)
      view.addSubview(done)
      NSLayoutConstraint.activate([done.topAnchor.constraint(equalTo:label.bottomAnchor,constant:24),done.centerXAnchor.constraint(equalTo:view.centerXAnchor)])
    } catch { extensionContext?.cancelRequest(withError:error) }
  }
  @objc private func finish() { extensionContext?.completeRequest(returningItems:nil) }
}
enum ShareFailure: LocalizedError {
  case group, size, invalid
  var errorDescription: String? {
    switch self {
    case .group: return "Earbud’s App Group is unavailable. Check signing for the app and Share Extension."
    case .size: return "Choose nonempty audio smaller than 512 MB."
    case .invalid: return "Share a supported audio file (MP3, M4A, WAV, AIFF, AAC, CAF or FLAC), up to one hour."
    }
  }
}
