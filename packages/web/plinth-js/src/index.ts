import { postBeacons } from "./poster.js";
import type {
  BeaconBatch,
  PlinthConfig,
  PlayerEvent,
  SessionMeta,
  WasmModule,
  WasmSessionLike,
} from "./types.js";

const DEFAULT_CONFIG: PlinthConfig = {
  endpoint: "http://localhost:3000/beacon",
  project_key: "p123456789",
  heartbeat_interval_ms: 10_000,
};

async function loadWasm(): Promise<WasmModule> {
  // Dynamic import keeps wasm loading out of test paths.
  const mod = (await import("../wasm/plinth_core.js")) as WasmModule;
  if (mod.default) {
    await mod.default();
  }
  return mod;
}

export class PlinthSession {
  private readonly wasmSession: WasmSessionLike;
  private readonly config: PlinthConfig;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  private constructor(wasmSession: WasmSessionLike, config: PlinthConfig) {
    this.wasmSession = wasmSession;
    this.config = config;
  }

  /**
   * Factory method. Loads Wasm (unless overridden), creates the underlying
   * session, and starts the heartbeat timer.
   *
   * @param meta        Session metadata (video, client, sdk).
   * @param config      Optional config; defaults to localhost:3000 / p123456789.
   * @param wasmModuleOverride  Injected for tests — skips real Wasm loading.
   */
  static async create(
    meta: SessionMeta,
    config: PlinthConfig = DEFAULT_CONFIG,
    wasmModuleOverride?: WasmModule,
  ): Promise<PlinthSession> {
    const wasm = wasmModuleOverride ?? (await loadWasm());
    const now = Date.now();
    const wasmSession = new wasm.WasmSession(
      JSON.stringify(config),
      JSON.stringify(meta),
      now,
    );
    const session = new PlinthSession(wasmSession, config);
    session.startHeartbeat();
    return session;
  }

  /** Send a player event to the state machine. Posts any resulting beacons. */
  processEvent(event: PlayerEvent): void {
    if (this.destroyed) return;
    const batchJson = this.wasmSession.process_event(
      JSON.stringify(event),
      Date.now(),
    );
    const batch = JSON.parse(batchJson) as BeaconBatch;
    if (batch.beacons.length > 0) {
      void postBeacons(this.config.endpoint, this.config.project_key, batchJson);
    }
  }

  /** Update the platform-reported playhead position (used in heartbeat beacons). */
  setPlayhead(playheadMs: number): void {
    if (this.destroyed) return;
    this.wasmSession.set_playhead(playheadMs);
  }

  /**
   * Tear down the session. Stops the heartbeat timer, posts any final beacons,
   * and frees the Wasm memory. Idempotent — safe to call more than once.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopHeartbeat();
    const batchJson = this.wasmSession.destroy(Date.now());
    const batch = JSON.parse(batchJson) as BeaconBatch;
    if (batch.beacons.length > 0) {
      void postBeacons(this.config.endpoint, this.config.project_key, batchJson);
    }
    this.wasmSession.free();
  }

  private startHeartbeat(): void {
    this.timerHandle = setInterval(() => {
      if (this.destroyed) return;
      const batchJson = this.wasmSession.tick(Date.now());
      const batch = JSON.parse(batchJson) as BeaconBatch;
      if (batch.beacons.length > 0) {
        void postBeacons(
          this.config.endpoint,
          this.config.project_key,
          batchJson,
        );
      }
    }, this.config.heartbeat_interval_ms);
  }

  private stopHeartbeat(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }
}

export type { BeaconBatch, Beacon, PlinthConfig, PlayerEvent, SessionMeta } from "./types.js";
