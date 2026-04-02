# Quick-start: Media3 / ExoPlayer Integration

Integrate plinth-telemetry into an Android Media3 app in three steps.

## Prerequisites

- Android minSdk 24+
- `androidx.media3:media3-exoplayer` ≥ 1.3
- The dev server (`samples/web/`) running on `http://localhost:3000` to receive beacons
- The `plinth-core` native library built for your target ABI (see below)

## 1. Install

Add the Gradle modules to your `settings.gradle.kts` and app `build.gradle.kts`.

**`settings.gradle.kts`** (already present in this repo):

```kotlin
include(":plinth-android")
project(":plinth-android").projectDir = file("packages/android/plinth-android")

include(":plinth-media3")
project(":plinth-media3").projectDir = file("packages/android/plinth-media3")
```

**`app/build.gradle.kts`**:

```kotlin
dependencies {
    implementation(project(":plinth-media3"))
}
```

Build the native `.so` files before running:

```bash
cargo ndk \
  -t arm64-v8a -t armeabi-v7a -t x86_64 \
  -o packages/android/plinth-android/src/main/jniLibs \
  build -p plinth-core --release
```

## 2. Wire up

```kotlin
import androidx.media3.exoplayer.ExoPlayer
import io.plinth.media3.PlinthMedia3
import io.plinth.media3.Media3VideoMeta

val player = ExoPlayer.Builder(context).build()

val plinth = PlinthMedia3.initialize(
    player = player,
    videoMeta = Media3VideoMeta(id = "my-video-id", title = "My Video"),
)

val mediaItem = MediaItem.fromUri("https://example.com/stream.m3u8")
player.setMediaItem(mediaItem)
player.prepare()
player.play()
```

`initialize` is synchronous — it attaches a `Player.Listener` immediately, starts the coroutine heartbeat, and emits a `load` event if the player already has a `currentMediaItem`.

## 3. Clean up

```kotlin
// Before releasing the player or in onDestroy():
plinth.destroy()
player.release()
```

`destroy` is idempotent — safe to call multiple times. It removes the `Player.Listener`, cancels the heartbeat coroutine, and flushes the final beacon.

## Seeks

For accurate `seek_start`/`seek_end` metrics when seeking programmatically, route the call through the plinth wrapper:

```kotlin
// Instead of: player.seekTo(positionMs)
plinth.seekTo(positionMs)
```

This emits `seek_start` immediately and emits `seek_end` once `onPositionDiscontinuity` fires with `DISCONTINUITY_REASON_SEEK`. Scrubber seeks initiated via `PlayerView` are detected automatically through the same callback.

## Configuration (optional)

Pass a `Media3Options` value to override the beacon endpoint, project key, or heartbeat interval:

```kotlin
import io.plinth.android.PlinthConfig
import io.plinth.media3.Media3Options

val plinth = PlinthMedia3.initialize(
    player = player,
    videoMeta = Media3VideoMeta(id = "my-video-id", title = "My Video"),
    options = Media3Options(
        config = PlinthConfig(
            endpoint = "https://ingest.example.com/beacon",
            projectKey = "p_your_key",
            heartbeatIntervalMs = 30_000L,
        )
    ),
)
```

## Test seam: `sessionFactory`

For unit tests, inject a `sessionFactory` to bypass the real `PlinthSession` and HTTP posting:

```kotlin
val capturedBatches = mutableListOf<BeaconBatch>()

val plinth = PlinthMedia3.initialize(
    player = fakePlayer,
    videoMeta = Media3VideoMeta(id = "test"),
    options = Media3Options(
        sessionFactory = { meta, config ->
            PlinthSession.create(meta, config, beaconHandler = { capturedBatches += it })
        }
    ),
)
```

See `packages/android/plinth-media3/src/test/.../PlinthMedia3Test.kt` for examples calling the internal `handle*` methods directly without a real `Player`.

## Events mapped

| Media3 source                                              | Core `PlayerEvent`                                                            |
|------------------------------------------------------------|-------------------------------------------------------------------------------|
| `onMediaItemTransition`                                    | `load`                                                                        |
| `onPlaybackStateChanged(STATE_READY)` (before first frame) | `can_play`                                                                    |
| `onIsPlayingChanged(true)` (before first frame)            | `play`                                                                        |
| `onRenderedFirstFrame`                                     | `first_frame` — sets `hasFiredFirstFrame`                                     |
| `onPlaybackStateChanged(STATE_BUFFERING)` (before first frame) | `waiting` — initial buffer stall (PlayAttempt → Buffering)               |
| `onPlaybackStateChanged(STATE_BUFFERING)` (after first frame)  | `stall` — mid-playback stall (Playing → Rebuffering)                     |
| `onIsPlayingChanged(true)` (after first frame)             | `playing` — rebuffer recovery / resume from pause                             |
| `onIsPlayingChanged(false)` (not ended, not mid-play stall)| `pause` — suppressed during natural end (`isEndingNaturally`) and during stall|
| `plinth.seekTo()` wrapper                                  | `seek_start` + `seek_end` (precise)                                           |
| `onPositionDiscontinuity(DISCONTINUITY_REASON_SEEK)`       | `seek_start` + `seek_end` (scrubber seeks)                                    |
| `onPlaybackStateChanged(STATE_ENDED)`                      | `ended`                                                                       |
| `onPlayerError`                                            | `error` (fatal)                                                               |
| `onVideoSizeChanged`                                       | `quality_change`                                                              |
| Periodic coroutine (500 ms)                                | updates playhead (heartbeat data)                                             |
