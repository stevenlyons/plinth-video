import { PlinthSession } from "@wirevice/plinth-js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@wirevice/plinth-js";

export const VERSION = "0.2.0";

export interface VideoMeta {
  id: string;
  title?: string;
}

export type { PlinthConfig, SessionMeta };

type SessionFactory = (meta: SessionMeta, config?: PlinthConfig) => Promise<PlinthSession>;

// dash.js v5 event string constants
const DashjsEvents = {
  MANIFEST_LOADING_STARTED: "manifestLoadingStarted",
  STREAM_INITIALIZED: "streamInitialized",
  QUALITY_CHANGE_RENDERED: "qualityChangeRendered",
  ERROR: "error",
} as const;

// Minimal structural interface — avoids importing dashjs in library code
interface DashjsRepresentation {
  bandwidth: number;
  width?: number | null;
  height?: number | null;
  frameRate?: number | string | null;
  codecs?: string | null;
}

interface DashjsPlayer {
  on(event: string, handler: (e?: unknown) => void, scope?: unknown): void;
  off(event: string, handler: (e?: unknown) => void, scope?: unknown): void;
  getSource(): string | null;
  getCurrentRepresentationForType(type: "video"): DashjsRepresentation | null;
}

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

// MPEG-DASH frameRate can be a fraction string like "30000/1001"
function parseFrameRate(fr: number | string | null | undefined): string | undefined {
  if (fr == null) return undefined;
  if (typeof fr === "number") return String(fr);
  return fr || undefined;
}

export class PlinthDashjs {
  private session: PlinthSession;
  private player: DashjsPlayer;
  private video: HTMLVideoElement;
  private lastPlayheadMs = 0;
  private hasFiredFirstFrame = false;
  private isSeeking = false;
  private _pendingSeekFrom: number | null = null;
  private _seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastQualityBandwidth: number | null = null;
  private destroyed = false;
  private playerHandlers = new Map<string, (e?: unknown) => void>();
  private videoHandlers = new Map<string, EventListener>();

  private constructor(session: PlinthSession, player: DashjsPlayer, video: HTMLVideoElement) {
    this.session = session;
    this.player = player;
    this.video = video;
  }

  static async initialize(
    player: DashjsPlayer,
    video: HTMLVideoElement,
    videoMeta: VideoMeta,
    options?: { config?: PlinthConfig; sessionFactory?: SessionFactory },
  ): Promise<PlinthDashjs> {
    const factory = options?.sessionFactory ?? PlinthSession.create.bind(PlinthSession);
    const userAgent =
      typeof globalThis.navigator !== "undefined" ? globalThis.navigator.userAgent : "unknown";
    const meta: SessionMeta = {
      video: { id: videoMeta.id, title: videoMeta.title },
      client: { user_agent: userAgent },
      sdk: {
        api_version: 1,
        core:      { name: "plinth-core",   version: "0.1.0" },
        framework: { name: "plinth-js",     version: "0.1.0" },
        player:    { name: "plinth-dashjs", version: "0.1.0" },
      },
    };
    const session = await factory(meta, options?.config);
    const instance = new PlinthDashjs(session, player, video);
    instance.attachPlayerListeners();
    instance.attachVideoListeners();
    return instance;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    clearTimeout(this._seekDebounceTimer!);
    this._seekDebounceTimer = null;

    for (const [event, handler] of this.playerHandlers) {
      this.player.off(event, handler);
    }
    this.playerHandlers.clear();

    for (const [event, handler] of this.videoHandlers) {
      this.video.removeEventListener(event, handler);
    }
    this.videoHandlers.clear();

    this.session.destroy();
  }

  private emit(event: PlayerEvent): void {
    this.session.processEvent(event);
  }

