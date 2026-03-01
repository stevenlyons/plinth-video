# Quick-start: Shaka Player Integration

Integrate plinth-video into a Shaka Player app in three steps.

## Prerequisites

- Bun workspace (or any bundler with ESM support)
- `shaka-player` ≥ 4.0
- The dev server (`samples/web/`) running on `http://localhost:3000` to receive beacons

## 1. Install

```bash
bun add shaka-player
# plinth-shaka and plinth-js are workspace packages; no separate install needed
```

## 2. Wire up

```typescript
import { PlinthShaka } from "@plinth/shaka";

const video = document.getElementById("video") as HTMLVideoElement;

shaka.polyfill.installAll();

if (!shaka.Player.isBrowserSupported()) {
  console.error("Shaka Player not supported in this browser");
}

const player = new shaka.Player(video);

const plinth = await PlinthShaka.initialize(
  player,
  video,
  { id: "my-video-id", title: "My Video" }, // VideoMeta
);

await player.load("https://example.com/stream.mpd");
```

`initialize` is async because it loads the Wasm core on first call. It attaches all Shaka player and `HTMLVideoElement` event listeners automatically and starts the heartbeat timer.

Note: call `PlinthShaka.initialize` before `player.load()` so that the `loading` event is captured.

## 3. Clean up

```typescript
// Before navigating away or loading a new source:
plinth.destroy();
await player.destroy();
```

`destroy` is idempotent — safe to call multiple times. Shaka's `unloading` event will also trigger `destroy` automatically when `player.destroy()` fires.

## Configuration (optional)

Pass a `config` option to override the beacon endpoint, project key, or heartbeat interval:

```typescript
const plinth = await PlinthShaka.initialize(player, video, videoMeta, {
  config: {
    endpoint: "https://ingest.example.com/beacon",
    project_key: "p_your_key",
    heartbeat_interval_ms: 30_000,
  },
});
```

## Test seam: `sessionFactory`

For unit tests, inject a `sessionFactory` to bypass real Wasm loading and HTTP:

```typescript
import { PlinthSession } from "@plinth/js";

const plinth = await PlinthShaka.initialize(player, video, videoMeta, {
  sessionFactory: async (meta, config) => {
    return PlinthSession.create(meta, config, mockWasmModule);
  },
});
```

See `packages/web/plinth-shaka/tests/shaka.test.ts` for examples using `FakePlayer` and a mock session.

## Events mapped

| Shaka / video event              | Core `PlayerEvent`                           |
|----------------------------------|----------------------------------------------|
| Shaka `loading`                  | `load` (src from `player.getAssetUri()`)     |
| Shaka `loaded`                   | `can_play`                                   |
| Shaka `buffering` (true)         | `waiting` (rebuffer start / initial buffer)  |
| Shaka `buffering` (false)        | `can_play_through`                           |
| Shaka `adaptation`               | `quality_change`                             |
| Shaka `error` (severity CRITICAL)| `error` (fatal)                              |
| Shaka `error` (severity RECOVERABLE) | `error` (non-fatal)                      |
| Shaka `unloading`                | triggers `destroy()`                         |
| `<video> play`                   | `play`                                       |
| `<video> playing` (first time)   | `first_frame`                                |
| `<video> pause`                  | `pause`                                      |
| `<video> seeking`                | `seek_start`                                 |
| `<video> seeked`                 | `seek_end`                                   |
| `<video> ended`                  | `ended`                                      |
| `<video> timeupdate`             | updates playhead (heartbeat data)            |
| `<video> error`                  | `error` (fatal, codec / decode errors)       |

### Key difference from Hls.js

Shaka uses a single `buffering` event with a boolean flag for both buffer-stall and buffer-recovery, whereas Hls.js relies on the `<video>` element's `waiting` and `canplaythrough` events. The `playing` event guard (`hasFiredFirstFrame`) ensures `first_frame` is emitted only once per load — subsequent `playing` events on resume or rebuffer recovery are suppressed.
