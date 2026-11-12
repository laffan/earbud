import Foundation

/// Enumerates this device's IPv4 network interfaces and derives the set of peer addresses to
/// probe during pairing. (From Woods Whisper.)
///
/// The Watch can't browse Bonjour, so to find the receiver without making the user type an IP
/// we scan the local subnet directly (authenticated by the short pairing code). This works over
/// any shared link layer: a Wi-Fi router, or an iPhone's Personal Hotspot.
public enum NetworkInterface {

    /// One active IPv4 interface: its BSD name, address, and subnet mask.
    public struct Interface: Sendable {
        public let name: String
        public let ip: String
        public let netmask: String
    }

    /// All up/running, non-loopback IPv4 interfaces on this device.
    public static func ipv4Interfaces() -> [Interface] {
        var result: [Interface] = []
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return result }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            guard (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING),
                  (flags & IFF_LOOPBACK) == 0,
                  let addrPtr = ptr.pointee.ifa_addr,
                  addrPtr.pointee.sa_family == UInt8(AF_INET) else { continue }

            let name = String(cString: ptr.pointee.ifa_name)
            guard let ip = string(from: addrPtr), ip != "127.0.0.1" else { continue }
            let mask = ptr.pointee.ifa_netmask.flatMap { string(from: $0) } ?? ""
            result.append(Interface(name: name, ip: ip, netmask: mask))
        }
        return result
    }

    /// This device's IPv4 addresses, for display.
    public static func displayAddresses() -> [String] {
        ipv4Interfaces().map(\.ip)
    }

    /// Ordered list of candidate hosts to probe when searching for the receiver, most-likely first:
    /// the Personal-Hotspot gateway, each interface's gateway guess (`.1`), then a full sweep of
    /// each interface's subnet. Deduplicated; the device's own addresses are excluded.
    public static func candidateHosts(cap: Int = 1024) -> [String] {
        var ordered: [String] = []
        var seen = Set<String>()
        func add(_ host: String) {
            if seen.insert(host).inserted { ordered.append(host) }
        }

        let interfaces = ipv4Interfaces()
        let ownIPs = Set(interfaces.map(\.ip))

        // 1. iOS Personal Hotspot always puts the host iPhone at this gateway address.
        add("172.20.10.1")

        // 2. The conventional gateway (.1 of each subnet) — often the host on small networks.
        for iface in interfaces {
            if let net = networkAddress(ip: iface.ip, mask: iface.netmask) {
                add(uint32ToIPv4(net + 1))
            }
        }

        // 3. Full sweep of each interface's subnet.
        for iface in interfaces {
            for host in hostsInSubnet(ip: iface.ip, mask: iface.netmask, cap: cap) {
                add(host)
            }
        }

        return ordered.filter { !ownIPs.contains($0) }
    }

    // MARK: - Subnet math

    public static func networkAddress(ip: String, mask: String) -> UInt32? {
        guard let ipv = ipv4ToUInt32(ip), let mv = ipv4ToUInt32(mask), mv != 0 else { return nil }
        return ipv & mv
    }

    /// Usable host addresses in `ip`'s subnet (excludes the network and broadcast addresses),
    /// capped so an unexpectedly large mask (e.g. /16) can't produce a runaway scan.
    public static func hostsInSubnet(ip: String, mask: String, cap: Int = 1024) -> [String] {
        guard let ipv = ipv4ToUInt32(ip), let mv = ipv4ToUInt32(mask), mv != 0 else { return [] }
        let network = ipv & mv
        let broadcast = network | ~mv
        guard broadcast > network + 1 else { return [] }

        var result: [String] = []
        var addr = network + 1
        while addr < broadcast && result.count < cap {
            result.append(uint32ToIPv4(addr))
            addr += 1
        }
        return result
    }

    public static func ipv4ToUInt32(_ s: String) -> UInt32? {
        let parts = s.split(separator: ".")
        guard parts.count == 4 else { return nil }
        var value: UInt32 = 0
        for part in parts {
            guard let octet = UInt8(part) else { return nil }
            value = (value << 8) | UInt32(octet)
        }
        return value
    }

    public static func uint32ToIPv4(_ v: UInt32) -> String {
        "\((v >> 24) & 0xFF).\((v >> 16) & 0xFF).\((v >> 8) & 0xFF).\(v & 0xFF)"
    }

    private static func string(from sockaddr: UnsafeMutablePointer<sockaddr>) -> String? {
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let result = getnameinfo(sockaddr, socklen_t(sockaddr.pointee.sa_len),
                                 &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
        guard result == 0 else { return nil }
        return String(cString: host)
    }
}
