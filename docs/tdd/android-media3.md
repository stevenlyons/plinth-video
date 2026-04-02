# TDD: Android Framework & Media3 Integration

## Overview

Technical design for `plinth-android` (Layer 2) and `plinth-media3` (Layer 3) — the Kotlin/Android counterparts to `plinth-swift` and `plinth-avplayer`. The Rust core (`plinth-core`) is reused without modification beyond adding an Android JNI bridge module.

---

## Architecture

```
plinth-core (Rust)
  └── compiled → .so (shared lib, per Android ABI)
        └── JNI bridge (Kotlin / C headers)
              └── plinth-android (Kotlin, Layer 2)
                    └── plinth-media3 (Kotlin, Layer 3)
                          └── Android sample app
```

The Rust core is compiled to a native shared library (`.so`) for each Android ABI using the Android NDK. Kotlin calls into the library via JNI. No Wasm is involved on Android. The JNI bridge replaces the C FFI header approach used on Apple. Java/Kotlin manages string memory, so there is no `free_string` equivalent — the JVM GC owns all returned strings.

---

## File Structure

```
crates/
  plinth-core/
    src/
      jni.rs                          # New: Android JNI exports (cfg android)

packages/
  plinth-android/
    build.gradle.kts
    src/
      main/
        java/io/plinth/android/
          PlinthCoreJni.kt            # internal: native method declarations
          PlinthSession.kt            # Layer 2 public API
          PlinthConfig.kt
          SessionMeta.kt
          Beacon.kt
          BeaconBatch.kt
      test/
        java/io/plinth/android/
          PlinthSessionTest.kt

  plinth-media3/
    build.gradle.kts
    src/
      main/
        java/io/plinth/media3/
          PlinthMedia3.kt             # Layer 3 public API
          Media3VideoMeta.kt
          Media3Options.kt
      test/
        java/io/plinth/media3/
          PlinthMedia3Test.kt

apps/
  android-sample/
    build.gradle.kts
    app/
      build.gradle.kts
      src/main/java/io/plinth/sample/
        MainActivity.kt
```

---

## Layer 0 changes: `plinth-core`

### New module: `src/jni.rs`

Gated on `#[cfg(target_os = "android")]`. Mirrors `ffi.rs` but uses JNI calling convention. The session pointer is passed as `jlong` (i64) across the JNI boundary.

```rust
// crates/plinth-core/src/jni.rs
#[cfg(target_os = "android")]
use jni::objects::{JClass, JString};
#[cfg(target_os = "android")]
use jni::sys::{jlong, jstring};
#[cfg(target_os = "android")]
use jni::JNIEnv;
```

**JNI function signatures** (Kotlin class: `io.plinth.android.PlinthCoreJni`):

| Rust export | Kotlin native | Description |
|---|---|---|
| `Java_io_plinth_android_PlinthCoreJni_sessionNew` | `sessionNew(configJson, metaJson, nowMs): Long` | Create session, return ptr as Long |
| `Java_io_plinth_android_PlinthCoreJni_sessionProcessEvent` | `sessionProcessEvent(ptr, eventJson, nowMs): String` | Returns beacon batch JSON |
| `Java_io_plinth_android_PlinthCoreJni_sessionTick` | `sessionTick(ptr, nowMs): String` | Returns beacon batch JSON |
| `Java_io_plinth_android_PlinthCoreJni_sessionSetPlayhead` | `sessionSetPlayhead(ptr, playheadMs)` | Unit |
| `Java_io_plinth_android_PlinthCoreJni_sessionDestroy` | `sessionDestroy(ptr, nowMs): String` | Returns final beacons, frees memory |

**Key implementation notes:**
- Session pointer stored as `Box::into_raw(Box::new(session)) as jlong`; recovered via `Box::from_raw(ptr as *mut Session)`
- Input `JString` → `env.get_string(&s)?.to_str()` → `&str`
- Return `String` → `env.new_string(json)?.into_raw()` (JVM owns the memory)
- NULL ptr guards identical to `ffi.rs`; return `{"beacons":[]}` JSON on error

### `Cargo.toml` additions

```toml
[target.'cfg(target_os = "android")'.dependencies]
jni = { version = "0.21", default-features = false }
```

