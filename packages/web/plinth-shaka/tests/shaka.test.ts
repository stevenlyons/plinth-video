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
  });

  afterEach(() => {
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
  it("video 'seeking' uses lastPlayheadMs from previous timeupdate", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");

    const seekCall = mockSession.processEvent.mock.calls.find(
      (c) => (c.arguments[0] as any).type === "seek_start",
    );
    assert.deepStrictEqual(seekCall?.arguments[0], { type: "seek_start", from_ms: 5_000 });
  });

  // 11. seeked buffer ready → seek_end buffer_ready:true
  it("video 'seeked' with buffer ready → seek_end { buffer_ready: true }", async () => {
    instance = await setup(player, video, mockSession);
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

  // 12. seeked buffer empty → seek_end buffer_ready:false
  it("video 'seeked' with buffer empty → seek_end { buffer_ready: false }", async () => {
    instance = await setup(player, video, mockSession);
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
        framerate: 29.97,
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
});
