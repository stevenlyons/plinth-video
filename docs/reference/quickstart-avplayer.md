# Quick-start: AVPlayer Integration

Integrate plinth-telemetry into an AVPlayer app in three steps.

## Prerequisites

- iOS 16+ or macOS 13+
- Xcode 15+ / Swift 5.9+
- The dev server (`samples/web/`) running on `http://localhost:3000` to receive beacons

## 1. Install

Add the package via Swift Package Manager. In Xcode: **File → Add Package Dependencies**, enter the repo URL, and add `PlinthAVPlayer` to your target (it pulls in `PlinthApple` automatically as a dependency).

Or in `Package.swift`:

```swift
.package(url: "https://github.com/your-org/plinth-telemetry", from: "0.1.0")
```

Then add `PlinthAVPlayer` to your target's dependencies:

```swift
.target(
    name: "MyApp",
    dependencies: ["PlinthAVPlayer"]
)
```

## 2. Wire up

```swift
import AVFoundation
import PlinthAVPlayer

let player = AVPlayer(url: URL(string: "https://example.com/stream.m3u8")!)
let playerLayer = AVPlayerLayer(player: player)

let plinth = PlinthAVPlayer.initialize(
    player: player,
    videoMeta: AVVideoMeta(id: "my-video-id", title: "My Video")
)

player.play()
```

`initialize` attaches all KVO observations and notification listeners immediately and starts the heartbeat timer. It is synchronous — there is no async Wasm load step as on the web.

If the player already has a `currentItem` at initialization time, a `load` event is emitted automatically.

## 3. Clean up

```swift
// Before releasing the player or loading a new source:
plinth.destroy()
```

`destroy` is idempotent — safe to call multiple times. It is also called automatically from `deinit` if you forget, but explicit cleanup is preferred to control timing of the final beacon flush.

## Seeks

AVPlayer does not expose a delegate or notification for programmatic seeks initiated by your own code. For accurate `seek_start`/`seek_end` metrics when calling `seek(to:)` yourself, route the call through the plinth wrapper instead of calling the player directly:

```swift
// Instead of: player.seek(to: time)
plinth.seek(to: time)
```

This emits `seek_start` immediately, calls `player.seek(to:toleranceBefore:toleranceAfter:)` with zero tolerance, and emits `seek_end` in the completion handler once the player has settled.

Seeks initiated by the system (e.g. `AVPlayerView` / `AVPlayerViewController` scrubber on macOS, or any indirect seek) are detected automatically via the periodic time observer — no extra wiring required.

## Configuration (optional)

Pass an `Options` value to override the beacon endpoint, project key, or heartbeat interval:

```swift
let options = PlinthAVPlayer.Options(
    config: PlinthConfig(
        endpoint: "https://ingest.example.com/beacon",
        projectKey: "p_your_key",
        heartbeatIntervalMs: 30_000
    )
)

let plinth = PlinthAVPlayer.initialize(
    player: player,
    videoMeta: AVVideoMeta(id: "my-video-id", title: "My Video"),
    options: options
)
```

## Test seam: `sessionFactory`

For unit tests, inject a `sessionFactory` to bypass the real `PlinthSession` and HTTP posting:

```swift
let options = PlinthAVPlayer.Options(
    sessionFactory: { meta, config in
        // Return a mock session or nil to disable beacon sending
        MockPlinthSession(meta: meta, config: config)
    }
)
```

See `PlinthAVPlayerTests` for examples of testing event handling by calling the internal `handle*` methods directly on a `PlinthAVPlayer` instance wired with a mock session.

## Events mapped

| AVFoundation source                          | Core `PlayerEvent`                                                        |
|----------------------------------------------|---------------------------------------------------------------------------|
| `player.currentItem` KVO (item replaced)     | `load`                                                                    |
| `AVPlayerItem.status` → `.readyToPlay`       | `can_play`                                                                |
| `player.rate` KVO (0 → >0)                   | `play`                                                                    |
| `player.timeControlStatus` → `.playing` (first time)     | `first_frame` — sets `hasFiredFirstFrame`          |
| `player.timeControlStatus` → `.waitingToPlayAtSpecifiedRate` (before first frame) | `waiting` — initial buffer stall |
| `player.timeControlStatus` → `.waitingToPlayAtSpecifiedRate` (after first frame)  | `stall` — mid-playback stall     |
| `player.timeControlStatus` → `.playing` (subsequent)     | `playing` — rebuffer recovery / resume from pause  |
| `player.rate` KVO (>0 → 0, not near end)     | `pause` — suppressed when current time is within 0.5 s of item duration  |
| Periodic observer — discontinuous position jump | `seek_start` + `seek_end`                                              |
| `plinth.seek(to:)` wrapper                   | `seek_start` + `seek_end` (precise)                                       |
| `AVPlayerItemDidPlayToEndTime`               | `ended`                                                                   |
| `AVPlayerItemFailedToPlayToEndTime`          | `error` (fatal)                                                           |
| `AVPlayerItem.status` → `.failed`            | `error` (fatal)                                                           |
| `AVPlayerItemNewAccessLogEntry`              | `quality_change`                                                          |
| Periodic observer — each tick                | updates playhead (heartbeat data)                                         |
