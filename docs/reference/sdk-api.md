# SDK API Reference

Both player integrations expose the same three-method surface. The platform framework (`PlinthSession`) is hidden behind this API — application code never touches it directly.

---

## `PlinthHlsJs` (TypeScript / Web)

### `PlinthHlsJs.initialize(hls, video, videoMeta, options?)` → `Promise<PlinthHlsJs>`

Creates an instance, attaches all event listeners, and starts the heartbeat timer. Must be awaited (Wasm loads on first call).

| Parameter | Type | Description |
|---|---|---|
| `hls` | `Hls` | The Hls.js instance (must already have a source loaded). |
| `video` | `HTMLVideoElement` | The `<video>` element attached to `hls`. |
| `videoMeta.id` | `string` | Unique content identifier. |
| `videoMeta.title` | `string?` | Human-readable title. |
| `options.config` | `PlinthConfig?` | Override endpoint, project key, or heartbeat interval. |
| `options.sessionFactory` | `SessionFactory?` | Test seam — replaces `PlinthSession.create`. |

### `plinth.destroy()` → `void`

Removes all event listeners, flushes any final beacons, and frees Wasm memory. Idempotent. Call before releasing the Hls.js instance or navigating away.

---

## `PlinthAVPlayer` (Swift / Apple platforms)

### `PlinthAVPlayer.initialize(player:videoMeta:options:)` → `PlinthAVPlayer`

Creates an instance and attaches KVO observers and AVFoundation notification observers to the player. If the player already has a current item at the time of the call, `load` is emitted immediately.

| Parameter | Type | Description |
|---|---|---|
| `player` | `AVPlayer` | The player instance to monitor. |
| `videoMeta.id` | `String` | Unique content identifier. |
| `videoMeta.title` | `String?` | Human-readable title. |
| `options.config` | `PlinthConfig` | Override endpoint, project key, or heartbeat interval. Defaults to `PlinthConfig.default`. |
| `options.sessionFactory` | `AVPlayerSessionFactory?` | Test seam — replaces `PlinthSession.create`. |

The return value is `@discardableResult` but must be retained (e.g., as a property) for observers to remain active.

### `plinth.seek(to:)` → `void`

Optional convenience wrapper around `player.seek(to:toleranceBefore:toleranceAfter:)` that uses zero tolerance. The SDK detects all seeks automatically via the periodic time observer, so calling this directly is not required. Use it when precise zero-tolerance seeking is needed; it suppresses the duplicate event that would otherwise fire from the periodic observer.

### `plinth.destroy()` → `void`

Invalidates all KVO observations, removes notification observers, stops the heartbeat timer, and flushes any final beacons. Idempotent. Call before releasing the `AVPlayer`.

---

## `PlinthConfig`

Shared across both platforms.

| Field | Default | Description |
|---|---|---|
| `endpoint` | `http://localhost:3000/beacon` | URL that receives `POST` requests with beacon batches. |
| `project_key` | `p123456789` | Identifies the project. Included in every beacon payload. |
| `heartbeat_interval_ms` | `10000` | Milliseconds between heartbeat beacons while a session is active. |

---

## Lifecycle diagram

```
initialize()
    │
    ▼
[Idle] ──load──► [Loading] ──canPlay──► [Ready]
                                            │
                                          play()
                                            │
                                            ▼
                                      [PlayAttempt] ──first_frame──► [Playing]
                                            │                            │
                                         waiting                    pause/seek/end
                                            │                            │
                                            ▼                            ▼
                                       [Buffering]               [Paused/Seeking/Ended]
                                            │
                                       first_frame
                                            │
                                            ▼
                                        [Playing]

destroy() → session_end beacon (if session was active)
```
