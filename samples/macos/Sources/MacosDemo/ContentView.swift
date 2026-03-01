import SwiftUI
import AVKit

struct ContentView: View {
    @StateObject private var vm = PlayerViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // ── URL bar ────────────────────────────────────────────────────────
            HStack(spacing: 8) {
                TextField("HLS URL", text: $vm.urlText)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
                    .onSubmit { vm.load() }
                Button("Load") { vm.load() }
                    .buttonStyle(.borderedProminent)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)

            Divider()

            // ── Player + log ──────────────────────────────────────────────────
            HSplitView {
                AVPlayerViewRepresentable(player: vm.player)
                    .frame(minWidth: 400, minHeight: 300)

                BeaconLogView(entries: vm.logEntries)
                    .frame(minWidth: 260, maxWidth: 340)
            }
        }
        .frame(minWidth: 760, minHeight: 460)
    }
}

/// NSViewRepresentable wrapping AVPlayerView directly.
/// SwiftUI's VideoPlayer crashes under `swift run` because it can't resolve
/// AVPlayerView's ObjC class hierarchy without a proper app bundle.
struct AVPlayerViewRepresentable: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.player = player
        view.showsFullScreenToggleButton = true
        view.controlsStyle = .floating
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        view.player = player
    }
}
