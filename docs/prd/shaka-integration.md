# Feature PRD: Shaka Player Web Integration

## Overview

Add a [Shaka Player](https://github.com/shaka-project/shaka-player) integration as a new Layer 3 package (`plinth-shaka`). Shaka is Google's open-source adaptive streaming library for web, primarily targeting DASH but also supporting HLS and other formats. It is a common alternative to Hls.js in production streaming applications.

This integration follows the same three-layer architecture and mirrors the `plinth-hlsjs` implementation as closely as Shaka's API allows.

---

## Goals

- Application developers integrate in a single `await PlinthShaka.initialize(player, video, videoMeta)` call
- No changes to `plinth-core` or `plinth-js` — Layer 2 is reused as-is
- Event mapping is correct for Shaka's buffering model, which differs meaningfully from Hls.js
- Test coverage matches `plinth-hlsjs` (fake player, no real network, no Wasm)

---

## Architecture

```
plinth-core (Rust / Wasm)
  └── plinth-js (TypeScript, Layer 2)
        └── plinth-shaka (TypeScript, Layer 3)   ← this feature
              └── Application code
```

`plinth-shaka` depends on `@plinth/js` (workspace) and `shaka-player` (peer dependency). It never imports from `plinth-hlsjs`.

---

## Package

| Field | Value |
|---|---|
| Location | `packages/plinth-shaka/` |
| Package name | `@plinth/shaka` |
| Main class | `PlinthShaka` |
| Peer dependency | `shaka-player ^4` |
| Dev dependency | `shaka-player ^4` (for types + fake in tests) |

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

export type { PlinthConfig, SessionMeta } from "@plinth/js";
```

`initialize` is `async` because `PlinthSession.create` loads Wasm on first call (same reason as `PlinthHlsJs.initialize`). Subsequent calls reuse the cached Wasm module so the `await` resolves immediately.

The return value must be retained by the caller. `destroy` is idempotent.

---

## How Shaka's Event Model Differs from Hls.js

Hls.js fires most meaningful events on the `Hls` instance. Shaka splits events across two sources:

- **`shaka.Player` instance** — manifest lifecycle, buffering state, quality changes, errors
- **`HTMLVideoElement`** — playback control events (`play`, `pause`, `seeking`, `seeked`, `ended`, `timeupdate`, `playing`)

This means `PlinthShaka` must attach listeners to both, mirroring the `attachHlsListeners` / `attachVideoListeners` split already in `PlinthHlsJs`.

A critical difference: Shaka's **`buffering` event** is a single event that fires for both buffer-start and buffer-end, carrying a boolean `event.buffering`. Hls.js has no equivalent — it relies on the `<video>` element's `waiting` / `canplaythrough` events. This changes which source is used for `waiting` and `can_play_through`.

---

## Event Mapping

### Shaka Player Events

| Shaka event | `event.detail` / notes | Core `PlayerEvent` |
|---|---|---|
| `loading` | Fires when `player.load(url)` is called | `{ type: "load", src: url }` |
| `loaded` | Fires when the manifest is parsed and content is ready | `{ type: "can_play" }` |
| `buffering` | `event.buffering === true` — player stalled waiting for data | `{ type: "waiting" }` |
| `buffering` | `event.buffering === false` — buffer recovered, resuming | `{ type: "can_play_through" }` |
| `adaptation` | ABR switched the active variant; read new track via `player.getVariantTracks()` | `{ type: "quality_change", quality: { ... } }` |
| `error` | `event.detail` is `shaka.util.Error`; fatal when `severity === CRITICAL` | `{ type: "error", code, message, fatal }` |

> **Note on `loading` src**: Shaka's `loading` event does not carry the URL in `event.detail`. Use `player.getAssetUri()` immediately after the event fires to get the current URL.

### Video Element Events

| `<video>` event | Core `PlayerEvent` | Notes |
|---|---|---|
| `play` | `{ type: "play" }` | User or programmatic resume |
| `playing` | `{ type: "first_frame" }` | First frame rendered; fired every resume, so `hasFiredFirstFrame` flag is needed |
| `pause` | `{ type: "pause" }` | |
| `seeking` | `{ type: "seek_start", from_ms: lastPlayheadMs }` | Capture `lastPlayheadMs` before seek moves the playhead |
| `seeked` | `{ type: "seek_end", to_ms, buffer_ready }` | `buffer_ready` from `isBufferReady(video)` (same helper as hlsjs) |
| `ended` | `{ type: "ended" }` | |
| `timeupdate` | — | Updates `lastPlayheadMs`; calls `session.setPlayhead(ms)` |
| `error` | `{ type: "error", code, fatal: true }` | From `video.error` (`MediaError`); fires for codec / decode errors Shaka doesn't surface |

### `hasFiredFirstFrame` Flag

Shaka fires no distinct "first frame" event. The `<video>` element's `playing` event serves this role, but it also fires on every resume from pause or rebuffer recovery. A boolean flag `hasFiredFirstFrame` (reset on each `loading` event) ensures `first_frame` is emitted only once per play session. After the flag is set, `playing` events are ignored.

---

## Quality Change Details

After an `adaptation` event, call `player.getVariantTracks()` and find the active track (`track.active === true`). Map its fields:

| Shaka `TrackInfo` field | Beacon `quality` field |
|---|---|
| `track.bandwidth` | `bitrate_bps` |
| `track.width` | `width` |
| `track.height` | `height` |
| `track.frameRate` | `framerate` |
| `track.videoCodec` | `codec` |

---

## Error Handling

Shaka errors carry `shaka.util.Error.Severity`:
- `RECOVERABLE (1)` — non-fatal; emit `error` beacon with `fatal: false`
- `CRITICAL (2)` — fatal; emit `error` beacon with `fatal: true`

Error code is `event.detail.code` (a numeric constant from `shaka.util.Error.Code`). Convert to a string for the beacon: `String(event.detail.code)`. Use `event.detail.message` or `shaka.util.Error.codeToString(event.detail.code)` for the human-readable message if available.

---

## Listener Cleanup

Store all listeners in two `Map` instances — one for Shaka events, one for video element events — and remove them all in `destroy()`. Same pattern as `PlinthHlsJs`.

```typescript
private shakaHandlers = new Map<string, EventListener>();
private videoHandlers = new Map<string, EventListener>();
```

Auto-destroy when Shaka tears itself down: listen for Shaka's `unloading` event and call `this.destroy()`.

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

## Test Strategy

No Wasm, no real network. Inject a `FakeSession` via `sessionFactory`. Build a minimal `FakePlayer` event emitter that implements just enough of `shaka.Player`'s surface to fire events and return stub data.

```typescript
class FakePlayer extends EventTarget {
  getAssetUri() { return "https://example.com/manifest.mpd"; }
  getVariantTracks() { return [{ active: true, bandwidth: 2_500_000, width: 1280, height: 720, frameRate: 29.97, videoCodec: "avc1.4d401f" }]; }
  fireLoading() { this.dispatchEvent(new Event("loading")); }
  fireLoaded()  { this.dispatchEvent(new Event("loaded")); }
  fireBuffering(buffering: boolean) {
    const e = new Event("buffering");
    (e as any).buffering = buffering;
    this.dispatchEvent(e);
  }
  fireAdaptation() { this.dispatchEvent(new Event("adaptation")); }
  fireError(code: number, severity: number) {
    const e = new Event("error");
    (e as any).detail = { code, severity, message: "test error" };
    this.dispatchEvent(e);
  }
}
```

`FakeVideo` reuses the same `EventTarget`-based stub already established in `plinth-hlsjs` tests.

### Test Coverage Targets

- `load` emitted on Shaka `loading`
- `can_play` emitted on Shaka `loaded`
- `first_frame` emitted on first `playing` but not on subsequent `playing` events
- `waiting` emitted when `buffering` event fires with `buffering === true`
- `can_play_through` emitted when `buffering` event fires with `buffering === false`
- `play` and `pause` emitted from video element events
- `seek_start` captures `lastPlayheadMs` as `from_ms`; `seek_end` carries correct `to_ms`
- `quality_change` reads `getVariantTracks()` and maps fields correctly
- Fatal error (`severity === CRITICAL`) emits `error` with `fatal: true`
- Non-fatal error emits `error` with `fatal: false`
- `destroy()` is idempotent — calling twice does not throw or double-emit
- `destroy()` removes all Shaka and video listeners

---

## Differences from `plinth-hlsjs` Summary

| Concern | `plinth-hlsjs` | `plinth-shaka` |
|---|---|---|
| Manifest load event | `Hls.MANIFEST_LOADING` | Shaka `loading` |
| Manifest ready event | `Hls.MANIFEST_PARSED` | Shaka `loaded` |
| Buffer stall | `<video>` `waiting` | Shaka `buffering` (`event.buffering === true`) |
| Buffer recovery | `<video>` `canplaythrough` | Shaka `buffering` (`event.buffering === false`) |
| Quality change | `Hls.LEVEL_SWITCHED` + `hls.levels[data.level]` | Shaka `adaptation` + `player.getVariantTracks()` |
| Fatal error | `Hls.ERROR` where `data.fatal === true` | Shaka `error` where `severity === CRITICAL` |
| Auto-cleanup trigger | `Hls.DESTROYING` | Shaka `unloading` |
| `first_frame` guard | Not needed (Hls.js `playing` fires reliably once) | Required — `hasFiredFirstFrame` flag |

---

## Relevant Files (to be created)

| Path | Purpose |
|---|---|
| `packages/plinth-shaka/package.json` | Package manifest; peer dep on `shaka-player ^4` |
| `packages/plinth-shaka/tsconfig.json` | TypeScript config; mirrors `plinth-hlsjs` |
| `packages/plinth-shaka/src/index.ts` | `PlinthShaka` class |
| `packages/plinth-shaka/src/index.test.ts` | Unit tests with `FakePlayer` + `FakeVideo` |
