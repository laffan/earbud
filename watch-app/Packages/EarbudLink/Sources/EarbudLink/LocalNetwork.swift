import Foundation
import Network

// Watch → receiver over TCP (Network framework). The receiver side is Rust
// (src-tauri/src/watch_link/server.rs), so it also runs on a Mac.
//
// watchOS restricts low-level networking: an app may use Network framework only in a few cases
// (Apple TN3135), and otherwise the connection stays in `.waiting` with ENETDOWN. Both the
// sender and the pairing scan therefore give up quickly on `.waiting`, so the caller can move
// on to Bluetooth or the paired iPhone.

/// Sends recordings to a receiver's address saved at pairing.
public enum LocalNetworkClient {
    public static func send(_ transfer: RecordingTransfer, audioURL: URL, to link: DeviceLink,
                            connectTimeout: TimeInterval = 8) async throws {
        guard let host = link.host, let rawPort = link.port,
              let port = NWEndpoint.Port(rawValue: rawPort),
              let secret = link.pairingSecret else {
            throw LinkError.notConfigured
        }
        let audio = try Data(contentsOf: audioURL)
        var stamped = transfer
        stamped.pairingSecret = secret
        stamped.byteCount = audio.count
        var frame = Wire.tcpRecordingHead(header: try EarbudJSON.encoder.encode(stamped))
        frame.append(audio)
        // Generous: 50 KB/s is far below Wi-Fi speeds.
        let total = connectTimeout + 20 + Double(audio.count) / 50_000
        let reply = try await TCPExchange(host: host, port: port)
            .run(sending: frame, framedReplyOnAck: false, connectTimeout: connectTimeout, totalTimeout: total)
        guard reply.ack == 1 else { throw LinkError.rejected }
        LinkLog.log("Sent “\(transfer.recording.name)” over Wi-Fi to \(host)")
    }
}

/// Finds the receiver showing `code` by trying the fixed port on every host of the local subnet
/// (Personal Hotspot gateway and `.1` addresses first). The receiver in pairing mode checks the
/// code and replies with its name, id and secret.
public enum PairingClient {
    public static func pair(code: String, deviceName: String,
                            port: UInt16 = EarbudLinkDefaults.port,
                            progress: (@Sendable (Int, Int) -> Void)? = nil) async throws -> DeviceLink {
        let hosts = NetworkInterface.candidateHosts()
        guard !hosts.isEmpty, let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw LinkError.networkUnavailable
        }
        let request = try EarbudJSON.encoder.encode(PairingRequest(code: code, deviceName: deviceName))
        let frame = Wire.tcpPairing(request: request)

        let batchSize = 16
        var scanned = 0
        var blocked = 0
        var sawRejection = false
        var index = 0
        while index < hosts.count {
            try Task.checkCancellation() // Bluetooth may have won the race
            let batch = Array(hosts[index ..< min(index + batchSize, hosts.count)])
            let outcomes = await withTaskGroup(of: Outcome.self) { group -> [Outcome] in
                for host in batch {
                    group.addTask { await attempt(host: host, port: nwPort, defaultPort: port, frame: frame) }
                }
                var results: [Outcome] = []
                for await outcome in group { results.append(outcome) }
                return results
            }
            scanned += batch.count
            progress?(scanned, hosts.count)
            for outcome in outcomes {
                switch outcome {
                case .paired(let link): return link
                case .rejected: sawRejection = true
                case .blocked: blocked += 1
                case .miss: break
                }
            }
            if blocked == scanned {
                // Every connection was held back: watchOS isn't allowing direct Wi-Fi right now.
                throw LinkError.networkUnavailable
            }
            index += batchSize
        }
        throw sawRejection ? LinkError.rejected : LinkError.notReachable
    }

    private enum Outcome {
        case paired(DeviceLink)
        case rejected
        case blocked
        case miss
    }

    private static func attempt(host: String, port: NWEndpoint.Port, defaultPort: UInt16,
                                frame: Data) async -> Outcome {
        do {
            let reply = try await TCPExchange(host: host, port: port)
                .run(sending: frame, framedReplyOnAck: true, connectTimeout: 1.2, totalTimeout: 3)
            guard reply.ack == 1 else { return .rejected }
            guard let body = reply.body,
                  let response = try? EarbudJSON.decoder.decode(PairingResponse.self, from: body)
            else { return .miss }
            let link = DeviceLink(transport: .localNetwork,
                                  displayName: response.displayName,
                                  deviceId: response.deviceId,
                                  host: host,
                                  port: response.port == 0 ? defaultPort : response.port,
                                  pairingSecret: response.token)
            return .paired(link)
        } catch LinkError.networkUnavailable {
            return .blocked
        } catch {
            return .miss
        }
    }
}