The `lib.rs` gains:
```rust
#[cfg(target_os = "android")]
mod jni;
```

### Build targets

Four Android ABIs are required:

| ABI | Rust target triple |
|---|---|
| arm64-v8a | `aarch64-linux-android` |
| armeabi-v7a | `armv7-linux-androideabi` |
| x86_64 | `x86_64-linux-android` |
| x86 | `i686-linux-android` |

Build via `cargo-ndk`:

```bash
cargo install cargo-ndk
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android

# Build all ABIs (from repo root)
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o packages/plinth-android/src/main/jniLibs build -p plinth-core --release
```

Outputs `libplinth_core.so` into `jniLibs/<ABI>/` for Gradle to bundle automatically.

---

## Layer 2: `plinth-android`

### `PlinthCoreJni.kt` (internal)

Internal object that declares native methods and loads the library:

```kotlin
internal object PlinthCoreJni {
    init { System.loadLibrary("plinth_core") }

    external fun sessionNew(configJson: String?, metaJson: String, nowMs: Long): Long
    external fun sessionProcessEvent(ptr: Long, eventJson: String, nowMs: Long): String
    external fun sessionTick(ptr: Long, nowMs: Long): String
    external fun sessionSetPlayhead(ptr: Long, playheadMs: Long)
    external fun sessionDestroy(ptr: Long, nowMs: Long): String
}
```

### `PlinthConfig.kt`

```kotlin
data class PlinthConfig(
    val endpoint: String = "http://localhost:3000/beacon",
    val projectKey: String = "p123456789",
    val heartbeatIntervalMs: Long = 5_000L
)
```

JSON serialized as `{"endpoint":...,"project_key":...,"heartbeat_interval_ms":...}` to match the Rust `Config` struct field names (`snake_case`). Use `kotlinx.serialization` with `@SerialName` annotations.

### `SessionMeta.kt`

```kotlin
@Serializable
data class SessionMeta(
    val video: VideoMetadata,
    val client: ClientMetadata,
    val sdk: SdkMetadata
)

@Serializable
data class VideoMetadata(val id: String, val title: String? = null)

@Serializable
data class ClientMetadata(@SerialName("user_agent") val userAgent: String)

@Serializable
data class SdkMetadata(
    @SerialName("api_version") val apiVersion: Int,
    val core: SdkComponent,
    val framework: SdkComponent,
    val player: SdkComponent
)

@Serializable
data class SdkComponent(val name: String, val version: String)
```

### `Beacon.kt` / `BeaconBatch.kt`

Mirror the JSON schema. All optional fields annotated with `@SerialName` to match `snake_case` keys. Use `kotlinx.serialization`.

```kotlin
@Serializable
data class BeaconBatch(val beacons: List<Beacon>)

@Serializable
data class Beacon(
    val seq: Int,
    @SerialName("play_id") val playId: String,
    val ts: Long,
    val event: String,
    val state: String? = null,
    val metrics: Metrics? = null,
    @SerialName("playhead_ms") val playheadMs: Long? = null,
    @SerialName("seek_from_ms") val seekFromMs: Long? = null,
    @SerialName("seek_to_ms") val seekToMs: Long? = null,
    val video: VideoMetadata? = null,
    val client: ClientMetadata? = null,
    val sdk: SdkMetadata? = null,
    val quality: QualityLevel? = null,
    val error: PlayerError? = null
)

@Serializable
data class Metrics(
    @SerialName("vst_ms") val vstMs: Long?,
    @SerialName("played_ms") val playedMs: Long,
    @SerialName("rebuffer_ms") val rebufferMs: Long,
    @SerialName("watched_ms") val watchedMs: Long,
    @SerialName("rebuffer_count") val rebufferCount: Int,
    @SerialName("error_count") val errorCount: Int
)
```

### `PlinthSession.kt`

Public Layer 2 API. Owns the JNI session pointer, heartbeat coroutine, and HTTP posting.

