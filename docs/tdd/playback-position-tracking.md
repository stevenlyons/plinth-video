# TDD: Playback Position Tracking

## Overview

Technical design for two related capabilities:

1. **Beacon enrichment** — Add `playhead_ms` to `pause` and `session_end` beacons so the server always knows the viewer's last known position at every natural session boundary, even if the final heartbeat was never received.
2. **Client-side position query API** — Expose a `getPlayhead()` method on every platform's public integration object so developers can read the current playhead position at any time without parsing beacons.

---

## Goals

- Server can restore a viewer's playback position after they exit by reading the most recent `pause` or `session_end` beacon.
- Server can determine whether a video was "completed" by comparing `playhead_ms` in `session_end` against video duration.
- Developers can call `getPlayhead()` locally to implement resume-from-position without running a separate beacon stack.
- Clients do not need to run a separate position-tracking beacon alongside the QoE beacon.

---

## Architecture

The beacon enrichment touches only Layer 1. The client-side query API propagates through all three layers.

```
plinth-core  ← beacon changes + get_playhead() + FFI/Wasm/JNI getter
  └── plinth-js / plinth-apple / plinth-android  ← getPlayhead() on session
        └── plinth-hlsjs / plinth-avplayer / plinth-media3  ← getPlayhead() on integration
```

---

## Beacon Changes

### `pause` beacon

Add `playhead_ms` to all `pause` beacons. This captures the position at which the viewer stopped watching, which is the value to use when resuming a later session.

`pause` beacons are emitted from two transitions:
- `Playing → Paused` (user explicitly pauses)
- `Rebuffering → Paused` (user pauses during a rebuffer stall)

Both transitions must set `b.playhead_ms`.

### `session_end` beacon

Add `playhead_ms` to all `session_end` beacons. This captures the final position of the session regardless of how it ended.

`session_end` beacons are emitted from three paths:
- `Playing → Ended` (`PlayerEvent::Ended` — video played to natural end)
- `Paused → Idle` (`PlayerEvent::Destroy` — session torn down while paused)
- `destroy()` from any active state (platform teardown, e.g. app backgrounded)

All three paths must set `b.playhead_ms`.

---

## Implementation: `crates/plinth-core/src/session.rs`

All changes follow the same pattern: change `let b =` to `let mut b =` and add `b.playhead_ms = Some(self.playhead_ms);` before `out.push(b)`.

### 1. Playing → Paused

```rust
(PlayerState::Playing, PlayerEvent::Pause) => {
    self.played_tracker.stop(now_ms);
    self.state = PlayerState::Paused;
    let m = self.snapshot_metrics(now_ms);
    let mut b =
        self.make_beacon(BeaconEvent::Pause, Some(PlayerState::Paused), Some(m), now_ms);
    b.playhead_ms = Some(self.playhead_ms);
    out.push(b);
}
```

### 2. Rebuffering → Paused

The `pause` beacon (`b2`) in this transition must also carry `playhead_ms`:

```rust
let mut b2 = self.make_beacon(
    BeaconEvent::Pause,
    Some(PlayerState::Paused),
    Some(m),
    now_ms,
);
b2.playhead_ms = Some(self.playhead_ms);
out.push(b2);
```

### 3. Playing → Ended

```rust
(PlayerState::Playing, PlayerEvent::Ended) => {
    self.played_tracker.stop(now_ms);
    self.watch_tracker.stop(now_ms);
    self.state = PlayerState::Ended;
    let m = self.snapshot_metrics(now_ms);
    let mut b = self.make_beacon(
        BeaconEvent::SessionEnd,
        Some(PlayerState::Ended),
        Some(m),
        now_ms,
    );
    b.playhead_ms = Some(self.playhead_ms);
    out.push(b);
}
```

### 4. Paused → Destroy

