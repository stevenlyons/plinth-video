import Hls, { Events } from "hls.js";
import { PlinthSession, VideoSeekTracker } from "@wirevice/plinth-js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@wirevice/plinth-js";

export const VERSION = "0.2.0";

export interface VideoMeta {
  id: string;
  title?: string;
}

export type { PlinthConfig, SessionMeta };

type HlsHandler = (event: string, data: any) => void;
type SessionFactory = (meta: SessionMeta, config?: PlinthConfig) => Promise<PlinthSession>;


export class PlinthHlsJs {
  private session: PlinthSession;
  private hls: Hls;
  private video: HTMLVideoElement;
  private lastPlayheadMs = 0;
  private hasFiredFirstFrame = false;
  private seekTracker!: VideoSeekTracker;
  private destroyed = false;
  private hlsHandlers = new Map<string, HlsHandler>();
  private videoHandlers = new Map<string, EventListener>();

  private constructor(session: PlinthSession, hls: Hls, video: HTMLVideoElement) {
    this.session = session;
    this.hls = hls;
    this.video = video;
  }

  static async initialize(
    hls: Hls,
    video: HTMLVideoElement,
    videoMeta: VideoMeta,
    options?: { config?: PlinthConfig; sessionFactory?: SessionFactory },
  ): Promise<PlinthHlsJs> {
    const factory = options?.sessionFactory ?? PlinthSession.create.bind(PlinthSession);
    const userAgent =
      typeof globalThis.navigator !== "undefined" ? globalThis.navigator.userAgent : "unknown";
    const meta: SessionMeta = {
      video: { id: videoMeta.id, title: videoMeta.title },
      client: { user_agent: userAgent },
      sdk: {
        api_version: 1,
        core: { name: "plinth-core", version: "0.1.0" },
        framework: { name: "plinth-js", version: "0.1.0" },
        player: { name: "plinth-hlsjs", version: "0.1.0" },
      },
    };
    const session = await factory(meta, options?.config);
    const instance = new PlinthHlsJs(session, hls, video);
    instance.seekTracker = new VideoSeekTracker(
      video,
      () => instance.lastPlayheadMs,
      (fromMs) => instance.emit({ type: "seek", from_ms: fromMs }),
      (toMs, bufferReady) => {
        instance.emit({ type: "seek_end", to_ms: toMs, buffer_ready: bufferReady });
        // Replay any playing event suppressed during the debounce window.
        if (!video.paused) instance.emit({ type: "playing" });
      },
    );
    instance.attachHlsListeners();
    instance.attachVideoListeners();
    return instance;
  }

  /** Return the last playhead position reported by the platform, in milliseconds. */
  getPlayhead(): number {
    if (this.destroyed) return 0;
    return this.session.getPlayhead();
  }

  /** Removes all event listeners and destroys the session. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.seekTracker.destroy();

    for (const [event, handler] of this.hlsHandlers) {
      this.hls.off(event as any, handler as any);
    }
    this.hlsHandlers.clear();

    for (const [event, handler] of this.videoHandlers) {
      this.video.removeEventListener(event, handler);
    }
    this.videoHandlers.clear();

    this.session.destroy();
  }

  private emit(event: PlayerEvent): void {
    this.session.processEvent(event);
  }

  private attachHlsListeners(): void {
    const onManifestLoading: HlsHandler = (_event, data) => {
      this.hasFiredFirstFrame = false;
      this.emit({ type: "load", src: data.url as string });
    };
    this.hls.on(Events.MANIFEST_LOADING, onManifestLoading as any);
    this.hlsHandlers.set(Events.MANIFEST_LOADING, onManifestLoading);

    const onManifestParsed: HlsHandler = () => {
      this.emit({ type: "can_play" });
      if (!this.video.paused) {
        this.emit({ type: "play" });
      }
    };
    this.hls.on(Events.MANIFEST_PARSED, onManifestParsed as any);
    this.hlsHandlers.set(Events.MANIFEST_PARSED, onManifestParsed);

    const onLevelSwitched: HlsHandler = (_event, data) => {
      const level = (this.hls as any).levels[data.level as number];
      if (!level) return;
      this.emit({
        type: "quality_change",
        quality: {
          bitrate_bps: level.bitrate,
          width: level.width,
          height: level.height,
          codec: level.videoCodec,
        },
      });
    };
    this.hls.on(Events.LEVEL_SWITCHED, onLevelSwitched as any);
    this.hlsHandlers.set(Events.LEVEL_SWITCHED, onLevelSwitched);

    const onError: HlsHandler = (_event, data) => {
      if (!data.fatal) return;
      this.emit({
        type: "error",
        code: data.type as string,
        message: data.details as string,
        fatal: true,
      });
    };
    this.hls.on(Events.ERROR, onError as any);
    this.hlsHandlers.set(Events.ERROR, onError);

    const onDestroying: HlsHandler = () => {
      this.destroy();
    };
    this.hls.on(Events.DESTROYING, onDestroying as any);
    this.hlsHandlers.set(Events.DESTROYING, onDestroying);
  }

  private attachVideoListeners(): void {
    const onPlay: EventListener = () => this.emit({ type: "play" });
    this.video.addEventListener("play", onPlay);
    this.videoHandlers.set("play", onPlay);

    const onPlaying: EventListener = () => {
      if (!this.hasFiredFirstFrame) {
        this.hasFiredFirstFrame = true;
        const hls = this.hls as any;
        const level = hls.levels?.[hls.currentLevel];
        this.emit({
          type: "first_frame",
          ...(level ? { quality: { bitrate_bps: level.bitrate, width: level.width, height: level.height, codec: level.videoCodec } } : {}),
        });
      } else if (!this.seekTracker.active) {
        this.emit({ type: "playing" });
      }
    };
    this.video.addEventListener("playing", onPlaying);
    this.videoHandlers.set("playing", onPlaying);

    const onWaiting: EventListener = () => {
      if (!this.hasFiredFirstFrame) {
        this.emit({ type: "waiting" });
      } else {
        // Forward stall even during a seek so the state machine can track seek_buffer_ms.
        this.emit({ type: "stall" });
      }
    };
    this.video.addEventListener("waiting", onWaiting);
    this.videoHandlers.set("waiting", onWaiting);

    const onPause: EventListener = () => {
      if (this.video.ended) return;
      if (this.video.seeking) return; // spurious pause fired by browser/player during seek
      this.emit({ type: "pause" });
    };
    this.video.addEventListener("pause", onPause);
    this.videoHandlers.set("pause", onPause);

    const onEnded: EventListener = () => {
      this.seekTracker.settle(true); // resolve any in-flight seek before ending the session
      this.emit({ type: "ended" });
    };
    this.video.addEventListener("ended", onEnded);
    this.videoHandlers.set("ended", onEnded);

    const onTimeUpdate: EventListener = () => {
      const ms = Math.round(this.video.currentTime * 1000);
      this.lastPlayheadMs = ms;
      this.session.setPlayhead(ms);
    };
    this.video.addEventListener("timeupdate", onTimeUpdate);
    this.videoHandlers.set("timeupdate", onTimeUpdate);

    const onVideoError: EventListener = () => {
      const err = this.video.error;
      if (!err) return;
      this.emit({
        type: "error",
        code: `MEDIA_ERR_${err.code}`,
        fatal: true,
      });
    };
    this.video.addEventListener("error", onVideoError);
    this.videoHandlers.set("error", onVideoError);
  }
}