```kotlin
class PlinthSession private constructor(
    private val ptr: Long,
    private val config: PlinthConfig,
    private val beaconHandler: (BeaconBatch) -> Unit,
    private val scope: CoroutineScope
) {
    @Volatile private var isDestroyed = false
    private var heartbeatJob: Job? = null

    companion object {
        fun create(
            meta: SessionMeta,
            config: PlinthConfig = PlinthConfig(),
            scope: CoroutineScope = CoroutineScope(Dispatchers.IO),
            beaconHandler: ((BeaconBatch) -> Unit)? = null
        ): PlinthSession? {
            val metaJson = Json.encodeToString(meta)
            val configJson = Json.encodeToString(config)
            val nowMs = System.currentTimeMillis()
            val ptr = PlinthCoreJni.sessionNew(configJson, metaJson, nowMs)
            if (ptr == 0L) return null

            val handler = beaconHandler ?: defaultBeaconPoster(config.endpoint, config.projectKey)
            return PlinthSession(ptr, config, handler, scope).also { it.startHeartbeat() }
        }

        private fun defaultBeaconPoster(endpoint: String, projectKey: String): (BeaconBatch) -> Unit = { batch ->
            // Fire-and-forget HTTP POST on IO dispatcher
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val body = Json.encodeToString(batch).toRequestBody("application/json".toMediaType())
                    OkHttpClient().newCall(
                        Request.Builder().url(endpoint)
                            .header("X-Project-Key", projectKey)
                            .post(body).build()
                    ).execute().close()
                } catch (_: Exception) { /* swallow — PoC */ }
            }
        }
    }

    fun processEvent(eventJson: String) {
        if (isDestroyed) return
        val nowMs = System.currentTimeMillis()
        val result = PlinthCoreJni.sessionProcessEvent(ptr, eventJson, nowMs)
        emit(result)
    }

    fun setPlayhead(ms: Long) {
        if (isDestroyed) return
        PlinthCoreJni.sessionSetPlayhead(ptr, ms)
    }

    fun destroy() {
        if (isDestroyed) return
        isDestroyed = true
        heartbeatJob?.cancel()
        val nowMs = System.currentTimeMillis()
        val result = PlinthCoreJni.sessionDestroy(ptr, nowMs)
        emit(result)
    }

    private fun startHeartbeat() {
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(config.heartbeatIntervalMs)
                if (!isDestroyed) {
                    val nowMs = System.currentTimeMillis()
                    emit(PlinthCoreJni.sessionTick(ptr, nowMs))
                }
            }
        }
    }

    private fun emit(batchJson: String) {
        val batch = try { Json.decodeFromString<BeaconBatch>(batchJson) } catch (_: Exception) { return }
        if (batch.beacons.isNotEmpty()) beaconHandler(batch)
    }
}
```

**Dependency**: OkHttp 4.x for HTTP posting (same as standard Android apps). `kotlinx.serialization` for JSON.

### `build.gradle.kts` (plinth-android)

```kotlin
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    compileSdk = 34
    defaultConfig { minSdk = 24 }
    sourceSets["main"].jniLibs.srcDirs("src/main/jniLibs")
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
}
```

---

## Layer 3: `plinth-media3`

### Media3 Event → PlinthCore Event Mapping

| Media3 callback / condition | Plinth event | Notes |
|---|---|---|
| `onMediaItemTransition` | `load` | src = `mediaItem.localConfiguration?.uri?.toString()`; resets `hasFiredFirstFrame` |
| `onPlaybackStateChanged(STATE_BUFFERING)` + `!hasFiredFirstFrame` | `waiting` | Initial buffer stall before first frame (PlayAttempt → Buffering) |
| `onPlaybackStateChanged(STATE_BUFFERING)` + `hasFiredFirstFrame` | `stall` | Mid-playback stall (Playing → Rebuffering) |
| `onPlaybackStateChanged(STATE_READY)` + not yet first frame | `can_play` | Item loaded and ready |
| `onRenderedFirstFrame` | `first_frame` | Fires once per content item; sets `hasFiredFirstFrame` |
| `onIsPlayingChanged(true)` + `hasFiredFirstFrame` | `playing` | Rebuffer recovery / resume from pause |
| `onIsPlayingChanged(true)` + `!hasFiredFirstFrame` | `play` | Initial play attempt |
| `onIsPlayingChanged(false)` + not ended + not mid-play stall | `pause` | Suppressed during natural end (`isEndingNaturally`) and during buffer stall |
| `onPlaybackStateChanged(STATE_ENDED)` | `ended` | Natural end |
| `onPlayerError(PlaybackException)` | `error` | `fatal = true` for all Media3 errors |
| `seekTo()` wrapper | `seek_start` then `seek_end` | Programmatic seeks via `PlinthMedia3.seekTo()` |
| `onPositionDiscontinuity(DISCONTINUITY_REASON_SEEK)` | `seek_start` + `seek_end` | User-initiated scrubber seeks |
| `onVideoSizeChanged` | `quality_change` | width/height; bitrate from `onBandwidthSample` |

