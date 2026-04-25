# TDD: Seek Tracking

## Overview

The current seek implementation emits one `seek_start`/`seek_end` pair per `seeking`/`seeked` browser event pair, filtered by a 250ms distance threshold. This works for a single click but fails for continuous scrubbing: dragging the scrub bar fires many rapid `seeking`/`seeked` pairs, generating multiple seek events from one user action. Stall events also fire incorrectly during scrubbing because `onWaiting`/`onBuffering` are not suppressed while seeking is in progress. This TDD replaces the current per-event approach with a debounce-based approach that emits exactly one seek event per user action and suppresses stalls during scrubbing.

---

## Architecture

Changes span **Layer 2** (seek tracker shared utility) and **Layer 3** (player integrations). plinth-core is unchanged. All three integrations share the same debounce pattern via `VideoSeekTracker`.

| Component | Change |
|---|---|
| `packages/web/plinth-js/src/seek-tracker.ts` | `VideoSeekTracker` class — shared debounce logic for all web adapters |
| `packages/web/plinth-hlsjs/src/index.ts` | Debounce seek via `VideoSeekTracker`; suppress spurious `pause` during seeking; forward `stall` during seek for `seek_buffer_ms` tracking |
| `packages/web/plinth-shaka/src/index.ts` | Same as above |
| `packages/web/plinth-dashjs/src/index.ts` | Same as above |

No changes to plinth-core, beacon schema, or reference docs beyond this TDD.

---

## Data Models

Seek state is encapsulated in `VideoSeekTracker` (Layer 2, `plinth-js`):

```ts
// Internal to VideoSeekTracker
private _active = false;                   // true between first seeking and debounce settlement
private _pendingSeekFrom: number | null;   // origin; set only on first seeking of a scrub
private _debounceTimer: ReturnType<typeof setTimeout> | null;
```

Adapters hold a `seekTracker: VideoSeekTracker` field. The `active` getter replaces the old `isSeeking` class field.

---

## Key Flows

### Click seek (single seeking → seeked pair)

1. `seeking` fires. `_pendingSeekFrom === null` → record origin from `lastPlayheadMs`. Emit `seek(from_ms)`. `_active = true`. Cancel any pending debounce timer (none).
2. `seeked` fires. Cancel any pending timer. Start 300ms debounce timer.
3. 300ms of silence. Debounce callback fires:
   - `_active = false`
   - Emit `seek_end(to_ms, buffer_ready)`
   - If `!video.paused`, emit `playing` — browser suppresses the native `playing` event during the debounce window and never re-fires it, so the adapter replays it explicitly
   - Reset `_pendingSeekFrom = null`

### Continuous scrubbing (many seeking → seeked pairs)

1. First `seeking` fires. `_pendingSeekFrom === null` → record origin. Emit `seek(from_ms)`. `_active = true`.
2. First `seeked` fires. Start debounce timer.
3. Second `seeking` fires within 300ms. `_pendingSeekFrom !== null` → do NOT update origin. Cancel debounce timer.
4. Second `seeked` fires. Start new debounce timer.
5. Steps 3–4 repeat for each drag position.
6. User releases. Last `seeked` fires. Start debounce timer.
7. 300ms of silence. Timer callback fires with original origin and final `currentTime`. Emit `seek_end` (and `playing` if not paused).

### Stall forwarding during seeking

Stall events (`waiting` / `buffering: true`) are **forwarded to the state machine even while seeking is active**. This allows plinth-core to accumulate `seek_buffer_ms` for seeks that include a rebuffer. The `seek_end` event carries `buffer_ready: false` when the buffer is empty at debounce time, causing `Seeking → Rebuffering` in the state machine.

### Spurious pause suppression

Browsers and some players (HLS.js, dash.js) fire a `pause` event during seeking. If forwarded, this corrupts `pre_seek_state` and causes `seek_end` to resolve to Paused even when the user never paused. The `onPause` handler guards against this:

```ts
const onPause: EventListener = () => {
  if (this.video.ended) return;
  if (this.video.seeking) return; // spurious pause fired by browser/player during seek
  this.emit({ type: "pause" });
};
```

### destroy() cleanup

