import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { PlinthDashjs } from "../src/index.js";
import type { PlinthSession } from "@wirevice/plinth-js";

// ── FakePlayer ────────────────────────────────────────────────────────────────

const REPRESENTATIONS = [
  { index: 0, bandwidth: 800_000,   width: 640,  height: 360  },
  { index: 1, bandwidth: 2_500_000, width: 1280, height: 720  },
  { index: 2, bandwidth: 5_000_000, width: 1920, height: 1080 },
];

class FakePlayer {
  private listeners = new Map<string, Array<(e?: unknown) => void>>();
  private _source = "https://example.com/manifest.mpd";
  // currentRepIndex drives the auto-synthesized qualityChangeRequested payload
  currentRepIndex = 1;

  on(event: string, handler: (e?: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  off(event: string, handler: (e?: unknown) => void): void {
    const hs = this.listeners.get(event);
    if (!hs) return;
    const idx = hs.indexOf(handler);
    if (idx !== -1) hs.splice(idx, 1);
  }

  getSource(): string { return this._source; }

  fire(event: string, data?: unknown): void {
    // Synthesize dash.js QUALITY_CHANGE_REQUESTED event data automatically
    const payload = event === "qualityChangeRequested" && data === undefined
      ? { mediaType: "video", newRepresentation: REPRESENTATIONS[this.currentRepIndex] }
      : data;
    for (const h of [...(this.listeners.get(event) ?? [])]) h(payload);
  }
}

// ── FakeVideo ─────────────────────────────────────────────────────────────────

class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 } as unknown as TimeRanges;
  error: { code: number; message?: string } | null = null;

  fire(name: string): void {
    if (name === "seeking") this.seeking = true;
    if (name === "seeked") this.seeking = false;
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
): Promise<PlinthDashjs> {
  const sessionFactory = mock.fn(async () => mockSession as unknown as PlinthSession);
  return PlinthDashjs.initialize(
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

describe("PlinthDashjs", () => {
  let player: FakePlayer;
  let video: FakeVideo;
  let mockSession: MockSession;
  let instance: PlinthDashjs | null;

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

  // 1
  it("MANIFEST_LOADING_STARTED → processEvent({ type:'load', src }) using getSource()", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("manifestLoadingStarted");

    assertCalledWith(mockSession.processEvent, {
      type: "load",
      src: "https://example.com/manifest.mpd",
    });
  });

  // 2
  it("STREAM_INITIALIZED → processEvent({ type:'can_play' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("streamInitialized");

    assertCalledWith(mockSession.processEvent, { type: "can_play" });
  });

  // 2b. STREAM_INITIALIZED while video already playing (autostart) → can_play then play
  it("STREAM_INITIALIZED while video not paused → can_play then play", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = false;
    player.fire("streamInitialized");

    const calls = mockSession.processEvent.mock.calls.map((c) => c.arguments[0]);
    assert.deepStrictEqual(calls, [{ type: "can_play" }, { type: "play" }]);
  });

  // 3
  it("video 'waiting' before first_frame → processEvent({ type:'waiting' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("waiting");

    assertCalledWith(mockSession.processEvent, { type: "waiting" });
  });

