import EarbudLink
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var store: RecordingStore
    @State private var confirmUnpair = false
    @State private var confirmClear = false

    private var sentCount: Int { store.recordings.filter { $0.delivery.isSent }.count }

    var body: some View {
        List {
            Section {
                if let link = model.link {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(link.displayName).font(.headline)
                        Text(routesText(link))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                NavigationLink("Pair with a code") {
                    PairingView()
                }
                if let receiver = model.phoneReceiver, receiver.deviceId != model.link?.deviceId {
                    Button {
                        model.usePairedPhone()
                    } label: {
                        Label("Send to \(receiver.displayName) (this Watch's iPhone)", systemImage: "iphone")
                    }
                }
                if model.link != nil {
                    Button("Unpair", role: .destructive) { confirmUnpair = true }
                }
            } header: {
                Text("Sends to")
            } footer: {
                Text("In Earbud on your iPhone, iPad or Mac: Settings → Apple Watch → Pair Apple Watch.")
            }

            Section {
                Toggle("Send automatically", isOn: $model.autoSend)
                Picker("Quality", selection: $model.quality) {
                    ForEach(RecordingQuality.allCases) { quality in
                        Text(quality.label).tag(quality)
                    }
                }
            } footer: {
                Text("Compact files are about a third of the size, which helps over Bluetooth. Both are fine for transcription.")
            }

            if sentCount > 0 {
                Section {
                    Button("Delete \(sentCount) sent", role: .destructive) { confirmClear = true }
                } footer: {
                    Text("Recordings stay on the Watch until you delete them.")
                }
            }

            Section {
                NavigationLink("Activity") { ActivityView() }
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Unpair from \(model.link?.displayName ?? "this device")?", isPresented: $confirmUnpair) {
            Button("Unpair", role: .destructive) { model.unpair() }
        }
        .confirmationDialog("Delete recordings already sent?", isPresented: $confirmClear) {
            Button("Delete", role: .destructive) { store.deleteSent() }
        }
    }

    private func routesText(_ link: DeviceLink) -> String {
        model.routes(for: link).map(\.label).joined(separator: ", ")
    }
}

/// Recent connection attempts, for troubleshooting.
struct ActivityView: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        List {
            if model.log.isEmpty {
                Text("Nothing yet.").foregroundStyle(.secondary)
            }
            ForEach(Array(model.log.reversed().enumerated()), id: \.offset) { _, line in
                Text(line).font(.caption2)
            }
        }
        .navigationTitle("Activity")
    }
}
