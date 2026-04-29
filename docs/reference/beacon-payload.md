# Beacon Payload

Beacons are sent as HTTP POST to the configured endpoint. The body is always a JSON object containing an array of one or more beacons from a single play session.

The authoritative JSON Schema is at [`beacon-payload.schema.json`](beacon-payload.schema.json). This document is the human-readable companion.

## HTTP request

```
POST /beacon HTTP/1.1
Content-Type: application/json

{ "beacons": [ ... ] }
```

All beacons in a batch belong to the same `play_id` and are ordered by ascending `seq`.

---

## Fields present on every beacon

| Field | Type | Description |
|---|---|---|
| `seq` | integer | Monotonically increasing counter starting at 0 (`play`) within a play session. Gaps indicate lost beacons. |
| `play_id` | UUID string | Generated at `PlayAttempt`. Uniquely identifies one play session. |
| `ts` | integer | Unix epoch milliseconds (client clock) when the beacon was emitted. |
| `event` | string | Event type. See the table below. |

---

## Event types

| `event` | Emitted when | Extra fields |
|---|---|---|
| `play` | User presses play (first beacon, seq=0). No `state` or `metrics`. | `video`, `client`, `sdk` |
| `first_frame` | First video frame renders. VST is now known. | `quality` (optional) |
| `playing` | Video is actively playing: emitted immediately after `first_frame` (same timestamp), after stall recovery, and after resuming from pause. | — |
| `pause` | Playback paused by user or system. | — |
| `seek` | Seek begins (debounced: fires once per gesture, at the start). | `seek_from_ms` |
| `stall` | Buffer exhausted mid-playback (after first frame); player is stalling. | — |
| `quality_change` | Rendition switch while playing or rebuffering. | `quality` |
| `error` | Player error, fatal or non-fatal. Fatal errors end the session. | `error` |
| `heartbeat` | Keepalive emitted when no other beacon has been sent for `heartbeat_interval_ms` and a session is active. | `playhead_ms` |
| `ended` | `destroy()` was called while a session was active. | `playhead_ms` |
| `completed` | Video reached its natural end. | `playhead_ms` |

---

## `state`

Present on all beacons except `play` (seq=0).

`idle` | `loading` | `ready` | `play_attempt` | `buffering` | `playing` | `paused` | `seeking` | `rebuffering` | `ended` | `error`

---

## `metrics`

Present on all beacons except `play` (seq=0). Each beacon carries the full cumulative snapshot.

| Field | Type | Description |
|---|---|---|
| `vst_ms` | integer \| null | Video Start Time: ms from `play_attempt` to `first_frame`. Null until first frame renders. |
| `played_ms` | integer | Cumulative ms spent in the `playing` state. |
| `rebuffer_ms` | integer | Cumulative ms spent in mid-playback rebuffering (`Playing → Rebuffering` only). |
| `watched_ms` | integer | Total elapsed ms since `play_attempt` (includes buffering, paused, seeking time). |
| `rebuffer_count` | integer | Number of discrete mid-playback rebuffer events (`Playing → Rebuffering`). |
| `error_count` | integer | Total errors emitted (fatal and non-fatal). |
| `seek_buffer_ms` | integer | Cumulative ms spent buffering after seeks (`Seeking → Rebuffering` only). |
| `seek_buffer_count` | integer | Number of seeks that resulted in buffering (`Seeking → Rebuffering` transitions). |
| `seek_count` | integer | Total seek events initiated during the session (`seek` events). |

---

## `play`-only fields (session open)

| Field | Description |
|---|---|
| `video.id` | Content identifier supplied by the integrator. |
| `video.title` | Human-readable title (optional). |
| `client.user_agent` | User agent string from the runtime. |
| `sdk.api_version` | Beacon schema version (currently `1`). |
| `sdk.core` | `{ name, version }` — Rust core component. |
| `sdk.framework` | `{ name, version }` — platform framework (`plinth-js` / `plinth-swift`). |
| `sdk.player` | `{ name, version }` — player integration (`plinth-hlsjs` / `plinth-avplayer`). |

---

## Seek fields

`seek_from_ms` is present on `seek` beacons. It is the playhead position (in milliseconds) recorded immediately before the seek gesture began. All values are milliseconds in the content timeline.

---

## `quality` object (`quality_change`)

| Field | Type | Description |
|---|---|---|
| `bitrate_bps` | integer? | Rendition bitrate in bits per second. |
| `width` | integer? | Video width in pixels. |
| `height` | integer? | Video height in pixels. |
| `framerate` | string? | Frame rate as a string (e.g. `"29.97"`). MPEG-DASH may supply fractional strings such as `"30000/1001"`; the integration normalises these to decimal strings. |
| `codec` | string? | Codec string (e.g. `avc1.4d401f`). |

---

## `error` object (`error`)

| Field | Type | Description |
|---|---|---|
| `code` | string | Error code from the player or network layer. |
| `message` | string? | Human-readable description, if available. |
| `fatal` | boolean | `true` if the error terminates the session. |

---

## `heartbeat`-only field

| Field | Type | Description |
|---|---|---|
| `playhead_ms` | integer | Current position in the content timeline. Used server-side to detect stalls and validate `played_ms`. |

---

## Example: play (session open)

```json
{
  "beacons": [{
    "seq": 0,
    "play_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "ts": 1708646400000,
    "event": "play",
    "video": { "id": "bbb-720p", "title": "Big Buck Bunny" },
    "client": { "user_agent": "Mozilla/5.0 ..." },
    "sdk": {
      "api_version": 1,
      "core":      { "name": "plinth-core",  "version": "0.1.0" },
      "framework": { "name": "plinth-js",    "version": "0.1.0" },
      "player":    { "name": "plinth-hlsjs", "version": "0.1.0" }
    }
  }]
}
```

See [`beacon-payload.samples.json`](beacon-payload.samples.json) for a complete play session lifecycle.
