# Quick-start: Hls.js Integration

Integrate plinth-telemetry into a Hls.js player in three steps.

## Prerequisites

- Bun workspace (or any bundler with ESM support)
- `hls.js` ≥ 1.0
- The dev server (`samples/web/`) running on `http://localhost:3000` to receive beacons

## 1. Install

```bash
bun add hls.js
# plinth-hlsjs and plinth-js are workspace packages; no separate install needed
```

## 2. Wire up

```typescript
import Hls from "hls.js";
import { PlinthHlsJs } from "@wirevice/plinth-hlsjs";

const video = document.getElementById("video") as HTMLVideoElement;
const hls = new Hls();
hls.loadSource("https://example.com/stream.m3u8");
hls.attachMedia(video);

const plinth = await PlinthHlsJs.initialize(
  hls,
  video,
  { id: "my-video-id", title: "My Video" }, // VideoMeta
);
```

`initialize` is async because it loads the Wasm core on first call. It attaches all Hls.js and `HTMLVideoElement` event listeners automatically and starts the heartbeat timer.

## 3. Clean up

```typescript
// Before navigating away or loading a new source:
plinth.destroy();
```

`destroy` is idempotent — safe to call multiple times or if `Hls.destroy()` fires first.

## Configuration (optional)

Pass a `config` option to override the beacon endpoint, project key, or heartbeat interval:

```typescript
const plinth = await PlinthHlsJs.initialize(hls, video, videoMeta, {
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
import { PlinthSession } from "@wirevice/plinth-js";

const plinth = await PlinthHlsJs.initialize(hls, video, videoMeta, {
  sessionFactory: async (meta, config) => {
    return PlinthSession.create(meta, config, mockWasmModule);
  },
});
```

## Events mapped

| Hls.js / video event     | Core `PlayerEvent`                          |
|--------------------------|---------------------------------------------|
| `MANIFEST_LOADING`       | `load`                                      |
| `MANIFEST_PARSED`        | `can_play`                                  |
| `LEVEL_SWITCHED`         | `quality_change`                            |
| `ERROR` (fatal only)     | `error`                                     |
| `DESTROYING`             | triggers `destroy()`                        |
| `<video> play`           | `play`                                      |
| `<video> playing`        | `first_frame`                               |
| `<video> waiting`        | `waiting` (rebuffer start / initial buffer) |
| `<video> pause`          | `pause`                                     |
| `<video> seeking`        | `seek_start`                                |
| `<video> seeked`         | `seek_end`                                  |
| `<video> ended`          | `ended`                                     |
| `<video> canplaythrough` | `can_play_through`                          |
| `<video> timeupdate`     | updates playhead (heartbeat data)           |
