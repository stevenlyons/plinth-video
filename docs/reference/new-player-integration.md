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

- **Web**: create a TypeScript package in `packages/`, depend on `@plinth/js`
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
load  →  can_play  →  play  →  [waiting]  →  first_frame  →  playing  →  ended
```

| Core event | When to emit |
|---|---|
| `load` | Player begins loading a new source (URL / manifest URL). |
| `can_play` | Player has parsed enough to start playback (manifest ready, `readyState ≥ 2`). |
| `play` | User initiates playback (or resumes after pause). |
| `first_frame` | First frame renders — the player is actually outputting video. |
| `can_play_through` | Buffer recovered after stall; player resumes output. |
| `waiting` | Player stalls waiting for data (rebuffer, initial buffer). |
| `pause` | Playback paused by user or programmatically. |
| `seek_start` | Seek begins. Pass `from_ms` (last known playhead position). |
| `seek_end` | Seek complete. Pass `to_ms` and `buffer_ready`. |
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
- The full `load → can_play → play → first_frame` path emits `session_open` + `first_frame`
- `destroy` is idempotent and cleans up all listeners
- Seek events bracket correctly (`seek_start` before `seek_end`)

See `packages/plinth-hlsjs/src/index.test.ts` (web) and `Tests/PlinthAVPlayerTests/` (Swift) for reference test patterns.

---

## Naming convention

| Component | Package name | Class name |
|---|---|---|
| Hls.js (web) | `@plinth/hlsjs` | `PlinthHlsJs` |
| AVPlayer (Apple) | `PlinthAVPlayer` (SPM target) | `PlinthAVPlayer` |
| Your player (web) | `@plinth/<playername>` | `Plinth<PlayerName>` |
| Your player (Swift) | `Plinth<PlayerName>` (SPM target) | `Plinth<PlayerName>` |
