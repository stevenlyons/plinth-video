# TDD: Heartbeat Inactivity Timeout

## Overview

This change adds an inactivity timer inside `plinth-core`: when the session has been in an inactive state (`Paused`, `Ended`, or `Error`) continuously for more than 60 seconds, heartbeat emission is suppressed. A final heartbeat fires at exactly the 60-second mark; ticks beyond that threshold are no-ops until the session returns to an active state. No platform-layer changes are required — the platforms keep calling `tick()` on their existing schedules and receive empty responses when suppressed.

---

## Architecture

All changes are confined to **Layer 1** (`plinth-core`). Platform wrappers (`plinth-js`, `plinth-apple`, `plinth-android`) and player integrations (Layer 3) are unchanged.

| Component | Change |
|---|---|
| `crates/plinth-core/src/session.rs` | Add `inactive_since_ms` field; update `process_event` and `tick` |

No changes to config, FFI, Wasm bindings, beacon schema, or any platform package.

---

## Data Models

### `Session` struct — new field

```rust
pub struct Session {
    // ... existing fields ...

    /// Timestamp (ms) when the session entered an inactive state (Paused, Ended, Error).
    /// None when the session is active or not yet started.
    inactive_since_ms: Option<u64>,
}
```

**Inactive states** (heartbeat suppressed after timeout): `Paused`, `Ended`, `Error`

**Active states** (heartbeat never suppressed): `Playing`, `Buffering`, `Seeking`, `Rebuffering`

Pre-playback states (`Idle`, `Loading`, `Ready`, `PlayAttempt`) do not participate because they never produce heartbeats.

### Inactivity timeout constant

```rust
const INACTIVITY_TIMEOUT_MS: u64 = 60_000;
```

Defined as a local constant inside `tick()`. Not configurable in this release.

---

## Key Flows

### Entering an inactive state (Paused)

1. `process_event` drives a state transition to `Paused`.
2. Before returning, `update_inactivity(now_ms)` sets `inactive_since_ms = Some(now_ms)`.
3. Heartbeat interval continues normally. Each `tick(now_ms)` call computes elapsed = `now_ms − inactive_since_ms`. While elapsed ≤ 60 000ms, heartbeats fire as usual (one final heartbeat fires at exactly the 60s mark).
4. Once elapsed > 60 000ms, `tick` returns `vec![]` — no beacon, no update to `last_heartbeat_ms`.

### Resuming from Paused (e.g., play pressed)

1. `process_event` drives a state transition to `Playing` (or `Buffering`).
2. `inactive_since_ms` is cleared (`= None`).
3. `last_heartbeat_ms` is updated to `now_ms` by the beacon emitted for the transition (existing behavior: any beacon resets the heartbeat countdown).
4. Next `tick` after `heartbeat_interval_ms` fires normally.

### Transitioning between inactive states (Paused → Ended)

1. `process_event` transitions from `Paused` to `Ended`.
2. `inactive_since_ms` is **reset** to the new `now_ms` (the timer restarts from the moment of the new transition).
3. `Ended` never fires heartbeats under the existing active-state guard, so suppression from the new timer is moot — but the reset ensures correctness if state definitions change.

### Transition into Error

Same as Ended: `inactive_since_ms` set/reset to `now_ms`. Already suppressed by existing guard, but tracked for consistency.

### destroy()

`destroy()` is unaffected. It emits a final beacon unconditionally regardless of `inactive_since_ms`.

---

## Implementation — `session.rs`

### `Session::new`

Initialize `inactive_since_ms: None`.

### `process_event` — update `inactive_since_ms` after state transition

After each state transition, add:

```rust
fn update_inactivity(&mut self, now_ms: u64) {
    match self.state {
        PlayerState::Paused | PlayerState::Ended | PlayerState::Error => {
            // Reset on every entry into an inactive state so that transitions
            // between inactive states (e.g. Paused → Ended) restart the clock.
            self.inactive_since_ms = Some(now_ms);
        }
        _ => {
            self.inactive_since_ms = None;
        }
    }
}
```

