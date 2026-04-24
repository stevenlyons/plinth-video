import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { PlinthShaka } from "../src/index.js";
import type { PlinthSession } from "@wirevice/plinth-js";

// ── FakePlayer ────────────────────────────────────────────────────────────────

class FakePlayer extends EventTarget {
  private _assetUri = "https://example.com/manifest.mpd";
  private _tracks = [
    {
      active: true,
      bandwidth: 2_500_000,
      width: 1280,
      height: 720,
      frameRate: 29.97,
      videoCodec: "avc1.4d401f",
    },
  ];

  getAssetUri(): string { return this._assetUri; }
  getVariantTracks(): typeof this._tracks { return this._tracks; }

  fireLoading(): void { this.dispatchEvent(new Event("loading")); }
  fireLoaded(): void  { this.dispatchEvent(new Event("loaded")); }

  fireBuffering(buffering: boolean): void {
    const e = new Event("buffering");
    (e as any).buffering = buffering;
    this.dispatchEvent(e);
  }

  fireAdaptation(): void { this.dispatchEvent(new Event("adaptation")); }

  fireError(code: number, severity: number, message = "test error"): void {
    const e = new Event("error");
    (e as any).detail = { code, severity, message };
    this.dispatchEvent(e);
  }

  fireUnloading(): void { this.dispatchEvent(new Event("unloading")); }
}

// ── FakeVideo ─────────────────────────────────────────────────────────────────

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
  destroy: ReturnType<typeof mock.fn>;
}

function makeMockSession(): MockSession {
  return {
    processEvent: mock.fn(() => {}),
    setPlayhead: mock.fn(() => {}),
    destroy: mock.fn(() => {}),
  };
}

