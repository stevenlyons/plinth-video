import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { PlinthSession } from "../src/index.js";
import type { PlinthConfig, SessionMeta, WasmModule, WasmSessionLike } from "../src/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEFAULT_META: SessionMeta = {
  video: { id: "vid-001", title: "Test Video" },
  client: { user_agent: "TestAgent/1.0" },
  sdk: {
    api_version: 1,
    core: { name: "plinth-core", version: "0.1.0" },
    framework: { name: "plinth-js", version: "0.1.0" },
    player: { name: "plinth-hlsjs", version: "0.1.0" },
  },
};

const DEFAULT_CONFIG: PlinthConfig = {
  endpoint: "http://localhost:3000/beacon",
  project_key: "p123456789",
  heartbeat_interval_ms: 10_000,
};

const EMPTY_BATCH = JSON.stringify({ beacons: [] });
const BEACON_BATCH = JSON.stringify({
  beacons: [{ seq: 0, play_id: "abc-123", ts: 1000, event: "session_open" }],
});

function makeMockWasmSession(): WasmSessionLike & {
  _mocks: {
    process_event: ReturnType<typeof mock>;
    tick: ReturnType<typeof mock>;
    destroy: ReturnType<typeof mock>;
    set_playhead: ReturnType<typeof mock>;
    get_playhead: ReturnType<typeof mock>;
    free: ReturnType<typeof mock>;
  };
} {
  const process_event_fn = mock(() => EMPTY_BATCH);
  const tick_fn = mock(() => EMPTY_BATCH);
  const destroy_fn = mock(() => EMPTY_BATCH);
  const set_playhead_fn = mock(() => {});
  const get_playhead_fn = mock(() => 0);
  const free_fn = mock(() => {});

  return {
    process_event: process_event_fn,
    tick: tick_fn,
    destroy: destroy_fn,
    set_playhead: set_playhead_fn,
    get_playhead: get_playhead_fn,
    free: free_fn,
    _mocks: {
      process_event: process_event_fn,
      tick: tick_fn,
      destroy: destroy_fn,
      set_playhead: set_playhead_fn,
      get_playhead: get_playhead_fn,
      free: free_fn,
    },
  };
}

