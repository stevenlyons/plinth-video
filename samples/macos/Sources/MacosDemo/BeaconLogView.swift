import SwiftUI

struct BeaconLogView: View {
    let entries: [LogEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text("Beacon log")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("\(entries.count)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)

            Divider()

            // Entries
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(entries) { entry in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(entry.time)
                                    .foregroundStyle(.tertiary)
                                    .font(.system(size: 10, design: .monospaced))
                                Text("#\(entry.seq)")
                                    .foregroundStyle(.secondary)
                                    .font(.system(size: 10, design: .monospaced))
                                    .frame(width: 28, alignment: .trailing)
                                Text(entry.event)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(color(for: entry.event))
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 2)
                            .id(entry.id)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onChange(of: entries.count) { _ in
                    if let last = entries.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }
        }
        .background(.background)
    }

    private func color(for event: String) -> Color {
        switch event {
        case "play":          return .blue
        case "first_frame":   return .green
        case "playing":       return .mint
        case "ended":         return .orange
        case "completed":     return .orange
        case "error":         return .red
        case "heartbeat":     return .secondary
        case "stall":         return .yellow
        case _ where event.hasPrefix("seek"): return .purple
        default:              return .primary
        }
    }
}
