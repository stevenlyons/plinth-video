# Code Review Findings

## Bugs

### `clearTimeout` with incorrect non-null assertion
**Files:** `packages/web/plinth-hlsjs/src/index.ts:74,184,191` / `packages/web/plinth-shaka/src/index.ts:71,184,191`

`_seekDebounceTimer` is typed `ReturnType<typeof setTimeout> | null` and initialized to `null`, but every `clearTimeout` call uses `!`. This compiles and runs fine (browsers accept `clearTimeout(null)`) but the assertion is wrong — the value genuinely can be null. Fix by passing `?? undefined`:

```typescript
clearTimeout(this._seekDebounceTimer ?? undefined);
```

---

## Design Issues

### Web adapters resolve seeks via `playing` instead of `seek_end`
**Files:** `packages/web/plinth-hlsjs/src/index.ts:197-199` / `packages/web/plinth-shaka/src/index.ts:same`

After seek debounce, the adapters emit `{ type: "playing" }` while the state machine is in `Seeking`. The state machine handles this (`Seeking + Playing → Playing`, `crates/plinth-core/src/session.rs:485`), but `buffer_ready` semantics are lost entirely on web — the core can't distinguish between a buffer-ready and buffer-empty seek completion, so `seek_buffer_ms` won't be tracked. `plinth-avplayer` sends the proper `SeekEnd { to_ms, buffer_ready }` event. This is a platform inconsistency that will affect seek rebuffer metrics on web.

### Seek code duplicated identically across hlsjs and shaka
**Files:** `packages/web/plinth-hlsjs/src/index.ts:178-204` / `packages/web/plinth-shaka/src/index.ts:178-204`

`isSeeking`, `_pendingSeekFrom`, `_seekDebounceTimer`, and the `onSeeking`/`onSeeked` handlers are line-for-line identical in both adapters. Any bug fix has to be applied twice. This belongs in a shared `VideoSeekTracker` helper or a base class.

---

## Simplifications

### `postBeacons` swallows network errors silently
**File:** `packages/web/plinth-js/src/poster.ts:10`

The function is documented "fire-and-forget" and callers use `void`, which is intentional. But `fetch` rejections (network down, CORS, etc.) are completely invisible — no console warning, no callback. For a telemetry SDK this means there's no way to know beacons are being dropped in production. A minimal `.catch(console.warn)` would surface failures during development and debugging.

### Heartbeat inactivity comment is misleading
**File:** `crates/plinth-core/src/session.rs:657`

The comment says "One final heartbeat fires at exactly the 60s mark." The actual behavior is: the last heartbeat fires on whichever `tick()` call lands with `elapsed <= 60000`; all subsequent ticks are suppressed. Since tick intervals are discrete (e.g. every 1s), the "final" one fires somewhere between 59s and 60s, not "exactly" at 60s. The logic is correct — the comment should read: "Heartbeats are suppressed after 60s of continuous inactivity; the last one fires on the tick at or just before the 60s threshold."

### `bitrate_bps: level?.bitrate` can pass `undefined` into an event
**File:** `packages/web/plinth-hlsjs/src/index.ts:116`

If `level` is undefined or `level.bitrate` is missing, `undefined` is passed as `bitrate_bps`. Cleaner to guard the whole event: `if (!level) return;` before constructing the quality object.
