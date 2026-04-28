# TDD: Initial Rendition on First Frame

## Overview

Add an optional `quality` field to the `first_frame` beacon so the starting rendition is captured at the exact moment the first frame renders. This requires a small change to the `PlayerEvent::FirstFrame` variant in the Rust core (adding `quality: Option<QualityLevel>`), a matching update to the TypeScript `PlayerEvent` discriminated union, and per-integration logic to read the active track at first-frame time.

---

## Architecture

The change touches all three layers:

- **Layer 1 (plinth-core)**: `PlayerEvent::FirstFrame` gains a `quality` payload field. The `first_frame` beacon handler writes it to `Beacon::quality`.
- **Layer 2 (plinth-js / plinth-apple / plinth-android)**: `PlayerEvent` TypeScript type is updated; no behavioral change — the event still passes through as JSON to the Wasm boundary.
- **Layer 3 (player integrations)**: Each adapter reads the active rendition when emitting `first_frame` and populates the `quality` field.

The `Beacon` struct already has `quality: Option<QualityLevel>` — it is currently only set on `quality_change` beacons. This feature reuses the same field on `first_frame` beacons at no structural cost.

---

## Data Models

### Rust — `PlayerEvent` (event.rs)

```rust
// Before:
FirstFrame,

// After:
FirstFrame { quality: Option<QualityLevel> },
```

The `PlayerEventMap` deserializer already collects a `quality` field (used by `QualityChange`). The `"first_frame"` match arm is updated to pluck it:

```rust
"first_frame" => PlayerEvent::FirstFrame {
    quality: self.quality.take(),
},
```

### TypeScript — `PlayerEvent` (plinth-js/src/types.ts)

```typescript
// Before:
| { type: "first_frame" }

// After:
| { type: "first_frame"; quality?: QualityLevel }
```

No changes needed to `plinth-js` internals — it serializes the event object to JSON and passes it to Wasm; the Rust deserializer handles the new field.

---

## Key Flows

### first_frame beacon emission (session.rs)

The handler for `(PlayAttempt | Buffering, FirstFrame)` already constructs a `Beacon` with `BeaconEvent::FirstFrame`. After construction, set `b.quality = quality`:

```rust
(PlayerState::PlayAttempt | PlayerState::Buffering, PlayerEvent::FirstFrame { quality }) => {
    // ... existing VST / state transition logic ...
    let mut b = self.make_beacon(BeaconEvent::FirstFrame, ...);
    b.quality = quality;   // ← new
    out.push(b);
    // ... existing playing beacon ...
}
```

### Player integration — plinth-hlsjs

Read `hls.levels[hls.currentLevel]` at the time the `<video> playing` handler fires for the first frame:

```typescript
const onPlaying: EventListener = () => {
  if (!this.hasFiredFirstFrame) {
    this.hasFiredFirstFrame = true;
    const level = (this.hls as any).levels[(this.hls as any).currentLevel];
    this.emit({
      type: "first_frame",
      quality: level ? {
        bitrate_bps: level.bitrate,
        width: level.width,
        height: level.height,
        codec: level.videoCodec,
      } : undefined,
    });
  }
};
```

If `currentLevel` is `-1` or levels are unavailable, `quality` is `undefined` and the field is omitted from the beacon.

### Player integration — plinth-shaka

Read the active track via `player.getVariantTracks().find(t => t.active)` at first-frame time. Extract a private helper `qualityFromTrack` so the same mapping is used by both `emitQualityForTrack` and the `first_frame` emission:

```typescript
private qualityFromTrack(track: ShakaTrack): QualityLevel {
  return {
    bitrate_bps: track.bandwidth,
    width: track.width ?? undefined,
    height: track.height ?? undefined,
    framerate: track.frameRate != null ? String(track.frameRate) : undefined,
    codec: track.videoCodec ?? undefined,
  };
}
```

```typescript
const onPlaying: EventListener = () => {
  if (!this.hasFiredFirstFrame) {
    this.hasFiredFirstFrame = true;
    const active = this.player.getVariantTracks().find((t) => t.active);
    this.emit({
      type: "first_frame",
      quality: active ? this.qualityFromTrack(active) : undefined,
    });
  }
  // ...
};
```

### Player integration — plinth-dashjs

Store the most recent `DashjsRepresentation` as `lastRepresentation: DashjsRepresentation | null`. `QUALITY_CHANGE_REQUESTED` fires before playback starts (ABR selects a rendition during manifest parsing), so `lastRepresentation` is available when the `<video> playing` handler fires for the first time:

