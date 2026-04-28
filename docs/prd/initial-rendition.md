# Feature PRD: Initial Rendition on First Frame

## Overview

Currently, rendition data is only reported via `quality_change` beacons, which fire when the player switches from one rendition to another. This means the starting rendition — the quality level that produced the first frame — is never captured unless a switch happens immediately at playback start (as some players like Hls.js happen to do). Sessions where the player plays at one rendition throughout have no quality data at all.

This feature adds an optional `quality` field to the `first_frame` beacon so the initial rendition is always captured at the moment the first frame renders, regardless of whether a switch ever occurs.

---

## Goals

- Capture the starting rendition for every play session that reaches first frame.
- Enable calculation of the initial rendition selected by ABR across a population of sessions.
- Support analysis of starting rendition vs. rebuffer rate, VST, and other QoE metrics.
- Complement the existing `rendition-tracking` feature: `first_frame.quality` is always the baseline; `quality_change` beacons remain the record of switches.

---

## Personas

- **Developers**: Want to verify the player is selecting the expected starting rendition in different network conditions.
- **Product Managers**: Want to know what quality most viewers start at and whether low starting renditions correlate with abandonment.
- **Data Engineers**: Want a clean baseline rendition value per session without having to infer it from `quality_change` sequences.

---

## Behavioral Rules

### `first_frame` beacon

1. The `first_frame` beacon gains an optional `quality` field, with the same shape as the `quality` object on `quality_change` beacons.
2. `quality` is populated by the player integration with the active rendition at the moment the first frame fires.
3. `quality` is omitted (`null` / not serialized) if the integration cannot determine the active rendition at that moment.
4. If `quality` is present, it does not suppress or replace any `quality_change` beacon that may follow — both are emitted independently.

### `quality_change` semantics are unchanged

5. `quality_change` continues to fire only on rendition switches. An initial `quality_change` emitted by a player immediately after `first_frame` (e.g. Hls.js) is still valid and is still emitted; it does not conflict with `first_frame.quality`.

### Per-load reset

6. `first_frame.quality` applies to the load in which `first_frame` fires. On a source reload within the same session, the next `first_frame` beacon may carry a different (or absent) `quality`.

---

## Out of Scope

- Audio rendition tracking (video only, consistent with existing `quality_change`).
- Capturing rendition at `play` (seq=0) — the player may not have selected a rendition yet at that point.
- Server-side rendition validation or ABR policy enforcement.