```rust
(PlayerState::Paused, PlayerEvent::Destroy) => {
    self.watch_tracker.stop(now_ms);
    self.state = PlayerState::Idle;
    let m = self.snapshot_metrics(now_ms);
    let mut b = self.make_beacon(
        BeaconEvent::SessionEnd,
        Some(PlayerState::Ended),
        Some(m),
        now_ms,
    );
    b.playhead_ms = Some(self.playhead_ms);
    out.push(b);
    self.last_heartbeat_ms = None;
}
```

### 5. `destroy()` method

```rust
if was_active {
    self.played_tracker.stop(now_ms);
    self.rebuffer_tracker.stop(now_ms);
    self.watch_tracker.stop(now_ms);
    let m = self.snapshot_metrics(now_ms);
    let mut b = self.make_beacon(
        BeaconEvent::SessionEnd,
        Some(PlayerState::Ended),
        Some(m),
        now_ms,
    );
    b.playhead_ms = Some(self.playhead_ms);
    out.push(b);
}
```

---

## Implementation: `docs/reference/beacon-payload.schema.json`

Add `playhead_ms` to the shared `Beacon.properties` section so it is documented at the top level, and add a new `allOf` condition that flags it as present (but not required) on `pause` and `session_end`:

### Add to `Beacon.properties`

```json
"playhead_ms": {
  "type": "integer",
  "minimum": 0,
  "description": "Current playhead position in the content timeline in milliseconds. Required on heartbeat. Also present on pause and session_end beacons, capturing the last known position at each session boundary."
}
```

### Add new `allOf` entry (after the heartbeat condition)

```json
{
  "if": {
    "properties": { "event": { "enum": ["pause", "session_end"] } },
    "required": ["event"]
  },
  "then": {
    "properties": {
      "playhead_ms": {
        "type": "integer",
        "minimum": 0,
        "description": "Last known playhead position in milliseconds at the time the beacon was emitted."
      }
    }
  }
}
```

The existing `heartbeat` condition retains `"required": ["playhead_ms"]`. The `pause` and `session_end` condition omits `required` because `playhead_ms` defaults to `0` if `set_playhead` was never called, but is always present.

---

## Test Coverage

New tests belong in `crates/plinth-core/src/session.rs` (inline `#[cfg(test)]` module), following the existing `make_session()` helper pattern.

| # | Test | Assertion |
|---|---|---|
| 1 | Playing → Pause carries `playhead_ms` | `set_playhead(5000)`, emit `Pause`, assert beacon `playhead_ms == Some(5000)` |
| 2 | Rebuffering → Pause carries `playhead_ms` on the pause beacon | Reach Rebuffering, `set_playhead(8000)`, emit `Pause`, assert the second beacon (pause) has `playhead_ms == Some(8000)` |
| 3 | Natural end carries `playhead_ms` | `set_playhead(120000)`, emit `Ended`, assert `session_end` beacon `playhead_ms == Some(120000)` |
| 4 | Paused → Destroy carries `playhead_ms` | Reach Paused, `set_playhead(30000)`, emit `Destroy`, assert `session_end` beacon `playhead_ms == Some(30000)` |
| 5 | `destroy()` from Playing carries `playhead_ms` | Reach Playing, `set_playhead(15000)`, call `destroy()`, assert `session_end` beacon `playhead_ms == Some(15000)` |
| 6 | `playhead_ms` defaults to `0` when `set_playhead` never called | Reach Playing, emit `Pause` without calling `set_playhead`, assert `playhead_ms == Some(0)` |
| 7 | Heartbeat still carries `playhead_ms` (regression) | `set_playhead(7000)`, call `tick(...)`, assert heartbeat `playhead_ms == Some(7000)` |

---

## Platform Layer: No Changes Required

All three platforms already call `set_playhead` continuously:

| Layer 3 | Mechanism |
|---|---|
| `plinth-hlsjs` | `video.timeupdate` → `session.setPlayhead(video.currentTime * 1000)` |
| `plinth-shaka` | `video.timeupdate` → `session.setPlayhead(video.currentTime * 1000)` |
| `plinth-avplayer` | `addPeriodicTimeObserver` → `session.setPlayhead(ms)` |
| `plinth-media3` | `Player.Listener.onEvents` + `Events.ON_POSITION_DISCONTINUITY` → `session.setPlayhead(ms)` |

