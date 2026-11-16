import AVFoundation
import AudioToolbox
import CoreAudioKit
import CoreMIDI
import Tauri
import UIKit
import WebKit

struct MusicEvent: Decodable {
  let time: Double
  let bytes: [UInt8]
}
struct MusicPlayArgs: Decodable { let events: [MusicEvent]; let destinationId: String? }
struct MusicIdArgs: Decodable { let id: String }
struct MusicPresetArgs: Decodable { let number: Int }
struct MusicParameterArgs: Decodable { let address: String; let value: Float }
struct MusicRenderArgs: Decodable { let events: [MusicEvent]; let tail: Double }

/// All host and MIDI state is confined to this serial queue. No JS timers
/// drive musical events. Foreground-only by design; backgrounding panics.
final class MusicPlugin: Plugin {
  private let queue = DispatchQueue(label: "earbud.music", qos: .userInitiated)
  private var client = MIDIClientRef()
  private var port = MIDIPortRef()
  private var virtualSource = MIDIEndpointRef()
  private var destination: MIDIEndpointRef = 0
  private var components: [String: AVAudioUnitComponent] = [:]
  private var unit: AVAudioUnit?
  private var engine: AVAudioEngine?
  private var observerTokens: [NSObjectProtocol] = []
  private var playing = false
  private var externalPlayback = false
  private var captureActive = false
  private var transportError: String?
  private var playbackTimer: DispatchSourceTimer?
  private var eventIndex = 0
  private var sequence: [MusicEvent] = []
  private var startHost: UInt64 = 0
  private var generation = 0
  private var rendering = false
  private let renderLock = NSLock()
  private var renderCancelled = false
  private var renderState: JsonObject = ["state":"idle", "fraction":0.0]
  private let inboxService = MusicInbox()

