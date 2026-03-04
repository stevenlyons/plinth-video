import Hls, { Events } from "hls.js";
import { PlinthSession } from "@plinth/js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@plinth/js";

export interface VideoMeta {
  id: string;
  title?: string;
}

export type { PlinthConfig, SessionMeta };

type HlsHandler = (event: string, data: any) => void;
type SessionFactory = (meta: SessionMeta, config?: PlinthConfig) => Promise<PlinthSession>;

function isBufferReady(video: HTMLVideoElement): boolean {
  const buffered = video.buffered;
  const ct = video.currentTime;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= ct && ct <= buffered.end(i)) {
      return true;
    }
  }
  return false;
}

export class PlinthHlsJs {
  private session: PlinthSession;
  private hls: Hls;
  private video: HTMLVideoElement;
  private lastPlayheadMs = 0;
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
      this.emit({ type: "load", src: data.url as string });
    };
    this.hls.on(Events.MANIFEST_LOADING, onManifestLoading as any);
    this.hlsHandlers.set(Events.MANIFEST_LOADING, onManifestLoading);

    const onManifestParsed: HlsHandler = () => {
      this.emit({ type: "can_play" });
    };
    this.hls.on(Events.MANIFEST_PARSED, onManifestParsed as any);
    this.hlsHandlers.set(Events.MANIFEST_PARSED, onManifestParsed);

    const onLevelSwitched: HlsHandler = (_event, data) => {
      const level = (this.hls as any).levels[data.level as number];
      this.emit({
        type: "quality_change",
        quality: {
          bitrate_bps: level?.bitrate,
          width: level?.width,
          height: level?.height,
          codec: level?.videoCodec,
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

    const onPlaying: EventListener = () => this.emit({ type: "first_frame" });
    this.video.addEventListener("playing", onPlaying);
    this.videoHandlers.set("playing", onPlaying);

    const onWaiting: EventListener = () => this.emit({ type: "waiting" });
    this.video.addEventListener("waiting", onWaiting);
    this.videoHandlers.set("waiting", onWaiting);

    const onPause: EventListener = () => this.emit({ type: "pause" });
    this.video.addEventListener("pause", onPause);
    this.videoHandlers.set("pause", onPause);

    const onSeeking: EventListener = () => {
      this.emit({ type: "seek_start", from_ms: this.lastPlayheadMs });
    };
    this.video.addEventListener("seeking", onSeeking);
    this.videoHandlers.set("seeking", onSeeking);

    const onSeeked: EventListener = () => {
      this.emit({
        type: "seek_end",
        to_ms: this.video.currentTime * 1000,
        buffer_ready: isBufferReady(this.video),
      });
    };
    this.video.addEventListener("seeked", onSeeked);
    this.videoHandlers.set("seeked", onSeeked);

    const onEnded: EventListener = () => this.emit({ type: "ended" });
    this.video.addEventListener("ended", onEnded);
    this.videoHandlers.set("ended", onEnded);

    const onCanPlayThrough: EventListener = () => this.emit({ type: "can_play_through" });
    this.video.addEventListener("canplaythrough", onCanPlayThrough);
    this.videoHandlers.set("canplaythrough", onCanPlayThrough);

    const onTimeUpdate: EventListener = () => {
      const ms = this.video.currentTime * 1000;
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
