# Quick-start: dash.js Integration

Integrate plinth-telemetry into a dash.js player in three steps.

## Prerequisites

- Bun workspace (or any bundler with ESM support)
- `dashjs` ≥ 5.0
- The dev server (`samples/web/`) running on `http://localhost:3000` to receive beacons

## 1. Install

```bash
bun add dashjs
# plinth-dashjs and plinth-js are workspace packages; no separate install needed
```

## 2. Wire up

```typescript
import dashjs from "dashjs";
import { PlinthDashjs } from "@wirevice/plinth-dashjs";

const video = document.getElementById("video") as HTMLVideoElement;
const player = dashjs.MediaPlayer().create();
player.initialize(video, "https://example.com/stream.mpd", true);

const plinth = await PlinthDashjs.initialize(
  player,
  video,
  { id: "my-video-id", title: "My Video" }, // VideoMeta
);
```

`initialize` is async because it loads the Wasm core on first call. It attaches all dash.js and `HTMLVideoElement` event listeners automatically and starts the heartbeat timer.

Note: call `PlinthDashjs.initialize` before or immediately after `player.initialize()` so the `manifestLoadingStarted` event is captured.

## 3. Clean up

```typescript
// Before navigating away or loading a new source:
plinth.destroy();
player.destroy();
```

`destroy` is idempotent — safe to call multiple times. Unlike Hls.js and Shaka, dash.js does not expose a player-destroy event, so you must call `plinth.destroy()` explicitly.

## Configuration (optional)

Pass a `config` option to override the beacon endpoint, project key, or heartbeat interval:

```typescript
const plinth = await PlinthDashjs.initialize(player, video, videoMeta, {
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

const plinth = await PlinthDashjs.initialize(player, video, videoMeta, {
  sessionFactory: async (meta, config) => {
    return PlinthSession.create(meta, config, mockWasmModule);
  },
});
```

See `packages/web/plinth-dashjs/tests/dashjs.test.ts` for examples using a fake dash.js player emitter and a mock session.

## Events mapped

| dash.js / video event                        | Core `PlayerEvent`                                                       |
|----------------------------------------------|--------------------------------------------------------------------------|
| `MANIFEST_LOADING_STARTED`                   | `load` (src from `player.getSource()`); resets `hasFiredFirstFrame`      |
| `STREAM_INITIALIZED`                         | `can_play`                                                               |
| `QUALITY_CHANGE_RENDERED`                    | `quality_change`                                                         |
| `ERROR`                                      | `error` (all dash.js errors are treated as fatal)                        |
| `<video> play`                               | `play`                                                                   |
| `<video> playing` (first time)               | `first_frame` — sets `hasFiredFirstFrame`                                |
| `<video> playing` (subsequent)               | `playing` — buffer recovered; drives Buffering/Rebuffering → Playing     |
| `<video> waiting` (before first frame)       | `waiting` — initial buffer stall (PlayAttempt → Buffering)               |
| `<video> waiting` (after first frame)        | `stall` — mid-playback stall (Playing → Rebuffering); suppressed during seek |
| `<video> pause`                              | `pause` — suppressed when `video.ended` is true                          |
| `<video> seeking`                            | `seek_start`                                                             |
| `<video> seeked`                             | `seek_end`                                                               |
| `<video> ended`                              | `ended`                                                                  |
| `<video> timeupdate`                         | updates playhead (heartbeat data)                                        |
| `<video> error`                              | `error` (fatal, codec / decode errors)                                   |

### Key differences from Hls.js and Shaka

- **No auto-destroy**: dash.js has no equivalent of `DESTROYING` (Hls.js) or `unloading` (Shaka). Always call `plinth.destroy()` explicitly before releasing the player.
- **`first_frame` and `playing` via `<video> playing`**: Both initial playback and buffer-recovery signals come from the native video element `playing` event, guarded by `hasFiredFirstFrame` — the same pattern used by the HLS.js integration.
- **`stall` and `waiting` via `<video> waiting`**: The native video element `waiting` event fires whenever the browser cannot continue playback. `hasFiredFirstFrame` differentiates the initial buffering case (`waiting`) from a mid-playback rebuffer (`stall`). Seek-time waiting is suppressed by the `isSeeking` guard.
- **All errors are fatal**: dash.js surfaces errors without a severity field; all `ERROR` events emit `fatal: true`.
- **Quality dedup**: `QUALITY_CHANGE_RENDERED` fires on every segment switch. The integration deduplicates by comparing `bandwidth` against the previous emission so identical-bitrate switches don't produce spurious events.