`VideoSeekTracker.destroy()` removes event listeners and clears the debounce timer. Adapters call `this.seekTracker.destroy()` in their own `destroy()` method. No manual timer management needed in adapters.

---

## API Design

`VideoSeekTracker` is exported from `@wirevice/plinth-js` for use by all web adapters. Adapters construct it in `initialize()` with four callbacks:

```ts
new VideoSeekTracker(
  video,
  () => instance.lastPlayheadMs,           // getPlayheadMs
  (fromMs) => instance.emit({ type: "seek", from_ms: fromMs }),  // onSeekStart
  (toMs, bufferReady) => {                  // onSeekEnd (fires after 300ms debounce)
    instance.emit({ type: "seek_end", to_ms: toMs, buffer_ready: bufferReady });
    if (!video.paused) instance.emit({ type: "playing" });
  },
)
```

The `active` getter is `true` between the first `seeking` event and debounce settlement. Adapters check `seekTracker.active` only where needed (e.g. to suppress Shaka's `buffering(false)` → `playing` during a seek).

### Debounce window

300ms. Not configurable. Long enough to absorb rapid scrub events (browsers typically fire seeking/seeked at 100–200ms intervals during drag); short enough that seek reporting is not meaningfully delayed.

---

## Shaka-specific note

Shaka's stall signal comes from the player `buffering` event (not the video `waiting` event). The stall path (`buffering: true`) forwards stalls unconditionally (no seeking guard) so `seek_buffer_ms` is tracked. The recovery path (`buffering: false`) is suppressed while `seekTracker.active` is true — seek recovery is driven by the `seeked` debounce callback instead:

```ts
const onBuffering: EventListener = (e) => {
  if ((e as any).buffering) {
    this.emit(this.hasFiredFirstFrame ? { type: "stall" } : { type: "waiting" });
  } else if (!this.seekTracker.active) {
    this.emit({ type: "playing" });
  }
};
```

---

## Testing Approach

All tests in the existing test files for each integration. Use `mock.timers` from `node:test` to control `setTimeout` without real delays.

### Setup pattern for timer tests

```ts
beforeEach(() => { mock.timers.enable(["setTimeout"]); });
afterEach(() => { mock.timers.reset(); });
```

Advance time with `mock.timers.tick(300)`.

### Key tests per integration (same for hlsjs, shaka, dashjs)

| Test | What it verifies |
|---|---|
| `seek completes → seek_end emitted with buffer_ready` | Fire `seeking` + `seeked`; tick 300ms; assert `seek_end` and `playing` emitted |
| `seek completes while video paused → seek_end emitted, playing not emitted` | Same but `video.paused = true`; assert `playing` NOT emitted |
| `seek_end emitted after 300ms debounce fires` | Full flow with `timeupdate`; assert `seek`, `seek_end`, and `playing` all emitted |
| `seek_end buffer_ready=true when video is not paused at debounce time` | Buffer ranges empty but `video.paused = false`; assert `buffer_ready: true` and `playing` emitted |
| `scrubbing emits exactly one seek_start` | Fire multiple `seeking`/`seeked` pairs; tick 300ms; assert exactly one `seek` emitted |
| `scrubbing: seek_start.from_ms is position before first seeking event` | Scrub from 5s through multiple positions; assert `from_ms === 5000` |
| `stall forwarded during seek for seek_buffer tracking` | Fire `seeking` then `waiting`; assert `stall` IS emitted (not suppressed) |
| `stall emits normally after seek debounce has settled` | Settle debounce first; fire `waiting`; assert `stall` emitted |
| `video 'pause' during seeking → pause suppressed` | Fire `seeking` then `pause`; assert no `pause` event forwarded |
| `destroy cancels pending seek debounce` | Fire `seeking` + `seeked`; call `destroy()`; tick 300ms; verify no seek emitted |
| `'ended' during seek debounce → seek_end emitted then ended` | Fire `seeked`, then `ended` before debounce; assert `seek_end` fires before `ended` |

---

## Open Questions

None. All decisions resolved from PRD and codebase.

---

## Associated Documents to Update

None. This feature changes no public API, schema, or beacon payload fields.
