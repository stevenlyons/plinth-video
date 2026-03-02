# TDD: Playback Position Tracking

## Overview

Technical design for adding `playhead_ms` to `pause` and `session_end` beacons so the server always knows the viewer's last known position at every natural session boundary — even if the final heartbeat was never received. No changes are required at Layer 2 (platform) or Layer 3 (player integration); all changes are in `plinth-core`.

---

## Goals

- Server can restore a viewer's playback position after they exit by reading the most recent `pause` or `session_end` beacon.
- Server can determine whether a video was "completed" by comparing `playhead_ms` in `session_end` against video duration.
- Clients do not need to run a separate position-tracking beacon alongside the QoE beacon.

---

## Architecture

Only Layer 1 (`plinth-core`) and the JSON schema are modified. Layers 2 and 3 already call `session.set_playhead(ms)` continuously, so the position data is already present in the session state. No API changes are needed.

```
plinth-core  ← changes here (session.rs + beacon-payload.schema.json)
  └── plinth-js / plinth-apple / plinth-android  ← no changes
        └── plinth-hlsjs / plinth-avplayer / plinth-media3  ← no changes
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
