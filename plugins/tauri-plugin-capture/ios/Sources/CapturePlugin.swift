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
//   stopRecording() / resetCapture()
//   getDiagnostics()
//   extractAnalysisAudio({ inputPath, outputPath, sampleRate })
//   exportAudio({ inputPath, outputPath })
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
  /// Receives `level`, `interrupted`, `error`, `log` and `finished` events.
  let events: Channel?
}

struct ExtractAudioArgs: Decodable {
  let inputPath: String
  let outputPath: String
  let sampleRate: Double?
}

struct ExportAudioArgs: Decodable {
  let inputPath: String
  let outputPath: String
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
  case interrupted(String)

  var errorDescription: String? {
    switch self {
    case .noMicrophone: return "No microphone is available."
    case .noCamera: return "The requested camera is not available."
    case .cannotAdd(let what): return "Could not add \(what) to the capture session."
    case .sessionNotRunning: return "The capture session failed to start."
    case .noAudioTrack: return "The recording has no audio track."
    case .readerFailed(let message): return "Could not read the recording: \(message)"
    case .interrupted(let reason): return "Recording was interrupted: \(reason)."
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
    let wanted = CapturePlugin.videoOrientation(for: orientation)
    // Only touch the connection when the orientation really changes; layout
    // runs often and the capture graph should be left alone while recording.
    if let connection = previewLayer.connection, connection.isVideoOrientationSupported,
      connection.videoOrientation != wanted
    {
      connection.videoOrientation = wanted
    }
  }
}

// MARK: - Plugin

class CapturePlugin: Plugin, AVCaptureFileOutputRecordingDelegate {
  private weak var webView: WKWebView?
  private let sessionQueue = DispatchQueue(label: "app.earbud.capture.session")

  // State below is only touched on `sessionQueue`.
  private var session: AVCaptureSession?
  /// The output of the *current* recording. Delegate callbacks from any other
  /// output (a cancelled or timed-out attempt) are ignored.
  private var movieOutput: AVCaptureMovieFileOutput?
  private var events: Channel?
  private var startInvoke: Invoke?
  private var stopInvoke: Invoke?
  private var startWatchdog: DispatchWorkItem?
  private var levelTimer: DispatchSourceTimer?
  private var hasVideo = false
  private var videoSize: CGSize?
  private var recordingStartedAt: Date?
  private var lastInterruption: String?
  private var observers: [NSObjectProtocol] = []

  // Main-thread state.
  private var previewView: PreviewView?
  private var savedBackground: UIColor?

  // Diagnostics ring buffer (any thread, guarded by `logLock`).
  private let logLock = NSLock()
  private var logLines: [String] = []
  private let logFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    return formatter
  }()

  /// How long to wait for the first recorded data before giving up.
  private static let startTimeout: TimeInterval = 6

  public override func load(webview: WKWebView) {
    self.webView = webview
    // Let review playback ignore the ring/silent switch (this is a music
    // app). Setting the category does not activate the session, so other
    // apps' audio is not interrupted at launch.
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
    log("plugin loaded (iOS \(UIDevice.current.systemVersion), \(UIDevice.current.model))")
  }

  // MARK: Diagnostics

  /// Record a line in the in-app capture log (Settings → Diagnostics), the
  /// device console, and the current recording's event channel.
  private func log(_ message: String) {
    logLock.lock()
    let line = "\(logFormatter.string(from: Date())) \(message)"
    logLines.append(line)
    if logLines.count > 300 {
      logLines.removeFirst(logLines.count - 300)
    }
    logLock.unlock()
    NSLog("[earbud-capture] %@", message)
    sessionQueue.async { [weak self] in
      let payload: JsonObject = ["type": "log", "message": line]
      self?.events?.send(payload)
    }
  }

