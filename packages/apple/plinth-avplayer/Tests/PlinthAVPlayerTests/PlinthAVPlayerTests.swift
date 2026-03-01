import XCTest
import AVFoundation
import PlinthApple
@testable import PlinthAVPlayer

/// Tests drive `PlinthAVPlayer` via the internal `handle*` event methods,
/// bypassing real KVO/notifications. This mirrors how plinth-hlsjs tests use
/// FakeHls + FakeVideo to exercise the event-mapping logic in isolation.
final class PlinthAVPlayerTests: XCTestCase {

    // MARK: - Helpers

    private func makeMeta(id: String = "test-video") -> AVVideoMeta {
        AVVideoMeta(id: id, title: "Test Video")
    }

    /// Build a `PlinthAVPlayer` wired to a capture array.
    private func makePlinth(
        meta: AVVideoMeta? = nil,
        onBatch: @escaping (BeaconBatch) -> Void = { _ in }
    ) -> PlinthAVPlayer {
        PlinthAVPlayer.initialize(
            player: AVPlayer(),
            videoMeta: meta ?? makeMeta(),
            options: .init(
                sessionFactory: { sessionMeta, config in
                    PlinthSession.create(
                        meta: sessionMeta,
                        config: config,
                        beaconHandler: onBatch
                    )
                }
            )
        )
    }

    /// Drive the state machine to Playing state.
    private func reachPlaying(_ p: PlinthAVPlayer) {
        p.handleLoad(src: "https://example.com/video.m3u8")
        p.handleCanPlay()
        p.handlePlay()
        p.handleFirstFrame()
    }

    // MARK: - Session lifecycle

    func testInitializeCreatesInstance() {
        let plinth = makePlinth()
        XCTAssertNotNil(plinth)
    }