  public override func load(webview: WKWebView) {
    super.load(webview: webview)
    // Do not change the capture plugin's category/mode/options. Acquire only
    // activation. Capture explicitly stops this host through notifications.
    for name in [UIApplication.willResignActiveNotification, AVAudioSession.interruptionNotification,
                 AVAudioSession.routeChangeNotification, Notification.Name("EarbudCaptureWillStart")] {
      observerTokens.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
        guard let owner = self else { return }
        owner.cancelFlag()
        let stop = {
          if name == Notification.Name("EarbudCaptureWillStart") { owner.captureActive = true }
          owner.stopTransport(); owner.engine?.stop()
        }
        // Capture cannot change the shared session until host rendering has
        // observed cancellation and released the graph.
        if name == Notification.Name("EarbudCaptureWillStart") { owner.queue.sync(execute:stop) }
        else { owner.queue.async(execute:stop) }
      })
    }
    observerTokens.append(NotificationCenter.default.addObserver(forName:Notification.Name("EarbudCaptureDidStop"),object:nil,queue:nil) { [weak self] _ in
      self?.queue.async { self?.captureActive = false }
    })
    queue.async { [weak self] in self?.setupMIDI() }
  }
  deinit {
    observerTokens.forEach(NotificationCenter.default.removeObserver)
    playbackTimer?.cancel()
    if port != 0 { MIDIPortDispose(port) }
    if virtualSource != 0 { MIDIEndpointDispose(virtualSource) }
    if client != 0 { MIDIClientDispose(client) }
  }
  private func setupMIDI() {
    MIDIClientCreateWithBlock("Earbud" as CFString, &client) { [weak self] _ in
      self?.queue.async {
        guard let self = self else { return }
        if self.destination != 0 && !self.destinationEndpoints().contains(self.destination) {
          self.stopTransport(); self.transportError = "The MIDI destination disconnected."
        }
      }
    }
    MIDIOutputPortCreate(client, "Earbud Out" as CFString, &port)
    MIDISourceCreate(client, "Earbud MIDI Out" as CFString, &virtualSource)
  }
  private func destinationEndpoints() -> [MIDIEndpointRef] {
    (0..<MIDIGetNumberOfDestinations()).map { MIDIGetDestination($0) }.filter { $0 != 0 }
  }
  private func midiString(_ object: MIDIObjectRef, _ property: CFString) -> String {
    var value: Unmanaged<CFString>?
    guard MIDIObjectGetStringProperty(object, property, &value) == noErr else { return "" }
    return value?.takeRetainedValue() as String? ?? ""
  }
  private func endpointID(_ endpoint: MIDIEndpointRef) -> String {
    var id: Int32 = 0
    MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &id)
    return String(id)
  }
  private func destinationKind(_ endpoint: MIDIEndpointRef) -> String {
    // Core MIDI has no public kMIDIPropertyTransport. Virtual endpoints have
    // no entity; device-backed endpoints can report a model without guessing
    // USB/Bluetooth from an application or driver name.
    var entity = MIDIEntityRef()
    guard MIDIEndpointGetEntity(endpoint, &entity) == noErr, entity != 0 else { return "Virtual/app" }
    var device = MIDIDeviceRef()
    guard MIDIEntityGetDevice(entity, &device) == noErr, device != 0 else { return "MIDI device" }
    let model = midiString(device, kMIDIPropertyModel)
    return model.isEmpty ? "MIDI device" : model
  }
  @objc func destinations(_ invoke: Invoke) {
    queue.async {
      var list: [JsonObject] = self.destinationEndpoints().map {
        let transport = self.destinationKind($0)
        return ["id":self.endpointID($0),"name":self.midiString($0,kMIDIPropertyDisplayName),"transport":transport]
      }
      if self.virtualSource != 0 { list.append(["id":"earbud-source","name":"Earbud MIDI Out (virtual source)","transport":"Subscribe in receiving app"]) }
      invoke.resolve(["items":list])
    }
  }
  @objc func instruments(_ invoke: Invoke) {
    queue.async {
      let desc = AudioComponentDescription(componentType:kAudioUnitType_MusicDevice,componentSubType:0,componentManufacturer:0,componentFlags:0,componentFlagsMask:0)
      self.components.removeAll()
      let list: [JsonObject] = AVAudioUnitComponentManager.shared().components(matching:desc).filter { AudioComponentFlags(rawValue: $0.audioComponentDescription.componentFlags).contains(.isV3AudioUnit) }.map {
        let d = $0.audioComponentDescription
        let id = "\(d.componentType):\(d.componentSubType):\(d.componentManufacturer)"
        self.components[id] = $0
        return ["id":id,"name":$0.name,"manufacturer":$0.manufacturerName]
      }
      invoke.resolve(["items":list])
    }
  }
  @objc func selectInstrument(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicIdArgs.self)
    queue.async {
      guard !self.rendering else { invoke.reject("Wait for rendering to finish."); return }
      self.stopTransport(); self.engine?.stop(); self.unit = nil; self.engine = nil
      guard let component = self.components[args.id] else { invoke.reject("Refresh the instrument list; this instrument is unavailable."); return }
      self.generation += 1
      let requestGeneration = self.generation
      var resolved = false
      self.queue.asyncAfter(deadline: .now() + 30) {
        if !resolved { resolved = true; self.generation += 1; invoke.reject("The instrument took too long to initialize.") }
      }
      AVAudioUnit.instantiate(with:component.audioComponentDescription, options:.loadOutOfProcess) { unit, error in
        self.queue.async {
          guard !resolved, requestGeneration == self.generation else { return }
          resolved = true
          guard let unit = unit, error == nil, unit.auAudioUnit.scheduleMIDIEventBlock != nil,
                unit.auAudioUnit.outputBusses.count > 0 else { invoke.reject(error?.localizedDescription ?? "This instrument has no compatible MIDI/audio output."); return }
          let engine = AVAudioEngine()
          engine.attach(unit)
          engine.connect(unit, to:engine.mainMixerNode, format:nil)
          self.unit = unit; self.engine = engine
          let presets: [JsonObject] = (unit.auAudioUnit.factoryPresets ?? []).map { ["number":$0.number,"name":$0.name] }
          let parameters: [JsonObject] = (unit.auAudioUnit.parameterTree?.allParameters ?? []).prefix(128).map {
            ["address":String($0.address),"name":$0.displayName,"min":$0.minValue,"max":$0.maxValue,"value":$0.value]
          }
          invoke.resolve(["presets":presets,"parameters":parameters])
        }
      }
    }
  }
  @objc func setPreset(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicPresetArgs.self)
    queue.async {
      guard !self.rendering, let unit = self.unit,
            let preset = unit.auAudioUnit.factoryPresets?.first(where:{$0.number == args.number}) else { invoke.reject("Preset unavailable."); return }
      unit.auAudioUnit.currentPreset = preset; invoke.resolve()
    }
  }
  @objc func setParameter(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicParameterArgs.self)
    queue.async {
      guard !self.rendering, let address = UInt64(args.address), let parameter = self.unit?.auAudioUnit.parameterTree?.parameter(withAddress:address), args.value.isFinite else { invoke.reject("Parameter unavailable."); return }
      parameter.value = min(parameter.maxValue,max(parameter.minValue,args.value)); invoke.resolve()
    }
  }
  @objc func showInterface(_ invoke: Invoke) {
    queue.async {
      guard !self.rendering, let unit = self.unit else { invoke.reject("Select an instrument first."); return }
      unit.auAudioUnit.requestViewController { controller in
        DispatchQueue.main.async {
          guard let controller = controller, let parent = self.manager.viewController else { invoke.reject("No custom interface; use parameters and presets."); return }
          let wrapper = UINavigationController(rootViewController:controller)
          controller.navigationItem.rightBarButtonItem = UIBarButtonItem(title:"Done",style:.done,target:self,action:#selector(self.dismissInstrument))
          parent.present(wrapper,animated:true); invoke.resolve()
        }
      }
    }
  }
  @objc private func dismissInstrument() { manager.viewController?.presentedViewController?.dismiss(animated:true) }
  private func validated(_ events: [MusicEvent]) throws -> [MusicEvent] {
    guard !events.isEmpty, events.count <= 100000 else { throw MusicFailure.message("No MIDI events, or too many events.") }
    guard events.allSatisfy({ e in
      let status = e.bytes.first ?? 0
      let kind = status & 0xf0
      if status == 0xf0 {
        return e.time.isFinite && e.time >= 0 && e.time <= 3600 && e.bytes.count <= 65535 && e.bytes.last == 0xf7 && e.bytes.dropFirst().dropLast().allSatisfy { $0 < 128 }
      }
      return e.time.isFinite && e.time >= 0 && e.time <= 3600 && status >= 0x80 && status < 0xf0 &&
        e.bytes.count == ((kind == 0xc0 || kind == 0xd0) ? 2 : 3) && e.bytes.dropFirst().allSatisfy { $0 < 128 }
    }) else { throw MusicFailure.message("Invalid MIDI event.") }
    return events.enumerated().sorted {
      if $0.element.time != $1.element.time { return $0.element.time < $1.element.time }
      let left = $0.element.bytes[0] & 0xf0 == 0x80 ? 0 : ($0.element.bytes[0] & 0xf0 == 0x90 ? 2 : 1)
      let right = $1.element.bytes[0] & 0xf0 == 0x80 ? 0 : ($1.element.bytes[0] & 0xf0 == 0x90 ? 2 : 1)
      return left != right ? left < right : $0.offset < $1.offset
    }.map { $0.element }
  }
  /// Core MIDI timestamps are mach host time. Schedule only 20 ms ahead so
  /// stop can flush pending output and release every channel immediately.
  private func send(_ bytes: [UInt8], at timestamp: UInt64) {
    let capacity = max(256, bytes.count + 128)
    let raw = UnsafeMutableRawPointer.allocate(byteCount:capacity,alignment:MemoryLayout<MIDIPacketList>.alignment)
    defer { raw.deallocate() }
    let list = raw.bindMemory(to:MIDIPacketList.self,capacity:1)
    let packet = MIDIPacketListInit(list)
    bytes.withUnsafeBufferPointer { buffer in
      _ = MIDIPacketListAdd(list,capacity,packet,timestamp,bytes.count,buffer.baseAddress!)
    }
    if destination != 0 { MIDISend(port,destination,list) }
    else if virtualSource != 0 { MIDIReceived(virtualSource,list) }
  }
  private func auSend(_ event: MusicEvent, sample: AUEventSampleTime) {
    guard let schedule = unit?.auAudioUnit.scheduleMIDIEventBlock else { return }
    event.bytes.withUnsafeBufferPointer { schedule(sample,0,event.bytes.count,$0.baseAddress!) }
  }
  private func stopTransport() {
    inboxService.stopPreview()
    playbackTimer?.cancel(); playbackTimer = nil; playing = false
    if destination != 0 { MIDIFlushOutput(destination) }
    // Sustain off, all sound off, all notes off, on all channels.
    for ch in 0..<16 { for cc in [64,120,123] {
      let bytes: [UInt8] = [0xb0 | UInt8(ch),UInt8(cc),0]
      if externalPlayback {
        send(bytes,at:0)
        // Subscribers may already have up to 20 ms of virtual-source events.
        if destination == 0 { send(bytes,at:mach_absolute_time() + AVAudioTime.hostTime(forSeconds:0.03)) }
      }
      auSend(MusicEvent(time:0,bytes:bytes),sample:AUEventSampleTimeImmediate)
    } }
    engine?.stop()
    unit?.auAudioUnit.reset()
  }
  @objc func play(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicPlayArgs.self)
    queue.async {
      do {
        guard !self.rendering, !self.captureActive else { throw MusicFailure.message("Stop recording or rendering before playing an instrument.") }
        self.stopTransport(); self.transportError = nil
        self.externalPlayback = args.destinationId != nil
        self.sequence = try self.validated(args.events); self.eventIndex = 0
        if let id = args.destinationId {
          self.engine?.stop()
          if id == "earbud-source" { self.destination = 0 }
          else {
            guard let endpoint = self.destinationEndpoints().first(where:{self.endpointID($0) == id}) else { throw MusicFailure.message("The MIDI destination disconnected.") }
            self.destination = endpoint
          }
        } else {
          self.destination = 0
          guard let engine = self.engine, self.unit != nil else { throw MusicFailure.message("Select an instrument first.") }
          try AVAudioSession.sharedInstance().setActive(true)
          try engine.start()
        }
        self.startHost = mach_absolute_time() + AVAudioTime.hostTime(forSeconds:0.1)
        self.playing = true
        let timer = DispatchSource.makeTimerSource(queue:self.queue)
        timer.schedule(deadline:.now(),repeating:.milliseconds(5))
        timer.setEventHandler { [weak owner = self] in owner?.pump(external:args.destinationId != nil) }
        self.playbackTimer = timer; timer.resume(); invoke.resolve()
      } catch { self.stopTransport(); invoke.reject(error.localizedDescription) }
    }
  }
  private func pump(external: Bool) {
    let now = mach_absolute_time()
    let elapsed = now >= startHost ? AVAudioTime.seconds(forHostTime:now-startHost) : -AVAudioTime.seconds(forHostTime:startHost-now)
    while eventIndex < sequence.count && sequence[eventIndex].time <= elapsed + 0.02 {
      let event = sequence[eventIndex]
      if external { send(event.bytes,at:startHost + AVAudioTime.hostTime(forSeconds:event.time)) }
      else {
        // Convert host deadline into the engine's sample clock. Events are
        // queued by native lookahead, never by a JavaScript timer.
        if let nodeTime = unit?.lastRenderTime, let engine = engine,
           let player = engine.outputNode.lastRenderTime, player.isSampleTimeValid {
          let delta = AVAudioTime.seconds(forHostTime:startHost + AVAudioTime.hostTime(forSeconds:event.time)) - AVAudioTime.seconds(forHostTime:nodeTime.hostTime)
          auSend(event,sample:nodeTime.sampleTime + Int64(delta * nodeTime.sampleRate))
        }
      }
      eventIndex += 1
    }
    if eventIndex == sequence.count && elapsed > (sequence.last?.time ?? 0) + 0.1 { stopTransport() }
  }
  @objc func stop(_ invoke: Invoke) { queue.async { self.stopTransport(); invoke.resolve() } }
  @objc func transportStatus(_ invoke: Invoke) { queue.async { invoke.resolve(["playing":self.playing,"error":self.transportError as Any? ?? NSNull()]) } }
  private func cancelFlag() { renderLock.lock(); renderCancelled = true; renderLock.unlock() }
  private func cancelled() -> Bool { renderLock.lock(); defer { renderLock.unlock() }; return renderCancelled }
  @objc func cancelRender(_ invoke: Invoke) { cancelFlag(); invoke.resolve() }
  @objc func renderProgress(_ invoke: Invoke) { renderLock.lock(); let state = renderState; renderLock.unlock(); invoke.resolve(state) }
  private func progress(_ value: JsonObject) { renderLock.lock(); renderState = value; renderLock.unlock() }
  @objc func render(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicRenderArgs.self)
    queue.async {
      var acknowledged = false
      guard !self.rendering, !self.captureActive, let engine = self.engine, let unit = self.unit else { invoke.reject("Select an instrument first; only one render can run."); return }
      do {
        let events = try self.validated(args.events)
        guard args.tail.isFinite && args.tail >= 0 && args.tail <= 30 else { throw MusicFailure.message("Tail must be between 0 and 30 seconds.") }
        self.stopTransport(); engine.stop()
        self.rendering = true
        self.renderLock.lock(); self.renderCancelled = false; self.renderLock.unlock()
        self.progress(["state":"rendering","fraction":0.0])
        invoke.resolve(); acknowledged = true
        defer { self.rendering = false; engine.stop(); engine.disableManualRenderingMode(); self.stopTransport() }
        let url = try self.inboxService.newRenderURL()
        var committed = false
        defer { if !committed { try? FileManager.default.removeItem(at:url.deletingLastPathComponent()) } }
        do {
          try self.offlineRender(engine:engine,unit:unit,events:events,tail:args.tail,url:url)
        } catch {
          try? FileManager.default.removeItem(at:url)
          if self.cancelled() { throw error }
          // Some AUv3s reject manual rendering. Capture their actual mixer
          // output in real time; never replace the selected instrument.
          engine.stop(); engine.disableManualRenderingMode(); unit.auAudioUnit.reset()
          try self.realtimeRender(engine:engine,events:events,tail:args.tail,url:url)
        }
        let audio = try self.inboxService.commitRender(url)
        committed = true
        self.progress(["state":"complete","fraction":1.0,"audio":audio])
      } catch {
        if !acknowledged { invoke.reject(error.localizedDescription) }
        self.progress(["state":self.cancelled() ? "cancelled" : "failed","fraction":0.0,"error":error.localizedDescription])
      }
    }
  }
  private func offlineRender(engine: AVAudioEngine, unit: AVAudioUnit, events: [MusicEvent], tail: Double, url: URL) throws {
    let format = AVAudioFormat(standardFormatWithSampleRate:44100,channels:2)!
    try engine.enableManualRenderingMode(.offline,format:format,maximumFrameCount:1024)
    try engine.start()
    let file = try AVAudioFile(forWriting:url,settings:format.settings)
    let buffer = AVAudioPCMBuffer(pcmFormat:engine.manualRenderingFormat,frameCapacity:1024)!
    let total = Int64(ceil(((events.last?.time ?? 0) + tail) * format.sampleRate))
    var index = 0, stalls = 0
    while engine.manualRenderingSampleTime < total {
      if cancelled() { throw MusicFailure.message("Rendering cancelled.") }
      let at = engine.manualRenderingSampleTime
      let count = AVAudioFrameCount(min(1024,total-at))
      while index < events.count && Int64((events[index].time * format.sampleRate).rounded()) < at + Int64(count) {
        auSend(events[index],sample:Int64((events[index].time * format.sampleRate).rounded())); index += 1
      }
      switch try engine.renderOffline(count,to:buffer) {
      case .success: try file.write(from:buffer); stalls = 0
      case .cannotDoInCurrentContext, .insufficientDataFromInputNode:
        stalls += 1; if stalls > 100 { throw MusicFailure.message("Instrument does not support offline rendering.") }
      case .error: throw MusicFailure.message("Instrument rendering failed.")
      @unknown default: throw MusicFailure.message("Unsupported rendering status.")
      }
      progress(["state":"rendering","fraction":Double(engine.manualRenderingSampleTime)/Double(max(1,total))])
    }
    guard file.length >= total else { throw MusicFailure.message("The instrument produced only a partial file.") }
  }
  private func realtimeRender(engine: AVAudioEngine, events: [MusicEvent], tail: Double, url: URL) throws {
    try AVAudioSession.sharedInstance().setActive(true)
    let mixer = engine.mainMixerNode
    let format = mixer.outputFormat(forBus:0)
    let file = try AVAudioFile(forWriting:url,settings:format.settings)
    let lock = NSLock()
    let total = (events.last?.time ?? 0) + tail
    let start = mach_absolute_time() + AVAudioTime.hostTime(forSeconds:0.1)
    var writeError: Error?
    mixer.installTap(onBus:0,bufferSize:1024,format:format) { buffer, time in
      lock.lock(); defer { lock.unlock() }
      do {
        let seconds = AVAudioTime.seconds(forHostTime:time.hostTime) - AVAudioTime.seconds(forHostTime:start)
        let first = max(0, Int(ceil(-seconds * format.sampleRate)))
        let last = min(Int(buffer.frameLength), Int(ceil((total-seconds) * format.sampleRate)))
        guard last > first, let input = buffer.floatChannelData,
              let trimmed = AVAudioPCMBuffer(pcmFormat:format,frameCapacity:AVAudioFrameCount(last-first)),
              let output = trimmed.floatChannelData else { return }
        trimmed.frameLength = AVAudioFrameCount(last-first)
        for channel in 0..<Int(format.channelCount) {
          memcpy(output[channel], input[channel].advanced(by:first), (last-first)*MemoryLayout<Float>.size)
        }
        try file.write(from:trimmed)
      } catch { writeError = error }
    }
    defer { engine.stop(); mixer.removeTap(onBus:0) }
    try engine.start()
    var index = 0
    while true {
      if cancelled() { throw MusicFailure.message("Rendering cancelled.") }
      let now = mach_absolute_time()
      let elapsed = now >= start ? AVAudioTime.seconds(forHostTime:now-start) : -0.1
      if elapsed >= total + 0.1 { break }
      while index < events.count && events[index].time <= elapsed + 0.02 {
        if let time = unit?.lastRenderTime, time.isSampleTimeValid {
          let deadline = start + AVAudioTime.hostTime(forSeconds:events[index].time)
          let seconds = AVAudioTime.seconds(forHostTime:deadline) - AVAudioTime.seconds(forHostTime:time.hostTime)
          auSend(events[index],sample:time.sampleTime + Int64(seconds * time.sampleRate))
        }
        index += 1
      }
      lock.lock(); let failure = writeError; lock.unlock()
      if let failure = failure { throw failure }
      progress(["state":"rendering","fraction":max(0,elapsed/total)])
      Thread.sleep(forTimeInterval:0.005)
    }
    guard Double(file.length)/format.sampleRate >= total - 0.001 else { throw MusicFailure.message("Real-time render was interrupted.") }
  }
  @objc func inbox(_ invoke: Invoke) { queue.async { do { invoke.resolve(["items":try self.inboxService.list()]) } catch { invoke.reject(error.localizedDescription) } } }
  @objc func copyIncoming(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicCopyArgs.self)
    queue.async { do { invoke.resolve(try self.inboxService.copy(args)) } catch { invoke.reject(error.localizedDescription) } }
  }
  @objc func acknowledge(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicIdArgs.self)
    queue.async { do { try self.inboxService.acknowledge(args.id); invoke.resolve() } catch { invoke.reject(error.localizedDescription) } }
  }
  @objc func previewIncoming(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(MusicIdArgs.self)
    queue.async { do { self.stopTransport(); try self.inboxService.preview(args.id); invoke.resolve() } catch { invoke.reject(error.localizedDescription) } }
  }
  @objc func stopPreview(_ invoke: Invoke) { queue.async { self.inboxService.stopPreview(); invoke.resolve() } }
  @objc func close(_ invoke: Invoke) { cancelFlag(); queue.async { self.stopTransport(); self.engine?.stop(); self.engine = nil; self.unit = nil; self.generation += 1; invoke.resolve() } }
}
enum MusicFailure: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
@_cdecl("init_plugin_music")
public func initMusicPlugin() -> Plugin { MusicPlugin() }
