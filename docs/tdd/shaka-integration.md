# TDD: Shaka Player Web Integration

## Overview

Technical design for `plinth-shaka` (Layer 3) — a Shaka Player integration that mirrors `plinth-hlsjs` as closely as Shaka's API allows. No changes are made to `plinth-core` or `plinth-js`; the Wasm core and Layer 2 session are reused as-is.

---

## Architecture

```
plinth-core (Rust / Wasm)
  └── plinth-js (TypeScript, Layer 2)         ← unchanged
        └── plinth-shaka (TypeScript, Layer 3) ← this feature
              └── Application code
```

`plinth-shaka` depends on `@wirevice/plinth-js` (workspace) and `shaka-player` (peer dependency). It never imports from `plinth-hlsjs`.

---

## File Structure

```
packages/
  plinth-shaka/
    package.json
    tsconfig.json
    src/
      index.ts          # PlinthShaka class + public exports
    tests/
      shaka.test.ts     # Unit tests with FakePlayer + FakeVideo
```

---

## Layer 0 & Layer 2: No Changes

`plinth-core` and `plinth-js` are used without modification. The `PlinthSession` interface consumed by `plinth-shaka` is identical to what `plinth-hlsjs` uses:

```typescript
interface PlinthSession {
  processEvent(event: PlayerEvent): void;
  setPlayhead(ms: number): void;
  destroy(): void;
}
```

`SessionFactory` type: `(meta: SessionMeta, config?: PlinthConfig) => Promise<PlinthSession>`

---

## Package Configuration

### `package.json`

```json
{
  "name": "@wirevice/plinth-shaka",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "@wirevice/plinth-js": "workspace:*"
  },
  "peerDependencies": {
    "shaka-player": "^4.0.0"
  },
  "devDependencies": {
    "shaka-player": "^4.0.0",
    "typescript": "^5.0.0",
    "@types/bun": "latest"
  }
}
```

### `tsconfig.json`

Mirrors `plinth-hlsjs`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src", "tests"]
}
```

---

## Public API

```typescript
export class PlinthShaka {
  static async initialize(
    player: shaka.Player,
    video: HTMLVideoElement,
    videoMeta: VideoMeta,
    options?: {
      config?: PlinthConfig;
      sessionFactory?: SessionFactory;
    },
  ): Promise<PlinthShaka>;

  destroy(): void;
}

export interface VideoMeta {
  id: string;
  title?: string;
}

export type { PlinthConfig, SessionMeta } from "@wirevice/plinth-js";
```

`initialize` is `async` because `PlinthSession.create` loads Wasm on first call. Subsequent calls return immediately from cache. The returned instance must be retained by the caller. `destroy` is idempotent.

---

## `PlinthShaka` Class Design

### Private State

```typescript
class PlinthShaka {
  private session: PlinthSession;
  private player: shaka.Player;
  private video: HTMLVideoElement;
  private lastPlayheadMs = 0;
  private hasFiredFirstFrame = false;
  private destroyed = false;
  private shakaHandlers = new Map<string, EventListener>();
  private videoHandlers = new Map<string, EventListener>();
}
```

### Construction

Private constructor, static `initialize` factory — identical pattern to `PlinthHlsJs`.

```typescript
private constructor(session: PlinthSession, player: shaka.Player, video: HTMLVideoElement) {
  this.session = session;
  this.player = player;
  this.video = video;
}

