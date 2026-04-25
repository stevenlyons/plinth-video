# Adding a New Player Integration

A player integration is a thin layer (Layer 3) that translates player-specific events into the core `PlayerEvent` enum and delegates everything else to the platform framework (`PlinthSession`). It never touches HTTP, timers, or the Wasm/FFI boundary directly.

## Architecture recap

```
Your player  →  [Layer 3: player integration]  →  PlinthSession  →  Rust core
                 (this document)                   (platform fw)
```

---

## Checklist

### 1. Choose a platform

- **Web**: create a TypeScript package in `packages/`, depend on `@wirevice/plinth-js`
- **Apple**: add a new Swift target to `packages/plinth-swift/Package.swift`, depend on `PlinthSwift`

### 2. Implement `initialize` / `destroy`

```
initialize(player, videoElement, videoMeta, options?) → instance
destroy() → void
```

Inside `initialize`:
1. Build a `SessionMeta` object (video, client, sdk fields).
2. Call `PlinthSession.create(meta, config)` (or the injected `sessionFactory` if provided).
3. Attach all player event listeners.
4. If the player already has a loaded source, emit `load` immediately.

Inside `destroy`:
1. Remove every listener attached in `initialize`.
2. Call `session.destroy()`.
3. Guard with an `isDestroyed` flag — `destroy` must be idempotent.

### 3. Map player events to `PlayerEvent`

Work through the player's event API and map each to the corresponding core event. The required path for a successful play session is:

```
load  →  can_play  →  play  →  [waiting]  →  first_frame  →  [stall / playing ...]  →  ended
```

| Core event | When to emit |
|---|---|
| `load` | Player begins loading a new source (URL / manifest URL). |
| `can_play` | Player has parsed enough to start playback (manifest ready, `readyState ≥ 2`). |
| `play` | User initiates playback (or resumes after pause). |
| `waiting` | Buffer empty **before** first frame (PlayAttempt → Buffering). Emitted only once per load, before `first_frame` fires. |
| `first_frame` | First decoded frame rendered — emitted **once per load**. Use a `hasFiredFirstFrame` flag and reset it on each new `load`. |
| `stall` | Buffer exhausted **after** first frame (Playing → Rebuffering). Use the same `hasFiredFirstFrame` flag to distinguish from `waiting`. |
| `playing` | Rebuffer recovery or resume from pause (Rebuffering/Paused → Playing). Do not re-emit `first_frame` here. |
| `pause` | Playback paused by user or programmatically. **Suppress if the video has ended naturally** (check `video.ended`). **Also suppress if the video is currently seeking** (check `video.seeking`) — browsers and some players fire a spurious `pause` event during seeks that would corrupt the pre-seek state. |
| `seek` | Seek begins. Pass `from_ms` (last known playhead position). Debounce multiple seeking events; emit only once per gesture. After the debounce fires, emit `seek_end` with `to_ms` and `buffer_ready`. If the video is not paused at debounce time, also emit `playing` immediately after — the browser suppresses the native `playing` event during the debounce window and never re-fires it. |
| `quality_change` | ABR rendition switch. |
| `error` | Player or network error. |
| `ended` | Content reached natural end. |

Consult [`player-state-machine.mermaid`](player-state-machine.mermaid) for the full transition table. Events sent in wrong states are silently ignored by the core.

### 4. Track the playhead

Call `session.setPlayhead(ms)` regularly (e.g. from a `timeupdate` event or a periodic timer) so heartbeat beacons include a current `playhead_ms`.

### 5. Provide a `sessionFactory` test seam

Accept an optional `sessionFactory` in the options struct. When present, use it instead of calling `PlinthSession.create` directly. This lets tests inject a mock session without loading real Wasm or hitting the network.

```typescript
// TypeScript pattern
const factory = options?.sessionFactory ?? PlinthSession.create.bind(PlinthSession);
const session = await factory(meta, options?.config);
```

```swift
// Swift pattern
let factory: AVPlayerSessionFactory = options.sessionFactory ?? { meta, config in
    PlinthSession.create(meta: meta, config: config)
}
```

### 6. Write unit tests

Use a fake/stub player that lets you fire events programmatically. Inject a mock session via `sessionFactory`. Verify that:

- The correct `PlayerEvent` is sent for each player event
- The full `load → can_play → play → first_frame` path emits `play` + `first_frame` + `playing`
- `destroy` is idempotent and cleans up all listeners
- Seek emits exactly one `seek` per gesture, followed by `seek_end` then `playing` when the video resumes; `playing` is omitted when the video is paused after seeking

See `packages/plinth-hlsjs/src/index.test.ts` (web) and `Tests/PlinthAVPlayerTests/` (Swift) for reference test patterns.

---

## Naming convention

| Component | Package name | Class name |
|---|---|---|
| Hls.js (web) | `@wirevice/plinth-hlsjs` | `PlinthHlsJs` |
| AVPlayer (Apple) | `PlinthAVPlayer` (SPM target) | `PlinthAVPlayer` |
| Your player (web) | `@wirevice/plinth-<playername>` | `Plinth<PlayerName>` |
| Your player (Swift) | `Plinth<PlayerName>` (SPM target) | `Plinth<PlayerName>` |
