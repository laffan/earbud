// Earbud Capture Engine (iOS).
//
// Records synchronized audio + video with AVCaptureMovieFileOutput, which
// writes both tracks against a single capture clock straight to disk. The
// live preview is a native AVCaptureVideoPreviewLayer placed *behind* the
// (temporarily transparent) WKWebView, so no frames cross the JS bridge.
//
// Commands (invoked from JS as `plugin:capture|<snake_case>`):
//   checkPermissions / requestPermissions / openAppSettings
//   startRecording({ outputPath, camera, lens, rawAudio, events })
//   stopRecording()
//   extractAnalysisAudio({ inputPath, outputPath, sampleRate })
//   shareFiles({ paths })
//
// Threading: Tauri delivers commands on its own serial "ipc" queue. All
// capture state lives on `sessionQueue`; UIKit work hops to the main queue.

import AVFoundation
import Tauri
import UIKit
import WebKit

// MARK: - Arguments

struct StartRecordingArgs: Decodable {
  /// Absolute path of the movie file to create (reserved by the Sketch Library).
  let outputPath: String
  /// "back" (default), "front", or "none" for audio-only sketches.
  let camera: String?
  /// "wide" (default) or "ultraWide" (fits a whole keyboard from closer up).
  let lens: String?
  /// Use AVAudioSession `.measurement` mode (minimal system processing).
  let rawAudio: Bool?
  /// Receives `level`, `interrupted`, `error` and `finished` events.
  let events: Channel?
}

struct ExtractAudioArgs: Decodable {
  let inputPath: String
  let outputPath: String
  let sampleRate: Double?
}

struct ShareFilesArgs: Decodable {
  let paths: [String]
}

enum CaptureError: LocalizedError {
  case noMicrophone
  case noCamera
  case cannotAdd(String)
  case sessionNotRunning
  case noAudioTrack
  case readerFailed(String)

  var errorDescription: String? {
    switch self {
    case .noMicrophone: return "No microphone is available."
    case .noCamera: return "The requested camera is not available."
    case .cannotAdd(let what): return "Could not add \(what) to the capture session."
    case .sessionNotRunning: return "The capture session failed to start."
    case .noAudioTrack: return "The recording has no audio track."
    case .readerFailed(let message): return "Could not read the recording: \(message)"
    }
  }
}

// MARK: - Preview view

/// A view whose backing layer *is* the preview layer, so it resizes with the
/// view (rotation, split view) without manual frame management.
final class PreviewView: UIView {
  override class var layerClass: AnyClass {
    return AVCaptureVideoPreviewLayer.self
  }

  var previewLayer: AVCaptureVideoPreviewLayer {
    return layer as! AVCaptureVideoPreviewLayer
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let orientation = window?.windowScene?.interfaceOrientation ?? .portrait
    if let connection = previewLayer.connection, connection.isVideoOrientationSupported {
      connection.videoOrientation = CapturePlugin.videoOrientation(for: orientation)
    }
  }
}

// MARK: - Plugin

class CapturePlugin: Plugin, AVCaptureFileOutputRecordingDelegate {
  private weak var webView: WKWebView?
  private let sessionQueue = DispatchQueue(label: "app.earbud.capture.session")

  // State below is only touched on `sessionQueue`.
  private var session: AVCaptureSession?
  private var movieOutput: AVCaptureMovieFileOutput?
  private var events: Channel?
  private var startInvoke: Invoke?
  private var stopInvoke: Invoke?
  private var levelTimer: DispatchSourceTimer?
  private var hasVideo = false
  private var videoSize: CGSize?
  private var observers: [NSObjectProtocol] = []

  // Main-thread state.
  private var previewView: PreviewView?
  private var savedBackground: UIColor?

  public override func load(webview: WKWebView) {
    self.webView = webview
    // Let review playback ignore the ring/silent switch (this is a music
    // app). Setting the category does not activate the session, so other
    // apps' audio is not interrupted at launch.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
  }