### Seek Handling

Two seek paths:
1. **Programmatic** — caller uses `plinthMedia3.seekTo(positionMs)`, which emits `seek_start`, calls `player.seekTo(positionMs)`, then emits `seek_end` in an `onPositionDiscontinuity` handler or via `addListener` after the seek completes.
2. **User scrubber** — `onPositionDiscontinuity(DISCONTINUITY_REASON_SEEK)` fires with `oldPosition` and `newPosition`. Emit `seek_start` then immediately `seek_end` (Media3 fires this callback after the seek is committed, so both can fire synchronously).

`isHandlingProgrammaticSeek: Boolean` flag prevents double-firing from `onPositionDiscontinuity` when a programmatic seek is in flight.

Buffer readiness for `seek_end`: `player.playbackState == Player.STATE_READY`.

### `Media3VideoMeta.kt`

```kotlin
data class Media3VideoMeta(val id: String, val title: String? = null)
```

### `Media3Options.kt`

```kotlin
data class Media3Options(
    val config: PlinthConfig = PlinthConfig(),
    val sessionFactory: ((SessionMeta, PlinthConfig) -> PlinthSession?)? = null
)
```

### `PlinthMedia3.kt` — Public API

```kotlin
class PlinthMedia3 private constructor(private val player: Player) : Player.Listener {

    internal var session: PlinthSession? = null
    private var isDestroyed = false
    private var hasFiredFirstFrame = false
    private var isHandlingProgrammaticSeek = false
    private var lastPlayheadMs: Long = 0L
    private var isEndingNaturally = false

    companion object {
        fun initialize(
            player: Player,
            videoMeta: Media3VideoMeta,
            options: Media3Options = Media3Options()
        ): PlinthMedia3 {
            val factory = options.sessionFactory ?: { meta, cfg -> PlinthSession.create(meta, cfg) }
            val userAgent = "${Build.MANUFACTURER} ${Build.MODEL}; Android ${Build.VERSION.RELEASE}"
            val meta = SessionMeta(
                video = VideoMetadata(id = videoMeta.id, title = videoMeta.title),
                client = ClientMetadata(userAgent = userAgent),
                sdk = SdkMetadata(
                    apiVersion = 1,
                    core = SdkComponent("plinth-core", "0.1.0"),
                    framework = SdkComponent("plinth-android", "0.1.0"),
                    player = SdkComponent("plinth-media3", "0.1.0")
                )
            )
            val instance = PlinthMedia3(player)
            instance.session = factory(meta, options.config)
            player.addListener(instance)

            // If player already has a media item loaded, emit load immediately.
            player.currentMediaItem?.let { item ->
                val src = item.localConfiguration?.uri?.toString() ?: "unknown"
                instance.handleLoad(src)
            }
            return instance
        }
    }

    // Public API

    fun seekTo(positionMs: Long) {
        if (isDestroyed) return
        val fromMs = lastPlayheadMs
        isHandlingProgrammaticSeek = true
        sendEvent("""{"type":"seek_start","from_ms":$fromMs}""")
        player.seekTo(positionMs)
        // seek_end emitted in onPositionDiscontinuity after seek commits
    }

    fun destroy() {
        if (isDestroyed) return
        isDestroyed = true
        player.removeListener(this)
        session?.destroy()
        session = null
    }

    // Internal handlers (also called directly in tests)

    internal fun handleLoad(src: String) {
        hasFiredFirstFrame = false
        isEndingNaturally = false
        sendEvent("""{"type":"load","src":"$src"}""")
    }

    internal fun handleCanPlay() = sendEvent("""{"type":"can_play"}""")
    internal fun handlePlay() = sendEvent("""{"type":"play"}""")
    internal fun handleWaiting() = sendEvent("""{"type":"waiting"}""")
    internal fun handleFirstFrame() { hasFiredFirstFrame = true; sendEvent("""{"type":"first_frame"}""") }
    internal fun handleRebufferRecovery() = sendEvent("""{"type":"first_frame"}""")
    internal fun handlePause() = sendEvent("""{"type":"pause"}""")
    internal fun handleEnded() { isEndingNaturally = true; sendEvent("""{"type":"ended"}""") }
    internal fun handleError(code: String, message: String?, fatal: Boolean) {
        val msg = if (message != null) ""","message":"$message"""" else ""
        sendEvent("""{"type":"error","code":"$code"$msg,"fatal":$fatal}""")
    }

    private fun sendEvent(json: String) = session?.processEvent(json)

    // Player.Listener overrides

    override fun onPlaybackStateChanged(playbackState: Int) {
        when (playbackState) {
            Player.STATE_BUFFERING -> if (hasFiredFirstFrame) { /* rebuffering — handled by isPlaying */ } else handleWaiting()
            Player.STATE_READY -> if (!hasFiredFirstFrame) handleCanPlay()
            Player.STATE_ENDED -> handleEnded()
            else -> {}
        }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) {
            if (!hasFiredFirstFrame) handlePlay()
            else handleCanPlayThrough()
        } else {
            if (!isEndingNaturally && player.playbackState != Player.STATE_ENDED) {
                if (player.playbackState == Player.STATE_BUFFERING && hasFiredFirstFrame) {
                    /* rebuffering — waiting event already fired */
                } else {
                    handlePause()
                }
            }
        }
    }

    override fun onRenderedFirstFrame() {
        if (!hasFiredFirstFrame) handleFirstFrame()
    }

    override fun onPlayerError(error: PlaybackException) {
        handleError(
            code = error.errorCodeName ?: "UNKNOWN",
            message = error.message,
            fatal = true
        )
    }

    override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        val src = mediaItem?.localConfiguration?.uri?.toString() ?: return
        handleLoad(src)
    }

    override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int
    ) {
        if (reason != Player.DISCONTINUITY_REASON_SEEK) return
        val toMs = newPosition.positionMs
        val bufferReady = player.playbackState == Player.STATE_READY
        if (isHandlingProgrammaticSeek) {
            isHandlingProgrammaticSeek = false
            sendEvent("""{"type":"seek_end","to_ms":$toMs,"buffer_ready":$bufferReady}""")
        } else {
            val fromMs = oldPosition.positionMs
            sendEvent("""{"type":"seek_start","from_ms":$fromMs}""")
            sendEvent("""{"type":"seek_end","to_ms":$toMs,"buffer_ready":$bufferReady}""")
        }
        lastPlayheadMs = toMs
    }

    override fun onVideoSizeChanged(videoSize: VideoSize) {
        val w = if (videoSize.width > 0) videoSize.width else null
        val h = if (videoSize.height > 0) videoSize.height else null
        if (w == null && h == null) return
        val quality = buildString {
            append("""{"type":"quality_change","quality":{""")
            if (w != null) append(""""width":$w""")
            if (w != null && h != null) append(",")
            if (h != null) append(""""height":$h""")
            append("}}")
        }
        sendEvent(quality)
    }
}
```

