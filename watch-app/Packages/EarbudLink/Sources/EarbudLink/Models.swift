import Foundation

/// JSON coding used on the wire and in the inbox: ISO-8601 dates, sorted keys.
/// The Rust receiver (`src-tauri/src/watch_link/protocol.rs`) reads exactly this.
public enum EarbudJSON {
    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    public static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

/// How a recording travels from the Watch to the receiver.
public enum Transport: String, Codable, CaseIterable, Sendable {
    /// TCP over a Wi-Fi network both devices are on (or the iPhone's Personal Hotspot).
    case localNetwork
    /// Bluetooth LE, straight to an iPhone or iPad running Earbud. Needs no network.
    case bluetooth
    /// WatchConnectivity, to the Watch's own paired iPhone. Queued and retried by watchOS.
    case phoneSession

    public var label: String {
        switch self {
        case .localNetwork: return "Wi-Fi"
        case .bluetooth: return "Bluetooth"
        case .phoneSession: return "Paired iPhone"
        }
    }
}

/// One recording's metadata, as sent.
public struct TransferRecording: Codable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    /// When recording started.
    public var createdAt: Date
    /// Seconds.
    public var duration: Double
    public var fileExtension: String
    public var mimeType: String

    public init(id: UUID, name: String, createdAt: Date, duration: Double,
                fileExtension: String = "m4a", mimeType: String = "audio/mp4") {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.duration = duration
        self.fileExtension = fileExtension
        self.mimeType = mimeType
    }

    /// The id Earbud gives the sketch: the UUID's 32 hex digits, lower case. Also the stem of
    /// the inbox file names.
    public var sketchID: String {
        id.uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

/// The header of a recording message.
public struct RecordingTransfer: Codable, Sendable {
    public var recording: TransferRecording
    /// Size of the audio that follows.
    public var byteCount: Int
    /// The receiver's secret from pairing. Required on Wi-Fi and Bluetooth.
    public var pairingSecret: String?
    /// The Watch's name, shown as "received from …".
    public var senderName: String?

    public init(recording: TransferRecording, byteCount: Int,
                pairingSecret: String? = nil, senderName: String? = nil) {
        self.recording = recording
        self.byteCount = byteCount
        self.pairingSecret = pairingSecret
        self.senderName = senderName
    }
}

/// Sent by the Watch while pairing. `code` is the 5 digits the receiver shows.
public struct PairingRequest: Codable, Sendable {
    public var code: String
    public var deviceName: String

    public init(code: String, deviceName: String) {
        self.code = code
        self.deviceName = deviceName
    }
}

/// The receiver's answer to a correct code.
public struct PairingResponse: Codable, Sendable {
    /// The name the Watch shows as the destination.
    public var displayName: String
    /// Durable secret the Watch stamps on every transfer.
    public var token: String
    /// TCP port (0 over Bluetooth, where there is none).
    public var port: UInt16
    /// Stable id of the receiver, the same on every transport.
    public var deviceId: String

    public init(displayName: String, token: String, port: UInt16, deviceId: String) {
        self.displayName = displayName
        self.token = token
        self.port = port
        self.deviceId = deviceId
    }
}

/// Published by Earbud on an iPhone through the WatchConnectivity application context, so the
/// Watch knows whether its paired iPhone runs Earbud, and under which name and id.
public struct ReceiverAnnouncement: Codable, Hashable, Sendable {
    public var deviceId: String
    public var displayName: String

    public init(deviceId: String, displayName: String) {
        self.deviceId = deviceId
        self.displayName = displayName
    }

    public static let contextKey = "earbudReceiver"
}

/// A recording waiting in Earbud's inbox. Written as `<sketchID>.json` next to the audio file,
/// after the audio is complete; the app imports it as a sketch.
public struct InboxEntry: Codable, Sendable {
    public var id: UUID
    public var name: String
    public var createdAt: Date
    public var duration: Double
    public var fileName: String
    public var mimeType: String
    public var byteCount: Int
    /// `Transport.rawValue`
    public var receivedVia: String
    public var sender: String?
    public var receivedAt: Date?

    public init(id: UUID, name: String, createdAt: Date, duration: Double, fileName: String,
                mimeType: String, byteCount: Int, receivedVia: String, sender: String?,
                receivedAt: Date?) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.duration = duration
        self.fileName = fileName
        self.mimeType = mimeType
        self.byteCount = byteCount
        self.receivedVia = receivedVia
        self.sender = sender
        self.receivedAt = receivedAt
    }
}

/// The device a Watch sends to, as saved on the Watch after pairing.
public struct DeviceLink: Codable, Hashable, Sendable {
    /// The transport that answered the pairing code (tried first when sending).
    public var transport: Transport
    /// The receiver's name, shown on the Watch ("→ Studio iPhone").
    public var displayName: String
    /// The receiver's stable id.
    public var deviceId: String
    /// Wi-Fi address found during pairing.
    public var host: String?
    public var port: UInt16?
    /// Secret from pairing. `nil` for a link made only through the paired iPhone.
    public var pairingSecret: String?
    /// Core Bluetooth's identifier for the receiver, once it has answered over Bluetooth.
    public var bluetoothIdentifier: UUID?

    public init(transport: Transport, displayName: String, deviceId: String, host: String? = nil,
                port: UInt16? = nil, pairingSecret: String? = nil, bluetoothIdentifier: UUID? = nil) {
        self.transport = transport
        self.displayName = displayName
        self.deviceId = deviceId
        self.host = host
        self.port = port
        self.pairingSecret = pairingSecret
        self.bluetoothIdentifier = bluetoothIdentifier
    }
}

public enum LinkError: Error, LocalizedError, Equatable {
    /// Nothing answered.
    case notReachable
    /// watchOS kept the Wi-Fi connection waiting ("network is down"). watchOS only allows direct
    /// TCP connections in a few situations (Apple TN3135), so this can happen on a working network.
    case networkUnavailable
    /// Bluetooth is off or not allowed.
    case bluetoothUnavailable
    /// The receiver answered but refused (wrong code, or not paired any more).
    case rejected
    /// The link has no address/secret for this transport.
    case notConfigured
    case failed(String)

    public var errorDescription: String? {
        switch self {
        case .notReachable: return "The device didn't answer."
        case .networkUnavailable: return "No Wi-Fi connection to the device."
        case .bluetoothUnavailable: return "Bluetooth is off or not allowed."
        case .rejected: return "The device refused. Pair again."
        case .notConfigured: return "Not set up for this connection."
        case .failed(let message): return message
        }
    }
}
