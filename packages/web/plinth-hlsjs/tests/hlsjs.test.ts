import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import Hls, { Events } from "hls.js";
import { PlinthHlsJs } from "../src/index.js";
import type { PlinthSession } from "@wirevice/plinth-js";

// ── Fake Hls ──────────────────────────────────────────────────────────────────

class FakeHls {
  levels = [
    { bitrate: 2_500_000, width: 1280, height: 720, videoCodec: "avc1.4d401f", attrs: {} },
  ];
  private handlers = new Map<string, Set<(event: string, data?: unknown) => void>>();

  on(event: string, handler: (event: string, data?: unknown) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off(event: string, handler: (event: string, data?: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, data?: unknown): void {
    this.handlers.get(event)?.forEach((h) => h(event, data));
  }

  handlerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

// ── Fake HTMLVideoElement ─────────────────────────────────────────────────────

class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 } as unknown as TimeRanges;
  error: { code: number; message?: string } | null = null;

  fire(name: string): void {
    this.dispatchEvent(new Event(name));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MockSession {
  processEvent: ReturnType<typeof mock.fn>;
  setPlayhead: ReturnType<typeof mock.fn>;
  getPlayhead: ReturnType<typeof mock.fn>;
  destroy: ReturnType<typeof mock.fn>;
}

function makeMockSession(): MockSession {
  return {
    processEvent: mock.fn(() => {}),
    setPlayhead: mock.fn(() => {}),
    getPlayhead: mock.fn(() => 0),
    destroy: mock.fn(() => {}),
  };
}

async function setup(
  hls: FakeHls,
  video: FakeVideo,
  mockSession: MockSession,
): Promise<PlinthHlsJs> {
  const sessionFactory = mock.fn(async () => mockSession as unknown as PlinthSession);
  return PlinthHlsJs.initialize(
    hls as unknown as Hls,
    video as unknown as HTMLVideoElement,
    { id: "vid-001", title: "Test Video" },
    { sessionFactory },
  );
}

function assertCalledWith(fn: ReturnType<typeof mock.fn>, ...expected: unknown[]): void {
  const matched = fn.mock.calls.some((call) => {
    try {
      assert.deepStrictEqual([...call.arguments], expected);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(matched, `Mock was not called with expected arguments: ${JSON.stringify(expected)}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PlinthHlsJs", () => {
  let hls: FakeHls;
  let video: FakeVideo;
  let mockSession: MockSession;
  let instance: PlinthHlsJs | null;

  beforeEach(() => {
    hls = new FakeHls();
    video = new FakeVideo();
    mockSession = makeMockSession();
    instance = null;
  });

  afterEach(() => {
    instance?.destroy();
    instance = null;
  });

  // 1. MANIFEST_LOADING → load
  it("MANIFEST_LOADING → processEvent({ type:'load', src })", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.MANIFEST_LOADING, { url: "http://example.com/test.m3u8" });

    assertCalledWith(mockSession.processEvent, {
      type: "load",
      src: "http://example.com/test.m3u8",
    });
  });

  // 2. MANIFEST_PARSED → can_play
  it("MANIFEST_PARSED → processEvent({ type:'can_play' })", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.MANIFEST_PARSED, {});

    assertCalledWith(mockSession.processEvent, { type: "can_play" });
  });

  // 2b. MANIFEST_PARSED while video already playing (autostart) → can_play then play
  it("MANIFEST_PARSED while video not paused → can_play then play", async () => {
    instance = await setup(hls, video, mockSession);
    video.paused = false; // simulate video.play() called before manifest loaded
    hls.emit(Events.MANIFEST_PARSED, {});

    const calls = mockSession.processEvent.mock.calls.map((c) => c.arguments[0]);
    assert.deepStrictEqual(calls, [{ type: "can_play" }, { type: "play" }]);
  });

  // 3. video play → play
  it("video 'play' → processEvent({ type:'play' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("play");

    assertCalledWith(mockSession.processEvent, { type: "play" });
  });

  // 4. video playing (first time) → first_frame
  it("video 'playing' (first time) → processEvent({ type:'first_frame' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("playing");

    assertCalledWith(mockSession.processEvent, { type: "first_frame" });
  });

  // 4b. video playing (subsequent) → playing
  it("video 'playing' (subsequent) → processEvent({ type:'playing' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("playing"); // first_frame
    mockSession.processEvent.mock.resetCalls();
    video.fire("playing"); // playing

    assertCalledWith(mockSession.processEvent, { type: "playing" });
  });

  // 5. video waiting (before first_frame) → waiting
  it("video 'waiting' before first_frame → processEvent({ type:'waiting' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("waiting");

    assertCalledWith(mockSession.processEvent, { type: "waiting" });
  });

  // 5b. video waiting (after first_frame) → stall
  it("video 'waiting' after first_frame → processEvent({ type:'stall' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("playing"); // first_frame
    mockSession.processEvent.mock.resetCalls();
    video.fire("waiting");

    assertCalledWith(mockSession.processEvent, { type: "stall" });
  });

  // 6. video pause → pause
  it("video 'pause' → processEvent({ type:'pause' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("pause");

    assertCalledWith(mockSession.processEvent, { type: "pause" });
  });

  // 7. video ended → ended
  it("video 'ended' → processEvent({ type:'ended' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("ended");

    assertCalledWith(mockSession.processEvent, { type: "ended" });
  });

  // 7b. pause while ended → no pause event (natural end suppresses pause)
  it("video 'pause' while ended → pause suppressed", async () => {
    instance = await setup(hls, video, mockSession);
    video.ended = true;
    video.fire("pause");

    assert.strictEqual(mockSession.processEvent.mock.callCount(), 0);
  });

  // 9. video timeupdate → setPlayhead(ms)
  it("video 'timeupdate' → setPlayhead(currentTime * 1000)", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 12.5;
    video.fire("timeupdate");

    assertCalledWith(mockSession.setPlayhead, 12_500);
  });

  // 10. video seeking → seek_start with lastPlayheadMs
  it("video 'seeking' uses lastPlayheadMs from previous timeupdate", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");

    const seekCall = mockSession.processEvent.mock.calls.find(
      (c) => (c.arguments[0] as any).type === "seek_start",
    );
    assert.deepStrictEqual(seekCall?.arguments[0], { type: "seek_start", from_ms: 5_000 });
  });

  // 11. video seeked (buffer ready) → seek_end buffer_ready:true
  it("video 'seeked' with buffer ready → seek_end { buffer_ready: true }", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 5.0;
    video.buffered = {
      length: 1,
      start: (_i: number) => 0,
      end: (_i: number) => 10,
    } as unknown as TimeRanges;
    video.fire("seeked");

    assertCalledWith(mockSession.processEvent, {
      type: "seek_end",
      to_ms: 5_000,
      buffer_ready: true,
    });
  });

  // 12. video seeked (buffer empty) → seek_end buffer_ready:false
  it("video 'seeked' with buffer empty → seek_end { buffer_ready: false }", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 15.0;
    video.buffered = {
      length: 1,
      start: (_i: number) => 0,
      end: (_i: number) => 10,
    } as unknown as TimeRanges;
    video.fire("seeked");

    assertCalledWith(mockSession.processEvent, {
      type: "seek_end",
      to_ms: 15_000,
      buffer_ready: false,
    });
  });

  // 13. LEVEL_SWITCHED → quality_change
  it("LEVEL_SWITCHED → processEvent({ type:'quality_change', quality })", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.LEVEL_SWITCHED, { level: 0 });

    assertCalledWith(mockSession.processEvent, {
      type: "quality_change",
      quality: {
        bitrate_bps: 2_500_000,
        width: 1280,
        height: 720,
        codec: "avc1.4d401f",
      },
    });
  });

  // 14. ERROR fatal → error event
  it("ERROR (fatal) → processEvent({ type:'error', fatal:true })", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.ERROR, {
      fatal: true,
      type: "networkError",
      details: "manifestLoadError",
    });

    assertCalledWith(mockSession.processEvent, {
      type: "error",
      code: "networkError",
      message: "manifestLoadError",
      fatal: true,
    });
  });

  // 15. ERROR non-fatal → NOT forwarded
  it("ERROR (non-fatal) → processEvent NOT called", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.ERROR, {
      fatal: false,
      type: "networkError",
      details: "fragLoadError",
    });

    assert.strictEqual(mockSession.processEvent.mock.callCount(), 0);
  });

  // 16. DESTROYING → session.destroy()
  it("DESTROYING → session.destroy() called", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.DESTROYING);

    assert.strictEqual(mockSession.destroy.mock.callCount(), 1);
    instance = null; // already destroyed, prevent double destroy in afterEach
  });

  // 17. video error → error event
  it("video 'error' → processEvent({ type:'error', code:'MEDIA_ERR_3', fatal:true })", async () => {
    instance = await setup(hls, video, mockSession);
    video.error = { code: 3, message: "MEDIA_ERR_DECODE" };
    video.fire("error");

    assertCalledWith(mockSession.processEvent, {
      type: "error",
      code: "MEDIA_ERR_3",
      fatal: true,
    });
  });

  // 18. destroy() removes all listeners and calls session.destroy()
  it("destroy() removes all listeners, calls session.destroy()", async () => {
    instance = await setup(hls, video, mockSession);
    instance.destroy();
    instance = null;

    // Events fired after destroy should be ignored
    hls.emit(Events.MANIFEST_LOADING, { url: "http://example.com/test.m3u8" });
    video.fire("play");

    assert.strictEqual(mockSession.processEvent.mock.callCount(), 0);
    assert.strictEqual(mockSession.destroy.mock.callCount(), 1);
  });

  // 19. destroy() is idempotent
  it("destroy() idempotent — second call is a no-op", async () => {
    instance = await setup(hls, video, mockSession);
    instance.destroy();
    instance.destroy();
    instance = null;

    assert.strictEqual(mockSession.destroy.mock.callCount(), 1);
  });

  // 20. seeked: currentTime falls in first of multiple ranges → buffer_ready: true
  it("seeked with multiple ranges — currentTime in first range → buffer_ready: true", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 3.0;
    // Two ranges: [0–5] and [10–20]
    video.buffered = {
      length: 2,
      start: (i: number) => [0, 10][i],
      end: (i: number) => [5, 20][i],
    } as unknown as TimeRanges;
    video.fire("seeked");

    assertCalledWith(mockSession.processEvent, {
      type: "seek_end",
      to_ms: 3_000,
      buffer_ready: true,
    });
  });

  // 21. seeked: currentTime falls in gap between ranges → buffer_ready: false
  it("seeked with multiple ranges — currentTime in gap → buffer_ready: false", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 7.0;
    // Two ranges: [0–5] and [10–20]; currentTime=7 is in the gap
    video.buffered = {
      length: 2,
      start: (i: number) => [0, 10][i],
      end: (i: number) => [5, 20][i],
    } as unknown as TimeRanges;
    video.fire("seeked");

    assertCalledWith(mockSession.processEvent, {
      type: "seek_end",
      to_ms: 7_000,
      buffer_ready: false,
    });
  });

  // 22. seeked: buffered is empty (length 0) → buffer_ready: false
  it("seeked with empty buffered (length 0) → buffer_ready: false", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 5.0;
    // FakeVideo.buffered defaults to length: 0
    video.fire("seeked");

    assertCalledWith(mockSession.processEvent, {
      type: "seek_end",
      to_ms: 5_000,
      buffer_ready: false,
    });
  });

  // 23. getPlayhead() delegates to session.getPlayhead()
  it("getPlayhead() delegates to session.getPlayhead()", async () => {
    mockSession.getPlayhead.mock.mockImplementation(() => 45_000);
    instance = await setup(hls, video, mockSession);

    assert.strictEqual(instance.getPlayhead(), 45_000);
    assert.strictEqual(mockSession.getPlayhead.mock.callCount(), 1);
  });

  // 24. getPlayhead() returns 0 and does not call session after destroy()
  it("getPlayhead() returns 0 after destroy()", async () => {
    mockSession.getPlayhead.mock.mockImplementation(() => 45_000);
    instance = await setup(hls, video, mockSession);
    instance.destroy();
    const result = instance.getPlayhead();
    instance = null;

    assert.strictEqual(result, 0);
    assert.strictEqual(mockSession.getPlayhead.mock.callCount(), 0);
  });
});
