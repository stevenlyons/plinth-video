import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import Hls, { Events } from "hls.js";
import { PlinthHlsJs } from "../src/index.js";
import type { PlinthSession } from "@plinth/js";

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
  getPlayhead: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
}

function makeMockSession(): MockSession {
  return {
    processEvent: mock(() => {}),
    setPlayhead: mock(() => {}),
    getPlayhead: mock(() => 0),
    destroy: mock(() => {}),
  };
}

async function setup(
  hls: FakeHls,
  video: FakeVideo,
  mockSession: MockSession,
): Promise<PlinthHlsJs> {
  const sessionFactory = mock(async () => mockSession as unknown as PlinthSession);
  return PlinthHlsJs.initialize(
    hls as unknown as Hls,
    video as unknown as HTMLVideoElement,
    { id: "vid-001", title: "Test Video" },
    { sessionFactory },
  );
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "load",
      src: "http://example.com/test.m3u8",
    });
  });

  // 2. MANIFEST_PARSED → can_play
  it("MANIFEST_PARSED → processEvent({ type:'can_play' })", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.MANIFEST_PARSED, {});

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "can_play" });
  });

  // 3. video play → play
  it("video 'play' → processEvent({ type:'play' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("play");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "play" });
  });

  // 4. video playing → first_frame
  it("video 'playing' → processEvent({ type:'first_frame' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("playing");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "first_frame" });
  });

  // 5. video waiting → waiting
  it("video 'waiting' → processEvent({ type:'waiting' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("waiting");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "waiting" });
  });

  // 6. video pause → pause
  it("video 'pause' → processEvent({ type:'pause' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("pause");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "pause" });
  });

  // 7. video ended → ended
  it("video 'ended' → processEvent({ type:'ended' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("ended");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "ended" });
  });

  // 8. video canplaythrough → can_play_through
  it("video 'canplaythrough' → processEvent({ type:'can_play_through' })", async () => {
    instance = await setup(hls, video, mockSession);
    video.fire("canplaythrough");

    expect(mockSession.processEvent).toHaveBeenCalledWith({ type: "can_play_through" });
  });

  // 9. video timeupdate → setPlayhead(ms)
  it("video 'timeupdate' → setPlayhead(currentTime * 1000)", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 12.5;
    video.fire("timeupdate");

    expect(mockSession.setPlayhead).toHaveBeenCalledWith(12_500);
  });

  // 10. video seeking → seek_start with lastPlayheadMs
  it("video 'seeking' uses lastPlayheadMs from previous timeupdate", async () => {
    instance = await setup(hls, video, mockSession);
    video.currentTime = 5.0;
    video.fire("timeupdate");
    video.fire("seeking");

    const calls = mockSession.processEvent.mock.calls as unknown[][];
    const seekCall = calls.find((c) => (c[0] as any).type === "seek_start");
    expect(seekCall?.[0]).toEqual({ type: "seek_start", from_ms: 5_000 });
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "seek_end",
      to_ms: 15_000,
      buffer_ready: false,
    });
  });

  // 13. LEVEL_SWITCHED → quality_change
  it("LEVEL_SWITCHED → processEvent({ type:'quality_change', quality })", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.LEVEL_SWITCHED, { level: 0 });

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).not.toHaveBeenCalled();
  });

  // 16. DESTROYING → session.destroy()
  it("DESTROYING → session.destroy() called", async () => {
    instance = await setup(hls, video, mockSession);
    hls.emit(Events.DESTROYING);

    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
    instance = null; // already destroyed, prevent double destroy in afterEach
  });

  // 17. video error → error event
  it("video 'error' → processEvent({ type:'error', code:'MEDIA_ERR_3', fatal:true })", async () => {
    instance = await setup(hls, video, mockSession);
    video.error = { code: 3, message: "MEDIA_ERR_DECODE" };
    video.fire("error");

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).not.toHaveBeenCalled();
    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
  });

  // 19. destroy() is idempotent
  it("destroy() idempotent — second call is a no-op", async () => {
    instance = await setup(hls, video, mockSession);
    instance.destroy();
    instance.destroy();
    instance = null;

    expect(mockSession.destroy).toHaveBeenCalledTimes(1);
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
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

    expect(mockSession.processEvent).toHaveBeenCalledWith({
      type: "seek_end",
      to_ms: 5_000,
      buffer_ready: false,
    });
  });

  // 23. getPlayhead() delegates to session.getPlayhead()
  it("getPlayhead() delegates to session.getPlayhead()", async () => {
    mockSession.getPlayhead.mockReturnValue(45_000);
    instance = await setup(hls, video, mockSession);

    expect(instance.getPlayhead()).toBe(45_000);
    expect(mockSession.getPlayhead).toHaveBeenCalledTimes(1);
  });

  // 24. getPlayhead() returns 0 and does not call session after destroy()
  it("getPlayhead() returns 0 after destroy()", async () => {
    mockSession.getPlayhead.mockReturnValue(45_000);
    instance = await setup(hls, video, mockSession);
    instance.destroy();
    const result = instance.getPlayhead();
    instance = null;

    expect(result).toBe(0);
    expect(mockSession.getPlayhead).not.toHaveBeenCalled();
  });
});