**Note on event JSON construction:** The raw string approach above is shown for clarity; the actual implementation should use `kotlinx.serialization` with a sealed `PlayerEventDto` class to avoid manual escaping errors, especially for the `src` URL field.

### `build.gradle.kts` (plinth-media3)

```kotlin
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    compileSdk = 34
    defaultConfig { minSdk = 24 }
}

dependencies {
    api(project(":plinth-android"))
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    implementation("androidx.media3:media3-common:1.3.1")
}
```

---

## Playhead Tracking

`PlinthMedia3` updates `lastPlayheadMs` and calls `session?.setPlayhead(ms)` via a periodic coroutine (every 500 ms) instead of AVPlayer's `addPeriodicTimeObserver`. This coroutine runs while `isPlaying`:

```kotlin
private var playheadJob: Job? = null

// Start in onIsPlayingChanged(true), cancel in onIsPlayingChanged(false)
private fun startPlayheadTracking() {
    playheadJob = scope.launch {
        while (isActive) {
            delay(500)
            val ms = player.currentPosition
            lastPlayheadMs = ms
            session?.setPlayhead(ms)
        }
    }
}
```

---

## `plinth-core` JNI Module Detail

```rust
// crates/plinth-core/src/jni.rs
#![cfg(target_os = "android")]

use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;

use crate::beacon::BeaconBatch;
use crate::config::Config;
use crate::event::PlayerEvent;
use crate::session::{Session, SessionMeta};

fn beacons_to_json(beacons: Vec<crate::beacon::Beacon>) -> String {
    miniserde::json::to_string(&BeaconBatch::new(beacons))
}

fn jstring_to_string(env: &mut JNIEnv, s: JString) -> Option<String> {
    env.get_string(&s).ok().map(|js| js.into())
}

fn to_jstring(env: &mut JNIEnv, s: String) -> jstring {
    env.new_string(s).unwrap().into_raw()
}

fn empty_batch_jstring(env: &mut JNIEnv) -> jstring {
    to_jstring(env, r#"{"beacons":[]}"#.to_string())
}

#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionNew(
    mut env: JNIEnv,
    _class: JClass,
    config_json: JString,
    meta_json: JString,
    now_ms: jlong,
) -> jlong {
    let config: Config = if config_json.is_null() {
        Config::default()
    } else {
        match jstring_to_string(&mut env, config_json)
            .and_then(|s| miniserde::json::from_str(&s).ok())
        {
            Some(c) => c,
            None => return 0,
        }
    };

    let meta: SessionMeta = match jstring_to_string(&mut env, meta_json)
        .and_then(|s| miniserde::json::from_str(&s).ok())
    {
        Some(m) => m,
        None => return 0,
    };

    let session = Session::new(config, meta, now_ms as u64);
    Box::into_raw(Box::new(session)) as jlong
}

#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionProcessEvent(
    mut env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    event_json: JString,
    now_ms: jlong,
) -> jstring {
    if ptr == 0 { return empty_batch_jstring(&mut env); }
    let event: PlayerEvent = match jstring_to_string(&mut env, event_json)
        .and_then(|s| miniserde::json::from_str(&s).ok())
    {
        Some(e) => e,
        None => return empty_batch_jstring(&mut env),
    };
    let session = unsafe { &mut *(ptr as *mut Session) };
    let beacons = session.process_event(event, now_ms as u64);
    to_jstring(&mut env, beacons_to_json(beacons))
}

#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionTick(
    mut env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    now_ms: jlong,
) -> jstring {
    if ptr == 0 { return empty_batch_jstring(&mut env); }
    let session = unsafe { &mut *(ptr as *mut Session) };
    let beacons = session.tick(now_ms as u64);
    to_jstring(&mut env, beacons_to_json(beacons))
}

#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionSetPlayhead(
    _env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    playhead_ms: jlong,
) {
    if ptr == 0 { return; }
    let session = unsafe { &mut *(ptr as *mut Session) };
    session.set_playhead(playhead_ms as u64);
}

#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionDestroy(
    mut env: JNIEnv,
    _class: JClass,
    ptr: jlong,
    now_ms: jlong,
) -> jstring {
    if ptr == 0 { return empty_batch_jstring(&mut env); }
    let mut session = unsafe { Box::from_raw(ptr as *mut Session) };
    let beacons = session.destroy(now_ms as u64);
    to_jstring(&mut env, beacons_to_json(beacons))
}
```

