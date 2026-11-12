// Earbud watch link, iOS half: receives recordings from the Apple Watch app over
// Bluetooth LE and WatchConnectivity and writes them into the library inbox.
// The app (Rust, `src-tauri/src/watch_link`) imports inbox entries as sketches and
// runs the local-network receiver itself.
//
// Commands (JS `plugin:watch-link|…`):
//   start({ inboxDir, displayName, deviceId, secret, bluetooth, events })
//   stop()                      Bluetooth off (WatchConnectivity stays on)
//   begin_pairing({ code, durationMs }) / end_pairing()
//   status()
// Events on the `events` channel:
//   { kind: "received", via, name, sender }
//   { kind: "paired", watchName, via: "bluetooth" }
//   { kind: "bluetooth", state }
//   { kind: "log", message }

import EarbudLink
import Tauri
import UIKit
import WebKit

struct StartArgs: Decodable {
  let inboxDir: String
  let displayName: String
  let deviceId: String
  let secret: String
  /// Advertise over Bluetooth (asks for Bluetooth permission the first time).
  let bluetooth: Bool
  let events: Channel?
}

struct PairingArgs: Decodable {
  let code: String
  let durationMs: Double
}

class WatchLinkPlugin: Plugin {
  private let lock = NSLock()
  // Guarded by `lock`.
  private var events: Channel?
  private var inbox: URL = WatchLinkPlugin.initialInbox()
  private var bluetooth: BluetoothReceiver?
  private var bluetoothConfiguration: BluetoothReceiver.Configuration?
  private var bluetoothState = "off"

  private static let inboxKey = "earbud.watchLink.inboxDir"
  private static let announcementKey = "earbud.watchLink.announcement"

  /// Before the app has told us where its library is (files that WatchConnectivity delivers at
  /// launch), use the last known inbox, or where Tauri puts app data on iOS:
  /// Application Support/<bundle id>/library/inbox.
  private static func initialInbox() -> URL {
    if let saved = UserDefaults.standard.string(forKey: inboxKey) {
      return URL(fileURLWithPath: saved, isDirectory: true)
    }
    return defaultInbox()
  }

