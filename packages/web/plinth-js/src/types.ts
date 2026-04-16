// ── Player events ─────────────────────────────────────────────────────────────
// Discriminated union matching Rust PlayerEvent serde tag = "type", rename_all = "snake_case"

export type PlayerEvent =
  | { type: "load"; src: string }
  | { type: "can_play" }
  | { type: "play" }
  | { type: "waiting" }
  | { type: "stall" }
  | { type: "first_frame" }
  | { type: "playing" }
  | { type: "pause" }
  | { type: "seek"; from_ms: number }
  | { type: "seek_end"; to_ms: number; buffer_ready: boolean }
  | { type: "ended" }
  | { type: "error"; code: string; message?: string; fatal: boolean }
  | { type: "destroy" }
  | { type: "quality_change"; quality: QualityLevel };

// ── Metadata types ────────────────────────────────────────────────────────────

export interface VideoMetadata {
  id: string;
  title?: string;
}

export interface ClientMetadata {
  user_agent: string;
}

export interface SdkComponent {
  name: string;
  version: string;
}

export interface SdkMetadata {
  api_version: number;
  core: SdkComponent;
  framework: SdkComponent;
  player: SdkComponent;
}

export interface SessionMeta {
  video: VideoMetadata;
  client: ClientMetadata;
  sdk: SdkMetadata;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface PlinthConfig {
  endpoint: string;
  project_key: string;
  heartbeat_interval_ms: number;
}

// ── Beacon types ──────────────────────────────────────────────────────────────

export interface QualityLevel {
  bitrate_bps?: number;
  width?: number;
  height?: number;
  framerate?: string;
  codec?: string;
}

export interface Metrics {
  vst_ms: number | null;
  played_ms: number;
  rebuffer_ms: number;
  watched_ms: number;
  rebuffer_count: number;
  error_count: number;
  seek_buffer_ms: number;
  seek_buffer_count: number;
  seek_count: number;
}

export interface Beacon {
  seq: number;
  play_id: string;
  ts: number;
  event: string;
  state?: string;
  metrics?: Metrics;
  video?: VideoMetadata;
  client?: ClientMetadata;
  sdk?: SdkMetadata;
  playhead_ms?: number;
  seek_from_ms?: number;
  seek_to_ms?: number;
  quality?: QualityLevel;
  error?: { code: string; message?: string; fatal: boolean };
}

export interface BeaconBatch {
  beacons: Beacon[];
}

// ── Wasm module interface ─────────────────────────────────────────────────────
// Matches the wasm-bindgen generated module shape.

export interface WasmSessionLike {
  process_event(event_json: string, now_ms: number): string;
  tick(now_ms: number): string;
  destroy(now_ms: number): string;
  set_playhead(playhead_ms: number): void;
  get_playhead(): number;
  free(): void;
}

export interface WasmModule {
  WasmSession: new (
    config_json: string,
    meta_json: string,
    now_ms: number,
  ) => WasmSessionLike;
  default?: (input?: unknown) => Promise<unknown>;
}