function makeMockWasmModule(wasmSession: WasmSessionLike): WasmModule & {
  _constructorMock: ReturnType<typeof mock>;
} {
  const constructorMock = mock(() => wasmSession);
  return {
    WasmSession: constructorMock as unknown as WasmModule["WasmSession"],
    default: mock(async () => {}),
    _constructorMock: constructorMock,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PlinthSession", () => {
  let mockWasmSession: ReturnType<typeof makeMockWasmSession>;
  let mockWasmModule: ReturnType<typeof makeMockWasmModule>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockWasmSession = makeMockWasmSession();
    mockWasmModule = makeMockWasmModule(mockWasmSession);
    // Replace global fetch with a spy
    globalThis.fetch = mock(() => Promise.resolve(new Response(null, { status: 200 })));
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    // Restore fetch to avoid leaking between tests
  });

  describe("create()", () => {
    it("forwards config JSON to WasmSession constructor", async () => {
      await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);

      expect(mockWasmModule._constructorMock).toHaveBeenCalledTimes(1);
      const [configArg, metaArg] = mockWasmModule._constructorMock.mock.calls[0] as [string, string, number];
      const parsedConfig = JSON.parse(configArg);
      expect(parsedConfig.endpoint).toBe(DEFAULT_CONFIG.endpoint);
      expect(parsedConfig.project_key).toBe(DEFAULT_CONFIG.project_key);
      expect(parsedConfig.heartbeat_interval_ms).toBe(DEFAULT_CONFIG.heartbeat_interval_ms);

      const parsedMeta = JSON.parse(metaArg);
      expect(parsedMeta.video.id).toBe(DEFAULT_META.video.id);
    });

    it("passes now_ms as a number to WasmSession constructor", async () => {
      const before = Date.now();
      await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      const after = Date.now();

      const [, , nowMs] = mockWasmModule._constructorMock.mock.calls[0] as [string, string, number];
      expect(typeof nowMs).toBe("number");
      expect(nowMs).toBeGreaterThanOrEqual(before);
      expect(nowMs).toBeLessThanOrEqual(after);
    });

    it("uses DEFAULT_CONFIG when no config provided", async () => {
      await PlinthSession.create(DEFAULT_META, undefined, mockWasmModule);

      const [configArg] = mockWasmModule._constructorMock.mock.calls[0] as [string];
      const parsedConfig = JSON.parse(configArg);
      expect(parsedConfig.endpoint).toBe("http://localhost:3000/beacon");
      expect(parsedConfig.project_key).toBe("p123456789");
      expect(parsedConfig.heartbeat_interval_ms).toBe(10_000);
    });
  });

  describe("processEvent()", () => {
    it("serializes event to JSON and calls process_event on WasmSession", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "play" });

      expect(mockWasmSession._mocks.process_event).toHaveBeenCalledTimes(1);
      const [eventArg] = mockWasmSession._mocks.process_event.mock.calls[0] as [string, number];
      const parsedEvent = JSON.parse(eventArg);
      expect(parsedEvent.type).toBe("play");

      session.destroy();
    });

    it("serializes seek_start event with from_ms field", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "seek_start", from_ms: 15_000 });

      const [eventArg] = mockWasmSession._mocks.process_event.mock.calls[0] as [string];
      const parsedEvent = JSON.parse(eventArg);
      expect(parsedEvent.type).toBe("seek_start");
      expect(parsedEvent.from_ms).toBe(15_000);

      session.destroy();
    });

    it("calls fetch with correct URL and X-Project-Key header when batch is non-empty", async () => {
      mockWasmSession._mocks.process_event.mockReturnValueOnce(BEACON_BATCH);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "play" });

      // Allow microtask queue to flush
      await Promise.resolve();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:3000/beacon");
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Project-Key"]).toBe("p123456789");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(init.method).toBe("POST");
      expect(init.body).toBe(BEACON_BATCH);

      session.destroy();
    });

    it("does NOT call fetch when batch is empty", async () => {
      // process_event already returns EMPTY_BATCH by default
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "play" });

      await Promise.resolve();

      expect(fetchSpy).not.toHaveBeenCalled();

      session.destroy();
    });

    it("is a no-op after destroy()", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();
      const callCountBefore = mockWasmSession._mocks.process_event.mock.calls.length;

      session.processEvent({ type: "play" });

      expect(mockWasmSession._mocks.process_event.mock.calls.length).toBe(callCountBefore);
    });
  });

  describe("setPlayhead()", () => {
    it("forwards playhead to WasmSession.set_playhead", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.setPlayhead(42_000);

      expect(mockWasmSession._mocks.set_playhead).toHaveBeenCalledWith(42_000);

      session.destroy();
    });

    it("is a no-op after destroy()", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();
      session.setPlayhead(99_000);

      // set_playhead should not have been called after destroy
      const calls = mockWasmSession._mocks.set_playhead.mock.calls;
      expect(calls.length).toBe(0);
    });
  });

  describe("getPlayhead()", () => {
    it("delegates to WasmSession.get_playhead", async () => {
      mockWasmSession._mocks.get_playhead.mockReturnValue(55_000);
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);

      expect(session.getPlayhead()).toBe(55_000);
      expect(mockWasmSession._mocks.get_playhead).toHaveBeenCalledTimes(1);

      session.destroy();
    });

    it("returns 0 after destroy()", async () => {
      mockWasmSession._mocks.get_playhead.mockReturnValue(55_000);
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      expect(session.getPlayhead()).toBe(0);
      // get_playhead on the Wasm side must NOT be called after destroy
      expect(mockWasmSession._mocks.get_playhead).not.toHaveBeenCalled();
    });

    it("reflects the value set by setPlayhead via the Wasm mock", async () => {
      let storedMs = 0;
      mockWasmSession._mocks.set_playhead.mockImplementation((ms: number) => { storedMs = ms; });
      mockWasmSession._mocks.get_playhead.mockImplementation(() => storedMs);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.setPlayhead(30_000);
      expect(session.getPlayhead()).toBe(30_000);

      session.destroy();
    });
  });

  describe("destroy()", () => {
    it("calls WasmSession.destroy and WasmSession.free", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      expect(mockWasmSession._mocks.destroy).toHaveBeenCalledTimes(1);
      expect(mockWasmSession._mocks.free).toHaveBeenCalledTimes(1);
    });

    it("POSTs final beacons when destroy returns a non-empty batch", async () => {
      mockWasmSession._mocks.destroy.mockReturnValueOnce(BEACON_BATCH);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      await Promise.resolve();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] as [string];
      expect(url).toBe("http://localhost:3000/beacon");
    });

    it("does NOT POST when destroy returns an empty batch", async () => {
      // destroy already returns EMPTY_BATCH by default
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      await Promise.resolve();

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("is idempotent — double destroy only calls Wasm destroy once", async () => {
      mockWasmSession._mocks.destroy.mockReturnValue(BEACON_BATCH);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();
      session.destroy(); // second call should be a no-op

      expect(mockWasmSession._mocks.destroy).toHaveBeenCalledTimes(1);
      expect(mockWasmSession._mocks.free).toHaveBeenCalledTimes(1);

      await Promise.resolve();
      // fetch should only have been called once
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