  private static func defaultInbox() -> URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support
      .appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.earbud.sketchbook", isDirectory: true)
      .appendingPathComponent("library", isDirectory: true)
      .appendingPathComponent(EarbudLinkDefaults.inboxFolder, isDirectory: true)
  }

  public override func load(webview: WKWebView) {
    LinkLog.handler = { [weak self] message in self?.emit(["kind": "log", "message": message]) }

    // WatchConnectivity starts at launch, whether or not receiving over Bluetooth/Wi-Fi is on:
    // it only ever carries files from this iPhone's own paired Watch.
    let phone = PhoneSessionLink.shared
    phone.inbox = { [weak self] in self?.currentInbox() ?? Self.defaultInbox() }
    phone.onReceive = { [weak self] entry in
      self?.emit([
        "kind": "received", "via": entry.receivedVia, "name": entry.name, "sender": entry.sender ?? "",
      ])
    }
    if let data = UserDefaults.standard.data(forKey: Self.announcementKey),
       let announcement = try? JSONDecoder().decode(ReceiverAnnouncement.self, from: data) {
      phone.announce(announcement)
    }
    phone.activate()
  }

  private func currentInbox() -> URL {
    lock.lock()
    defer { lock.unlock() }
    return inbox
  }

  private func emit(_ payload: JsonObject) {
    lock.lock()
    let channel = events
    lock.unlock()
    channel?.send(payload)
  }

  // MARK: Commands

  @objc func start(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(StartArgs.self)
    let newInbox = URL(fileURLWithPath: args.inboxDir, isDirectory: true)
    let configuration = BluetoothReceiver.Configuration(
      displayName: args.displayName, deviceId: args.deviceId, secret: args.secret, inbox: newInbox)

    lock.lock()
    let oldInbox = inbox
    inbox = newInbox
    if let channel = args.events { events = channel }
    lock.unlock()
    UserDefaults.standard.set(newInbox.path, forKey: Self.inboxKey)
    if oldInbox.standardizedFileURL != newInbox.standardizedFileURL {
      Self.moveEntries(from: oldInbox, to: newInbox)
    }

    // Tell the paired Watch which device this is.
    let announcement = ReceiverAnnouncement(deviceId: args.deviceId, displayName: args.displayName)
    if let data = try? JSONEncoder().encode(announcement) {
      UserDefaults.standard.set(data, forKey: Self.announcementKey)
    }
    PhoneSessionLink.shared.announce(announcement)

    if args.bluetooth {
      startBluetooth(configuration)
    } else {
      stopBluetooth()
    }
    invoke.resolve(statusPayload())
  }

  @objc func stop(_ invoke: Invoke) {
    stopBluetooth()
    invoke.resolve(statusPayload())
  }

  @objc func beginPairing(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PairingArgs.self)
    lock.lock()
    let receiver = bluetooth
    lock.unlock()
    receiver?.beginPairing(code: args.code, duration: args.durationMs / 1000)
    invoke.resolve(statusPayload())
  }

  @objc func endPairing(_ invoke: Invoke) {
    lock.lock()
    let receiver = bluetooth
    lock.unlock()
    receiver?.endPairing()
    invoke.resolve(statusPayload())
  }

  @objc func status(_ invoke: Invoke) {
    invoke.resolve(statusPayload())
  }

  // MARK: Bluetooth

  private func startBluetooth(_ configuration: BluetoothReceiver.Configuration) {
    lock.lock()
    if let existing = bluetooth {
      if bluetoothConfiguration != configuration {
        existing.update(configuration)
        bluetoothConfiguration = configuration
      }
      lock.unlock()
      return
    }
    let receiver = BluetoothReceiver(configuration: configuration)
    bluetooth = receiver
    bluetoothConfiguration = configuration
    bluetoothState = "starting"
    lock.unlock()

    receiver.onReceive = { [weak self] entry in
      self?.emit([
        "kind": "received", "via": entry.receivedVia, "name": entry.name, "sender": entry.sender ?? "",
      ])
    }
    receiver.onPaired = { [weak self] name in
      self?.emit(["kind": "paired", "watchName": name, "via": Transport.bluetooth.rawValue])
    }
    receiver.onStateChange = { [weak self] state in
      guard let self else { return }
      self.lock.lock()
      self.bluetoothState = state
      self.lock.unlock()
      self.emit(["kind": "bluetooth", "state": state])
    }
    receiver.start()
  }

  private func stopBluetooth() {
    lock.lock()
    let receiver = bluetooth
    bluetooth = nil
    bluetoothConfiguration = nil
    bluetoothState = "off"
    lock.unlock()
    receiver?.stop()
  }

  private func statusPayload() -> JsonObject {
    let phone = PhoneSessionLink.shared
    lock.lock()
    let state = bluetoothState
    let inboxPath = inbox.path
    lock.unlock()
    return [
      "bluetooth": state,
      "phoneSessionSupported": phone.isSupported,
      "phoneSessionActivated": phone.isActivated,
      "watchPaired": phone.isPaired,
      "watchAppInstalled": phone.isWatchAppInstalled,
      "deviceModel": UIDevice.current.model,
      "inboxDir": inboxPath,
      "pendingInInbox": InboxWriter.pendingCount(in: URL(fileURLWithPath: inboxPath)),
    ]
  }

  /// Move entries received before the app reported its real inbox.
  private static func moveEntries(from old: URL, to new: URL) {
    let fileManager = FileManager.default
    guard let names = try? fileManager.contentsOfDirectory(atPath: old.path), !names.isEmpty else { return }
    try? fileManager.createDirectory(at: new, withIntermediateDirectories: true)
    // Audio first, sidecars last, so the importer never sees a sidecar without its audio.
    let ordered = names.filter { !$0.hasPrefix(".") && !$0.hasSuffix(".json") }
      + names.filter { !$0.hasPrefix(".") && $0.hasSuffix(".json") }
    for name in ordered {
      let target = new.appendingPathComponent(name)
      if fileManager.fileExists(atPath: target.path) { continue }
      try? fileManager.moveItem(at: old.appendingPathComponent(name), to: target)
    }
  }
}

@_cdecl("init_plugin_watch_link")
public func initWatchLinkPlugin() -> Plugin {
  return WatchLinkPlugin()
}
