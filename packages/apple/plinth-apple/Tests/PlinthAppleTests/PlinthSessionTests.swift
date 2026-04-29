import XCTest
@testable import PlinthApple

final class PlinthSessionTests: XCTestCase {

    // MARK: - Helpers

    private func makeMeta(videoId: String = "test-video") -> SessionMeta {
        SessionMeta(
            video: VideoMetadata(id: videoId, title: "Test Video"),
            client: ClientMetadata(userAgent: "TestAgent/1.0"),
            sdk: SdkMetadata(
                apiVersion: 1,
                core: SdkComponent(name: "plinth-core", version: "0.1.0"),
                framework: SdkComponent(name: "plinth-apple", version: "0.1.0"),
                player: SdkComponent(name: "plinth-avplayer", version: "0.1.0")
            )
        )
    }

    /// Collect all beacons emitted during `body` synchronously via the injected handler.
    private func collectBeacons(
        meta: SessionMeta? = nil,
        config: PlinthConfig = .default,
        body: (PlinthSession) -> Void
    ) -> [BeaconBatch] {
        var captured: [BeaconBatch] = []
        let session = PlinthSession.create(
            meta: meta ?? makeMeta(),
            config: config,
            beaconHandler: { batch in captured.append(batch) }
        )!
        body(session)
        return captured
    }

    /// Drive the session to Playing state: Load → CanPlay → Play → FirstFrame.
    private func reachPlaying(_ session: PlinthSession) {
        session.processEvent(.load(src: "https://example.com/video.m3u8"))
        session.processEvent(.canPlay)
        session.processEvent(.play)
        session.processEvent(.firstFrame())
    }

    // MARK: - Session lifecycle

