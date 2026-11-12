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
        .onDisappear {
            if case .searching = model.pairing { model.cancelPairing() }
            if case .paired = model.pairing { model.pairing = .idle }
        }
    }

    private var entry: some View {
        VStack(spacing: 5) {
            HStack(spacing: 4) {
                ForEach(0 ..< codeLength, id: \.self) { index in
                    Text(index < entered.count ? String(Array(entered)[index]) : "•")
                        .font(.callout.monospacedDigit())
                        .frame(width: 18, height: 22)
                        .background(.gray.opacity(0.25), in: RoundedRectangle(cornerRadius: 4))
                        .foregroundStyle(index < entered.count ? .primary : .secondary)
                }
            }
            .accessibilityLabel("Code: \(entered.map(String.init).joined(separator: " "))")
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 3), spacing: 4) {
                ForEach(1 ... 9, id: \.self) { digit in
                    key("\(digit)") { append("\(digit)") }
                }
                key("⌫") { if !entered.isEmpty { entered.removeLast() } }
                    .accessibilityLabel("Delete")
                key("0") { append("0") }
                Color.clear.frame(height: 1)
            }
        }
        .padding(.horizontal, 2)
    }

    private func key(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.body)
                .frame(maxWidth: .infinity, minHeight: 26)
        }
        .buttonStyle(.bordered)
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
