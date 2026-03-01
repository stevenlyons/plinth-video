import AVFoundation
import PlinthSwift
import PlinthAVPlayer

struct LogEntry: Identifiable {
    let id = UUID()
    let time: String
    let seq: UInt32
    let event: String
}

@MainActor
final class PlayerViewModel: ObservableObject {
    @Published var logEntries: [LogEntry] = []
    @Published var urlText = "https://stream.mux.com/GWPDeDbc011cmHckB4h4l87OofuZPGPKl.m3u8"
    @Published var isLoaded = false

    let player = AVPlayer()
    private var plinth: PlinthAVPlayer?

    func load() {
        let raw = urlText.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: raw) else { return }

        // Tear down previous instance cleanly
        plinth?.destroy()
        plinth = nil
        logEntries.removeAll()

        player.replaceCurrentItem(with: AVPlayerItem(url: url))

        plinth = PlinthAVPlayer.initialize(
            player: player,
            videoMeta: AVVideoMeta(id: raw),
            options: .init(
                sessionFactory: { [weak self] meta, config in
                    PlinthSession.create(
                        meta: meta,
                        config: config,
                        beaconHandler: { batch in
                            // PlinthSession's heartbeat timer fires on a background queue;
                            // dispatch to main before touching @Published state.
                            DispatchQueue.main.async { [weak self] in
                                self?.append(batch)
                            }
                        }
                    )
                }
            )
        )

        isLoaded = true
    }

    private func append(_ batch: BeaconBatch) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        let time = formatter.string(from: Date())

        for beacon in batch.beacons {
            logEntries.append(LogEntry(time: time, seq: beacon.seq, event: beacon.event))
        }
    }
}
