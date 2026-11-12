import EarbudLink
import SwiftUI

/// Enter the 5-digit code Earbud shows (Settings → Apple Watch → Pair Apple Watch). The Watch
/// then looks for that device over Wi-Fi and Bluetooth at once; no address to type.
struct PairingView: View {
    @EnvironmentObject private var model: WatchModel
    @Environment(\.dismiss) private var dismiss
    @State private var entered = ""

    private let codeLength = 5

    var body: some View {
        Group {
            switch model.pairing {
            case .idle:
                entry
            case .searching(let tried, let total):
                searching(tried: tried, total: total)
            case .paired(let name):
                result(icon: "checkmark.circle.fill", color: Theme.ok,
                       text: "Recordings now go to \(name).") {
                    Button("Done") {
                        model.pairing = .idle
                        dismiss()
                    }
                }
            case .failed(let message):
                result(icon: "xmark.circle.fill", color: Theme.warn, text: message) {
                    Button("Try again") {
                        entered = ""
                        model.pairing = .idle
                    }
                }
            }
        }
        .navigationTitle("Pair")
        // A small title leaves the keypad most of the screen.
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear {
            if case .searching = model.pairing { model.cancelPairing() }
            if case .paired = model.pairing { model.pairing = .idle }
        }
    }

    /// The keypad: three columns, delete at the bottom right.
    private static let keypad: [[String]] = [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
        ["", "0", "delete"],
    ]

    /// The code and the keypad are sized from the space the system leaves under the navigation
    /// bar, so every row is on screen on every Watch size. System-styled buttons have a minimum
    /// height of their own: four rows of them were taller than a small Watch's screen, which
    /// pushed the code under the navigation bar and the bottom row (with delete) off the screen.
    private var entry: some View {
        GeometryReader { geometry in
            let spacing: CGFloat = 3
            let rows = CGFloat(Self.keypad.count)
            let codeHeight = min(24, max(16, geometry.size.height * 0.15))
            let keyHeight = max(14, (geometry.size.height - codeHeight - spacing * rows) / rows)
            VStack(spacing: spacing) {
                codeRow
                    .frame(height: codeHeight)
                ForEach(Self.keypad.indices, id: \.self) { row in
                    HStack(spacing: spacing) {
                        ForEach(Self.keypad[row], id: \.self) { label in
                            key(label, height: keyHeight)
                        }
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top)
        }
        .padding(.horizontal, 4)
    }

    private var codeRow: some View {
        HStack(spacing: 4) {
            ForEach(0 ..< codeLength, id: \.self) { index in
                Text(index < entered.count ? String(Array(entered)[index]) : "•")
                    .font(.callout.monospacedDigit())
                    .frame(maxWidth: 20, maxHeight: .infinity)
                    .background(.gray.opacity(0.25), in: RoundedRectangle(cornerRadius: 4))
                    .foregroundStyle(index < entered.count ? .primary : .secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Code: \(entered.map(String.init).joined(separator: " "))")
    }

    @ViewBuilder
    private func key(_ label: String, height: CGFloat) -> some View {
        if label.isEmpty {
            Color.clear
                .frame(maxWidth: .infinity)
                .frame(height: height)
        } else if label == "delete" {
            keyButton(height: height, enabled: !entered.isEmpty) {
                if !entered.isEmpty { entered.removeLast() }
            } label: {
                Image(systemName: "delete.left")
            }
            .accessibilityLabel("Delete")
        } else {
            keyButton(height: height, enabled: true) {
                append(label)
            } label: {
                Text(label)
            }
        }
    }

    /// A plain button with its own background, so its height is exactly `height`.
    private func keyButton<Content: View>(height: CGFloat, enabled: Bool, action: @escaping () -> Void,
                                          @ViewBuilder label: () -> Content) -> some View {
        Button(action: action) {
            label()
                .font(.system(size: min(20, max(11, height * 0.55)), weight: .medium, design: .rounded))
                .frame(maxWidth: .infinity)
                .frame(height: height)
                .background(.gray.opacity(0.28), in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.4)
        .disabled(!enabled)
    }

    private func append(_ digit: String) {
        guard entered.count < codeLength else { return }
        entered.append(digit)
        if entered.count == codeLength { model.pair(code: entered) }
    }

    private func searching(tried: Int, total: Int) -> some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("Looking for Earbud…").font(.footnote)
            Text(total > 0 ? "Wi-Fi \(tried)/\(total) · Bluetooth" : "Wi-Fi · Bluetooth")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            Button("Cancel") {
                model.cancelPairing()
                entered = ""
            }
        }
        .padding()
    }

    private func result<Actions: View>(icon: String, color: Color, text: String,
                                       @ViewBuilder actions: () -> Actions) -> some View {
        ScrollView {
            VStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.largeTitle)
                    .foregroundStyle(color)
                Text(text)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                actions()
            }
            .padding()
        }
    }
}