/// One TCP request/reply: connect, send `payload`, read a one-byte acknowledgement and, if
/// asked and the acknowledgement is 1, a `[u32 length][body]` frame after it.
final class TCPExchange: @unchecked Sendable {
    struct Reply {
        let ack: UInt8
        let body: Data?
    }

    private let connection: NWConnection
    private let queue = DispatchQueue(label: "earbud.link.tcp")
    private let label: String

    // Touched only on `queue`.
    private var continuation: CheckedContinuation<Reply, Error>?
    private var finished = false
    private var connectTimer: DispatchWorkItem?
    private var totalTimer: DispatchWorkItem?

    init(host: String, port: NWEndpoint.Port) {
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        connection = NWConnection(to: .hostPort(host: NWEndpoint.Host(host), port: port), using: parameters)
        label = "\(host):\(port.rawValue)"
    }

    func run(sending payload: Data, framedReplyOnAck: Bool, connectTimeout: TimeInterval,
             totalTimeout: TimeInterval) async throws -> Reply {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Reply, Error>) in
                queue.async {
                    guard !self.finished else {
                        // Cancelled before it started.
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    self.continuation = continuation
                    let connectTimer = DispatchWorkItem { self.finish(.failure(LinkError.notReachable)) }
                    let totalTimer = DispatchWorkItem { self.finish(.failure(LinkError.notReachable)) }
                    self.connectTimer = connectTimer
                    self.totalTimer = totalTimer
                    self.queue.asyncAfter(deadline: .now() + connectTimeout, execute: connectTimer)
                    self.queue.asyncAfter(deadline: .now() + totalTimeout, execute: totalTimer)
                    self.connection.stateUpdateHandler = { [weak self] state in
                        self?.handle(state, payload: payload, framedReplyOnAck: framedReplyOnAck)
                    }
                    self.connection.start(queue: self.queue)
                }
            }
        } onCancel: {
            queue.async { self.finish(.failure(CancellationError())) }
        }
    }

    private func handle(_ state: NWConnection.State, payload: Data, framedReplyOnAck: Bool) {
        switch state {
        case .ready:
            connectTimer?.cancel()
            connection.send(content: payload, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                if let error {
                    self.finish(.failure(LinkError.failed(error.localizedDescription)))
                    return
                }
                self.readReply(framed: framedReplyOnAck)
            })
        case .waiting(let error):
            // NWConnection would wait for the path to change; we want an answer now.
            if case .posix(let code) = error, code == .ENETDOWN {
                finish(.failure(LinkError.networkUnavailable))
            } else {
                finish(.failure(LinkError.notReachable))
            }
        case .failed(let error):
            if case .posix(let code) = error, code == .ECONNREFUSED || code == .EHOSTUNREACH {
                finish(.failure(LinkError.notReachable))
            } else {
                finish(.failure(LinkError.failed(error.localizedDescription)))
            }
        case .cancelled:
            finish(.failure(LinkError.notReachable))
        default:
            break
        }
    }

    private func readReply(framed: Bool) {
        receiveExactly(1) { [weak self] data in
            guard let self else { return }
            guard let ack = data?.first else {
                self.finish(.failure(LinkError.notReachable))
                return
            }
            guard framed, ack == 1 else {
                self.finish(.success(Reply(ack: ack, body: nil)))
                return
            }
            self.receiveExactly(4) { lengthData in
                guard let lengthData else {
                    self.finish(.failure(LinkError.notReachable))
                    return
                }
                let length = Int(Wire.readBigEndian(lengthData))
                guard length > 0, length <= 64 * 1024 else {
                    self.finish(.failure(LinkError.notReachable))
                    return
                }
                self.receiveExactly(length) { body in
                    if let body {
                        self.finish(.success(Reply(ack: ack, body: body)))
                    } else {
                        self.finish(.failure(LinkError.notReachable))
                    }
                }
            }
        }
    }

    /// Accumulate exactly `count` bytes (Network delivers arbitrary chunks).
    private func receiveExactly(_ count: Int, accumulated: Data = Data(),
                                completion: @escaping (Data?) -> Void) {
        let remaining = count - accumulated.count
        connection.receive(minimumIncompleteLength: 1, maximumLength: remaining) { [weak self] chunk, _, isComplete, error in
            var data = accumulated
            if let chunk { data.append(chunk) }
            if data.count >= count {
                completion(data)
            } else if isComplete || error != nil {
                completion(nil)
            } else {
                self?.receiveExactly(count, accumulated: data, completion: completion)
            }
        }
    }

    private func finish(_ result: Result<Reply, Error>) {
        guard !finished else { return }
        finished = true
        connectTimer?.cancel()
        totalTimer?.cancel()
        connection.stateUpdateHandler = nil
        connection.cancel()
        let continuation = self.continuation
        self.continuation = nil
        continuation?.resume(with: result)
    }
}