Call `self.update_inactivity(now_ms)` at the end of `process_event`, after the state field is updated and beacons are collected.

### `Session::tick` — add inactivity suppression

After the existing active-state guard, add:

```rust
const INACTIVITY_TIMEOUT_MS: u64 = 60_000;
if let Some(inactive_since) = self.inactive_since_ms {
    if now_ms.saturating_sub(inactive_since) > INACTIVITY_TIMEOUT_MS {
        return vec![];
    }
}
```

Full updated `tick` (showing insertion point):

```rust
pub fn tick(&mut self, now_ms: u64) -> Vec<Beacon> {
    let last = match self.last_heartbeat_ms {
        Some(t) => t,
        None => return vec![],
    };

    if now_ms.saturating_sub(last) < self.config.heartbeat_interval_ms {
        return vec![];
    }

    let active = matches!(
        self.state,
        PlayerState::PlayAttempt
            | PlayerState::Buffering
            | PlayerState::Playing
            | PlayerState::Paused
            | PlayerState::Seeking
            | PlayerState::Rebuffering
    );

    if !active {
        return vec![];
    }

    // Suppress heartbeat after more than 60s of continuous inactivity.
    // One final heartbeat fires at exactly the 60s mark.
    const INACTIVITY_TIMEOUT_MS: u64 = 60_000;
    if let Some(inactive_since) = self.inactive_since_ms {
        if now_ms.saturating_sub(inactive_since) > INACTIVITY_TIMEOUT_MS {
            return vec![];
        }
    }

    self.last_heartbeat_ms = Some(now_ms);
    let m = self.snapshot_metrics(now_ms);
    let playhead = self.playhead_ms;
    let mut b = self.make_beacon(BeaconEvent::Heartbeat, Some(self.state), Some(m), now_ms);
    b.playhead_ms = Some(playhead);
    vec![b]
}
```

---

## API Design

No public API changes. `tick()` signature is unchanged at all layers. The suppression is transparent — callers receive an empty beacon list, exactly as they do today when the interval hasn't elapsed.

---

## Testing Approach

All new tests go in `crates/plinth-core/tests/` (or alongside existing session tests).

### Unit tests — inactivity suppression

| Test | Scenario | Assertion |
|---|---|---|
| `heartbeat_fires_before_inactivity_timeout` | Pause at t=1000; tick at t=60 999 (59 999ms elapsed, within interval) → heartbeat emitted | Beacon present |
| `heartbeat_suppressed_after_60s_paused` | Pause at t=1000; tick at t=61 000 (exactly 60 000ms elapsed) → one final heartbeat. Tick at t=61 001 (60 001ms elapsed) → suppressed | Final heartbeat at 60s; empty at 60 001ms |
| `heartbeat_resumes_after_resume_from_pause` | Pause; suppress via tick at 60 001ms; emit play event; tick after one interval → heartbeat | Beacon present |
| `inactivity_timer_resets_on_inactive_to_inactive_transition` | Pause at t=1000; tick at t=51 000 (heartbeat fires); Error event at t=51 000 (resets timer); resume via Load→Play→FirstFrame at t=66 000; tick at t=77 001 → heartbeat | Beacon present after reset |
| `inactivity_timer_cleared_on_active_state` | Pause at t=0; tick at t=31 000; resume play at t=31 000; tick at t=41 001 (only 10s since interval reset) → heartbeat | Beacon present |
| `destroy_emits_beacon_when_heartbeat_suppressed` | Pause; suppress via tick at 60 001ms; call destroy → ended beacon returned | Beacon present |

### Regression

Run the full existing test suite (`cargo test -p plinth-core`) to confirm no existing heartbeat behavior changed.

---

## Open Questions

None. All decisions resolved from PRD and codebase review.

---

## Out of Scope

- Configurable timeout duration.
- Automatic session termination or cleanup after inactivity.
- Platform-layer changes (all layers are unchanged).

---

## Associated Documents

No updates required to beacon schema, payload reference, state machine diagram, or quickstart guides. This is an internal SDK behavior change with no externally visible API or payload differences.