```typescript
// In onQualityChangeRequested:
this.lastRepresentation = rep;   // ← store in addition to lastQualityIndex

// In onPlaying (first_frame path):
const rep = this.lastRepresentation;
this.emit({
  type: "first_frame",
  quality: rep ? { bitrate_bps: rep.bandwidth, width: rep.width, height: rep.height } : undefined,
});
```

Reset `lastRepresentation = null` alongside `lastQualityIndex` in `onManifestLoadingStarted`.

### Player integration — plinth-avplayer (Swift)

Emit `first_frame` as a JSON string. Extend `handleFirstFrame()` to include current AVPlayerItem track info:

```swift
// Read current presentation size and bitrate from AVPlayerItem
let quality = currentQuality()  // returns a [String: Any]? dict
var event: [String: Any] = ["type": "first_frame"]
if let q = quality { event["quality"] = q }
session.processEvent(try JSONSerialization.data(withJSONObject: event))
```

`currentQuality()` reads `AVPlayerItem.presentationSize` (width/height) and the indicated bitrate from `AVPlayerItem.accessLog()?.events.last?.indicatedBitrate`.

### Player integration — plinth-media3 (Android/Kotlin)

In `handleFirstFrame()`, serialize a `quality` object from `player.videoFormat`:

```kotlin
val fmt = player.videoFormat
val quality = fmt?.let {
    buildJsonObject {
        put("bitrate_bps", it.bitrate.toLong())
        put("width", it.width)
        put("height", it.height)
        it.frameRate.takeIf { fr -> fr > 0 }?.let { fr ->
            put("framerate", fr.toBigDecimal().toPlainString())
        }
        it.codecs?.let { c -> put("codec", c) }
    }
}
val event = buildJsonObject {
    put("type", "first_frame")
    quality?.let { put("quality", it) }
}
session.processEvent(event.toString())
```

---

## API Design

No public API changes. `PlayerEvent` is an internal type not exposed to integrators. The beacon schema change is additive — `quality` is optional on `first_frame`, so existing server-side consumers that don't expect it are unaffected.

---

## Testing Approach

### plinth-core (Rust)

- `first_frame_beacon_carries_quality_when_provided` — emit `FirstFrame { quality: Some(...) }`, assert `beacon.quality == Some(...)`.
- `first_frame_beacon_omits_quality_when_none` — emit `FirstFrame { quality: None }`, assert `beacon.quality.is_none()`.
- `first_frame_quality_does_not_affect_playing_beacon` — confirm the `playing` beacon emitted immediately after `first_frame` does not carry quality.
- Existing `FirstFrame` tests: update all call sites to use `FirstFrame { quality: None }`.

### plinth-js (TypeScript)

- TypeScript compile check: `{ type: "first_frame" }` (no quality) is still valid.
- `{ type: "first_frame", quality: { bitrate_bps: 2_500_000, width: 1280, height: 720 } }` is accepted.

### plinth-hlsjs, plinth-shaka, plinth-dashjs

For each integration, add one new test:

| # | Scenario | Setup | Assert |
|---|---|---|---|
| N | `first_frame` carries initial rendition | Set up level/track before first playing event | `processEvent` called with `{ type: "first_frame", quality: { bitrate_bps: ... } }` |
| N+1 | `first_frame` omits quality when no track available | No level/track set | `processEvent` called with `{ type: "first_frame" }` (no quality key) |

### plinth-avplayer, plinth-media3

- `testFirstFrameBeaconIncludesQuality` — stub `AVPlayerItem`/`Format` with known size+bitrate; assert the serialized event JSON contains `"quality"`.
- `testFirstFrameBeaconOmitsQualityWhenFormatUnavailable` — nil/unknown format; assert no `"quality"` key.

---

## Associated Documents to Update

- **`docs/reference/beacon-payload.md`**: Add `quality` to the `first_frame` row's "Extra fields" column.
- **`docs/reference/beacon-payload.schema.json`**: Add an `allOf` entry for `event: "first_frame"` that declares `quality` as an optional `$ref: QualityLevel`. Also update the `QualityLevel` description to note it appears on both `first_frame` and `quality_change`.
- **`docs/tdd/shaka-integration.md`** and **`docs/tdd/dashjs-integration.md`**: Update the first_frame row in each test table; note `qualityFromTrack` helper (Shaka) and `lastRepresentation` field (dashjs).

---

## Out of Scope

- Audio rendition tracking.
- Capturing rendition before `first_frame` (e.g. at `play` or `can_play`).
- Server-side enforcement or validation of `first_frame.quality`.
- Changing the `quality_change` dedup logic to account for `first_frame.quality`.
