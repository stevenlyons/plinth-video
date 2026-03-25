import { PlinthSession } from "@wirevice/plinth-js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@wirevice/plinth-js";

export interface VideoMeta {
  id: string;
  title?: string;
}

export type { PlinthConfig, SessionMeta };

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

export class PlinthShaka {
  private session: PlinthSession;
  private player: ShakaPlayer;
  private video: HTMLVideoElement;
  private lastPlayheadMs = 0;
  private hasFiredFirstFrame = false;
  private destroyed = false;
  private shakaHandlers = new Map<string, EventListener>();
  private videoHandlers = new Map<string, EventListener>();

  private constructor(session: PlinthSession, player: ShakaPlayer, video: HTMLVideoElement) {
    this.session = session;
    this.player = player;
    this.video = video;
  }

  static async initialize(
    player: ShakaPlayer,
    video: HTMLVideoElement,
    videoMeta: VideoMeta,
    options?: { config?: PlinthConfig; sessionFactory?: SessionFactory },
  ): Promise<PlinthShaka> {
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
        player: { name: "plinth-shaka", version: "0.1.0" },
      },
    };
    const session = await factory(meta, options?.config);
    const instance = new PlinthShaka(session, player, video);
    instance.attachShakaListeners();
    instance.attachVideoListeners();
    return instance;
  }

  /** Return the last playhead position reported by the platform, in milliseconds. */
  getPlayhead(): number {
    if (this.destroyed) return 0;
    return this.session.getPlayhead();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const [event, handler] of this.shakaHandlers) {
      this.player.removeEventListener(event, handler);
    }
    this.shakaHandlers.clear();

    for (const [event, handler] of this.videoHandlers) {
      this.video.removeEventListener(event, handler);
    }
    this.videoHandlers.clear();

    this.session.destroy();
  }

  private emit(event: PlayerEvent): void {
    this.session.processEvent(event);
  }

  private attachShakaListeners(): void {
    const onLoading: EventListener = () => {
      this.hasFiredFirstFrame = false;
      this.emit({ type: "load", src: this.player.getAssetUri() ?? "" });
    };
    this.player.addEventListener("loading", onLoading);
    this.shakaHandlers.set("loading", onLoading);

    const onLoaded: EventListener = () => {
      this.emit({ type: "can_play" });
    };
    this.player.addEventListener("loaded", onLoaded);
    this.shakaHandlers.set("loaded", onLoaded);

    const onBuffering: EventListener = (e) => {
      if ((e as any).buffering) {
        this.emit({ type: "waiting" });
      } else {
        this.emit({ type: "can_play_through" });
      }
    };
    this.player.addEventListener("buffering", onBuffering);
    this.shakaHandlers.set("buffering", onBuffering);

    const onAdaptation: EventListener = () => {
      const track = this.player.getVariantTracks().find((t) => t.active);
      if (!track) return;
      this.emit({
        type: "quality_change",
        quality: {
          bitrate_bps: track.bandwidth,
          width: track.width ?? undefined,
          height: track.height ?? undefined,
          framerate: track.frameRate ?? undefined,
          codec: track.videoCodec ?? undefined,
        },
      });
    };
    this.player.addEventListener("adaptation", onAdaptation);
    this.shakaHandlers.set("adaptation", onAdaptation);

    const onError: EventListener = (e) => {
      const detail = (e as any).detail as
        | { code: number; severity: number; message?: string }
        | undefined;
      if (!detail) return;
      this.emit({
        type: "error",
        code: String(detail.code),
        message: detail.message,
        fatal: detail.severity === 2,
      });
    };
    this.player.addEventListener("error", onError);
    this.shakaHandlers.set("error", onError);

    const onUnloading: EventListener = () => {
      this.destroy();
    };
    this.player.addEventListener("unloading", onUnloading);
    this.shakaHandlers.set("unloading", onUnloading);
  }

  private attachVideoListeners(): void {
    const onPlay: EventListener = () => this.emit({ type: "play" });
    this.video.addEventListener("play", onPlay);
    this.videoHandlers.set("play", onPlay);

    const onPlaying: EventListener = () => {
      if (!this.hasFiredFirstFrame) {
        this.hasFiredFirstFrame = true;
        this.emit({ type: "first_frame" });
      }
    };
    this.video.addEventListener("playing", onPlaying);
    this.videoHandlers.set("playing", onPlaying);

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
      this.emit({ type: "error", code: `MEDIA_ERR_${err.code}`, fatal: true });
    };
    this.video.addEventListener("error", onVideoError);
    this.videoHandlers.set("error", onVideoError);
  }
}

// Minimal structural interface for shaka.Player to avoid importing the full shaka namespace
interface ShakaTrack {
  active: boolean;
  bandwidth: number;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
}

interface ShakaPlayer extends EventTarget {
  getAssetUri(): string | null;
  getVariantTracks(): ShakaTrack[];
}