---

## Build System

### Toolchain

| Component | Language | Toolchain |
|---|---|---|
| `plinth-core` (Android) | Rust | `cargo-ndk`, NDK r26+ |
| `plinth-android` | Kotlin | Gradle 8.x, AGP 8.x |
| `plinth-media3` | Kotlin | Gradle 8.x, AGP 8.x |
| `android-sample` | Kotlin | Gradle 8.x, AGP 8.x |

### Build Commands

```bash
# Install tools (once)
cargo install cargo-ndk
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android

# Build .so files for all ABIs (run from repo root)
ANDROID_NDK_HOME=/path/to/ndk cargo ndk \
  -t arm64-v8a -t armeabi-v7a -t x86_64 \
  -o packages/plinth-android/src/main/jniLibs \
  build -p plinth-core --release

# Build Android library and sample
./gradlew :plinth-android:assembleRelease
./gradlew :plinth-media3:assembleRelease
./gradlew :android-sample:app:installDebug

# Run unit tests (JVM, no device needed)
./gradlew :plinth-android:test
./gradlew :plinth-media3:test
```

### Gradle root `settings.gradle.kts`

```kotlin
include(":plinth-android")
project(":plinth-android").projectDir = file("packages/plinth-android")

include(":plinth-media3")
project(":plinth-media3").projectDir = file("packages/plinth-media3")

include(":android-sample:app")
project(":android-sample:app").projectDir = file("apps/android-sample/app")
```

