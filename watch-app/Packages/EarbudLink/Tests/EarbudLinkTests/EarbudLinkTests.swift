import XCTest
@testable import EarbudLink

/// Run on a Mac with `swift test` in watch-app/Packages/EarbudLink. The fixtures are shared with
/// the Rust receiver's tests (src-tauri/src/watch_link/tests.rs), which decode the same files.
final class EarbudLinkTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    private let recordingID = UUID(uuidString: "E621E1F8-C36C-495A-93FC-0C247A3E6E5F")!

    private func sampleTransfer(byteCount: Int = 48_213) -> RecordingTransfer {
        let recording = TransferRecording(id: recordingID, name: "Nov 11, 10:04 AM",
                                          createdAt: Date(timeIntervalSince1970: 1_794_420_245),
                                          duration: 12.5)
        return RecordingTransfer(recording: recording, byteCount: byteCount,
                                 pairingSecret: "9f1c2a7be04d4c5e8a3b6d2f1e0c9b8a",
                                 senderName: "Apple Watch")
    }

    func testTransferEncodesExactlyAsTheFixture() throws {
        let encoded = try EarbudJSON.encoder.encode(sampleTransfer())
        XCTAssertEqual(String(data: encoded, encoding: .utf8),
                       String(data: try fixture("recording-transfer"), encoding: .utf8))
    }

    func testDecodesInboxEntryAndPairingResponseFixtures() throws {
        let entry = try EarbudJSON.decoder.decode(InboxEntry.self, from: try fixture("inbox-entry"))
        XCTAssertEqual(entry.id, recordingID)
        XCTAssertEqual(entry.fileName, "e621e1f8c36c495a93fc0c247a3e6e5f.m4a")
        XCTAssertEqual(entry.receivedVia, Transport.bluetooth.rawValue)

        let response = try EarbudJSON.decoder.decode(PairingResponse.self, from: try fixture("pairing-response"))
        XCTAssertEqual(response.displayName, "Studio iPhone")
        XCTAssertEqual(response.port, EarbudLinkDefaults.port)
    }

    func testSketchIDIsLowercaseHex() {
        XCTAssertEqual(sampleTransfer().recording.sketchID, "e621e1f8c36c495a93fc0c247a3e6e5f")
    }

    func testTCPFramesMatchTheProtocol() throws {
        let header = Data("{}".utf8)
        XCTAssertEqual([UInt8](Wire.tcpRecordingHead(header: header)), [0x01, 0, 0, 0, 2, 0x7B, 0x7D])
        XCTAssertEqual([UInt8](Wire.tcpPairing(request: header)), [0x02, 0, 0, 0, 2, 0x7B, 0x7D])
        XCTAssertEqual(Wire.readBigEndian(Wire.bigEndian(0x0102_0304)), 0x0102_0304)
    }

    func testRecordingBodyRoundTrip() throws {
        let header = Data("{\"a\":1}".utf8)
        let audio = Data((0 ..< 300).map { UInt8($0 % 251) })
        let body = Wire.recordingBody(header: header, audio: audio)
        // A slice that does not start at index 0, as `Data` slices from a buffer often don't.
        let parts = try XCTUnwrap(Wire.splitRecordingBody((Data([9]) + body).dropFirst(1)))
        XCTAssertEqual(parts.header, header)
        XCTAssertEqual(parts.audio, audio)
        XCTAssertNil(Wire.splitRecordingBody(Data([0, 0, 0, 9, 1])))
    }

    func testReassemblerHandlesArbitraryChunks() {
        let first = Wire.envelope(type: MessageType.ack, body: Data([1]))
        let second = Wire.envelope(type: MessageType.pairingResponse, body: Data(repeating: 7, count: 1000))
        let stream = first + second
        var reassembler = MessageReassembler()
        var messages: [(type: UInt8, body: Data)] = []
        var offset = 0
        for size in [1, 3, 2, 17, 180, 1, 2000] where offset < stream.count {
            let end = min(stream.count, offset + size)
            messages += reassembler.append(stream.subdata(in: offset ..< end))
            offset = end
        }
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].type, MessageType.ack)
        XCTAssertEqual(messages[0].body, Data([1]))
        XCTAssertEqual(messages[1].body.count, 1000)
        XCTAssertEqual(reassembler.bufferedByteCount, 0)
    }

    func testInboxWriterProducesWhatTheImporterReads() throws {
        let inbox = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: inbox) }
        let audio = Data(repeating: 3, count: 512)
        let entry = try InboxWriter.write(audio: audio, transfer: sampleTransfer(byteCount: 512),
                                          via: .bluetooth, to: inbox)
        XCTAssertEqual(entry.fileName, "e621e1f8c36c495a93fc0c247a3e6e5f.m4a")
        let names = try FileManager.default.contentsOfDirectory(atPath: inbox.path).sorted()
        XCTAssertEqual(names, ["e621e1f8c36c495a93fc0c247a3e6e5f.json", "e621e1f8c36c495a93fc0c247a3e6e5f.m4a"])
        XCTAssertEqual(InboxWriter.pendingCount(in: inbox), 1)
        XCTAssertThrowsError(try InboxWriter.write(audio: audio.prefix(10), transfer: sampleTransfer(byteCount: 512),
                                                   via: .bluetooth, to: inbox))
    }

    func testCandidateHostsPutLikelyHostsFirst() {
        XCTAssertEqual(NetworkInterface.hostsInSubnet(ip: "192.168.1.20", mask: "255.255.255.252"),
                       ["192.168.1.21", "192.168.1.22"])
        XCTAssertEqual(NetworkInterface.hostsInSubnet(ip: "10.0.0.5", mask: "255.255.0.0", cap: 3).count, 3)
        XCTAssertEqual(NetworkInterface.uint32ToIPv4(NetworkInterface.ipv4ToUInt32("172.20.10.1")!), "172.20.10.1")
    }
}
