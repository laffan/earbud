import AVFoundation
import Foundation
import Tauri

struct MusicCopyArgs: Decodable { let id: String; let mediaPath: String; let analysisPath: String }

/// App Group inbox entries are directories committed by atomic rename. No
/// caller-supplied source path crosses the bridge. UUIDs are the only handles.
final class MusicInbox {
  private let fm = FileManager.default
  private var player: AVPlayer?
  func stopPreview() { player?.pause(); player = nil }
  func preview(_ id: String) throws {
    stopPreview()
    let dir = try entry(id), meta = try metadata(dir)
    let source = dir.appendingPathComponent(meta["file"] as! String)
    _ = try probe(source,id:id,name:source.lastPathComponent)
    try AVAudioSession.sharedInstance().setActive(true)
    player = AVPlayer(url:source); player?.play()
  }
  private let maxSize: Int64 = 512 * 1024 * 1024
  private let formats: [String:String] = ["mp3":"audio/mpeg","m4a":"audio/mp4","aac":"audio/aac","wav":"audio/wav","aif":"audio/aiff","aiff":"audio/aiff","caf":"audio/x-caf","flac":"audio/flac"]
  private func validID(_ id: String) -> Bool { UUID(uuidString:id) != nil }
  private func localRoot() throws -> URL {
    let root = try fm.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true).appendingPathComponent("EarbudMusicInbox",isDirectory:true)
    try fm.createDirectory(at:root,withIntermediateDirectories:true)
    return root
  }
  private func groupRoot() -> URL? {
    guard let group = Bundle.main.object(forInfoDictionaryKey:"EarbudAppGroup") as? String,
          let url = fm.containerURL(forSecurityApplicationGroupIdentifier:group) else { return nil }
    return url.appendingPathComponent("MusicInbox",isDirectory:true)
  }
  private func roots() throws -> [URL] { var roots = [try localRoot()]; if let group = groupRoot() { roots.append(group) }; return roots }
  private func entry(_ id: String) throws -> URL {
    guard validID(id) else { throw MusicFailure.message("Invalid inbox identifier.") }
    for root in try roots() {
      let dir = root.appendingPathComponent(id,isDirectory:true)
      if fm.fileExists(atPath:dir.appendingPathComponent("metadata.json").path) { return dir }
    }
    throw MusicFailure.message("The shared audio is no longer in the inbox.")
  }
  private func metadata(_ dir: URL) throws -> JsonObject {
    guard let data = try JSONSerialization.jsonObject(with:Data(contentsOf:dir.appendingPathComponent("metadata.json"))) as? JsonObject,
          let name = data["file"] as? String, name == URL(fileURLWithPath:name).lastPathComponent,
          !name.contains("/"), !name.contains("\\") else { throw MusicFailure.message("Invalid shared audio metadata.") }
    return data
  }
  private func probe(_ url: URL, id: String, name: String) throws -> JsonObject {
    let size = (try url.resourceValues(forKeys:[.fileSizeKey])).fileSize ?? 0
    guard size > 0, size <= maxSize, let mime = formats[url.pathExtension.lowercased()] else { throw MusicFailure.message("Unsupported or empty audio (maximum 512 MB).") }
    let asset = AVURLAsset(url:url)
    let duration = CMTimeGetSeconds(asset.duration)
    guard asset.tracks(withMediaType:.audio).first != nil, duration.isFinite, duration > 0, duration <= 3600 else { throw MusicFailure.message("The audio cannot be decoded, or is longer than one hour.") }
    return ["id":id,"name":name,"size":size,"durationMs":Int((duration*1000).rounded()),"mime":mime,"extension":url.pathExtension.lowercased()]
  }
  func list() throws -> [JsonObject] {
    var results: [JsonObject] = []
    for root in try roots() {
      guard fm.fileExists(atPath:root.path) else { continue }
      for dir in try fm.contentsOfDirectory(at:root,includingPropertiesForKeys:[.contentModificationDateKey]) {
        if dir.lastPathComponent.hasSuffix(".partial") {
          if let date = try? dir.resourceValues(forKeys:[.contentModificationDateKey]).contentModificationDate, date.timeIntervalSinceNow < -86400 { try? fm.removeItem(at:dir) }
          continue
        }
        guard validID(dir.lastPathComponent) else { continue }
        // Invalid entries remain available for explicit deletion/retry rather
        // than blocking all valid incoming items.
        guard let meta = try? metadata(dir), let file = meta["file"] as? String else { continue }
        do { results.append(try probe(dir.appendingPathComponent(file),id:dir.lastPathComponent,name:meta["name"] as? String ?? file)) }
        catch { results.append(["id":dir.lastPathComponent,"name":meta["name"] as? String ?? file,"size":0,"durationMs":0,"mime":"","extension":"","error":error.localizedDescription]) }
      }
    }
    return results
  }
  func newRenderURL() throws -> URL {
    let dir = try localRoot().appendingPathComponent(UUID().uuidString + ".partial",isDirectory:true)
    try fm.createDirectory(at:dir,withIntermediateDirectories:false)
    return dir.appendingPathComponent("render.wav")
  }
  func commitRender(_ url: URL) throws -> JsonObject {
    // Ensure the result contains actual synthesized samples, not a valid but
    // silent header after an AU failed to produce output.
    let audio = try AVAudioFile(forReading:url)
    let buffer = AVAudioPCMBuffer(pcmFormat:audio.processingFormat,frameCapacity:4096)!
    var audible = false
    while audio.framePosition < audio.length {
      try audio.read(into:buffer)
      guard buffer.frameLength > 0 else { break }
      if let channels = buffer.floatChannelData {
        for c in 0..<Int(buffer.format.channelCount) {
          if (0..<Int(buffer.frameLength)).contains(where:{ abs(channels[c][$0]) > 0.000001 }) { audible = true }
        }
      }
    }
    guard audible else { try? fm.removeItem(at:url.deletingLastPathComponent()); throw MusicFailure.message("The instrument produced silence. Check its preset and MIDI channel.") }
    let partial = url.deletingLastPathComponent()
    let id = String(partial.lastPathComponent.dropLast(".partial".count))
    let meta: JsonObject = ["file":"render.wav","name":"Instrument render.wav"]
    try JSONSerialization.data(withJSONObject:meta).write(to:partial.appendingPathComponent("metadata.json"),options:.atomic)
    let dest = partial.deletingLastPathComponent().appendingPathComponent(id,isDirectory:true)
    try fm.moveItem(at:partial,to:dest)
    return try probe(dest.appendingPathComponent("render.wav"),id:id,name:"Instrument render.wav")
  }
  private func outputURL(_ path: String, expected: String?) throws -> URL {
    let url = URL(fileURLWithPath:path).standardizedFileURL
    let parts = url.pathComponents
    guard parts.count >= 5, parts[parts.count-4] == "library", parts[parts.count-3] == "sketches",
          parts[parts.count-2].count == 32, parts[parts.count-2].allSatisfy({$0.isHexDigit}),
          (expected != nil ? url.lastPathComponent == expected! : url.deletingPathExtension().lastPathComponent == "recording") else { throw MusicFailure.message("Invalid reserved sketch path.") }
    let appSupport = try fm.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true).resolvingSymlinksInPath().path + "/"
    guard url.deletingLastPathComponent().resolvingSymlinksInPath().path.hasPrefix(appSupport),
          !fm.fileExists(atPath:url.path) else { throw MusicFailure.message("The reserved file already exists or is outside the library.") }
    return url
  }
  func copy(_ args: MusicCopyArgs) throws -> JsonObject {
    let dir = try entry(args.id), meta = try metadata(dir)
    let source = dir.appendingPathComponent(meta["file"] as! String)
    let result = try probe(source,id:args.id,name:meta["name"] as? String ?? source.lastPathComponent)
    let media = try outputURL(args.mediaPath,expected:nil)
    let analysis = try outputURL(args.analysisPath,expected:"analysis.wav")
    guard media.deletingLastPathComponent() == analysis.deletingLastPathComponent(), media.pathExtension.lowercased() == source.pathExtension.lowercased() else { throw MusicFailure.message("Mismatched import reservation.") }
    do {
      try fm.copyItem(at:source,to:media)
      try extract(source,output:analysis)
      return result
    } catch { try? fm.removeItem(at:media); try? fm.removeItem(at:analysis); throw error }
  }
  func acknowledge(_ id: String) throws { try fm.removeItem(at:entry(id)) }
  /// Stream decoded PCM into a separate waveform WAV; keep the source intact.
  private func extract(_ input: URL, output: URL) throws {
    let asset = AVURLAsset(url:input)
    guard let track = asset.tracks(withMediaType:.audio).first else { throw MusicFailure.message("No audio track.") }
    let reader = try AVAssetReader(asset:asset)
    let settings: [String:Any] = [AVFormatIDKey:kAudioFormatLinearPCM,AVSampleRateKey:22050,AVNumberOfChannelsKey:1,AVLinearPCMBitDepthKey:16,AVLinearPCMIsFloatKey:false,AVLinearPCMIsBigEndianKey:false,AVLinearPCMIsNonInterleaved:false]
    let out = AVAssetReaderTrackOutput(track:track,outputSettings:settings)
    guard reader.canAdd(out) else { throw MusicFailure.message("Unsupported decoder.") }
    reader.add(out)
    guard reader.startReading() else { throw reader.error ?? MusicFailure.message("Cannot start audio decoding.") }
    guard fm.createFile(atPath:output.path,contents:Data(count:44)) else { throw MusicFailure.message("Cannot create waveform file.") }
    let handle = try FileHandle(forWritingTo:output)
    defer { try? handle.close() }
    try handle.seekToEnd()
    var count: UInt32 = 0
    while let sample = out.copyNextSampleBuffer() {
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let length = CMBlockBufferGetDataLength(block)
      var bytes = Data(count:length)
      let status = bytes.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:$0.baseAddress!) }
      guard status == noErr, UInt64(count) + UInt64(length) < UInt64(UInt32.max)-44 else { throw MusicFailure.message("Audio decode failed or exceeds WAV limits.") }
      try handle.write(contentsOf:bytes); count += UInt32(length)
    }
    guard reader.status == .completed, count > 0 else { throw reader.error ?? MusicFailure.message("Incomplete audio decoding.") }
    var header = Data()
    func text(_ s: String) { header.append(s.data(using:.ascii)!) }
    func u16(_ n: UInt16) { var v = n.littleEndian; withUnsafeBytes(of:&v) { header.append(contentsOf:$0) } }
    func u32(_ n: UInt32) { var v = n.littleEndian; withUnsafeBytes(of:&v) { header.append(contentsOf:$0) } }
    text("RIFF"); u32(count+36); text("WAVEfmt "); u32(16); u16(1); u16(1); u32(22050); u32(44100); u16(2); u16(16); text("data"); u32(count)
    try handle.seek(toOffset:0); try handle.write(contentsOf:header); try handle.synchronize()
  }
}