  // 3b
  it("video 'waiting' after first_frame → processEvent({ type:'stall' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // sets hasFiredFirstFrame
    mockSession.processEvent.mock.resetCalls();
    video.fire("waiting");

    assertCalledWith(mockSession.processEvent, { type: "stall" });
  });

  // 3c
  it("video 'waiting' while seeking after first_frame → stall forwarded for seek_buffer tracking", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // sets hasFiredFirstFrame
    video.fire("seeking");
    mockSession.processEvent.mock.resetCalls();
    video.fire("waiting"); // must be forwarded so state machine tracks seek_buffer_ms

    const stallCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "stall",
    );
    assert.strictEqual(stallCalls.length, 1, "stall must be forwarded during seeking for seek_buffer tracking");
  });

  // 4
  it("video 'playing' after stall → processEvent({ type:'playing' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // first_frame
    mockSession.processEvent.mock.resetCalls();
    video.fire("playing"); // recovery

    assertCalledWith(mockSession.processEvent, { type: "playing" });
  });

  // 5
  it("video 'playing' (first, no prior quality event) → processEvent({ type:'first_frame' }) without quality", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing");

    assertCalledWith(mockSession.processEvent, { type: "first_frame" });
  });

  // 5a. first_frame carries quality when QUALITY_CHANGE_REQUESTED fired before playing
  it("video 'playing' (first, after qualityChangeRequested) → first_frame with quality", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRequested"); // sets lastRepresentation (index:1, 2500000, 1280×720)
    video.fire("playing");

    assertCalledWith(mockSession.processEvent, {
      type: "first_frame",
      quality: { bitrate_bps: 2_500_000, width: 1280, height: 720 },
    });
  });

  // 6
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

  // 7
  it("hasFiredFirstFrame resets on MANIFEST_LOADING_STARTED — second first_frame emitted after reload", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing");               // first_frame #1
    player.fire("manifestLoadingStarted");  // resets flag
    video.fire("playing");               // first_frame #2

    const firstFrameCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "first_frame",
    );
    assert.strictEqual(firstFrameCalls.length, 2);
  });

  // 8
  it("video 'play' → processEvent({ type:'play' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("play");

    assertCalledWith(mockSession.processEvent, { type: "play" });
  });

  // 9
  it("video 'pause' → processEvent({ type:'pause' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("pause");

    assertCalledWith(mockSession.processEvent, { type: "pause" });
  });

  // 10
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

  // 11. seek completes → seek_end emitted with buffer_ready, then playing replayed
  it("seek completes → seek_end emitted with buffer_ready", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = false;
    video.currentTime = 10.0;
    video.buffered = { length: 1, start: () => 0, end: () => 15 } as unknown as TimeRanges;
    video.fire("seeking");
    video.fire("seeked");
    mock.timers.tick(300);

    assertCalledWith(mockSession.processEvent, { type: "seek_end", to_ms: 10_000, buffer_ready: true });
    assertCalledWith(mockSession.processEvent, { type: "playing" });
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

  // 13
  it("video 'ended' → processEvent({ type:'ended' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("ended");

    assertCalledWith(mockSession.processEvent, { type: "ended" });
  });

  it("video 'pause' while ended → pause suppressed", async () => {
    instance = await setup(player, video, mockSession);
    video.ended = true;
    video.fire("pause");

    assert.strictEqual(mockSession.processEvent.mock.callCount(), 0);
  });

  it("video 'pause' during seeking → pause suppressed", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("seeking"); // seeking = true
    video.fire("pause");   // browser fires this during seek; must be suppressed

    const pauseCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "pause",
    );
    assert.strictEqual(pauseCalls.length, 0, "pause must be suppressed while seeking");
  });

  // 14
  it("video 'timeupdate' → setPlayhead(currentTime * 1000)", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 12.5;
    video.fire("timeupdate");

    assertCalledWith(mockSession.setPlayhead, 12_500);
  });

  // 15
  it("QUALITY_CHANGE_REQUESTED → processEvent({ type:'quality_change', quality })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRequested");

    assertCalledWith(mockSession.processEvent, {
      type: "quality_change",
      quality: {
        bitrate_bps: 2_500_000,
        width: 1280,
        height: 720,
      },
    });
  });

  // 16
  it("QUALITY_CHANGE_REQUESTED with same quality index → quality_change emitted only once", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRequested");
    player.fire("qualityChangeRequested"); // same quality index — no change

    const qualityCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "quality_change",
    );
    assert.strictEqual(qualityCalls.length, 1);
  });

  // 17
  it("QUALITY_CHANGE_REQUESTED with different quality index → quality_change emitted each time", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRequested"); // quality index 1 → 2_500_000 bps

    // swap to a lower rendition (index 0 → 800_000 bps)
    player.currentRepIndex = 0;
    player.fire("qualityChangeRequested");

    const qualityCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "quality_change",
    );
    assert.strictEqual(qualityCalls.length, 2);
    assert.strictEqual((qualityCalls[1].arguments[0] as any).quality.bitrate_bps, 800_000);
  });

  // 18
  it("ERROR event → processEvent({ type:'error', fatal: true })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("error", { code: 34, message: "manifest error" });

    assertCalledWith(mockSession.processEvent, {
      type: "error",
      code: "34",
      message: "manifest error",
      fatal: true,
    });
  });

  // 19
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

  // 20
  it("destroy() removes all listeners — post-destroy events ignored", async () => {
    instance = await setup(player, video, mockSession);
    instance.destroy();
    instance = null;

    player.fire("manifestLoadingStarted");
    player.fire("streamInitialized");
    video.fire("waiting");
    video.fire("playing");
    video.fire("play");
    video.fire("pause");

    assert.strictEqual(mockSession.processEvent.mock.callCount(), 0);
    assert.strictEqual(mockSession.destroy.mock.callCount(), 1);
  });

  // 21
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

  // 23. seek_end emitted after 300ms debounce with to_ms and buffer_ready, then playing replayed
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
    assertCalledWith(mockSession.processEvent, { type: "playing" });
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

  // 26. stall fires normally after debounce has settled
  it("stall emits normally after seek debounce has settled", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // hasFiredFirstFrame = true
    video.fire("seeking");
    video.fire("seeked");
    mock.timers.tick(300); // settle — isSeeking = false
    mockSession.processEvent.mock.resetCalls();
    video.fire("waiting");

    assertCalledWith(mockSession.processEvent, { type: "stall" });
  });

  // 27. buffer_ready=true when video is playing at debounce time (race condition guard)
  it("seek_end buffer_ready=true when video is not paused at debounce time", async () => {
    instance = await setup(player, video, mockSession);
    video.paused = false;
    video.buffered = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges; // no ranges
    video.fire("seeking");
    video.fire("seeked");
    mock.timers.tick(300);

    const seekEndCall = mockSession.processEvent.mock.calls.find(
      (c) => (c.arguments[0] as any).type === "seek_end",
    );
    assert.ok(seekEndCall, "seek_end must be emitted");
    assert.strictEqual((seekEndCall!.arguments[0] as any).buffer_ready, true,
      "buffer_ready must be true when video is playing at debounce time");
    assertCalledWith(mockSession.processEvent, { type: "playing" });
  });

  // 29. 'ended' during seek — seek_end settled before ended so state machine exits Seeking
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

  // 30. destroy() cancels pending debounce — playing not emitted after destroy
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
