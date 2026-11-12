import EarbudLink
import SwiftUI

@main
struct EarbudWatchApp: App {
    @StateObject private var model = WatchModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.store)
                .environmentObject(model.recorder)
                .tint(Theme.accent)
        }
    }
}

enum Theme {
    /// Earbud's red (the app's dark-mode accent, #E0584C).
    static let accent = Color(red: 0.878, green: 0.345, blue: 0.298)
    static let ok = Color(red: 0.561, green: 0.761, blue: 0.604)
    static let warn = Color(red: 0.878, green: 0.690, blue: 0.353)

    static func icon(for transport: Transport) -> String {
        switch transport {
        case .localNetwork: return "wifi"
        case .bluetooth: return "dot.radiowaves.left.and.right"
        case .phoneSession: return "iphone"
        }
    }
}

enum Format {
    static func duration(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// 0:42.3 while recording.
    static func elapsed(_ seconds: TimeInterval) -> String {
        let tenths = Int((seconds * 10).rounded(.down))
        return String(format: "%d:%02d.%d", tenths / 600, (tenths / 10) % 60, tenths % 10)
    }

    static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()

    static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMMd")
        return formatter
    }()

    static func when(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? time.string(from: date) : "\(day.string(from: date)), \(time.string(from: date))"
    }
}