  private func audioSessionSummary() -> String {
    let audio = AVAudioSession.sharedInstance()
    let inputs = audio.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ",")
    let outputs = audio.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
    return "category=\(audio.category.rawValue) mode=\(audio.mode.rawValue) "
      + "options=\(audio.categoryOptions.rawValue) otherAudioPlaying=\(audio.isOtherAudioPlaying) "
      + "in=[\(inputs)] out=[\(outputs)]"
  }

  @objc func getDiagnostics(_ invoke: Invoke) {
    logLock.lock()
    let lines = logLines
    logLock.unlock()
    let payload: JsonObject = [
      "lines": lines,
      "audioSession": audioSessionSummary(),
      "camera": CapturePlugin.state(for: .video),
      "microphone": CapturePlugin.state(for: .audio),
    ]
    invoke.resolve(payload)
  }

  private static func describeInterruption(_ raw: Int) -> String {
    guard let reason = AVCaptureSession.InterruptionReason(rawValue: raw) else {
      return "unknown reason \(raw)"
    }
    switch reason {
    case .videoDeviceNotAvailableInBackground:
      return "the app left the foreground"
    case .audioDeviceInUseByAnotherClient:
      return "the microphone was taken by another audio session"
    case .videoDeviceInUseByAnotherClient:
      return "the camera is in use by another app"
    case .videoDeviceNotAvailableWithMultipleForegroundApps:
      return "the camera is unavailable while multitasking"
    case .videoDeviceNotAvailableDueToSystemPressure:
      return "the camera was paused due to system pressure (heat or power)"
    @unknown default:
      return "reason \(raw)"
    }
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
        let states = self.permissionStates()
        self.log("permissions after request: \(states)")
        invoke.resolve(states)
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
    log(
      "start requested camera=\(args.camera ?? "back") lens=\(args.lens ?? "wide") "
        + "raw=\(args.rawAudio ?? false)")
    // The permission alerts leave the app briefly inactive; a capture session
    // started then is interrupted straight away. Wait until it is active.
    DispatchQueue.main.async {
      self.runWhenActive(deadline: Date().addingTimeInterval(3)) { orientation in
        self.sessionQueue.async {
          self.beginRecording(invoke, args: args, orientation: orientation)
        }
      }
    }
  }

  /// Main thread. Calls `body` with the interface orientation once the app
  /// is active (or the deadline passes).
  private func runWhenActive(
    deadline: Date, _ body: @escaping (UIInterfaceOrientation) -> Void
  ) {
    let active = UIApplication.shared.applicationState == .active
    if active || Date() >= deadline {
      if !active {
        log("app still not active; starting anyway")
      }
      body(currentInterfaceOrientation())
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        self.runWhenActive(deadline: deadline, body)
      }
    }
  }

  private func beginRecording(
    _ invoke: Invoke, args: StartRecordingArgs, orientation: UIInterfaceOrientation
  ) {
    if session != nil || startInvoke != nil || stopInvoke != nil {
      // A previous attempt is still around (e.g. the UI gave up on it).
      // Recover instead of refusing, so one tap always works.
      log("previous capture state found; resetting before starting")
      abandonCurrentRecording(reason: "superseded by a new recording")
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

    // Attach the event channel first so setup diagnostics reach the app.
    self.events = args.events

    do {
      try configureRecordingAudioSession(raw: args.rawAudio ?? false)
      log("audio session ready: \(audioSessionSummary())")

      let session = AVCaptureSession()
      // Stored immediately so `teardown()` can stop it if a later step fails.
      self.session = session
      self.lastInterruption = nil
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

      // Attach the preview *before* the session starts. Attaching a preview
      // layer to a running session adds a connection, which reconfigures the
      // session; if that lands while the movie output is starting, the
      // recording stops at once with AVError -11818 "Recording Stopped".
      var previewConnection: AVCaptureConnection? = nil
      if videoDevice != nil {
        previewConnection = DispatchQueue.main.sync { () -> AVCaptureConnection? in
          self.installPreview(session: session)
          return self.previewView?.previewLayer.connection
        }
        log("preview attached (connection=\(previewConnection != nil))")
      }

      observe(session)
      let runStart = Date()
      session.startRunning()
      log(
        "session startRunning took \(Int(Date().timeIntervalSince(runStart) * 1000)) ms, "
          + "running=\(session.isRunning) interrupted=\(session.isInterrupted)")
      guard session.isRunning else {
        throw CaptureError.sessionNotRunning
      }

      // Give the capture graph a moment to come up: starting a file output
      // on inactive connections can fail or end immediately.
      let watched = output.connections + [previewConnection].compactMap { $0 }
      let settleDeadline = Date().addingTimeInterval(1.0)
      while Date() < settleDeadline && !watched.allSatisfy({ $0.isActive }) {
        Thread.sleep(forTimeInterval: 0.02)
      }
      // Let the first buffers flow before the file writer starts.
      Thread.sleep(forTimeInterval: 0.1)
      let allActive = watched.allSatisfy { $0.isActive }
      log("connections active=\(allActive) count=\(watched.count)")
      if session.isInterrupted {
        throw CaptureError.interrupted(lastInterruption ?? "the capture session was interrupted")
      }

      let url = URL(fileURLWithPath: args.outputPath)
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      if FileManager.default.fileExists(atPath: url.path) {
        try FileManager.default.removeItem(at: url)
      }

      self.hasVideo = videoDevice != nil
      self.startInvoke = invoke
      self.recordingStartedAt = nil

      setIdleTimerDisabled(true)
      armStartWatchdog(for: output)
      // Resolved from fileOutput(_:didStartRecordingTo:from:).
      output.startRecording(to: url, recordingDelegate: self)
      log("movie output asked to start recording")
    } catch {
      log("start failed: \(error.localizedDescription)")
      movieOutput = nil
      teardown()
      invoke.reject(
        "Could not start recording: \(error.localizedDescription)", code: "start_failed")
    }
  }

  /// If no data arrives, fail the start instead of leaving the UI waiting.
  private func armStartWatchdog(for output: AVCaptureMovieFileOutput) {
    startWatchdog?.cancel()
    let item = DispatchWorkItem { [weak self, weak output] in
      guard let self = self, let output = output, output === self.movieOutput,
        let invoke = self.startInvoke
      else { return }
      let reason = self.lastInterruption.map { " (\($0))" } ?? ""
      self.log("start timed out after \(Int(CapturePlugin.startTimeout)) s\(reason)")
      self.startInvoke = nil
      self.abandonCurrentRecording(reason: "start timed out")
      invoke.reject(
        "The camera or microphone did not start\(reason). Please try again.",
        code: "start_timeout")
    }
    startWatchdog = item
    sessionQueue.asyncAfter(deadline: .now() + CapturePlugin.startTimeout, execute: item)
  }

  /// Stop whatever is running without reporting a result; any late delegate
  /// callbacks from it are ignored. Runs on `sessionQueue`.
  private func abandonCurrentRecording(reason: String) {
    startWatchdog?.cancel()
    startWatchdog = nil
    if let start = startInvoke {
      startInvoke = nil
      start.reject("Recording was cancelled (\(reason)).", code: "cancelled")
    }
    if let stop = stopInvoke {
      stopInvoke = nil
      stop.reject("Recording was cancelled (\(reason)).", code: "cancelled")
    }
    let output = movieOutput
    movieOutput = nil
    if let output = output, output.isRecording {
      output.stopRecording()
    }
    teardown()
  }

  /// Cancel any recording or pending start and release the camera.
  @objc func resetCapture(_ invoke: Invoke) {
    sessionQueue.async {
      self.log("reset requested by the app")
      self.abandonCurrentRecording(reason: "reset by the app")
      invoke.resolve()
    }
  }

  @objc func stopRecording(_ invoke: Invoke) {
    sessionQueue.async {
      guard let output = self.movieOutput, output.isRecording else {
        self.log("stop requested but nothing is recording")
        invoke.reject("Not recording.", code: "not_recording")
        return
      }
      if self.stopInvoke != nil {
        invoke.reject("Already stopping.", code: "busy")
        return
      }
      self.log("stop requested")
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
      guard output === self.movieOutput else {
        self.log("ignoring start callback from an abandoned recording")
        return
      }
      self.startWatchdog?.cancel()
      self.startWatchdog = nil
      self.recordingStartedAt = Date()
      self.log("recording started")
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
      guard output === self.movieOutput else {
        self.log("ignoring finish callback from an abandoned recording")
        return
      }
      self.startWatchdog?.cancel()
      self.startWatchdog = nil
      var ok = true
      var message: String? = nil
      var errorCode = 0
      if let error = error as NSError? {
        // Interruptions (phone call, app backgrounded, disk full) still
        // produce a playable file when this flag is set.
        ok = (error.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) ?? false
        message = error.localizedDescription
        errorCode = error.code
        let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError
        let underlyingText = underlying.map { "\($0.domain) \($0.code)" } ?? "none"
        let details = error.userInfo
          .filter { $0.key != NSUnderlyingErrorKey && $0.key != NSLocalizedDescriptionKey }
          .map { "\($0.key)=\($0.value)" }
          .sorted()
          .joined(separator: "; ")
        self.log(
          "recording ended with \(error.domain) \(error.code) (\(error.localizedDescription)); "
            + "underlying=\(underlyingText) fileComplete=\(ok) info: \(details)")
        if let session = self.session {
          self.log("session running=\(session.isRunning) interrupted=\(session.isInterrupted)")
        }
      }
      let seconds = CMTimeGetSeconds(recorded)
      let userStopped = self.stopInvoke != nil
      let wallMs = self.recordingStartedAt.map { Date().timeIntervalSince($0) * 1000.0 } ?? 0
      self.log(
        "recording finished: \(String(format: "%.2f", seconds.isFinite ? seconds : 0)) s recorded, "
          + "userStopped=\(userStopped)")
      var result: JsonObject = [
        "path": outputFileURL.path,
        "durationMs": seconds.isFinite ? seconds * 1000.0 : 0.0,
        "wallMs": wallMs,
        "hasVideo": self.hasVideo,
        "ok": ok,
        "userStopped": userStopped,
        "errorCode": errorCode,
      ]
      if let size = self.videoSize {
        result["width"] = Int(size.width)
        result["height"] = Int(size.height)
      }
      if let reason = self.lastInterruption {
        result["interruption"] = reason
      }
      if let message = message {
        result["message"] = message
      }

      if let start = self.startInvoke {
        self.startInvoke = nil
        let reason = self.lastInterruption ?? message ?? "it ended before it started"
        start.reject("Recording could not start: \(reason).", code: "start_failed")
      }
      if let stop = self.stopInvoke {
        self.stopInvoke = nil
        stop.resolve(result)
      } else {
        // Finished without a stop request (interruption, backgrounding):
        // tell the UI so it can save (or retry) the sketch.
        result["type"] = "finished"
        self.events?.send(result)
      }
      self.movieOutput = nil
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
        let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int ?? -1
        let reason = CapturePlugin.describeInterruption(raw)
        self?.log("capture session interrupted: \(reason) (\(raw))")
        self?.sessionQueue.async {
          self?.lastInterruption = reason
          let payload: JsonObject = ["type": "interrupted", "reason": reason, "code": raw]
          self?.events?.send(payload)
        }
      })
    observers.append(
      center.addObserver(
        forName: .AVCaptureSessionInterruptionEnded, object: session, queue: nil
      ) { [weak self] _ in
        self?.log("capture session interruption ended")
      })
    observers.append(
      center.addObserver(
        forName: .AVCaptureSessionRuntimeError, object: session, queue: nil
      ) { [weak self] note in
        let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
        self?.log(
          "capture session runtime error \(error?.domain ?? "-") \(error?.code ?? 0): "
            + "\(error?.localizedDescription ?? "unknown")")
        self?.sessionQueue.async {
          let payload: JsonObject = [
            "type": "error",
            "message": error?.localizedDescription ?? "Capture session error",
          ]
          self?.events?.send(payload)
        }
      })
    observers.append(
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: AVAudioSession.sharedInstance(), queue: nil
      ) { [weak self] note in
        let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ?? 99
        let kind = type == 1 ? "began" : (type == 0 ? "ended" : String(type))
        self?.log("audio session interruption \(kind)")
      })
    observers.append(
      center.addObserver(
        forName: AVAudioSession.routeChangeNotification,
        object: AVAudioSession.sharedInstance(), queue: nil
      ) { [weak self] note in
        let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 99
        self?.log("audio route changed reason=\(reason)")
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
    startWatchdog?.cancel()
    startWatchdog = nil
    stopLevelMeter()
    removeObservers()
    if let session = session, session.isRunning {
      session.stopRunning()
    }
    session = nil
    events = nil
    recordingStartedAt = nil
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
    //
    // `.mixWithOthers` matters: WKWebView plays audio from a separate
    // process with its own audio session. A non-mixable recording session
    // and the web view's session interrupt each other, which ends the
    // recording the moment it starts.
    let mode: AVAudioSession.Mode = raw ? .measurement : .videoRecording
    try audio.setCategory(
      .playAndRecord, mode: mode,
      options: [.defaultToSpeaker, .allowBluetoothA2DP, .mixWithOthers])
    try audio.setActive(true)
  }

  // MARK: Preview (main thread)

  /// Main thread only. Puts the camera preview behind the (now transparent)
  /// web view and connects it to the session.
  private func installPreview(session: AVCaptureSession) {
    guard let webView = self.webView, let container = webView.superview else { return }
    if let old = previewView {
      old.previewLayer.session = nil
      old.removeFromSuperview()
    }
    let preview = PreviewView(frame: webView.frame)
    preview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    preview.backgroundColor = .black
    // Show the whole recorded frame so framing the keyboard is honest.
    preview.previewLayer.videoGravity = .resizeAspect
    preview.previewLayer.session = session
    // Set the orientation now, before the session runs, so the first layout
    // pass has nothing to change on the connection.
    if let connection = preview.previewLayer.connection, connection.isVideoOrientationSupported {
      connection.videoOrientation = CapturePlugin.videoOrientation(for: currentInterfaceOrientation())
    }
    container.insertSubview(preview, belowSubview: webView)
    previewView = preview

    if !(webView.backgroundColor == UIColor.clear) {
      savedBackground = webView.backgroundColor
    }
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
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

  /// Write the recording's audio track as AAC `.m4a` (for sharing the
  /// take's sound on its own). The original file is only read.
  @objc func exportAudio(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ExportAudioArgs.self)
    let output = URL(fileURLWithPath: args.outputPath)
    let asset = AVURLAsset(url: URL(fileURLWithPath: args.inputPath))
    guard
      let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A)
    else {
      invoke.reject("The audio of this recording cannot be exported.", code: "export_unavailable")
      return
    }
    if FileManager.default.fileExists(atPath: output.path) {
      try FileManager.default.removeItem(at: output)
    }
    exporter.outputURL = output
    exporter.outputFileType = .m4a
    log("exporting take audio")
    exporter.exportAsynchronously {
      if exporter.status == .completed {
        self.log("take audio exported")
        let payload: JsonObject = ["path": args.outputPath]
        invoke.resolve(payload)
      } else {
        let message = exporter.error?.localizedDescription ?? "export ended with status \(exporter.status.rawValue)"
        self.log("take audio export failed: \(message)")
        invoke.reject("Could not export the audio: \(message)", code: "export_failed")
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
