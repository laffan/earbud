import Foundation

/// Logging hook. Lines go to the device console with the prefix `[earbud-link]`, and to
/// `handler` if set (the Watch's diagnostics screen, the iOS plugin's event channel).
public enum LinkLog {
    public static var handler: ((String) -> Void)?

    public static func log(_ message: String) {
        NSLog("[earbud-link] %@", message)
        handler?(message)
    }
}
