import EarbudLink
import SwiftUI

/// Record button on top, where recordings go, then the recordings themselves.
struct RootView: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var store: RecordingStore

    var body: some View {
        NavigationStack {
            List {
                RecordControl()
                    .listRowBackground(Color.clear)

                DestinationRow()

                if let message = model.message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .onTapGesture { model.message = nil }
                }

                if !store.recordings.isEmpty {
                    Section {
                        ForEach(store.recordings) { recording in
                            NavigationLink(value: recording.id) {
                                RecordingRow(recording: recording)
                            }
                        }
                        .onDelete { offsets in
                            let ids = offsets.map { store.recordings[$0].id }
                            for id in ids { model.delete(id) }
                        }
                        if model.link != nil, model.unsentCount > 1 {
                            Button {
                                model.sendAllUnsent()
                            } label: {
                                Label("Send all \(model.unsentCount)", systemImage: "paperplane")
                            }
                        }
                    } header: {
                        Text("Recordings")
                    }
                }
            }
            .navigationTitle("Earbud")
            .navigationDestination(for: UUID.self) { id in
                RecordingDetailView(id: id)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView()
                    } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("Settings")
                }
            }
        }
    }
}

/// The big round button, with the time and an input meter while recording.
struct RecordControl: View {
    @EnvironmentObject private var model: WatchModel
    @EnvironmentObject private var recorder: AudioRecorder

    var body: some View {
        VStack(spacing: 6) {
            Button {
                Task { await model.toggleRecording() }
            } label: {
                ZStack {
                    Circle()
                        .strokeBorder(Theme.accent.opacity(0.5), lineWidth: 3)
                    if recorder.isRecording {
                        RoundedRectangle(cornerRadius: 6)
                            .fill(Theme.accent)
                            .frame(width: 30, height: 30)
                    } else {
                        Circle()
                            .fill(Theme.accent)
                            .padding(7)
                    }
                }
                .frame(width: 78, height: 78)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(recorder.isRecording ? "Stop recording" : "Record")

            if recorder.isRecording {
                Text(Format.elapsed(recorder.elapsed))
                    .font(.system(.title3, design: .rounded).monospacedDigit())
                LevelMeter(level: recorder.level)
                    .frame(width: 90)
            } else {
                Text("Record")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }
}

struct LevelMeter: View {
    let level: Float

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(Theme.accent)
                    .frame(width: geometry.size.width * CGFloat(level))
            }
        }
        .frame(height: 4)
        .animation(.linear(duration: 0.08), value: level)
    }
}

/// "To Studio iPhone" — which device the recordings go to.
struct DestinationRow: View {
    @EnvironmentObject private var model: WatchModel

    var body: some View {
        NavigationLink {
            if model.link == nil { PairingView() } else { SettingsView() }
        } label: {
            if let link = model.link {
                Label {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Sends to").font(.caption2).foregroundStyle(.secondary)
                        Text(link.displayName).lineLimit(1)
                    }
                } icon: {
                    Image(systemName: Theme.icon(for: link.transport))
                }
            } else {
                Label("Pair with Earbud", systemImage: "link")
            }
        }
    }
}
