import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { PlinthDashjs } from "../src/index.js";
import type { PlinthSession } from "@plinth/js";

// ── FakePlayer ────────────────────────────────────────────────────────────────

class FakePlayer {
  private listeners = new Map<string, Array<(e?: unknown) => void>>();
  private _source = "https://example.com/manifest.mpd";
  _representation = {
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
  });

  afterEach(() => {
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

  // 3
  it("PLAYBACK_STALLED → processEvent({ type:'waiting' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStalled");

    assertCalledWith(mockSession.processEvent, { type: "waiting" });
  });

  // 4
  it("BUFFER_LOADED → processEvent({ type:'can_play_through' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("bufferLoaded");

    assertCalledWith(mockSession.processEvent, { type: "can_play_through" });
  });

  // 5
  it("PLAYBACK_STARTED (first) → processEvent({ type:'first_frame' })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStarted");

    assertCalledWith(mockSession.processEvent, { type: "first_frame" });
  });

  // 6
  it("PLAYBACK_STARTED (subsequent) → first_frame emitted only once", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStarted");
    player.fire("playbackStarted");
    player.fire("playbackStarted");

    const firstFrameCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "first_frame",
    );
    assert.strictEqual(firstFrameCalls.length, 1);
  });

  // 7
  it("hasFiredFirstFrame resets on MANIFEST_LOADING_STARTED — second first_frame emitted after reload", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("playbackStarted");         // first_frame #1
    player.fire("manifestLoadingStarted");  // resets flag
    player.fire("playbackStarted");         // first_frame #2

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

    assertCalledWith(mockSession.processEvent, {
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

    assertCalledWith(mockSession.processEvent, {
      type: "seek_end",
      to_ms: 15_000,
      buffer_ready: false,
    });
  });

  // 13
  it("video 'ended' → processEvent({ type:'ended' })", async () => {
    instance = await setup(player, video, mockSession);
    video.fire("ended");

    assertCalledWith(mockSession.processEvent, { type: "ended" });
  });

  // 14
  it("video 'timeupdate' → setPlayhead(currentTime * 1000)", async () => {
    instance = await setup(player, video, mockSession);
    video.currentTime = 12.5;
    video.fire("timeupdate");

    assertCalledWith(mockSession.setPlayhead, 12_500);
  });

  // 15
  it("QUALITY_CHANGE_RENDERED → processEvent({ type:'quality_change', quality })", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRendered");

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

  // 16
  it("QUALITY_CHANGE_RENDERED with same bandwidth → quality_change emitted only once", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRendered");
    player.fire("qualityChangeRendered"); // same representation — no change

    const qualityCalls = mockSession.processEvent.mock.calls.filter(
      (c) => (c.arguments[0] as any).type === "quality_change",
    );
    assert.strictEqual(qualityCalls.length, 1);
  });

  // 17
  it("QUALITY_CHANGE_RENDERED with different bandwidth → quality_change emitted each time", async () => {
    instance = await setup(player, video, mockSession);
    player.fire("qualityChangeRendered"); // bandwidth 2_500_000

    // swap to a lower rendition
    player._representation = { bandwidth: 800_000, width: 640, height: 360, frameRate: 29.97, codecs: "avc1.4d401f" };
    player.fire("qualityChangeRendered");

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
    player.fire("playbackStalled");
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
});
