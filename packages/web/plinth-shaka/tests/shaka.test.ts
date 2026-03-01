import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PlinthShaka } from "../src/index.js";
import type { PlinthSession } from "@plinth/js";

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
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 } as unknown as TimeRanges;
  error: { code: number; message?: string } | null = null;

  fire(name: string): void {
    this.dispatchEvent(new Event(name));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MockSession {
  processEvent: ReturnType<typeof mock>;
  setPlayhead: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
}

function makeMockSession(): MockSession {
  return {
    processEvent: mock(() => {}),
    setPlayhead: mock(() => {}),
    destroy: mock(() => {}),
  };
}

async function setup(
  player: FakePlayer,
  video: FakeVideo,
  mockSession: MockSession,
): Promise<PlinthShaka> {
  const sessionFactory = mock(async () => mockSession as unknown as PlinthSession);
  return PlinthShaka.initialize(
    player as any,
    video as unknown as HTMLVideoElement,
    { id: "vid-001", title: "Test Video" },
    { sessionFactory },
  );
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "load",
      src: "https://example.com/manifest.mpd",
    });
  });

  // 2. loaded → can_play
  it("'loaded' → processEvent({ type:'can_play' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireLoaded();

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "can_play" });
  });

  // 3. buffering(true) → waiting
  it("'buffering' (true) → processEvent({ type:'waiting' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireBuffering(true);

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "waiting" });
  });

  // 4. buffering(false) → can_play_through
  it("'buffering' (false) → processEvent({ type:'can_play_through' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireBuffering(false);

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "can_play_through" });
  });

  // 5. playing (first) → first_frame
  it("video 'playing' (first time) → processEvent({ type:'first_frame' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "first_frame" });
  });

  // 6. playing (subsequent) → no-op
  it("video 'playing' (subsequent) → first_frame emitted only once", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing");
    video.fire("playing");
    video.fire("playing");

    const firstFrameCalls = (mockSession.processEvent.mock.calls as unknown[][]).filter(
      (c) => (c[0] as any).type === "first_frame",
    );
    expect(firstFrameCalls).toHaveLength(1);
  });

  // 7. hasFiredFirstFrame resets on loading
  it("hasFiredFirstFrame resets on 'loading' — second first_frame emitted after reload", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("playing"); // first_frame #1
    player.fireLoading();  // resets flag
    video.fire("playing"); // first_frame #2

    const firstFrameCalls = (mockSession.processEvent.mock.calls as unknown[][]).filter(
      (c) => (c[0] as any).type === "first_frame",
    );
    expect(firstFrameCalls).toHaveLength(2);
  });

  // 8. play → play
  it("video 'play' → processEvent({ type:'play' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("play");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "play" });
  });

  // 9. pause → pause
  it("video 'pause' → processEvent({ type:'pause' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("pause");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "pause" });
  });

  // 10. seeking uses lastPlayheadMs from prior timeupdate
  it("video 'seeking' uses lastPlayheadMs from previous timeupdate", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");

    const calls = mockSession.processEvent.mock.calls as unknown[][];
    const seekCall = calls.find((c) => (c[0] as any).type === "seek_start");
    expect(seekCall?.[0]).toEqual({ type: "seek_start", from_ms: 5_000 });
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "seek_end",
      to_ms: 15_000,
      buffer_ready: false,
    });
  });

  // 13. ended → ended
  it("video 'ended' → processEvent({ type:'ended' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("ended");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "ended" });
  });

  // 14. timeupdate → setPlayhead(ms)
  it("video 'timeupdate' → setPlayhead(currentTime * 1000)", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 12.5;
    video.fire("timeupdate");

    expect(mockSession.setPlayhead).toHaveBeenCalledWith(12_500);
  });

  // 15. adaptation → quality_change with all track fields
  it("'adaptation' → processEvent({ type:'quality_change', quality })", async () => {
    instance = await setup(player, video, mockSession);
    player.fireAdaptation();

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "error",
      code: "MEDIA_ERR_3",
      fatal: true,
    });
  });

  // 19. unloading → session.destroy() called
  it("'unloading' → session.destroy() called", async () => {
    instance = await setup(player, video, mockSession);
    player.fireUnloading();

    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
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

    expect(mockSession.processEvent).not.toHaveBeenCalled();
    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });

  // 21. destroy() idempotent — second call is a no-op
  it("destroy() idempotent — second call does not double-destroy", async () => {
    instance = await setup(player, video, mockSession);
    instance.destroy();
    instance.destroy();
    instance = null;

    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });
});
