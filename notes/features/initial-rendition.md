# Notes: Initial Rendition on First Frame

## Key decisions

- `PlayerEvent::FirstFrame` becomes `FirstFrame { quality: Option<QualityLevel> }` — unit variant → struct variant.
- Rust `PlayerEventMap` already collects `quality` for `QualityChange`; reuse the same field for `FirstFrame`.
- `Beacon::quality` already exists — no new struct fields.
- TypeScript: `{ type: "first_frame"; quality?: QualityLevel }` — additive, backward compatible.

## Per-integration quality source

| Integration | Quality source at first_frame |
|---|---|
| plinth-hlsjs | `hls.levels[hls.currentLevel]` |
| plinth-shaka | `player.getVariantTracks().find(t => t.active)` |
| plinth-dashjs | `lastRepresentation` (stored from most recent `QUALITY_CHANGE_REQUESTED`) |
| plinth-avplayer | `AVPlayerItem.presentationSize` + `accessLog().events.last.indicatedBitrate` |
| plinth-media3 | `player.videoFormat` |

## Dashjs: new state field

Add `lastRepresentation: DashjsRepresentation | null = null` alongside `lastQualityIndex`.
Reset both to `null` in `onManifestLoadingStarted`.

## Shaka: new private helper

Extract `qualityFromTrack(track: ShakaTrack): QualityLevel` — shared by `emitQualityForTrack` and the `first_frame` emission path.

## Existing test impact

All Rust tests that emit `PlayerEvent::FirstFrame` must change to `PlayerEvent::FirstFrame { quality: None }`.