async function setup(
  player: FakePlayer,
  video: FakeVideo,
  mockSession: MockSession,
): Promise<PlinthShaka> {
  const sessionFactory = mock.fn(async () => mockSession as unknown as PlinthSession);
  return PlinthShaka.initialize(
    player as any,
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

describe("PlinthShaka", () => {
  let player: FakePlayer;
  let video: FakeVideo;
  let mockSession: MockSession;
  let instance: PlinthShaka | null;

  beforeEach(() => {
    player = new FakePlayer();
    video = new FakeVideo();
    mockSession = makeMockSession();
    instance = null;
    mock.timers.enable(["setTimeout"]);
  });

  afterEach(() => {
    mock.timers.reset();
    instance?.destroy();
    instance = null;
  });

  // 1. loading → load with URI from getAssetUri()
  it("'loading' → processEvent({ type:'load', src }) using getAssetUri()", async () => {
    instance = await setup(player, video, mockSession);
    player.fireLoading();

    assertCalledWith(mockSession.processEvent, {
      type: "load",
      src: "https://example.com/manifest.mpd",
    });
  });

  // 2. loaded → can_play
  it("'loaded' → processEvent({ type:'can_play' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireLoaded();

    assertCalledWith(mockSession.processEvent, { type: "can_play" });
  });

  // 2b. loaded while video already playing (autostart) → can_play then play
  it("'loaded' while video not paused → can_play then play", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = false;
    player.fireLoaded();

    const calls = mockSession.processEvent.mock.calls.map((c) => c.arguments[0]);
    assert.deepStrictEqual(calls, [{ type: "can_play" }, { type: "play" }]);
  });

  // 3. buffering(true) before first_frame → waiting
  it("'buffering' (true) before first_frame → processEvent({ type:'waiting' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireBuffering(true);

    assertCalledWith(mockSession.processEvent, { type: "waiting" });
  });

  // 3b. buffering(true) after first_frame → stall
  it("'buffering' (true) after first_frame → processEvent({ type:'stall' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // sets hasFiredFirstFrame
    mockSession.processEvent.mock.resetCalls();
    player.fireBuffering(true);

    assertCalledWith(mockSession.processEvent, { type: "stall" });
  });

  // 4. buffering(false) → playing
  it("'buffering' (false) → processEvent({ type:'playing' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireBuffering(false);

    assertCalledWith(mockSession.processEvent, { type: "playing" });
  });

  // 5. playing (first) → first_frame
  it("video 'playing' (first time) → processEvent({ type:'first_frame' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing");

    assertCalledWith(mockSession.processEvent, { type: "first_frame" });
  });

  // 6. playing (subsequent) → no-op
  it("video 'playing' (subsequent) → first_frame emitted only once", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing");
    video.fire("playing");
    video.fire("playing");

    const firstFrameCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "first_frame",
    );
    assert.strictEqual(firstFrameCalls.length, 1);
  });

  // 7. hasFiredFirstFrame resets on loading
  it("hasFiredFirstFrame resets on 'loading' — second first_frame emitted after reload", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // first_frame #1
    player.fireLoading();  // resets flag
    video.fire("playing"); // first_frame #2

    const firstFrameCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "first_frame",
    );
    assert.strictEqual(firstFrameCalls.length, 2);
  });

  // 8. play → play
  it("video 'play' → processEvent({ type:'play' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("play");

    assertCalledWith(mockSession.processEvent, { type: "play" });
  });

  // 9. pause → pause
  it("video 'pause' → processEvent({ type:'pause' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("pause");

    assertCalledWith(mockSession.processEvent, { type: "pause" });
  });

  // 10. seeking uses lastPlayheadMs from prior timeupdate
  it("seek > 500ms → seek_start { from_ms } and seek_end emitted on seeked", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");    // lastPlayheadMs = 5000
    video.fire("seeking");       // _pendingSeekFrom = 5000
    video.currentTime = 10.0;   // seeked to 10s (distance = 5000 > 500)
    video.fire("seeked");
    mock.timers.tick(300);

    const seekCall = mockSession.processEvent.mock.calls.find(
      (c) => (c.arguments[0] as any).type === "seek",
    );
    assert.deepStrictEqual(seekCall?.arguments[0], { type: "seek", from_ms: 5_000 });
  });

  // 11. seek completes → seek_end emitted with buffer_ready
  it("seek completes → seek_end emitted with buffer_ready", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = false;
    video.currentTime = 10.0;
    video.buffered = { length: 1, start: () => 0, end: () => 15 } as unknown as TimeRanges;
    video.fire("seeking");
    video.fire("seeked");
    mock.timers.tick(300);

    assertCalledWith(mockSession.processEvent, { type: "seek_end", to_ms: 10_000, buffer_ready: true });
  });

  // 12. seek completes while paused → seek_end emitted, playing NOT emitted from debounce
  it("seek completes while video paused → seek_end emitted, playing not emitted", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = true;
    video.fire("seeking");
    video.fire("seeked");
    mock.timers.tick(300);

    const seekEndCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "seek_end",
    );
    assert.strictEqual(seekEndCalls.length, 1, "seek_end must be emitted even when paused");
    const playingCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "playing",
    );
    assert.strictEqual(playingCalls.length, 0, "playing must not be emitted from debounce");
  });

  // 13. ended → ended
  it("video 'ended' → processEvent({ type:'ended' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("ended");

    assertCalledWith(mockSession.processEvent, { type: "ended" });
  });

  // 13b. pause while ended → suppressed
  it("video 'pause' while ended → pause suppressed", async () => {
    instance = await setup(player, video, mockSession);
    video.ended = true;
    video.fire("pause");

    assert.strictEqual(mockSession.processEvent.mock.callCount(), 0);
  });

  // 14. timeupdate → setPlayhead(ms)
  it("video 'timeupdate' → setPlayhead(currentTime * 1000)", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 12.5;
    video.fire("timeupdate");

    assertCalledWith(mockSession.setPlayhead, 12_500);
  });

  // 15. adaptation → quality_change with all track fields
  it("'adaptation' → processEvent({ type:'quality_change', quality })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireAdaptation();

    assertCalledWith(mockSession.processEvent, {
      type: "quality_change",
      quality: {
        bitrate_bps: 2_500_000,
        width: 1280,
        height: 720,
        framerate: "29.97",
        codec: "avc1.4d401f",
      },
    });
  });

  // 16. Shaka error severity=2 (CRITICAL) → fatal:true
  it("Shaka 'error' (severity=2) → processEvent({ type:'error', fatal:true })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireError(3016, 2, "CRITICAL error");

    assertCalledWith(mockSession.processEvent, {
      type: "error",
      code: "3016",
      message: "CRITICAL error",
      fatal: true,
    });
  });

  // 17. Shaka error severity=1 (RECOVERABLE) → fatal:false
  it("Shaka 'error' (severity=1) → processEvent({ type:'error', fatal:false })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireError(1001, 1, "recoverable error");

    assertCalledWith(mockSession.processEvent, {
      type: "error",
      code: "1001",
      message: "recoverable error",
      fatal: false,
    });
  });

  // 18. video element error → MEDIA_ERR_* fatal
  it("video 'error' → processEvent({ type:'error', code:'MEDIA_ERR_3', fatal:true })", async () => {
    instance = await setup(player, video, mockSession);
    video.error = { code: 3, message: "MEDIA_ERR_DECODE" };
    video.fire("error");

    assertCalledWith(mockSession.processEvent, {
      type: "error",
      code: "MEDIA_ERR_3",
      fatal: true,
    });
  });

  // 19. unloading → session.destroy() called
  it("'unloading' → session.destroy() called", async () => {
    instance = await setup(player, video, mockSession);
    player.fireUnloading();

    assert.strictEqual(mockSession.destroy.mock.callCount(), 1);
    instance = null; // already destroyed
  });

  // 20. destroy() removes all listeners — post-destroy events are no-ops
  it("destroy() removes all listeners — post-destroy events ignored", async () => {
    instance = await setup(player, video, mockSession);
    instance.destroy();
    instance = null;

    player.fireLoading();
    player.fireLoaded();
    player.fireBuffering(true);
    video.fire("play");
    video.fire("playing");

    assert.strictEqual(mockSession.processEvent.mock.callCount(), 0);
    assert.strictEqual(mockSession.destroy.mock.callCount(), 1);
  });

  // 21. destroy() idempotent — second call is a no-op
  it("destroy() idempotent — second call does not double-destroy", async () => {
    instance = await setup(player, video, mockSession);
    instance.destroy();
    instance.destroy();
    instance = null;

    assert.strictEqual(mockSession.destroy.mock.callCount(), 1);
  });

  // ── Seek debounce ──────────────────────────────────────────────────────────

  // 22. seek_start emitted immediately on seeking; seek_end deferred until debounce fires
  it("seek_start emitted on seeking; seek_end not emitted until debounce fires", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");

    assertCalledWith(mockSession.processEvent, { type: "seek", from_ms: 5_000 });
    const hasSeekEnd = mockSession.processEvent.mock.calls.some(
      (c) => (c.arguments[0] as any).type === "seek_end",
    );
    assert.ok(!hasSeekEnd, "seek_end must not emit before debounce window");
  });

  // 23. seek_end emitted after 300ms debounce with to_ms and buffer_ready
  it("seek_end emitted after 300ms debounce fires", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = false;
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");
    video.currentTime = 10.0;
    video.buffered = { length: 1, start: () => 0, end: () => 15 } as unknown as TimeRanges;
    video.fire("seeked");
    mock.timers.tick(300);

    assertCalledWith(mockSession.processEvent, { type: "seek", from_ms: 5_000 });
    assertCalledWith(mockSession.processEvent, { type: "seek_end", to_ms: 10_000, buffer_ready: true });
  });

  // 24. scrubbing emits exactly one seek for many seeking/seeked pairs
  it("scrubbing (multiple seeking/seeked pairs) emits exactly one seek_start", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate"); // lastPlayheadMs = 5000
    for (let t = 10; t <= 25; t += 5) {
      video.fire("seeking");
      video.currentTime = t;
      video.fire("seeked");
    }
    mock.timers.tick(300);

    const seekStartCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "seek",
    );
    assert.strictEqual(seekStartCalls.length, 1, "exactly one seek_start for entire scrub");
  });

  // 25. scrubbing preserves original seek origin
  it("scrubbing: seek_start.from_ms is position before first seeking event", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");
    video.currentTime = 10.0;
    video.fire("seeked");
    video.fire("seeking"); // second seeking during scrub — must not overwrite origin
    video.currentTime = 20.0;
    video.fire("seeked");
    mock.timers.tick(300);

    const seekStartCall = mockSession.processEvent.mock.calls.find(
      (c) => (c.arguments[0] as any).type === "seek",
    );
    assert.deepStrictEqual(seekStartCall?.arguments[0], { type: "seek", from_ms: 5_000 });
  });

  // 26. stall forwarded during seeking so state machine can track seek_buffer_* metrics
  it("stall emitted during seek so seek_buffer metrics can be tracked", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // hasFiredFirstFrame = true
    mockSession.processEvent.mock.resetCalls();
    video.fire("seeking");
    player.fireBuffering(true);

    const stallCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "stall",
    );
    assert.strictEqual(stallCalls.length, 1, "stall forwarded during seeking for seek_buffer tracking");
  });

  // 27. stall fires normally after debounce has settled
  it("stall emits normally after seek debounce has settled", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // hasFiredFirstFrame = true
    video.fire("seeking");
    video.fire("seeked");
    mock.timers.tick(300); // settle — isSeeking = false
    mockSession.processEvent.mock.resetCalls();
    player.fireBuffering(true);

    assertCalledWith(mockSession.processEvent, { type: "stall" });
  });

  // 28. 'ended' during seek — seek_end settled before ended so state machine exits Seeking
  it("'ended' during seek debounce → seek_end emitted then ended", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // hasFiredFirstFrame = true
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");
    video.fire("seeked"); // debounce started (not yet fired)
    video.fire("ended"); // fires before the 300ms debounce resolves

    const calls = mockSession.processEvent.mock.calls.map((c) => (c.arguments[0] as any).type);
    const seekEndIdx = calls.lastIndexOf("seek_end");
    const endedIdx = calls.lastIndexOf("ended");
    assert.ok(seekEndIdx !== -1, "seek_end must be emitted");
    assert.ok(endedIdx !== -1, "ended must be emitted");
    assert.ok(seekEndIdx < endedIdx, "seek_end must precede ended");
  });

  // 29. destroy() cancels pending debounce — playing not emitted after destroy
  it("destroy() cancels pending seek debounce", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = false;
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");  // seek_start emitted immediately
    video.currentTime = 10.0;
    video.fire("seeked");
    instance.destroy();
    instance = null;
    mock.timers.tick(300);

    // seek_start was emitted on seeking; playing must NOT fire after destroy
    const playingCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "playing",
    );
    assert.strictEqual(playingCalls.length, 0, "playing must not fire after destroy");
  });
});
