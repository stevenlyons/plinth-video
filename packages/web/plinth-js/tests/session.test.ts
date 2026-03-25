import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
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
    process_event: ReturnType<typeof mock.fn>;
    tick: ReturnType<typeof mock.fn>;
    destroy: ReturnType<typeof mock.fn>;
    set_playhead: ReturnType<typeof mock.fn>;
    get_playhead: ReturnType<typeof mock.fn>;
    free: ReturnType<typeof mock.fn>;
  };
} {
  const process_event_fn = mock.fn(() => EMPTY_BATCH);
  const tick_fn = mock.fn(() => EMPTY_BATCH);
  const destroy_fn = mock.fn(() => EMPTY_BATCH);
  const set_playhead_fn = mock.fn(() => {});
  const get_playhead_fn = mock.fn(() => 0);
  const free_fn = mock.fn(() => {});

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
  _constructorMock: ReturnType<typeof mock.fn>;
} {
  const constructorMock = mock.fn();
  // Must be a regular function (not arrow) so it can be called with `new`.
  // Returning an object from a constructor makes `new Ctor()` return that object.
  function MockWasmSession(this: unknown, ...args: unknown[]) {
    constructorMock(...args);
    return wasmSession;
  }
  return {
    WasmSession: MockWasmSession as unknown as WasmModule["WasmSession"],
    default: mock.fn(async () => {}),
    _constructorMock: constructorMock,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PlinthSession", () => {
  let mockWasmSession: ReturnType<typeof makeMockWasmSession>;
  let mockWasmModule: ReturnType<typeof makeMockWasmModule>;
  let fetchMock: ReturnType<typeof mock.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockWasmSession = makeMockWasmSession();
    mockWasmModule = makeMockWasmModule(mockWasmSession);
    originalFetch = globalThis.fetch;
    fetchMock = mock.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("create()", () => {
    it("forwards config JSON to WasmSession constructor", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);

      assert.strictEqual(mockWasmModule._constructorMock.mock.callCount(), 1);
      const [configArg, metaArg] = mockWasmModule._constructorMock.mock.calls[0].arguments as [string, string, number];
      const parsedConfig = JSON.parse(configArg);
      assert.strictEqual(parsedConfig.endpoint, DEFAULT_CONFIG.endpoint);
      assert.strictEqual(parsedConfig.project_key, DEFAULT_CONFIG.project_key);
      assert.strictEqual(parsedConfig.heartbeat_interval_ms, DEFAULT_CONFIG.heartbeat_interval_ms);

      const parsedMeta = JSON.parse(metaArg);
      assert.strictEqual(parsedMeta.video.id, DEFAULT_META.video.id);

      session.destroy();
    });

    it("passes now_ms as a number to WasmSession constructor", async () => {
      const before = Date.now();
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      const after = Date.now();

      const [, , nowMs] = mockWasmModule._constructorMock.mock.calls[0].arguments as [string, string, number];
      assert.strictEqual(typeof nowMs, "number");
      assert.ok(nowMs >= before);
      assert.ok(nowMs <= after);

      session.destroy();
    });

    it("uses DEFAULT_CONFIG when no config provided", async () => {
      const session = await PlinthSession.create(DEFAULT_META, undefined, mockWasmModule);

      const [configArg] = mockWasmModule._constructorMock.mock.calls[0].arguments as [string];
      const parsedConfig = JSON.parse(configArg);
      assert.strictEqual(parsedConfig.endpoint, "http://localhost:3000/beacon");
      assert.strictEqual(parsedConfig.project_key, "p123456789");
      assert.strictEqual(parsedConfig.heartbeat_interval_ms, 10_000);

      session.destroy();
    });
  });

  describe("processEvent()", () => {
    it("serializes event to JSON and calls process_event on WasmSession", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "play" });

      assert.strictEqual(mockWasmSession._mocks.process_event.mock.callCount(), 1);
      const [eventArg] = mockWasmSession._mocks.process_event.mock.calls[0].arguments as [string, number];
      const parsedEvent = JSON.parse(eventArg);
      assert.strictEqual(parsedEvent.type, "play");

      session.destroy();
    });

    it("serializes seek_start event with from_ms field", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "seek_start", from_ms: 15_000 });

      const [eventArg] = mockWasmSession._mocks.process_event.mock.calls[0].arguments as [string];
      const parsedEvent = JSON.parse(eventArg);
      assert.strictEqual(parsedEvent.type, "seek_start");
      assert.strictEqual(parsedEvent.from_ms, 15_000);

      session.destroy();
    });

    it("calls fetch with correct URL and X-Project-Key header when batch is non-empty", async () => {
      mockWasmSession._mocks.process_event.mock.mockImplementationOnce(() => BEACON_BATCH);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "play" });

      // Allow microtask queue to flush
      await Promise.resolve();

      assert.strictEqual(fetchMock.mock.callCount(), 1);
      const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
      assert.strictEqual(url, "http://localhost:3000/beacon");
      const headers = init.headers as Record<string, string>;
      assert.strictEqual(headers["X-Project-Key"], "p123456789");
      assert.strictEqual(headers["Content-Type"], "application/json");
      assert.strictEqual(init.method, "POST");
      assert.strictEqual(init.body, BEACON_BATCH);

      session.destroy();
    });

    it("does NOT call fetch when batch is empty", async () => {
      // process_event already returns EMPTY_BATCH by default
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.processEvent({ type: "play" });

      await Promise.resolve();

      assert.strictEqual(fetchMock.mock.callCount(), 0);

      session.destroy();
    });

    it("is a no-op after destroy()", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();
      const callCountBefore = mockWasmSession._mocks.process_event.mock.callCount();

      session.processEvent({ type: "play" });

      assert.strictEqual(mockWasmSession._mocks.process_event.mock.callCount(), callCountBefore);
    });
  });

  describe("setPlayhead()", () => {
    it("forwards playhead to WasmSession.set_playhead", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.setPlayhead(42_000);

      assert.strictEqual(mockWasmSession._mocks.set_playhead.mock.callCount(), 1);
      assert.strictEqual(mockWasmSession._mocks.set_playhead.mock.calls[0].arguments[0], 42_000);

      session.destroy();
    });

    it("is a no-op after destroy()", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();
      session.setPlayhead(99_000);

      // set_playhead should not have been called after destroy
      assert.strictEqual(mockWasmSession._mocks.set_playhead.mock.callCount(), 0);
    });
  });

  describe("getPlayhead()", () => {
    it("delegates to WasmSession.get_playhead", async () => {
      mockWasmSession._mocks.get_playhead.mock.mockImplementation(() => 55_000);
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);

      assert.strictEqual(session.getPlayhead(), 55_000);
      assert.strictEqual(mockWasmSession._mocks.get_playhead.mock.callCount(), 1);

      session.destroy();
    });

    it("returns 0 after destroy()", async () => {
      mockWasmSession._mocks.get_playhead.mock.mockImplementation(() => 55_000);
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      assert.strictEqual(session.getPlayhead(), 0);
      // get_playhead on the Wasm side must NOT be called after destroy
      assert.strictEqual(mockWasmSession._mocks.get_playhead.mock.callCount(), 0);
    });

    it("reflects the value set by setPlayhead via the Wasm mock", async () => {
      let storedMs = 0;
      mockWasmSession._mocks.set_playhead.mock.mockImplementation((ms: number) => { storedMs = ms; });
      mockWasmSession._mocks.get_playhead.mock.mockImplementation(() => storedMs);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.setPlayhead(30_000);
      assert.strictEqual(session.getPlayhead(), 30_000);

      session.destroy();
    });
  });

  describe("destroy()", () => {
    it("calls WasmSession.destroy and WasmSession.free", async () => {
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      assert.strictEqual(mockWasmSession._mocks.destroy.mock.callCount(), 1);
      assert.strictEqual(mockWasmSession._mocks.free.mock.callCount(), 1);
    });

    it("POSTs final beacons when destroy returns a non-empty batch", async () => {
      mockWasmSession._mocks.destroy.mock.mockImplementationOnce(() => BEACON_BATCH);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      await Promise.resolve();

      assert.strictEqual(fetchMock.mock.callCount(), 1);
      const [url] = fetchMock.mock.calls[0].arguments as [string];
      assert.strictEqual(url, "http://localhost:3000/beacon");
    });

    it("does NOT POST when destroy returns an empty batch", async () => {
      // destroy already returns EMPTY_BATCH by default
      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();

      await Promise.resolve();

      assert.strictEqual(fetchMock.mock.callCount(), 0);
    });

    it("is idempotent — double destroy only calls Wasm destroy once", async () => {
      mockWasmSession._mocks.destroy.mock.mockImplementation(() => BEACON_BATCH);

      const session = await PlinthSession.create(DEFAULT_META, DEFAULT_CONFIG, mockWasmModule);
      session.destroy();
      session.destroy(); // second call should be a no-op

      assert.strictEqual(mockWasmSession._mocks.destroy.mock.callCount(), 1);
      assert.strictEqual(mockWasmSession._mocks.free.mock.callCount(), 1);

      await Promise.resolve();
      // fetch should only have been called once
      assert.strictEqual(fetchMock.mock.callCount(), 1);
    });
  });
});