    func testLoadEmitsNoBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        plinth.handleLoad(src: "https://example.com/v.m3u8")
        XCTAssertTrue(batches.isEmpty)
    }

    func testCanPlayEmitsNoBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        plinth.handleLoad(src: "x")
        plinth.handleCanPlay()
        XCTAssertTrue(batches.isEmpty)
    }

    func testPlayEmitsSessionOpen() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        plinth.handleLoad(src: "x")
        plinth.handleCanPlay()
        plinth.handlePlay()
        XCTAssertEqual(batches.count, 1)
        XCTAssertEqual(batches[0].beacons[0].event, "session_open")
        XCTAssertEqual(batches[0].beacons[0].seq, 0)
    }

    func testFirstFrameEmitsFirstFrameBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        // batch 0: session_open, batch 1: first_frame
        XCTAssertEqual(batches.count, 2)
        XCTAssertEqual(batches[1].beacons[0].event, "first_frame")
        XCTAssertEqual(batches[1].beacons[0].seq, 1)
    }

    func testWaitingBeforeFirstFrameDoesNotEmitBeacon() {
        // PlayAttempt → Buffering transition is silent (no beacon from core)
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        plinth.handleLoad(src: "x")
        plinth.handleCanPlay()
        plinth.handlePlay()      // → session_open (1 batch)
        plinth.handleWaiting()   // → Buffering (no beacon)
        XCTAssertEqual(batches.count, 1)
        XCTAssertEqual(batches[0].beacons[0].event, "session_open")
    }

    func testFirstFrameAfterWaitingEmitsFirstFrame() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        plinth.handleLoad(src: "x")
        plinth.handleCanPlay()
        plinth.handlePlay()
        plinth.handleWaiting()
        plinth.handleFirstFrame()
        XCTAssertEqual(batches.last!.beacons[0].event, "first_frame")
    }

    func testPauseEmitsPauseBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handlePause()
        XCTAssertEqual(batches.last!.beacons[0].event, "pause")
    }

    func testResumeAfterPauseEmitsPlayBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handlePause()
        plinth.handlePlay()
        XCTAssertEqual(batches.last!.beacons[0].event, "play")
    }

    func testResumeNoSecondFirstFrame() {
        // After resume, canPlayThrough → Playing but no first_frame beacon (vst_ms set)
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handlePause()
        plinth.handlePlay()
        let countBeforeResume = batches.count
        plinth.handleCanPlayThrough()
        XCTAssertEqual(batches.count, countBeforeResume, "no extra beacon on resume")
    }

    func testWaitingFromPlayingEmitsRebufferStart() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handleWaiting()
        XCTAssertEqual(batches.last!.beacons[0].event, "rebuffer_start")
    }

    func testCanPlayThroughFromRebufferingEmitsRebufferEnd() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handleWaiting()
        plinth.handleCanPlayThrough()
        XCTAssertEqual(batches.last!.beacons[0].event, "rebuffer_end")
    }

    func testEndedEmitsSessionEnd() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handleEnded()
        XCTAssertEqual(batches.last!.beacons[0].event, "session_end")
    }

    // MARK: - Seek events (driven via session directly, same as seek(to:) completion)

    func testSeekStartEmitsSeekStartBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.session?.processEvent(.seekStart(fromMs: 10_000))
        XCTAssertEqual(batches.last!.beacons[0].event, "seek_start")
    }

    func testSeekEndBufferReadyEmitsSeekEndBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.session?.processEvent(.seekStart(fromMs: 10_000))
        plinth.session?.processEvent(.seekEnd(toMs: 60_000, bufferReady: true))
        XCTAssertEqual(batches.last!.beacons[0].event, "seek_end")
    }

    // MARK: - Error handling

    func testErrorFromPlayingEmitsErrorBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handleError(code: "NETWORK_ERR", message: "timeout", fatal: true)
        XCTAssertEqual(batches.last!.beacons[0].event, "error")
    }

    func testErrorBeforePlayEmitsErrorBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        plinth.handleLoad(src: "x")
        plinth.handleError(code: "MANIFEST_ERR", message: nil, fatal: true)
        XCTAssertEqual(batches.last!.beacons[0].event, "error")
    }

    // MARK: - Quality change

    func testQualityChangeEmitsQualityBeacon() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handleQualityChange(bitrateBps: 2_500_000, width: 1280, height: 720)
        XCTAssertEqual(batches.last!.beacons[0].event, "quality_change")
    }

    // MARK: - destroy()

    func testDestroyFromPlayingEmitsSessionEnd() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.destroy()
        XCTAssertEqual(batches.last!.beacons[0].event, "session_end")
    }

    func testDestroyFromIdleEmitsNothing() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        plinth.destroy()
        XCTAssertTrue(batches.isEmpty)
    }

    func testDestroyIsIdempotent() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.destroy()
        let countAfterFirst = batches.count
        plinth.destroy()
        XCTAssertEqual(batches.count, countAfterFirst)
    }

    // MARK: - Beacon ordering

    func testSeqIncrementsCorrectly() {
        var allBeacons: [Beacon] = []
        let plinth = makePlinth { allBeacons.append(contentsOf: $0.beacons) }
        reachPlaying(plinth)
        plinth.handlePause()
        for (i, b) in allBeacons.enumerated() {
            XCTAssertEqual(b.seq, UInt32(i), "Wrong seq at index \(i): \(b.event)")
        }
    }

    func testAllBeaconsSharePlayId() {
        var allBeacons: [Beacon] = []
        let plinth = makePlinth { allBeacons.append(contentsOf: $0.beacons) }
        reachPlaying(plinth)
        let playId = allBeacons[0].playId
        XCTAssertFalse(playId.isEmpty)
        for b in allBeacons {
            XCTAssertEqual(b.playId, playId, "seq=\(b.seq) has wrong play_id")
        }
    }

    // MARK: - handleLoad resets firstFrame state

    func testNewLoadResetsFirstFrameTracking() {
        var batches: [BeaconBatch] = []
        let plinth = makePlinth { batches.append($0) }
        reachPlaying(plinth)
        plinth.handleEnded()

        // Simulate replaying: new play session via load → play → firstFrame
        plinth.handleLoad(src: "https://example.com/video2.m3u8")
        plinth.handleCanPlay()
        plinth.handlePlay()
        plinth.handleFirstFrame()

        XCTAssertEqual(batches.last!.beacons[0].event, "first_frame")
    }
}