  // MARK: Permissions

  private static func state(for type: AVMediaType) -> String {
    switch AVCaptureDevice.authorizationStatus(for: type) {
    case .authorized: return "granted"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "prompt"
    @unknown default: return "prompt"
    }
  }

  private func permissionStates() -> JsonObject {
    let states: JsonObject = [
      "camera": CapturePlugin.state(for: .video),
      "microphone": CapturePlugin.state(for: .audio),
    ]
    return states
  }

  @objc override func checkPermissions(_ invoke: Invoke) {
    invoke.resolve(permissionStates())
  }

  @objc override func requestPermissions(_ invoke: Invoke) {
    AVCaptureDevice.requestAccess(for: .audio) { _ in
      AVCaptureDevice.requestAccess(for: .video) { _ in
        invoke.resolve(self.permissionStates())
      }
    }
  }

  @objc func openAppSettings(_ invoke: Invoke) {
    DispatchQueue.main.async {
      guard let url = URL(string: UIApplication.openSettingsURLString) else {
        invoke.reject("Settings URL unavailable")
        return
      }
      UIApplication.shared.open(url, options: [:]) { _ in
        invoke.resolve()
      }
    }
  }

  // MARK: Recording

  @objc func startRecording(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StartRecordingArgs.self)
    // Read UI orientation on the main thread before touching the session.
    DispatchQueue.main.async {
      let orientation = self.currentInterfaceOrientation()
      self.sessionQueue.async {
        self.beginRecording(invoke, args: args, orientation: orientation)
      }
    }
  }

  private func beginRecording(
    _ invoke: Invoke, args: StartRecordingArgs, orientation: UIInterfaceOrientation
  ) {
    if session != nil || startInvoke != nil || stopInvoke != nil {
      invoke.reject("A recording is already in progress.", code: "busy")
      return
    }
    let camera = args.camera ?? "back"
    let wantsVideo = camera != "none"

    if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
      invoke.reject("Microphone access has not been granted.", code: "permission_denied")
      return
    }
    if wantsVideo && AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
      invoke.reject("Camera access has not been granted.", code: "permission_denied")
      return
    }

    do {
      try configureRecordingAudioSession(raw: args.rawAudio ?? false)

      let session = AVCaptureSession()
      // Stored immediately so `teardown()` can stop it if a later step fails.
      self.session = session
      // We configure AVAudioSession ourselves (category/mode above).
      session.automaticallyConfiguresApplicationAudioSession = false
      session.beginConfiguration()

      var videoDevice: AVCaptureDevice? = nil
      if wantsVideo {
        // 720p keeps sketches small (~1 MB/s) while staying sharp enough to
        // see hands on the keys; it also leaves headroom for future
        // on-device Vision analysis.
        if session.canSetSessionPreset(.hd1280x720) {
          session.sessionPreset = .hd1280x720
        }
        guard let device = CapturePlugin.findCamera(camera: camera, lens: args.lens) else {
          session.commitConfiguration()
          throw CaptureError.noCamera
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
          session.commitConfiguration()
          throw CaptureError.cannotAdd("the camera")
        }
        session.addInput(input)
        videoDevice = device
      }

      guard let mic = AVCaptureDevice.default(for: .audio) else {
        session.commitConfiguration()
        throw CaptureError.noMicrophone
      }
      let micInput = try AVCaptureDeviceInput(device: mic)
      guard session.canAddInput(micInput) else {
        session.commitConfiguration()
        throw CaptureError.cannotAdd("the microphone")
      }
      session.addInput(micInput)

      let output = AVCaptureMovieFileOutput()
      guard session.canAddOutput(output) else {
        session.commitConfiguration()
        throw CaptureError.cannotAdd("the movie output")
      }
      session.addOutput(output)
      self.movieOutput = output

      if let connection = output.connection(with: .video) {
        // H.264 for maximum compatibility when exporting to other tools.
        if output.availableVideoCodecTypes.contains(.h264) {
          output.setOutputSettings([AVVideoCodecKey: AVVideoCodecType.h264], for: connection)
        }
        // A phone mounted above the keys does not move; stabilization would
        // only crop the frame.
        if connection.isVideoStabilizationSupported {
          connection.preferredVideoStabilizationMode = .off
        }
        if connection.isVideoOrientationSupported {
          connection.videoOrientation = CapturePlugin.videoOrientation(for: orientation)
        }
      }
      session.commitConfiguration()

      if let device = videoDevice {
        let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        let portrait = orientation == .portrait || orientation == .portraitUpsideDown
        videoSize =
          portrait
          ? CGSize(width: CGFloat(dims.height), height: CGFloat(dims.width))
          : CGSize(width: CGFloat(dims.width), height: CGFloat(dims.height))
      } else {
        videoSize = nil
      }

      observe(session)
      session.startRunning()
      guard session.isRunning else {
        removeObservers()
        throw CaptureError.sessionNotRunning
      }

      let url = URL(fileURLWithPath: args.outputPath)
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }

      self.events = args.events
      self.hasVideo = videoDevice != nil
      self.startInvoke = invoke

      if videoDevice != nil {
        showPreview(session: session)
      }
      setIdleTimerDisabled(true)
      // Resolved from fileOutput(_:didStartRecordingTo:from:).
      output.startRecording(to: url, recordingDelegate: self)
    } catch {
      teardown()
      invoke.reject(
        "Could not start recording: \(error.localizedDescription)", code: "start_failed")
    }
  }

  @objc func stopRecording(_ invoke: Invoke) {
    sessionQueue.async {
      guard let output = self.movieOutput, output.isRecording else {
        invoke.reject("Not recording.", code: "not_recording")
        return
      }
      if self.stopInvoke != nil {
        invoke.reject("Already stopping.", code: "busy")
        return
      }
      // Resolved from fileOutput(_:didFinishRecordingTo:from:error:).
      self.stopInvoke = invoke
      output.stopRecording()
    }
  }

  func fileOutput(
    _ output: AVCaptureFileOutput, didStartRecordingTo fileURL: URL,
    from connections: [AVCaptureConnection]
  ) {
    sessionQueue.async {
      self.startLevelMeter()
      if let invoke = self.startInvoke {
        self.startInvoke = nil
        let payload: JsonObject = [
          "path": fileURL.path,
          "hasVideo": self.hasVideo,
        ]
        invoke.resolve(payload)
      }
    }
  }

  func fileOutput(
    _ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL,
    from connections: [AVCaptureConnection], error: Error?
  ) {
    let recorded = output.recordedDuration
    sessionQueue.async {
      var ok = true
      var message: String? = nil
      if let error = error as NSError? {
        // Interruptions (phone call, app backgrounded, disk full) still
        // produce a playable file when this flag is set.
        ok = (error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) ?? false
        message = error.localizedDescription
      }
      let seconds = CMTimeGetSeconds(recorded)
      var result: JsonObject = [
        "path": outputFileURL.path,
        "durationMs": seconds.isFinite ? seconds * 1000.0 : 0.0,
        "hasVideo": self.hasVideo,
        "ok": ok,
      ]
      if let size = self.videoSize {
        result["width"] = Int(size.width)
        result["height"] = Int(size.height)
      }
      if let message = message {
        result["message"] = message
      }

      if let start = self.startInvoke {
        self.startInvoke = nil
        start.reject(message ?? "Recording ended before it started.", code: "start_failed")
      }
      if let stop = self.stopInvoke {
        self.stopInvoke = nil
        stop.resolve(result)
      } else {
        // Finished without a stop request (interruption, backgrounding):
        // tell the UI so it can save the sketch.
        result["type"] = "finished"
        self.events?.send(result)
      }
      self.teardown()
    }
  }

  // MARK: Level meter

  private func startLevelMeter() {
    stopLevelMeter()
    let timer = DispatchSource.makeTimerSource(queue: sessionQueue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(100))
    timer.setEventHandler { [weak self] in
      guard let self = self, let output = self.movieOutput,
        let connection = output.connection(with: .audio)
      else { return }
      var average: Float = -160
      var peak: Float = -160
      for channel in connection.audioChannels {
        if channel.averagePowerLevel.isFinite { average = max(average, channel.averagePowerLevel) }
        if channel.peakHoldLevel.isFinite { peak = max(peak, channel.peakHoldLevel) }
      }
      let seconds = CMTimeGetSeconds(output.recordedDuration)
      let payload: JsonObject = [
        "type": "level",
        "averageDb": Double(average),
        "peakDb": Double(peak),
        "elapsedMs": seconds.isFinite ? seconds * 1000.0 : 0.0,
      ]
      self.events?.send(payload)
    }
    timer.resume()
    levelTimer = timer
  }

  private func stopLevelMeter() {
    levelTimer?.cancel()
    levelTimer = nil
  }

  // MARK: Session lifecycle

  private func observe(_ session: AVCaptureSession) {
    removeObservers()
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(
        forName: .AVCaptureSessionWasInterrupted, object: session, queue: nil
      ) { [weak self] note in
        let reason = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int ?? -1
        self?.sessionQueue.async {
          let payload: JsonObject = ["type": "interrupted", "reason": reason]
          self?.events?.send(payload)
        }
      })
    observers.append(
      center.addObserver(
        forName: .AVCaptureSessionRuntimeError, object: session, queue: nil
      ) { [weak self] note in
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
        self?.sessionQueue.async {
          let payload: JsonObject = [
            "type": "error",
            "message": error?.localizedDescription ?? "Capture session error",
          ]
          self?.events?.send(payload)
        }
      })
  }

  private func removeObservers() {
    for observer in observers {
      NotificationCenter.default.removeObserver(observer)
    }
    observers.removeAll()
  }

  /// Release the camera and microphone and restore the webview. Runs on
  /// `sessionQueue`.
  private func teardown() {
    stopLevelMeter()
    removeObservers()
    if let session = session, session.isRunning {
      session.stopRunning()
    }
    session = nil
    movieOutput = nil
    events = nil
    hidePreview()
    setIdleTimerDisabled(false)
    let audio = AVAudioSession.sharedInstance()
    try? audio.setCategory(.playback, mode: .default, options: [])
    try? audio.setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func configureRecordingAudioSession(raw: Bool) throws {
    let audio = AVAudioSession.sharedInstance()
    // `.videoRecording` picks the microphone that matches the camera and
    // behaves like the Camera app; `.measurement` disables system
    // processing (AGC, EQ) for the most faithful piano signal.
    let mode: AVAudioSession.Mode = raw ? .measurement : .videoRecording
    try audio.setCategory(
      .playAndRecord, mode: mode, options: [.defaultToSpeaker, .allowBluetoothA2DP])
    try audio.setActive(true)
  }

  // MARK: Preview (main thread)

  private func showPreview(session: AVCaptureSession) {
    DispatchQueue.main.async {
      guard let webView = self.webView, let container = webView.superview else { return }
      self.previewView?.removeFromSuperview()
      let preview = PreviewView(frame: webView.frame)
      preview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      preview.backgroundColor = .black
      // Show the whole recorded frame so framing the keyboard is honest.
      preview.previewLayer.videoGravity = .resizeAspect
      preview.previewLayer.session = session
      container.insertSubview(preview, belowSubview: webView)
      self.previewView = preview

      self.savedBackground = webView.backgroundColor
      webView.isOpaque = false
      webView.backgroundColor = .clear
      webView.scrollView.backgroundColor = .clear
    }
  }

  private func hidePreview() {
    DispatchQueue.main.async {
      guard let preview = self.previewView else { return }
      preview.previewLayer.session = nil
      preview.removeFromSuperview()
      self.previewView = nil
      if let webView = self.webView {
        let background = self.savedBackground ?? .systemBackground
        webView.isOpaque = true
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
      }
    }
  }

  private func setIdleTimerDisabled(_ disabled: Bool) {
    // Auto-lock would stop the camera mid-performance.
    DispatchQueue.main.async {
      UIApplication.shared.isIdleTimerDisabled = disabled
    }
  }

  private func currentInterfaceOrientation() -> UIInterfaceOrientation {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first
    return scene?.interfaceOrientation ?? .portrait
  }

  static func videoOrientation(for orientation: UIInterfaceOrientation) -> AVCaptureVideoOrientation
  {
    switch orientation {
    case .landscapeLeft: return .landscapeLeft
    case .landscapeRight: return .landscapeRight
    case .portraitUpsideDown: return .portraitUpsideDown
    default: return .portrait
    }
  }

  private static func findCamera(camera: String, lens: String?) -> AVCaptureDevice? {
    let position: AVCaptureDevice.Position = camera == "front" ? .front : .back
    if lens == "ultraWide", position == .back,
      let ultraWide = AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back)
    {
      return ultraWide
    }
    return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
  }

  // MARK: Analysis audio

  /// Decode the recording's audio track to 16-bit PCM WAV for the
  /// transcription engine. The original file is only read, never modified.
  @objc func extractAnalysisAudio(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExtractAudioArgs.self)
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let result = try AnalysisAudioExtractor.extract(
          input: URL(fileURLWithPath: args.inputPath),
          output: URL(fileURLWithPath: args.outputPath),
          sampleRate: args.sampleRate ?? 22050)
        let payload: JsonObject = [
          "path": args.outputPath,
          "sampleRate": result.sampleRate,
          "channels": result.channels,
          "frames": result.frames,
          "durationMs": result.sampleRate > 0
            ? Double(result.frames) / result.sampleRate * 1000.0 : 0.0,
        ]
        invoke.resolve(payload)
      } catch {
        invoke.reject(
          "Audio extraction failed: \(error.localizedDescription)", code: "extract_failed")
      }
    }
  }

  // MARK: Sharing

  @objc func shareFiles(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareFilesArgs.self)
    let urls = args.paths
      .map { URL(fileURLWithPath: $0) }
      .filter { FileManager.default.fileExists(atPath: $0.path) }
    if urls.isEmpty {
      invoke.reject("There is nothing to share.", code: "not_found")
      return
    }
    DispatchQueue.main.async {
      guard var presenter = self.manager.viewController else {
        invoke.reject("No view controller to present from.")
        return
      }
      while let presented = presenter.presentedViewController {
        presenter = presented
      }
      let activity = UIActivityViewController(activityItems: urls, applicationActivities: nil)
      activity.completionWithItemsHandler = { activityType, completed, _, error in
        if let error = error {
          invoke.reject(error.localizedDescription)
        } else {
          let payload: JsonObject = [
            "completed": completed,
            "activity": activityType?.rawValue ?? "",
          ]
          invoke.resolve(payload)
        }
      }
      // Required on iPad, where the sheet is a popover.
      if let popover = activity.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(
          x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
        popover.permittedArrowDirections = []
      }
      presenter.present(activity, animated: true, completion: nil)
    }
  }
}

