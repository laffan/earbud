import Foundation

/// Fixed values both sides agree on. They differ from Woods Whisper's (port 50710 and its
/// Bluetooth UUIDs), so the two apps never answer each other.
public enum EarbudLinkDefaults {
    /// TCP port of the receiver. Fixed, because the Watch cannot browse Bonjour and finds the
    /// receiver by trying this port on every host of its subnet during pairing.
    public static let port: UInt16 = 50720
    /// How long a pairing code shown on the receiver is accepted.
    public static let pairingWindow: TimeInterval = 120
    /// Name of the inbox folder inside Earbud's library.
    public static let inboxFolder = "inbox"
}

/// First byte of every message. Watch→receiver use the low values; Bluetooth replies use the
/// high ones.
public enum MessageType {
    /// TCP: `[0x01][u32 headerLen][RecordingTransfer JSON][audio]` → `[ack]`.
    /// Bluetooth body: `[u32 headerLen][RecordingTransfer JSON][audio]`.
    public static let recording: UInt8 = 0x01
    /// TCP: `[0x02][u32 len][PairingRequest JSON]` → `[ack][u32 len][PairingResponse JSON]`.
    /// Bluetooth body: `PairingRequest` JSON.
    public static let pairing: UInt8 = 0x02
    /// Bluetooth only. Body: one byte, 1 accepted, 0 rejected.
    public static let ack: UInt8 = 0x11
    /// Bluetooth only. Body: `PairingResponse` JSON.
    public static let pairingResponse: UInt8 = 0x12
}

/// Byte-level framing, kept free of networking so it can be unit tested.
public enum Wire {
    public static func bigEndian(_ value: UInt32) -> Data {
        Data([UInt8((value >> 24) & 0xFF), UInt8((value >> 16) & 0xFF),
              UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF)])
    }

    /// The first four bytes of `data` as a big-endian integer (0 if shorter).
    public static func readBigEndian(_ data: Data) -> UInt32 {
        let bytes = [UInt8](data.prefix(4))
        guard bytes.count == 4 else { return 0 }
        return (UInt32(bytes[0]) << 24) | (UInt32(bytes[1]) << 16)
            | (UInt32(bytes[2]) << 8) | UInt32(bytes[3])
    }

    /// `[u32 BE length][payload]`
    public static func lengthPrefixed(_ payload: Data) -> Data {
        var out = bigEndian(UInt32(payload.count))
        out.append(payload)
        return out
    }

    /// TCP recording message without the audio, which the caller appends (or streams).
    public static func tcpRecordingHead(header: Data) -> Data {
        var out = Data([MessageType.recording])
        out.append(lengthPrefixed(header))
        return out
    }

    /// TCP pairing message.
    public static func tcpPairing(request: Data) -> Data {
        var out = Data([MessageType.pairing])
        out.append(lengthPrefixed(request))
        return out
    }

    /// Bluetooth envelope: `[type][u32 BE length][body]`, chunked over the GATT characteristics.
    public static func envelope(type: UInt8, body: Data) -> Data {
        var out = Data([type])
        out.append(lengthPrefixed(body))
        return out
    }

    /// Bluetooth recording body: `[u32 BE headerLen][header][audio]`.
    public static func recordingBody(header: Data, audio: Data) -> Data {
        var out = lengthPrefixed(header)
        out.append(audio)
        return out
    }

    /// Split a Bluetooth recording body into its header and audio.
    public static func splitRecordingBody(_ body: Data) -> (header: Data, audio: Data)? {
        let bytes = Data(body) // re-base indices at 0
        guard bytes.count >= 4 else { return nil }
        let headerLength = Int(readBigEndian(bytes))
        guard headerLength > 0, bytes.count >= 4 + headerLength else { return nil }
        let header = bytes.subdata(in: 4 ..< 4 + headerLength)
        let audio = bytes.subdata(in: 4 + headerLength ..< bytes.count)
        return (header, audio)
    }
}

/// Reassembles a byte stream that arrives in arbitrary chunks (Bluetooth packets) into whole
/// `[type][u32 length][body]` messages.
public struct MessageReassembler {
    /// Messages announcing more than this are treated as corrupt and the buffer is dropped.
    public static let maximumMessageLength = 128 * 1024 * 1024

    private var buffer = Data()

    public init() {}

    public var bufferedByteCount: Int { buffer.count }

    public mutating func reset() {
        buffer.removeAll(keepingCapacity: false)
    }

    /// Append a chunk and return every message completed by it.
    public mutating func append(_ chunk: Data) -> [(type: UInt8, body: Data)] {
        buffer.append(chunk)
        var messages: [(type: UInt8, body: Data)] = []
        var cursor = 0
        while buffer.count - cursor >= 5 {
            let base = buffer.startIndex + cursor
            let length = Int(Wire.readBigEndian(buffer.subdata(in: (base + 1) ..< (base + 5))))
            if length > Self.maximumMessageLength {
                buffer.removeAll(keepingCapacity: false)
                return messages
            }
            let total = 5 + length
            guard buffer.count - cursor >= total else { break }
            let type = buffer[base]
            let body = buffer.subdata(in: (base + 5) ..< (base + total))
            messages.append((type: type, body: body))
            cursor += total
        }
        if cursor > 0 {
            buffer.removeSubrange(buffer.startIndex ..< (buffer.startIndex + cursor))
        }
        return messages
    }
}