---

## Testing Strategy

### `PlinthSessionTest.kt` (plinth-android, JVM unit tests)

- Inject a fake `PlinthCoreJni` via dependency injection or test subclass — or compile a native test build.
- Alternatively: test the JNI layer against the real `.so` on an emulator via instrumented tests.
- Test `beaconHandler` invocation, heartbeat interval, `destroy()` idempotency.

### `PlinthMedia3Test.kt` (plinth-media3, JVM unit tests)

Follow the same pattern as `PlinthAVPlayerTests.swift` — call `internal handleXxx()` methods directly without a real `Player`. A `FakePlayer` stub implements the `Player` interface.

```kotlin
class PlinthMedia3Test {
    private val capturedBatches = mutableListOf<BeaconBatch>()
    private val fakePlayer = FakePlayer()
    private lateinit var plinth: PlinthMedia3

    @BeforeEach fun setup() {
        val session = PlinthSession.create(
            meta = testMeta(),
            beaconHandler = { capturedBatches += it }
        )!!
        plinth = PlinthMedia3.initialize(fakePlayer, Media3VideoMeta("v1"),
            options = Media3Options(sessionFactory = { _, _ -> session }))
    }

    @Test fun `play sequence emits session_open then first_frame`() {
        plinth.handleLoad("https://example.com/v.m3u8")
        plinth.handlePlay()
        plinth.handleCanPlay()
        plinth.handleFirstFrame()
        val events = capturedBatches.flatMap { it.beacons }.map { it.event }
        assertThat(events).contains("session_open", "first_frame")
    }
}
```

`FakePlayer` is a minimal stub that implements `Player` (or just the listener-registration surface), so no robolectric or real Media3 dependency is needed in unit tests.

---

## Sample App (`android-sample`)

`MainActivity.kt` mirrors the AVPlayer macOS sample:
- Creates a `PlayerView` (Media3 `StyledPlayerView`)
- Calls `PlinthMedia3.initialize(player, Media3VideoMeta("big-buck-bunny"))`
- Loads a test HLS stream
- Displays a scrolling beacon log overlay in the UI

---

## Dependencies Summary

| Package | Dependencies |
|---|---|
| `plinth-core` (Android build) | `jni = "0.21"` (Rust) |
| `plinth-android` | `kotlinx-serialization-json`, `kotlinx-coroutines-android`, `okhttp3` |
| `plinth-media3` | `plinth-android`, `media3-exoplayer`, `media3-common` |
| `android-sample` | `plinth-media3`, `media3-ui` |

---

## Open Questions / Risks

1. **JNI thread safety** — the Rust `Session` is not `Sync`. All JNI calls must originate from the same thread or be serialized. `PlinthSession` should enforce this via a single-threaded coroutine dispatcher (`Dispatchers.IO.limitedParallelism(1)`) rather than relying on caller discipline.

2. **`onRenderedFirstFrame` availability** — this callback requires Media3 `1.1+` and an `ExoPlayer`-backed `Player`. Verify it fires for both HLS and DASH.

3. **Rebuffering detection** — Media3 does not expose a distinct `rebuffering` state; it reuses `STATE_BUFFERING`. The distinction (initial buffering vs. mid-playback stall) must be inferred from `hasFiredFirstFrame`. Validate against edge cases (pause → STATE_BUFFERING on some devices).

4. **`cargo-ndk` NDK version** — NDK r26b is the recommended version for Rust cross-compilation as of early 2026. Pin the NDK version in CI.
