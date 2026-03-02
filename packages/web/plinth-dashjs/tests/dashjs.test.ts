import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { PlinthDashjs } from "../src/index.js";
import type { PlinthSession } from "@plinth/js";

// ── FakePlayer ────────────────────────────────────────────────────────────────

class FakePlayer {
  private listeners = new Map<string, Array<(e?: unknown) => void>>();
  private _source = "https://example.com/manifest.mpd";
  private _representation = {
    bandwidth: 2_500_000,
    width: 1280,
    height: 720,
    frameRate: 29.97,
    codecs: "avc1.4d401f",
  };

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
  getCurrentRepresentationForType(): typeof this._representation { return this._representation; }

  fire(event: string, data?: unknown): void {
    for (const h of [...(this.listeners.get(event) ?? [])]) h(data);
  }
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
): Promise<PlinthDashjs> {
  const sessionFactory = mock(async () => mockSession as unknown as PlinthSession);
  return PlinthDashjs.initialize(
    player as any,
    video as unknown as HTMLVideoElement,
    { id: "vid-001", title: "Test Video" },
    { sessionFactory },
  );
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
  });

  afterEach(() => {
    instance?.destroy();
    instance = null;
  });

  // 1
  it("MANIFEST_LOADING_STARTED → processEvent({ type:'load', src }) using getSource()", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("manifestLoadingStarted");

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "load",
      src: "https://example.com/manifest.mpd",
    });
  });

  // 2
  it("STREAM_INITIALIZED → processEvent({ type:'can_play' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("streamInitialized");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "can_play" });
  });

  // 3
  it("PLAYBACK_STALLED → processEvent({ type:'waiting' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStalled");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "waiting" });
  });

  // 4
  it("BUFFER_LOADED → processEvent({ type:'can_play_through' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("bufferLoaded");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "can_play_through" });
  });

  // 5
  it("PLAYBACK_STARTED (first) → processEvent({ type:'first_frame' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStarted");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "first_frame" });
  });

  // 6
  it("PLAYBACK_STARTED (subsequent) → first_frame emitted only once", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStarted");
    player.fire("playbackStarted");
    player.fire("playbackStarted");

    const firstFrameCalls = (mockSession.processEvent.mock.calls as unknown[][]).filter(
      (c) => (c[0] as any).type === "first_frame",
    );
    expect(firstFrameCalls).toHaveLength(1);
  });

  // 7
  it("hasFiredFirstFrame resets on MANIFEST_LOADING_STARTED — second first_frame emitted after reload", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStarted");         // first_frame #1
    player.fire("manifestLoadingStarted");  // resets flag
    player.fire("playbackStarted");         // first_frame #2

    const firstFrameCalls = (mockSession.processEvent.mock.calls as unknown[][]).filter(
      (c) => (c[0] as any).type === "first_frame",
    );
    expect(firstFrameCalls).toHaveLength(2);
  });

  // 8
  it("video 'play' → processEvent({ type:'play' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("play");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "play" });
  });

  // 9
  it("video 'pause' → processEvent({ type:'pause' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("pause");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "pause" });
  });

  // 10
  it("video 'seeking' uses lastPlayheadMs from previous timeupdate", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");

    const calls = mockSession.processEvent.mock.calls as unknown[][];
    const seekCall = calls.find((c) => (c[0] as any).type === "seek_start");
    expect(seekCall?.[0]).toEqual({ type: "seek_start", from_ms: 5_000 });
  });

  // 11
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

  // 12
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

  // 13
  it("video 'ended' → processEvent({ type:'ended' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("ended");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "ended" });
  });

  // 14
  it("video 'timeupdate' → setPlayhead(currentTime * 1000)", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 12.5;
    video.fire("timeupdate");

    expect(mockSession.setPlayhead).toHaveBeenCalledWith(12_500);
  });

  // 15
  it("QUALITY_CHANGE_RENDERED → processEvent({ type:'quality_change', quality })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRendered");

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

  // 16
  it("ERROR event → processEvent({ type:'error', fatal: true })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("error", { code: 34, message: "manifest error" });

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "error",
      code: "34",
      message: "manifest error",
      fatal: true,
    });
  });

  // 17
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

  // 18
  it("destroy() removes all listeners — post-destroy events ignored", async () => {
    instance = await setup(player, video, mockSession);
    instance.destroy();
    instance = null;

    player.fire("manifestLoadingStarted");
    player.fire("streamInitialized");
    player.fire("playbackStalled");
    video.fire("play");
    video.fire("pause");

    expect(mockSession.processEvent).not.toHaveBeenCalled();
    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });

  // 19
  it("destroy() idempotent — second call does not double-destroy", async () => {
    instance = await setup(player, video, mockSession);
    instance.destroy();
    instance.destroy();
    instance = null;

    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });
});
