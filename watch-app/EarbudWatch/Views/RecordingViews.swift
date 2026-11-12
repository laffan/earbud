import EarbudLink
import SwiftUI

struct RecordingRow: View {
    let recording: WatchRecording

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(Format.when(recording.createdAt))
                Spacer()
                Text(Format.duration(recording.duration))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            DeliveryLabel(delivery: recording.delivery)
                .font(.caption2)
        }
    }
}

struct DeliveryLabel: View {
    let delivery: Delivery

    var body: some View {
        switch delivery {
        case .notSent:
            Label("Not sent", systemImage: "circle")
                .foregroundStyle(.secondary)
        case .sending(let progress):
            if let progress {
                Label("Sending \(Int(progress * 100))%", systemImage: "arrow.up.circle")
                    .foregroundStyle(.secondary)
            } else {
                Label("Sending…", systemImage: "arrow.up.circle")
                    .foregroundStyle(.secondary)
            }
        case .queued(let destination):
            Label("Waiting for \(destination)", systemImage: "clock")
                .foregroundStyle(Theme.warn)
        case .sent(let destination, _, _):
            Label("Sent to \(destination)", systemImage: "checkmark.circle")
                .foregroundStyle(Theme.ok)
        case .failed:
            Label("Not sent", systemImage: "exclamationmark.triangle")
                .foregroundStyle(Theme.warn)
        }
    }
}

struct RecordingDetailView: View {
    let id: UUID
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var store: RecordingStore
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelete = false

    var body: some View {
        if let recording = store.recording(id) {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(recording.title).font(.headline)
                        Text("\(Format.duration(recording.duration)) · \(ByteCountFormatter.string(fromByteCount: Int64(recording.byteCount), countStyle: .file))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    DeliveryLabel(delivery: recording.delivery)
                        .font(.footnote)
                    detail(for: recording.delivery)
                }

                Section {
                    switch recording.delivery {
                    case .sending:
                        Button("Stop sending") { model.cancelSend(id) }
                    case .queued:
                        EmptyView()
                    default:
                        if let link = model.link {
                            Button {
                                model.send(id)
                            } label: {
                                Label(recording.delivery.isSent ? "Send again" : "Send to \(link.displayName)",
                                      systemImage: "paperplane")
                            }
                        } else {
                            NavigationLink("Pair to send") { PairingView() }
                        }
                    }
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
            .navigationTitle(Format.time.string(from: recording.createdAt))
            .confirmationDialog("Delete this recording from the Watch?", isPresented: $confirmDelete) {
                Button("Delete", role: .destructive) {
                    model.delete(id)
                    dismiss()
                }
            } message: {
                Text(recording.delivery.isSent ? "It is already on the paired device." : "It has not been sent.")
            }
        } else {
            Text("This recording was deleted.")
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func detail(for delivery: Delivery) -> some View {
        switch delivery {
        case .sent(_, let via, let date):
            Text("\(via.label), \(Format.when(date))")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .queued:
            Text("watchOS delivers it through the paired iPhone when it can. It is added when Earbud opens there.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        case .failed(let message):
            Text(message)
                .font(.caption2)
                .foregroundStyle(.secondary)
        default:
            EmptyView()
        }
    }
}