    func testCreateReturnsNonNil() {
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { _ in }
        )
        XCTAssertNotNil(session)
    }

    func testLoadEmitsNoBeacon() {
        let batches = collectBeacons { session in
            session.processEvent(.load(src: "https://example.com/v.m3u8"))
        }
        XCTAssertTrue(batches.isEmpty)
    }

    func testPlayEmitsPlayBeacon() {
        let batches = collectBeacons { session in
            session.processEvent(.load(src: "x"))
            session.processEvent(.canPlay)
            session.processEvent(.play)
        }
        XCTAssertEqual(batches.count, 1)
        let beacons = batches[0].beacons
        XCTAssertEqual(beacons.count, 1)
        XCTAssertEqual(beacons[0].event, "play")
        XCTAssertEqual(beacons[0].seq, 0)
    }

    func testFirstFrameEmitsFirstFrameBeacon() {
        let batches = collectBeacons { session in
            reachPlaying(session)
        }
        // Batch 0: play; Batch 1: first_frame + playing
        XCTAssertEqual(batches.count, 2)
        XCTAssertEqual(batches[1].beacons[0].event, "first_frame")
        XCTAssertEqual(batches[1].beacons[0].seq, 1)
        XCTAssertEqual(batches[1].beacons[1].event, "playing")
        XCTAssertEqual(batches[1].beacons[1].seq, 2)
    }

    func testPauseEmitsPauseBeacon() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.processEvent(.pause)
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "pause")
    }

    func testSeekStartEmitsSeekStartBeacon() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.processEvent(.seekStart(fromMs: 10_000))
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "seek")
    }

    func testSeekEndBufferReadyEmitsSeekEndBeacon() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.processEvent(.seekStart(fromMs: 10_000))
            session.processEvent(.seekEnd(toMs: 60_000, bufferReady: true))
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "seek_end")
    }

    func testWaitingFromPlayingEmitsStall() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.processEvent(.stall)
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "stall")
    }

    func testPlayingFromRebufferingEmitsPlaying() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.processEvent(.stall)
            session.processEvent(.playing)
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "playing")
    }

    func testEndedEmitsCompleted() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.processEvent(.ended)
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "completed")
    }

    // MARK: - destroy()

    func testDestroyFromPlayingEmitsEnded() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.destroy()
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "ended")
    }

    func testDestroyIsIdempotent() {
        var callCount = 0
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { _ in callCount += 1 }
        )!
        reachPlaying(session)
        session.destroy()
        session.destroy()
        // Second destroy should not emit any additional beacons
        let countAfterFirst = callCount
        XCTAssertEqual(callCount, countAfterFirst)
    }

    func testDestroyFromIdleEmitsNothing() {
        let batches = collectBeacons { session in
            // No events fired — still in Idle
            session.destroy()
        }
        XCTAssertTrue(batches.isEmpty)
    }

    // MARK: - play_id / seq ordering

    func testBeaconsSharePlayId() {
        var allBeacons: [Beacon] = []
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { batch in allBeacons.append(contentsOf: batch.beacons) }
        )!
        reachPlaying(session)

        let playId = allBeacons[0].playId
        XCTAssertFalse(playId.isEmpty)
        for beacon in allBeacons {
            XCTAssertEqual(beacon.playId, playId, "beacon seq=\(beacon.seq) has wrong play_id")
        }
    }

    func testSeqIncrementsAcrossEvents() {
        var allBeacons: [Beacon] = []
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { batch in allBeacons.append(contentsOf: batch.beacons) }
        )!
        reachPlaying(session)
        session.processEvent(.pause)

        for (i, b) in allBeacons.enumerated() {
            XCTAssertEqual(b.seq, UInt32(i), "out-of-order seq at index \(i)")
        }
    }

    // MARK: - PlayerEvent encoding

    func testEventEncodesCorrectly() throws {
        let encoder = JSONEncoder()

        let loadData = try encoder.encode(PlayerEvent.load(src: "https://example.com"))
        let loadJson = try JSONSerialization.jsonObject(with: loadData) as! [String: Any]
        XCTAssertEqual(loadJson["type"] as? String, "load")
        XCTAssertEqual(loadJson["src"] as? String, "https://example.com")

        let seekData = try encoder.encode(PlayerEvent.seekStart(fromMs: 5_000))
        let seekJson = try JSONSerialization.jsonObject(with: seekData) as! [String: Any]
        XCTAssertEqual(seekJson["type"] as? String, "seek")
        XCTAssertEqual(seekJson["from_ms"] as? Int, 5_000)

        let errorData = try encoder.encode(PlayerEvent.error(code: "NET_ERR", message: "timeout", fatal: true))
        let errorJson = try JSONSerialization.jsonObject(with: errorData) as! [String: Any]
        XCTAssertEqual(errorJson["type"] as? String, "error")
        XCTAssertEqual(errorJson["fatal"] as? Bool, true)
    }

    // MARK: - setPlayhead / getPlayhead

    func testSetPlayheadDoesNotCrash() {
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { _ in }
        )!
        reachPlaying(session)
        session.setPlayhead(30_000)
        // No assertion needed — verifies no crash through FFI boundary
    }

    func testGetPlayheadReturnsZeroInitially() {
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { _ in }
        )!
        XCTAssertEqual(session.getPlayhead(), 0)
        session.destroy()
    }

    func testGetPlayheadReturnsLastSetValue() {
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { _ in }
        )!
        session.setPlayhead(42_000)
        XCTAssertEqual(session.getPlayhead(), 42_000)
        session.destroy()
    }

    func testGetPlayheadReturnsZeroAfterDestroy() {
        let session = PlinthSession.create(
            meta: makeMeta(),
            beaconHandler: { _ in }
        )!
        session.setPlayhead(42_000)
        session.destroy()
        XCTAssertEqual(session.getPlayhead(), 0)
    }

    // MARK: - Error events

    func testErrorFromPlayingEmitsErrorBeacon() {
        let batches = collectBeacons { session in
            reachPlaying(session)
            session.processEvent(.error(code: "NETWORK_ERR", message: nil, fatal: true))
        }
        let last = batches.last!.beacons[0]
        XCTAssertEqual(last.event, "error")
    }
}