The `playhead_ms` field on the `Session` struct already holds the latest value reported by the platform. The only change is that `session.rs` now copies it into more beacon types.

---

## Relevant Files

| File | Change |
|---|---|
| `crates/plinth-core/src/session.rs` | Set `b.playhead_ms` on `pause` and `session_end` beacons (5 sites) |
| `docs/reference/beacon-payload.schema.json` | Add `playhead_ms` to `Beacon.properties`; add `allOf` condition for `pause`/`session_end` |

---

## Client-Side Position Query API

The PRD requires a local, callable API that developers can use to retrieve the current playhead position at any time — not just from beacons. This is a read-only getter that exposes the `playhead_ms` value already maintained by the core.

### Architecture

The getter propagates through all three layers on every platform. Unlike the beacon changes above, this touches Layers 1, 2, and 3.

```
plinth-core  ← Session::get_playhead() + FFI/Wasm getter
  └── plinth-js / plinth-apple / plinth-android  ← getPlayhead() on session
        └── plinth-hlsjs / plinth-avplayer / plinth-media3  ← getPlayhead() on integration
```

The value returned is the same `playhead_ms` that Layer 3 writes via `setPlayhead()` on every `timeupdate` / periodic observer. It is always the last value reported by the player, in milliseconds. It defaults to `0` if `setPlayhead` has never been called.

---

### Layer 1: `crates/plinth-core/src/session.rs`

Add a public getter alongside the existing `set_playhead`:

```rust
/// Return the last playhead position reported by the platform, in milliseconds.
pub fn get_playhead(&self) -> u64 {
    self.playhead_ms
}
```

### Layer 1: `crates/plinth-core/src/wasm.rs`

Add to the `#[wasm_bindgen] impl WasmSession` block:

```rust
pub fn get_playhead(&self) -> f64 {
    self.inner.get_playhead() as f64
}
```

Returns `f64` consistent with the existing `set_playhead` signature (JS numbers are f64).

### Layer 1: `crates/plinth-core/src/ffi.rs`

Add a new C FFI function:

```rust
/// Return the last playhead position reported by the platform, in milliseconds.
/// Returns 0 if ptr is NULL.
#[no_mangle]
pub unsafe extern "C" fn plinth_session_get_playhead(ptr: *mut Session) -> u64 {
    if ptr.is_null() {
        return 0;
    }
    (*ptr).get_playhead()
}
```

### Layer 1: `packages/apple/plinth-apple/Sources/PlinthCoreFFI/plinth_core.h`

Add declaration alongside `plinth_session_set_playhead`:

```c
/**
 * Return the last playhead position reported by the platform, in milliseconds.
 * Returns 0 if session is NULL.
 */
uint64_t plinth_session_get_playhead(PlinthSession* session);
```

### Layer 1: `crates/plinth-core/src/jni.rs`

Add JNI export alongside `sessionSetPlayhead`:

```rust
/// Return the last playhead position reported by the platform, in milliseconds.
/// Returns 0 if ptr is 0.
#[no_mangle]
pub extern "system" fn Java_io_plinth_android_PlinthCoreJni_sessionGetPlayhead(
    _env: JNIEnv,
    _class: JClass,
    ptr: jlong,
) -> jlong {
    if ptr == 0 {
        return 0;
    }
    let session = unsafe { &*(ptr as *mut Session) };
    session.get_playhead() as jlong
}
```

---

### Layer 2: `packages/web/plinth-js/src/types.ts`

Add `get_playhead` to `WasmSessionLike`:

```ts
export interface WasmSessionLike {
  process_event(event_json: string, now_ms: number): string;
  tick(now_ms: number): string;
  destroy(now_ms: number): string;
  set_playhead(playhead_ms: number): void;
  get_playhead(): number;  // ← new
  free(): void;
}
```

### Layer 2: `packages/web/plinth-js/src/index.ts`

Add `getPlayhead()` to `PlinthSession`:

```ts
/** Return the last playhead position reported by the player, in milliseconds. */
getPlayhead(): number {
  if (this.destroyed) return 0;
  return this.wasmSession.get_playhead();
}
```

### Layer 2: `packages/apple/plinth-apple/Sources/PlinthApple/PlinthSession.swift`

Add alongside `setPlayhead`:

```swift
/// Return the last playhead position reported by the player, in milliseconds.
public func getPlayhead() -> UInt64 {
    guard !isDestroyed else { return 0 }
    return plinth_session_get_playhead(ptr)
}
```

### Layer 2: `packages/android/plinth-android/src/main/java/io/plinth/android/CoreJni.kt`

Add to the `CoreJni` interface:

```kotlin
fun sessionGetPlayhead(ptr: Long): Long
```

### Layer 2: `packages/android/plinth-android/src/main/java/io/plinth/android/PlinthCoreJni.kt`

The JNI binding is generated automatically from the `jni.rs` export — no manual implementation is needed beyond declaring the method in the interface.

### Layer 2: `packages/android/plinth-android/src/main/java/io/plinth/android/PlinthSession.kt`

Add alongside `setPlayhead`:

```kotlin
/**
 * Return the last playhead position reported by the player, in milliseconds.
 * Returns 0 if the session has been destroyed or setPlayhead was never called.
 */
fun getPlayhead(): Long {
    if (isDestroyed) return 0L
    // Synchronous read — dispatched to the session thread for consistency.
    return runBlocking(sessionDispatcher) {
        if (isDestroyed) 0L else jni.sessionGetPlayhead(ptr)
    }
}
```

> **Note:** `getPlayhead()` is synchronous from the caller's perspective. It marshals to the session dispatcher to read the value on the same thread as `setPlayhead` writes. `runBlocking` is acceptable here because `sessionGetPlayhead` is a simple memory read with no blocking I/O.

---

### Layer 3: `packages/web/plinth-hlsjs/src/index.ts`

Add to `PlinthHlsJs`:

```ts
/** Return the last known playhead position in milliseconds. */
getPlayhead(): number {
  if (this.destroyed) return 0;
  return this.session.getPlayhead();
}
```

### Layer 3: `packages/web/plinth-shaka/src/index.ts`

Same pattern as `plinth-hlsjs`.

### Layer 3: `packages/apple/plinth-avplayer/Sources/PlinthAVPlayer/PlinthAVPlayer.swift`

Add to `PlinthAVPlayer`:

```swift
/// Return the last known playhead position in milliseconds.
public func getPlayhead() -> UInt64 {
    return session?.getPlayhead() ?? 0
}
```

### Layer 3: `packages/android/plinth-media3/src/main/java/io/plinth/media3/PlinthMedia3.kt`

Add to `PlinthMedia3`:

```kotlin
/** Return the last known playhead position in milliseconds. */
fun getPlayhead(): Long = session?.getPlayhead() ?: 0L
```

---

## Test Coverage (Client-Side API)

### `crates/plinth-core/src/session.rs`

| # | Test | Assertion |
|---|---|---|
| 1 | `get_playhead_returns_zero_before_set` | Fresh session → `get_playhead() == 0` |
| 2 | `get_playhead_returns_last_set_value` | `set_playhead(42_000)` → `get_playhead() == 42_000` |
| 3 | `get_playhead_updates_on_repeated_sets` | Set 1000, then 5000 → `get_playhead() == 5000` |

### `crates/plinth-core/src/ffi.rs`

| # | Test | Assertion |
|---|---|---|
| 4 | `get_playhead_null_ptr_returns_zero` | `plinth_session_get_playhead(null) == 0` |
| 5 | `get_playhead_returns_value_set_via_ffi` | Call `plinth_session_set_playhead(ptr, 7000)` then `plinth_session_get_playhead(ptr) == 7000` |

### `crates/plinth-core/src/wasm.rs` (tested via `packages/web/plinth-js`)

Covered by the plinth-js Layer 2 tests below via `wasmModuleOverride`.

### `packages/web/plinth-js/tests/session.test.ts`