// MARK: - WAV extraction

enum AnalysisAudioExtractor {
  struct Result {
    let frames: Int
    let sampleRate: Double
    let channels: Int
  }

  static func extract(input: URL, output: URL, sampleRate: Double) throws -> Result {
    let asset = AVURLAsset(url: input)
    guard let track = asset.tracks(withMediaType: .audio).first else {
      throw CaptureError.noAudioTrack
    }
    let reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: sampleRate,
      AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    let trackOutput = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    trackOutput.alwaysCopiesSampleData = false
    guard reader.canAdd(trackOutput) else {
      throw CaptureError.readerFailed("cannot add track output")
    }
    reader.add(trackOutput)
    guard reader.startReading() else {
      throw CaptureError.readerFailed(reader.error?.localizedDescription ?? "unknown error")
    }

    let temp = output.deletingPathExtension().appendingPathExtension("partial")
    if FileManager.default.fileExists(atPath: temp.path) {
      try FileManager.default.removeItem(at: temp)
    }
    FileManager.default.createFile(atPath: temp.path, contents: nil)
    let handle = try FileHandle(forWritingTo: temp)
    // Placeholder header; rewritten once the data length is known.
    try handle.write(contentsOf: Data(count: 44))

    var dataBytes = 0
    // The header describes what the reader actually produced, in case the
    // requested conversion was not applied; the JS side resamples/downmixes
    // anything that is not 22.05 kHz mono.
    var actualRate = sampleRate
    var actualChannels = 1
    var sawFormat = false

    while let sample = trackOutput.copyNextSampleBuffer() {
      if !sawFormat, let format = CMSampleBufferGetFormatDescription(sample),
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee
      {
        actualRate = asbd.mSampleRate
        actualChannels = Int(max(1, asbd.mChannelsPerFrame))
        sawFormat = true
      }
      if let block = CMSampleBufferGetDataBuffer(sample) {
        let length = CMBlockBufferGetDataLength(block)
        if length > 0 {
          var data = Data(count: length)
          let status = data.withUnsafeMutableBytes { (buffer: UnsafeMutableRawBufferPointer) -> OSStatus in
            guard let base = buffer.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(
              block, atOffset: 0, dataLength: length, destination: base)
          }
          if status == noErr {
            try handle.write(contentsOf: data)
            dataBytes += length
          }
        }
      }
    }

    if reader.status == .failed {
      try? handle.close()
      try? FileManager.default.removeItem(at: temp)
      throw CaptureError.readerFailed(reader.error?.localizedDescription ?? "unknown error")
    }

    try handle.seek(toOffset: 0)
    try handle.write(
      contentsOf: wavHeader(
        dataBytes: dataBytes, sampleRate: Int(actualRate.rounded()), channels: actualChannels,
        bitsPerSample: 16))
    try handle.close()

    if FileManager.default.fileExists(atPath: output.path) {
      try FileManager.default.removeItem(at: output)
    }
    try FileManager.default.moveItem(at: temp, to: output)

    let frames = dataBytes / (2 * actualChannels)
    return Result(frames: frames, sampleRate: actualRate, channels: actualChannels)
  }

  static func wavHeader(dataBytes: Int, sampleRate: Int, channels: Int, bitsPerSample: Int)
    -> Data
  {
    var header = Data()
    func appendUInt32(_ value: UInt32) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { header.append(contentsOf: $0) }
    }
    func appendUInt16(_ value: UInt16) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { header.append(contentsOf: $0) }
    }
    let blockAlign = channels * bitsPerSample / 8
    header.append(contentsOf: Array("RIFF".utf8))
    appendUInt32(UInt32(36 + dataBytes))
    header.append(contentsOf: Array("WAVE".utf8))
    header.append(contentsOf: Array("fmt ".utf8))
    appendUInt32(16)  // PCM fmt chunk size
    appendUInt16(1)  // PCM
    appendUInt16(UInt16(channels))
    appendUInt32(UInt32(sampleRate))
    appendUInt32(UInt32(sampleRate * blockAlign))
    appendUInt16(UInt16(blockAlign))
    appendUInt16(UInt16(bitsPerSample))
    header.append(contentsOf: Array("data".utf8))
    appendUInt32(UInt32(dataBytes))
    return header
  }
}

@_cdecl("init_plugin_capture")
public func initPlugin() -> Plugin {
  return CapturePlugin()
}
