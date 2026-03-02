# TDD: dash.js Player Web Integration

## Overview

Technical design for `plinth-dashjs` (Layer 3) — a dash.js integration that mirrors `plinth-hlsjs` and `plinth-shaka` as closely as dash.js's API allows. No changes are made to `plinth-core` or `plinth-js`; the Wasm core and Layer 2 session are reused as-is.

Target: **dash.js v5** (native ESM, importable as `'dashjs'` from npm).

---

## Architecture

```
plinth-core (Rust / Wasm)
  └── plinth-js (TypeScript, Layer 2)          ← unchanged
        └── plinth-dashjs (TypeScript, Layer 3) ← this feature
              └── Application code
```

`plinth-dashjs` depends on `@plinth/js` (workspace) and `dashjs` (peer dependency). It never imports from `plinth-hlsjs` or `plinth-shaka`.

---

## File Structure

```
packages/
  web/
    plinth-dashjs/
      package.json
      tsconfig.json
      src/
        index.ts          # PlinthDashjs class + public exports
      tests/
        dashjs.test.ts    # Unit tests with FakePlayer + FakeVideo
```

---

## Layer 1 & Layer 2: No Changes

`plinth-core` and `plinth-js` are used without modification. The `PlinthSession` interface is identical to what `plinth-hlsjs` and `plinth-shaka` consume:

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
  "name": "@plinth/dashjs",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "bun test"
  },
  "dependencies": {
    "@plinth/js": "workspace:*"
  },
  "peerDependencies": {
    "dashjs": "^5.0.0"
  },
  "devDependencies": {
    "dashjs": "^5.0.0",
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
export class PlinthDashjs {
  static async initialize(
    player: DashjsPlayer,
    video: HTMLVideoElement,
    videoMeta: VideoMeta,
    options?: {
      config?: PlinthConfig;
      sessionFactory?: SessionFactory;
    },
  ): Promise<PlinthDashjs>;

  destroy(): void;
}

export interface VideoMeta {
  id: string;
  title?: string;
}

export type { PlinthConfig, SessionMeta } from "@plinth/js";
```

`initialize` is `async` because `PlinthSession.create` loads Wasm on first call. The returned instance must be retained by the caller. `destroy` is idempotent.

**Integration order**: `PlinthDashjs.initialize` must be called before `player.initialize(video, url)` or `player.attachSource(url)`, so listeners are in place before loading begins.

---

## `DashjsPlayer` Structural Interface

Rather than importing from `dashjs`, a minimal structural interface is defined locally. This keeps the tests free of the real `dashjs` package and avoids a browser-only import at test time.

```typescript
interface DashjsRepresentation {
  bandwidth: number;        // bits per second (from MPEG-DASH @bandwidth)
  width?: number | null;
  height?: number | null;
  frameRate?: number | string | null;  // may be "30000/1001" fraction or numeric
  codecs?: string | null;
}

interface DashjsPlayer {
  on(event: string, handler: (e?: unknown) => void, scope?: unknown): void;
  off(event: string, handler: (e?: unknown) => void, scope?: unknown): void;
  getSource(): string | null;
  getCurrentRepresentationForType(type: 'video'): DashjsRepresentation | null;
}
```

`FakePlayer` in tests implements this interface without importing `dashjs`.

---

## dash.js Event Constants

dash.js v5 exposes event constants as `dashjs.MediaPlayer.events.CONSTANT_NAME`. In the implementation, import and reference them via the `dashjs` package rather than hardcoding string values:

```typescript
import dashjs from 'dashjs';
const Events = dashjs.MediaPlayer.events;
// Events.MANIFEST_LOADING_STARTED, Events.STREAM_INITIALIZED, etc.
```

For testability, a local `const DashjsEvents` mapping mirrors these constants using their known string values so `FakePlayer` can fire events by name without a real `dashjs` import.

---

## `PlinthDashjs` Class Design

### Private State

```typescript
class PlinthDashjs {
  private session: PlinthSession;
  private player: DashjsPlayer;
  private video: HTMLVideoElement;
  private lastPlayheadMs = 0;
  private hasFiredFirstFrame = false;
  private destroyed = false;
  private playerHandlers = new Map<string, (e?: unknown) => void>();
  private videoHandlers = new Map<string, EventListener>();
}
```

### Construction

Private constructor, static `initialize` factory — same pattern as `PlinthHlsJs` and `PlinthShaka`.

```typescript
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
```

---

## Event Mapping

### dash.js Player Listeners (`attachPlayerListeners`)

Handlers are stored in `playerHandlers` and added via `player.on(event, handler)`.

| dash.js event constant | Trigger | Core `PlayerEvent` emitted |
|---|---|---|
| `MANIFEST_LOADING_STARTED` | Source attachment begins | `{ type: "load", src: player.getSource() ?? "" }`; also resets `hasFiredFirstFrame = false` |
| `STREAM_INITIALIZED` | Manifest parsed, stream ready | `{ type: "can_play" }` |
| `PLAYBACK_STALLED` | Buffer exhausted; playback halted | `{ type: "waiting" }` |
| `BUFFER_LOADED` | Buffer recovered | `{ type: "can_play_through" }` |
| `PLAYBACK_STARTED` | Playback begins or resumes | If `!hasFiredFirstFrame`: set flag, `emit({ type: "first_frame" })`; else no-op |
| `QUALITY_CHANGE_RENDERED` | ABR switch visible on screen | `{ type: "quality_change", quality: { ... } }` |
| `ERROR` | Player error | `{ type: "error", code, message, fatal: true }` |

**`MANIFEST_LOADING_STARTED` source note**: Call `player.getSource()` synchronously within the handler. Also reset `hasFiredFirstFrame = false` here so the flag clears for each new source load.

**`PLAYBACK_STARTED` handler pattern**:

```typescript
const onPlaybackStarted = () => {
  if (!this.hasFiredFirstFrame) {
    this.hasFiredFirstFrame = true;
    this.emit({ type: "first_frame" });
  }
};
player.on(Events.PLAYBACK_STARTED, onPlaybackStarted);
this.playerHandlers.set(Events.PLAYBACK_STARTED, onPlaybackStarted);
```

### Video Element Listeners (`attachVideoListeners`)

Listeners are stored in `videoHandlers` and added via `video.addEventListener`.

| `<video>` event | Action |
|---|---|
| `play` | `emit({ type: "play" })` |
| `pause` | `emit({ type: "pause" })` |
| `seeking` | `emit({ type: "seek_start", from_ms: lastPlayheadMs })` |
| `seeked` | `emit({ type: "seek_end", to_ms: video.currentTime * 1000, buffer_ready: isBufferReady(video) })` |
| `ended` | `emit({ type: "ended" })` |
| `timeupdate` | `lastPlayheadMs = video.currentTime * 1000; session.setPlayhead(lastPlayheadMs)` |
| `error` | Read `video.error`; `emit({ type: "error", code: \`MEDIA_ERR_${err.code}\`, fatal: true })` |

**Seek position tracking**: dash.js seek event payloads do not carry reliable position data. `from_ms` is captured from `lastPlayheadMs` (updated continuously via `timeupdate`) when `seeking` fires. `to_ms` is read from `video.currentTime` when `seeked` fires.

---

## Quality Change Mapping

In the `QUALITY_CHANGE_RENDERED` handler, call `player.getCurrentRepresentationForType('video')` to get the active representation. In MPEG-DASH, `bandwidth` is specified in bits per second.

`frameRate` may be a numeric value or a fraction string (e.g. `"30000/1001"` for 29.97 fps). Parse it:

```typescript
function parseFrameRate(fr: number | string | null | undefined): number | undefined {
  if (fr == null) return undefined;
  if (typeof fr === "number") return fr;
  const parts = fr.split("/");
  if (parts.length === 2) return Number(parts[0]) / Number(parts[1]);
  return parseFloat(fr) || undefined;
}
```

```typescript
const onQualityChangeRendered = () => {
  const rep = this.player.getCurrentRepresentationForType('video');
  if (!rep) return;
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
```

---

## Error Handling

All dash.js `ERROR` events are reported as `fatal: true` — the app decides how to handle them:

```typescript
const onError = (e?: unknown) => {
  const detail = (e as any);
  if (!detail) return;
  this.emit({
    type: "error",
    code: String(detail.code ?? "UNKNOWN"),
    message: detail.message,
    fatal: true,
  });
};
```

Video element `error` events surface codec/decode errors dash.js may not catch:

```typescript
const onVideoError: EventListener = () => {
  const err = this.video.error;
  if (!err) return;
  this.emit({ type: "error", code: `MEDIA_ERR_${err.code}`, fatal: true });
};
```

---

## `isBufferReady` Helper

Identical to `plinth-hlsjs` and `plinth-shaka`:

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

dash.js provides no teardown event (unlike Shaka's `unloading`). The caller is responsible for calling `destroy()`. The method is idempotent via the `destroyed` flag.

```typescript
destroy(): void {
  if (this.destroyed) return;
  this.destroyed = true;

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
```

---

## Session Metadata

```typescript
sdk: {
  api_version: 1,
  core:      { name: "plinth-core",   version: "0.1.0" },
  framework: { name: "plinth-js",     version: "0.1.0" },
  player:    { name: "plinth-dashjs", version: "0.1.0" },
}
```

---

## Testing Strategy

No Wasm, no real network. Inject a mock session via `sessionFactory`. `FakePlayer` implements a custom `on`/`off`/`fire` emitter — not `EventTarget` — because dash.js uses `player.on(event, handler)`, not DOM-style `addEventListener`.

### `FakePlayer`

```typescript
class FakePlayer {
  private listeners = new Map<string, Array<(e?: unknown) => void>>();
  private _source = "https://example.com/manifest.mpd";
  private _representation = {
    bandwidth: 2_500_000,
    width: 1280,
    height: 720,
    frameRate: 29.97,
    codecs: "avc1.4d401f",
  };

  on(event: string, handler: (e?: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler);
  }

  off(event: string, handler: (e?: unknown) => void): void {
    const hs = this.listeners.get(event);
    if (!hs) return;
    const idx = hs.indexOf(handler);
    if (idx !== -1) hs.splice(idx, 1);
  }

  getSource(): string { return this._source; }
  getCurrentRepresentationForType(): typeof this._representation { return this._representation; }

  fire(event: string, data?: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(data);
  }
}
```

### `FakeVideo`

Same stub as in `plinth-hlsjs` and `plinth-shaka` tests:

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

### Mock Session and Setup Helper

Identical pattern to `plinth-shaka`:

```typescript
function makeMockSession() {
  return {
    processEvent: mock(() => {}),
    setPlayhead: mock(() => {}),
    destroy: mock(() => {}),
  };
}

async function setup(player: FakePlayer, video: FakeVideo, mockSession: ReturnType<typeof makeMockSession>) {
  const sessionFactory = mock(async () => mockSession as unknown as PlinthSession);
  return PlinthDashjs.initialize(
    player as unknown as DashjsPlayer,
    video as unknown as HTMLVideoElement,
    { id: "vid-001", title: "Test Video" },
    { sessionFactory },
  );
}
```

---

## Test Coverage

| # | Test description | Setup | Assert |
|---|---|---|---|
| 1 | `MANIFEST_LOADING_STARTED` → `load` with URI from `getSource()` | `player.fire('manifestLoadingStarted')` | `processEvent({ type:"load", src:"https://example.com/manifest.mpd" })` |
| 2 | `STREAM_INITIALIZED` → `can_play` | `player.fire('streamInitialized')` | `processEvent({ type:"can_play" })` |
| 3 | `PLAYBACK_STALLED` → `waiting` | `player.fire('playbackStalled')` | `processEvent({ type:"waiting" })` |
| 4 | `BUFFER_LOADED` → `can_play_through` | `player.fire('bufferLoaded')` | `processEvent({ type:"can_play_through" })` |
| 5 | `PLAYBACK_STARTED` (first) → `first_frame` | `player.fire('playbackStarted')` | `processEvent({ type:"first_frame" })` called once |
| 6 | `PLAYBACK_STARTED` (subsequent) → no-op | `player.fire('playbackStarted')` twice | `processEvent` called once total |
| 7 | `hasFiredFirstFrame` resets on `MANIFEST_LOADING_STARTED` | `started` → `loading` → `started` | second `first_frame` emitted after reset |
| 8 | `play` video event → `play` | `video.fire('play')` | `processEvent({ type:"play" })` |
| 9 | `pause` video event → `pause` | `video.fire('pause')` | `processEvent({ type:"pause" })` |
| 10 | `seeking` uses `lastPlayheadMs` from prior `timeupdate` | `currentTime=5.0`, `timeupdate`, `seeking` | `processEvent({ type:"seek_start", from_ms:5000 })` |
| 11 | `seeked` buffer ready → `seek_end { buffer_ready:true }` | `currentTime=5.0`, buffered `[0,10]`, `seeked` | `processEvent({ type:"seek_end", to_ms:5000, buffer_ready:true })` |
| 12 | `seeked` buffer empty → `seek_end { buffer_ready:false }` | `currentTime=15.0`, buffered `[0,10]`, `seeked` | `processEvent({ type:"seek_end", to_ms:15000, buffer_ready:false })` |
| 13 | `ended` video event → `ended` | `video.fire('ended')` | `processEvent({ type:"ended" })` |
| 14 | `timeupdate` → `setPlayhead(ms)` | `currentTime=12.5`, `timeupdate` | `setPlayhead(12500)` |
| 15 | `QUALITY_CHANGE_RENDERED` → `quality_change` with representation fields | `player.fire('qualityChangeRendered')` | `processEvent({ type:"quality_change", quality:{ bitrate_bps:2500000, width:1280, height:720, framerate:29.97, codec:"avc1.4d401f" } })` |
| 16 | `ERROR` event → `fatal: true` | `player.fire('error', { code: 34, message: "manifest error" })` | `processEvent({ type:"error", code:"34", fatal:true, message:"manifest error" })` |
| 17 | Video element `error` → `MEDIA_ERR_*` fatal | `video.error={code:3}`, `video.fire("error")` | `processEvent({ type:"error", code:"MEDIA_ERR_3", fatal:true })` |
| 18 | `destroy()` removes all listeners — post-destroy events ignored | `destroy()` then fire events | `processEvent` not called |
| 19 | `destroy()` idempotent — second call is no-op | `destroy()` twice | `session.destroy` called once |

---

## Sample App

Following the Shaka sample pattern:

- `samples/web/dashjs.html` — demo page; dash.js bundled directly (no CDN script tag needed)
- `samples/web/dashjs-main.ts` — `import { MediaPlayer } from 'dashjs'`; calls `PlinthDashjs.initialize` before `player.initialize(video, url, false)`
- `samples/web/server.ts` — add a third Bun build entry for `dashjs-main.ts`; add `/dashjs` route serving `dashjs.html`
- `samples/web/home.html` — add a third demo card linking to `/dashjs`
- `samples/web/package.json` — add `"@plinth/dashjs": "workspace:*"` and `"dashjs": "^5.0.0"`

Unlike Hls.js (externalled, loaded from CDN) and Shaka (UMD global, loaded via `<script>`), dash.js v5 is bundled directly by Bun because it ships native ESM. No `external` declaration or UMD global workaround is needed.

---

## Differences from `plinth-hlsjs` and `plinth-shaka`

| Concern | `plinth-hlsjs` | `plinth-shaka` | `plinth-dashjs` |
|---|---|---|---|
| Player event API | `hls.on` / `hls.off` | `player.addEventListener` / `removeEventListener` | `player.on` / `player.off` |
| Test fake type | `extends EventTarget` | `extends EventTarget` | Custom `on`/`off`/`fire` emitter |
| Manifest loading event | `MANIFEST_LOADING` | Shaka `loading` | `MANIFEST_LOADING_STARTED` |
| Content ready event | `MANIFEST_PARSED` | Shaka `loaded` | `STREAM_INITIALIZED` |
| Buffer stall | `<video>` `waiting` | Shaka `buffering(true)` | `PLAYBACK_STALLED` |
| Buffer recovery | `<video>` `canplaythrough` | Shaka `buffering(false)` | `BUFFER_LOADED` |
| First frame signal | `<video>` `playing` (no guard needed) | `<video>` `playing` (with guard) | `PLAYBACK_STARTED` (with guard) |
| Seek position source | `<video>` `seeking`/`seeked` | `<video>` `seeking`/`seeked` | `<video>` `seeking`/`seeked` |
| Quality change | `LEVEL_SWITCHED` + `hls.levels[n]` | `adaptation` + `getVariantTracks()` | `QUALITY_CHANGE_RENDERED` + `getCurrentRepresentationForType()` |
| Error severity | `data.fatal === true` | `detail.severity === 2` | All `ERROR` events: `fatal: true` |
| Auto-cleanup trigger | `DESTROYING` event | `unloading` event | None — caller must call `destroy()` |
| Package bundling | External (CDN script) | External (CDN UMD global) | Bundled directly (native ESM) |

---

## Build Commands

```bash
# From repo root or package directory
bun install

# Run tests
bun test --cwd packages/web/plinth-dashjs

# Or from within the package directory
cd packages/web/plinth-dashjs && bun test
```

No Wasm build step required. Tests bypass real Wasm via `sessionFactory`.

---

## Relevant Files

| Path | Purpose |
|---|---|
| `packages/web/plinth-dashjs/package.json` | Package manifest; peer dep on `dashjs ^5` |
| `packages/web/plinth-dashjs/tsconfig.json` | TypeScript config; mirrors `plinth-hlsjs` |
| `packages/web/plinth-dashjs/src/index.ts` | `PlinthDashjs` class, `isBufferReady`, `parseFrameRate`, exports |
| `packages/web/plinth-dashjs/tests/dashjs.test.ts` | Unit tests with `FakePlayer` + `FakeVideo` |
| `samples/web/dashjs.html` | dash.js demo page |
| `samples/web/dashjs-main.ts` | Demo entry point |
| `samples/web/server.ts` | Updated to build and serve `/dashjs` |
| `samples/web/home.html` | Updated with dash.js demo card |
| `samples/web/package.json` | Updated with `@plinth/dashjs` and `dashjs` deps |