| # | Test | Assertion |
|---|---|---|
| 6 | `getPlayhead() returns 0 before setPlayhead` | Mock `get_playhead` returns 0; assert `session.getPlayhead() === 0` |
| 7 | `getPlayhead() delegates to WasmSession.get_playhead` | Mock `get_playhead` returns 12000; assert `session.getPlayhead() === 12000` |
| 8 | `getPlayhead() returns 0 after destroy` | Call `destroy()` first; assert `session.getPlayhead() === 0` without calling Wasm |

### `packages/web/plinth-hlsjs/tests/hlsjs.test.ts`

| # | Test | Assertion |
|---|---|---|
| 9 | `getPlayhead() delegates to session.getPlayhead` | Set `mockSession.getPlayhead = mock(() => 8000)`; assert `instance.getPlayhead() === 8000` |
| 10 | `getPlayhead() returns 0 after destroy` | `instance.destroy()` then `instance.getPlayhead() === 0` |

### `packages/apple/plinth-apple` (Swift)

| # | Test | Assertion |
|---|---|---|
| 11 | `getPlayhead returns 0 before setPlayhead` | Create session; `session.getPlayhead() == 0` |
| 12 | `getPlayhead returns last set value` | `session.setPlayhead(55_000)` then `session.getPlayhead() == 55_000` |
| 13 | `getPlayhead returns 0 after destroy` | `session.destroy()` then `session.getPlayhead() == 0` |

### `packages/android/plinth-android` (Kotlin)

| # | Test | Assertion |
|---|---|---|
| 14 | `getPlayhead returns 0 before setPlayhead` | Fake returns 0; assert `session.getPlayhead() == 0L` |
| 15 | `getPlayhead returns value from jni` | Fake `sessionGetPlayhead` returns 9000; assert `session.getPlayhead() == 9000L` |
| 16 | `getPlayhead returns 0 after destroy` | `destroy()`; assert `session.getPlayhead() == 0L` without calling JNI |

---

## Updated Relevant Files

| File | Change |
|---|---|
| `crates/plinth-core/src/session.rs` | Add `get_playhead() -> u64`; set `b.playhead_ms` on `pause` and `session_end` beacons |
| `crates/plinth-core/src/wasm.rs` | Add `get_playhead() -> f64` to `WasmSession` |
| `crates/plinth-core/src/ffi.rs` | Add `plinth_session_get_playhead` C export |
| `crates/plinth-core/src/jni.rs` | Add `Java_io_plinth_android_PlinthCoreJni_sessionGetPlayhead` JNI export |
| `packages/apple/plinth-apple/Sources/PlinthCoreFFI/plinth_core.h` | Declare `plinth_session_get_playhead` |
| `packages/web/plinth-js/src/types.ts` | Add `get_playhead()` to `WasmSessionLike` |
| `packages/web/plinth-js/src/index.ts` | Add `getPlayhead()` to `PlinthSession` |
| `packages/apple/plinth-apple/Sources/PlinthApple/PlinthSession.swift` | Add `getPlayhead() -> UInt64` |
| `packages/android/plinth-android/src/main/java/io/plinth/android/CoreJni.kt` | Add `sessionGetPlayhead` to interface |
| `packages/android/plinth-android/src/main/java/io/plinth/android/PlinthSession.kt` | Add `getPlayhead(): Long` |
| `packages/web/plinth-hlsjs/src/index.ts` | Add `getPlayhead(): number` |
| `packages/web/plinth-shaka/src/index.ts` | Add `getPlayhead(): number` |
| `packages/apple/plinth-avplayer/Sources/PlinthAVPlayer/PlinthAVPlayer.swift` | Add `getPlayhead() -> UInt64` |
| `packages/android/plinth-media3/src/main/java/io/plinth/media3/PlinthMedia3.kt` | Add `getPlayhead(): Long` |
| `docs/reference/beacon-payload.schema.json` | Add `playhead_ms` to `Beacon.properties`; add `allOf` condition for `pause`/`session_end` |