  private attachPlayerListeners(): void {
    const onManifestLoadingStarted = () => {
      this.hasFiredFirstFrame = false;
      this.isSeeking = false;
      this.lastQualityBandwidth = null;
      this.emit({ type: "load", src: this.player.getSource() ?? "" });
    };
    this.player.on(DashjsEvents.MANIFEST_LOADING_STARTED, onManifestLoadingStarted);
    this.playerHandlers.set(DashjsEvents.MANIFEST_LOADING_STARTED, onManifestLoadingStarted);

    const onStreamInitialized = () => {
      this.emit({ type: "can_play" });
      if (!this.video.paused) {
        this.emit({ type: "play" });
      }
    };
    this.player.on(DashjsEvents.STREAM_INITIALIZED, onStreamInitialized);
    this.playerHandlers.set(DashjsEvents.STREAM_INITIALIZED, onStreamInitialized);

    const onQualityChangeRendered = () => {
      const rep = this.player.getCurrentRepresentationForType("video");
      if (!rep) return;
      if (rep.bandwidth === this.lastQualityBandwidth) return;
      this.lastQualityBandwidth = rep.bandwidth;
      this.emit({
        type: "quality_change",
        quality: {
          bitrate_bps: rep.bandwidth,
          width: rep.width ?? undefined,
          height: rep.height ?? undefined,
          framerate: parseFrameRate(rep.frameRate),
          codec: rep.codecs ?? undefined,
        },
      });
    };
    this.player.on(DashjsEvents.QUALITY_CHANGE_RENDERED, onQualityChangeRendered);
    this.playerHandlers.set(DashjsEvents.QUALITY_CHANGE_RENDERED, onQualityChangeRendered);

    const onError = (e?: unknown) => {
      const detail = e as { code?: unknown; message?: string } | undefined;
      if (!detail) return;
      this.emit({
        type: "error",
        code: String(detail.code ?? "UNKNOWN"),
        message: detail.message,
        fatal: true,
      });
    };
    this.player.on(DashjsEvents.ERROR, onError);
    this.playerHandlers.set(DashjsEvents.ERROR, onError);
  }

  private attachVideoListeners(): void {
    const onPlay: EventListener = () => this.emit({ type: "play" });
    this.video.addEventListener("play", onPlay);
    this.videoHandlers.set("play", onPlay);

    const onPlaying: EventListener = () => {
      if (!this.hasFiredFirstFrame) {
        this.hasFiredFirstFrame = true;
        this.emit({ type: "first_frame" });
      } else if (!this.isSeeking) {
        this.emit({ type: "playing" });
      }
    };
    this.video.addEventListener("playing", onPlaying);
    this.videoHandlers.set("playing", onPlaying);

    const onWaiting: EventListener = () => {
      if (this.hasFiredFirstFrame) {
        if (!this.isSeeking) this.emit({ type: "stall" });
      } else {
        this.emit({ type: "waiting" });
      }
    };
    this.video.addEventListener("waiting", onWaiting);
    this.videoHandlers.set("waiting", onWaiting);

    const onPause: EventListener = () => {
      if (this.video.ended) return;
      this.emit({ type: "pause" });
    };
    this.video.addEventListener("pause", onPause);
    this.videoHandlers.set("pause", onPause);

    const onSeeking: EventListener = () => {
      if (this._pendingSeekFrom === null) {
        this._pendingSeekFrom = Math.round(this.lastPlayheadMs);
      }
      this.isSeeking = true;
      clearTimeout(this._seekDebounceTimer!);
      this._seekDebounceTimer = null;
    };
    this.video.addEventListener("seeking", onSeeking);
    this.videoHandlers.set("seeking", onSeeking);

    const onSeeked: EventListener = () => {
      clearTimeout(this._seekDebounceTimer!);
      this._seekDebounceTimer = setTimeout(() => {
        this._seekDebounceTimer = null;
        this.isSeeking = false;
        const seekTo = Math.round(this.video.currentTime * 1000);
        const seekDistance = Math.abs(seekTo - (this._pendingSeekFrom ?? 0));
        if (seekDistance > 250) {
          this.emit({ type: "seek_start", from_ms: this._pendingSeekFrom! });
          this.emit({
            type: "seek_end",
            to_ms: seekTo,
            buffer_ready: isBufferReady(this.video),
          });
        }
        this._pendingSeekFrom = null;
      }, 300);
    };
    this.video.addEventListener("seeked", onSeeked);
    this.videoHandlers.set("seeked", onSeeked);

    const onEnded: EventListener = () => this.emit({ type: "ended" });
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
      this.emit({ type: "error", code: `MEDIA_ERR_${err.code}`, fatal: true });
    };
    this.video.addEventListener("error", onVideoError);
    this.videoHandlers.set("error", onVideoError);
  }
}