static async initialize(
  player: shaka.Player,
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
      core:      { name: "plinth-core",  version: "0.1.0" },
      framework: { name: "plinth-js",    version: "0.1.0" },
      player:    { name: "plinth-shaka", version: "0.1.0" },
    },
  };
  const session = await factory(meta, options?.config);
  const instance = new PlinthShaka(session, player, video);
  instance.attachShakaListeners();
  instance.attachVideoListeners();
  return instance;
}
```

---

## Event Mapping

### Shaka Player Event Listeners (`attachShakaListeners`)

Listeners are stored in `shakaHandlers` as `EventListener` functions added via `player.addEventListener`.

| Shaka event | Trigger condition | Core `PlayerEvent` emitted |
|---|---|---|
| `loading` | `player.load(url)` called | `{ type: "load", src: player.getAssetUri() }`; resets `hasFiredFirstFrame = false` |
| `loaded` | Manifest parsed, content ready | `{ type: "can_play" }` |
| `buffering` | `(e as any).buffering === true` AND `!hasFiredFirstFrame` | `{ type: "waiting" }` — initial buffer stall |
| `buffering` | `(e as any).buffering === true` AND `hasFiredFirstFrame` | `{ type: "stall" }` — mid-playback stall |
| `buffering` | `(e as any).buffering === false` | `{ type: "playing" }` — buffer recovered |
| `adaptation` | ABR switched variant | `{ type: "quality_change", quality: { ... } }` |
| `error` | Shaka error | `{ type: "error", code, message, fatal }` |
| `unloading` | Shaka tearing down | `this.destroy()` |

**`loading` src note:** The `loading` event carries no URL in `event.detail`. Call `player.getAssetUri()` synchronously within the handler to capture the current URI. Also reset `hasFiredFirstFrame = false` on `loading` so the flag is cleared for each new load.

**`buffering` handler pattern:**

```typescript
const onBuffering: EventListener = (e) => {
  if ((e as any).buffering) {
    this.emit(this.hasFiredFirstFrame ? { type: "stall" } : { type: "waiting" });
  } else {
    this.emit({ type: "playing" });
  }
};
player.addEventListener("buffering", onBuffering);
this.shakaHandlers.set("buffering", onBuffering);
```

### Video Element Event Listeners (`attachVideoListeners`)

Listeners are stored in `videoHandlers` and added via `video.addEventListener`.

| `<video>` event | Action |
|---|---|
| `play` | `emit({ type: "play" })` |
| `playing` | If `!hasFiredFirstFrame`: set flag, `emit({ type: "first_frame" })`; else no-op (recovery handled by Shaka `buffering(false)`) |
| `pause` | If `video.ended`: no-op (suppress spurious pause on natural end); else `emit({ type: "pause" })` |
| `seeking` | `emit({ type: "seek_start", from_ms: lastPlayheadMs })` |
| `seeked` | `emit({ type: "seek_end", to_ms: video.currentTime * 1000, buffer_ready: isBufferReady(video) })` |
| `ended` | `emit({ type: "ended" })` |
| `timeupdate` | `lastPlayheadMs = video.currentTime * 1000; session.setPlayhead(lastPlayheadMs)` |
| `error` | Read `video.error`; `emit({ type: "error", code: \`MEDIA_ERR_${err.code}\`, fatal: true })` |

### `hasFiredFirstFrame` Flag

The `hasFiredFirstFrame` flag distinguishes initial buffering from mid-playback stalls and ensures `first_frame` is sent exactly once per load:

- Reset to `false` in the `loading` Shaka event handler.
- Set to `true` and emit `first_frame` on the first `<video> playing` event after `loading`.
- All subsequent `<video> playing` events are no-ops.
- The `buffering` event checks this flag: `false` → `waiting`; `true` → `stall`.

```typescript
const onPlaying: EventListener = () => {
  if (!this.hasFiredFirstFrame) {
    this.hasFiredFirstFrame = true;
    this.emit({ type: "first_frame" });
  }
};
```

---

## Quality Change Mapping

In the `adaptation` handler, call `player.getVariantTracks()` and find the track where `track.active === true`. Map its fields:

| Shaka `TrackInfo` | Beacon `quality` field |
|---|---|
| `track.bandwidth` | `bitrate_bps` |
| `track.width` | `width` |
| `track.height` | `height` |
| `track.frameRate` | `framerate` |
| `track.videoCodec` | `codec` |

```typescript
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
```

---

## Error Handling

Shaka errors have a `severity` field:
- `1` (`RECOVERABLE`) → `fatal: false`
- `2` (`CRITICAL`) → `fatal: true`

```typescript
const onError: EventListener = (e) => {
  const detail = (e as any).detail as { code: number; severity: number; message?: string };
  if (!detail) return;
  this.emit({
    type: "error",
    code: String(detail.code),
    message: detail.message,
    fatal: detail.severity === 2,
  });
};
```

Video element `error` events surface codec/decode errors Shaka doesn't catch:

```typescript
const onVideoError: EventListener = () => {
  const err = this.video.error;
  if (!err) return;
  this.emit({ type: "error", code: `MEDIA_ERR_${err.code}`, fatal: true });
};
```

---

## `isBufferReady` Helper

Identical to `plinth-hlsjs` — checks `video.buffered` TimeRanges for `currentTime`:

```typescript
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
```

---

## Listener Cleanup

`destroy()` removes all listeners from both the Shaka player instance and the video element, then calls `session.destroy()`. The `destroyed` flag makes it idempotent.

```typescript
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
```

The `unloading` Shaka event handler calls `this.destroy()` to auto-cleanup when Shaka tears itself down:

```typescript
const onUnloading: EventListener = () => this.destroy();
player.addEventListener("unloading", onUnloading);
this.shakaHandlers.set("unloading", onUnloading);
```

---

## Session Metadata

```typescript
sdk: {
  api_version: 1,
  core:      { name: "plinth-core",  version: "0.1.0" },
  framework: { name: "plinth-js",    version: "0.1.0" },
  player:    { name: "plinth-shaka", version: "0.1.0" },
}
```

---

## Testing Strategy

No Wasm, no real network. Inject a mock session via `sessionFactory`. Build minimal fakes that implement only the surfaces needed by `PlinthShaka`.

### `FakePlayer`

`FakePlayer extends EventTarget` to support `addEventListener` / `removeEventListener` natively. Expose helper methods to fire events and provide stub data:

```typescript
class FakePlayer extends EventTarget {
  private _assetUri = "https://example.com/manifest.mpd";
  private _tracks = [
    {
      active: true,
      bandwidth: 2_500_000,
      width: 1280,
      height: 720,
      frameRate: 29.97,
      videoCodec: "avc1.4d401f",
    },
  ];

  getAssetUri(): string { return this._assetUri; }
  getVariantTracks(): typeof this._tracks { return this._tracks; }

  fireLoading(): void { this.dispatchEvent(new Event("loading")); }
  fireLoaded(): void  { this.dispatchEvent(new Event("loaded")); }

  fireBuffering(buffering: boolean): void {
    const e = new Event("buffering");
    (e as any).buffering = buffering;
    this.dispatchEvent(e);
  }

  fireAdaptation(): void { this.dispatchEvent(new Event("adaptation")); }

  fireError(code: number, severity: number, message = "test error"): void {
    const e = new Event("error");
    (e as any).detail = { code, severity, message };
    this.dispatchEvent(e);
  }

  fireUnloading(): void { this.dispatchEvent(new Event("unloading")); }
}
```

### `FakeVideo`

Same stub as in `plinth-hlsjs` tests:

```typescript
class FakeVideo extends EventTarget {
  currentTime = 0;
  buffered = { length: 0, start: (_i: number) => 0, end: (_i: number) => 0 } as unknown as TimeRanges;
  error: { code: number; message?: string } | null = null;

  fire(name: string): void {
    this.dispatchEvent(new Event(name));
  }
}
```

### Mock Session

```typescript
interface MockSession {
  processEvent: ReturnType<typeof mock>;
  setPlayhead: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
}

function makeMockSession(): MockSession {
  return {
    processEvent: mock(() => {}),
    setPlayhead: mock(() => {}),
    destroy: mock(() => {}),
  };
}
```

### Setup Helper

```typescript
async function setup(
  player: FakePlayer,
  video: FakeVideo,
  mockSession: MockSession,
): Promise<PlinthShaka> {
  const sessionFactory = mock(async () => mockSession as unknown as PlinthSession);
  return PlinthShaka.initialize(
    player as unknown as shaka.Player,
    video as unknown as HTMLVideoElement,
    { id: "vid-001", title: "Test Video" },
    { sessionFactory },
  );
}
```

---

## Test Coverage

Tests are in `tests/shaka.test.ts`. Each test is independent with `beforeEach` / `afterEach` setup/teardown.

| # | Test description | Setup | Assert |
|---|---|---|---|
| 1 | `loading` → `load` with URI from `getAssetUri()` | `player.fireLoading()` | `processEvent({ type:"load", src:"https://example.com/manifest.mpd" })` |
| 2 | `loaded` → `can_play` | `player.fireLoaded()` | `processEvent({ type:"can_play" })` |
| 3 | `buffering(true)` before first frame → `waiting` | `player.fireBuffering(true)` (no prior `playing`) | `processEvent({ type:"waiting" })` |
| 3b | `buffering(true)` after first frame → `stall` | `video.fire("playing")`, then `player.fireBuffering(true)` | `processEvent({ type:"stall" })` |
| 4 | `buffering(false)` → `playing` | `player.fireBuffering(false)` | `processEvent({ type:"playing" })` |
| 5 | `playing` (first) → `first_frame` | `video.fire("playing")` | `processEvent({ type:"first_frame" })` called once |
| 6 | `playing` (subsequent) → no-op | `video.fire("playing")` twice | `processEvent` called once total |
| 7 | `hasFiredFirstFrame` resets on `loading` | `playing` → `loading` → `playing` | second `first_frame` emitted after reset |
| 8 | `play` → `play` event | `video.fire("play")` | `processEvent({ type:"play" })` |
| 9 | `pause` → `pause` event | `video.fire("pause")` | `processEvent({ type:"pause" })` |
| 10 | `seeking` uses `lastPlayheadMs` from prior `timeupdate` | `currentTime=5.0`, `timeupdate`, `seeking` | `processEvent({ type:"seek_start", from_ms:5000 })` |
| 11 | `seeked` buffer ready → `seek_end { buffer_ready:true }` | `currentTime=5.0`, buffered `[0,10]`, `seeked` | `processEvent({ type:"seek_end", to_ms:5000, buffer_ready:true })` |
| 12 | `seeked` buffer empty → `seek_end { buffer_ready:false }` | `currentTime=15.0`, buffered `[0,10]`, `seeked` | `processEvent({ type:"seek_end", to_ms:15000, buffer_ready:false })` |
| 13 | `ended` → `ended` | `video.fire("ended")` | `processEvent({ type:"ended" })` |
| 14 | `timeupdate` → `setPlayhead(ms)` | `currentTime=12.5`, `timeupdate` | `setPlayhead(12500)` |
| 15 | `adaptation` → `quality_change` with track fields | `player.fireAdaptation()` | `processEvent({ type:"quality_change", quality:{ bitrate_bps:2500000, width:1280, height:720, framerate:29.97, codec:"avc1.4d401f" } })` |
| 16 | Shaka error `severity=CRITICAL` → `fatal:true` | `player.fireError(3016, 2)` | `processEvent({ type:"error", code:"3016", fatal:true, ... })` |
| 17 | Shaka error `severity=RECOVERABLE` → `fatal:false` | `player.fireError(1001, 1)` | `processEvent({ type:"error", code:"1001", fatal:false, ... })` |
| 18 | Video element `error` → `MEDIA_ERR_*` fatal | `video.error={code:3}`, `video.fire("error")` | `processEvent({ type:"error", code:"MEDIA_ERR_3", fatal:true })` |
| 19 | `unloading` → `session.destroy()` called | `player.fireUnloading()` | `destroy` called once |
| 20 | `destroy()` removes all listeners — post-destroy events ignored | `destroy()` then fire events | `processEvent` not called |
| 21 | `destroy()` idempotent — second call is no-op | `destroy()` twice | `session.destroy` called once |

---

## Differences from `plinth-hlsjs`

| Concern | `plinth-hlsjs` | `plinth-shaka` |
|---|---|---|
| Manifest load event | Hls.js `MANIFEST_LOADING` on Hls instance | Shaka `loading` on player |
| Manifest ready event | Hls.js `MANIFEST_PARSED` on Hls instance | Shaka `loaded` on player |
| Buffer stall | `<video>` `waiting` event | Shaka `buffering` (`event.buffering === true`) |
| Buffer recovery | `<video>` `playing` event (first_frame) | Shaka `buffering` (`event.buffering === false`) |
| Quality change | `LEVEL_SWITCHED` + `hls.levels[n]` | Shaka `adaptation` + `player.getVariantTracks()` |
| Error severity | `data.fatal === true` only | `detail.severity === 2` (fatal) or `=== 1` (non-fatal) |
| Auto-cleanup trigger | `DESTROYING` event | `unloading` event |
| `first_frame` guard | Not needed (Hls.js `playing` fires once on play start) | Required — `hasFiredFirstFrame` flag |
| Player listener API | `hls.on` / `hls.off` | `player.addEventListener` / `player.removeEventListener` |

---

## Build Commands

```bash
# From repo root or package directory
bun install

# Run tests
bun test --cwd packages/plinth-shaka

# Or from within the package directory
cd packages/plinth-shaka && bun test
```

No Wasm build step is required. `plinth-shaka` depends on `@wirevice/plinth-js` which includes pre-built Wasm, but tests bypass the real Wasm via `sessionFactory`.

---

## Relevant Files

| Path | Purpose |
|---|---|
| `packages/plinth-shaka/package.json` | Package manifest; peer dep on `shaka-player ^4` |
| `packages/plinth-shaka/tsconfig.json` | TypeScript config; mirrors `plinth-hlsjs` |
| `packages/plinth-shaka/src/index.ts` | `PlinthShaka` class, `isBufferReady` helper, public exports |
| `packages/plinth-shaka/tests/shaka.test.ts` | Unit tests with `FakePlayer` + `FakeVideo` |
