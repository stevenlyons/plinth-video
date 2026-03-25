import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { postBeacons } from "../src/poster.js";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("postBeacons", () => {
  const ENDPOINT = "http://localhost:3000/beacon";
  const PROJECT_KEY = "p123456789";
  const BATCH_JSON = JSON.stringify({ beacons: [{ seq: 0, event: "session_open" }] });

  let fetchMock: ReturnType<typeof mock.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = mock.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sets method POST", async () => {
    await postBeacons(ENDPOINT, PROJECT_KEY, BATCH_JSON);

    const [, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(init.method, "POST");
  });

  it("sets keepalive true", async () => {
    await postBeacons(ENDPOINT, PROJECT_KEY, BATCH_JSON);

    const [, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(init.keepalive, true);
  });

  it("sets Content-Type header to application/json", async () => {
    await postBeacons(ENDPOINT, PROJECT_KEY, BATCH_JSON);

    const [, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    assert.strictEqual(headers["Content-Type"], "application/json");
  });

  it("sets X-Project-Key header to the provided project key", async () => {
    await postBeacons(ENDPOINT, PROJECT_KEY, BATCH_JSON);

    const [, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    assert.strictEqual(headers["X-Project-Key"], PROJECT_KEY);
  });

  it("sends batch JSON as body", async () => {
    await postBeacons(ENDPOINT, PROJECT_KEY, BATCH_JSON);

    const [, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.strictEqual(init.body, BATCH_JSON);
  });

  it("rejects when fetch throws a network error", async () => {
    globalThis.fetch = mock.fn(() => Promise.reject(new TypeError("network error"))) as unknown as typeof fetch;

    await assert.rejects(
      postBeacons(ENDPOINT, PROJECT_KEY, BATCH_JSON),
      { message: "network error" },
    );
  });
});
