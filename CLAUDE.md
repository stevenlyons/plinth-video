# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**plinth-video** is a multi-platform Video Quality of Experience (QoE) SDK framework — a proof-of-concept. It measures playback metrics (Video Start Time, Rebuffer Time, Played Time, Watched Time) and reports them via HTTP beacons.

## Process

New features will have a Product Requirements Document (PRD) added to the docs/prd directory. The PRD will list the high-level requirements, goals, and experience expectations of the feature. From the information in the PRD, create a matching Technical Design Document (TDD) that includes architecture, technical information, data types, build commands, and other information. The TDD documents should be put in the docs/tdd directory and named the same as the source PRD document. If there are open questions from processing the PRD, ask the user.

When implementing a TDD, create a git branch using the name of the feature. 

Keep track of the TDDs that are implemented in file called FEATURES.md. Add a checkbox for each TDD when it is created. When the TDD is implemented, check the checkbox.  

If changes are made that impact functionality listed in this file, update the file.

## Architecture

Three-layer architecture designed to minimize per-platform maintenance:

```
plinth-core (Rust)
  ├── → wasm target  → plinth-js (TypeScript)  → plinth-hlsjs (Hls.js integration)
  └── → native .a    → plinth-apple (Swift)    → plinth-avplayer (AVPlayer integration)
```

### Layer 1: `plinth-core` (Rust)
- State machine, time tracking, beacon building, beacon queuing, JSON serialization
- Compiled to WebAssembly for web; native static/dynamic lib for iOS/Android
- **Does NOT perform HTTP** — returns serialized beacon batches for the platform layer to transmit
- Heartbeat timer is platform-driven: platform calls `tick(now_ms)` periodically; core checks if the interval has elapsed

### Layer 2: Platform frameworks (`plinth-js`, `plinth-apple`, etc.)
- Written in the platform's native language (TypeScript, Swift, Kotlin)
- Owns all platform I/O: HTTP fetch, timers, timestamps, user agent string
- Loads and wraps the core (Wasm or native FFI)
- Calls `tick(now_ms)` on an interval; sends HTTP POST when core returns beacon data

### Layer 3: Player integrations (`plinth-hlsjs`, `plinth-avplayer`, etc.)
- Maps player-specific events/APIs to the core's `PlayerEvent` enum
- Implements the public SDK API: `initialize(player, component, metadata)`, `updateMetadata(metadata)`, `destroy()`
- Hides layers 1 and 2 from the application developer

## Repository Layout

```
plinth-video/
├── crates/                        # Rust
│   └── plinth-core/               # Layer 1: state machine, metrics, beacon, FFI
├── packages/
│   ├── web/                       # JS/TypeScript packages (bun workspace)
│   │   ├── plinth-js/             # Layer 2: Wasm wrapper, heartbeat, HTTP poster
│   │   ├── plinth-hlsjs/          # Layer 3: Hls.js integration
│   │   └── plinth-shaka/          # Layer 3: Shaka Player integration
│   ├── apple/
│   │   ├── plinth-apple/          # Layer 2: Swift package (PlinthApple + PlinthCoreFFI)
│   │   └── plinth-avplayer/       # Layer 3: AVPlayer integration (depends on plinth-apple)
│   └── android/
│       ├── plinth-android/        # Layer 2: Kotlin/JNI wrapper
│       └── plinth-media3/         # Layer 3: Media3/ExoPlayer integration
├── samples/
│   ├── web/                       # Bun dev server + HLS.js and Shaka smoke-test pages
│   ├── macos/                     # macOS SwiftUI demo app
│   └── android/                   # Android sample app
├── docs/
│   ├── overview-prd.md        # Top-level product requirements and personas
│   ├── prd/                       # Per-feature Product Requirements Documents
│   ├── tdd/                       # Per-feature Technical Design Documents
│   └── reference/                 # Specs, schemas, quickstarts, API docs
│       ├── beacon-payload.schema.json
│       ├── beacon-payload.samples.json
│       ├── beacon-payload.md
│       ├── player-state-machine.mermaid
│       ├── sdk-api.md
│       ├── quickstart-hlsjs.md
│       ├── quickstart-avplayer.md
│       └── new-player-integration.md
└── scripts/                       # build-xcframework.sh, setup-android.sh
```

## Key Specs & Docs

All specs are authoritative — implement against them:

- `docs/overview-prd.md` — requirements, personas, goals
- `docs/reference/player-state-machine.mermaid` — 11-state machine with guards (read before touching state logic)
- `docs/reference/beacon-payload.schema.json` — JSON Schema for beacon payloads (source of truth for types)
- `docs/reference/beacon-payload.samples.json` — concrete examples of a full play session lifecycle
- `TASKS.md` — phased task list (update as work progresses)

## Player State Machine

11 states: `Idle → Loading → Ready → PlayAttempt → Buffering → Playing → Paused → Seeking → Rebuffering → Ended → Error`

Critical seek guard: `pre_seek_state` must be tracked. `seekEnd` resolves to `Playing`, `Rebuffering`, or `Paused` based on the state active when `seekStart` fired.

## Beacon HTTP Protocol

- **POST** to `http://localhost:3000/beacon` (default, configurable)
- Project key: `p123456789` (hardcoded for PoC)
- Payload: `{ "beacons": [...] }` — a batch of one or more beacons, always from a single play session, in ascending `seq` order
- `session_open` (seq=0) is sent at `PlayAttempt`; it carries `video`, `client`, and `sdk` metadata — no `state` or `metrics`
- All other beacons include cumulative `metrics` snapshot and current `state`
- Heartbeat beacons additionally include `playhead_ms`

## Language & Toolchain per Component

| Component | Location | Language | Toolchain |
|---|---|---|---|
| `plinth-core` | `crates/plinth-core/` | Rust | `cargo`, `wasm-pack` for Wasm target |
| `plinth-js` | `packages/web/plinth-js/` | TypeScript | `pnpm` |
| `plinth-hlsjs` | `packages/web/plinth-hlsjs/` | TypeScript | `pnpm` |
| `plinth-shaka` | `packages/web/plinth-shaka/` | TypeScript | `pnpm` |
| `plinth-apple` | `packages/apple/plinth-apple/` | Swift | Xcode / Swift Package Manager |
| `plinth-avplayer` | `packages/apple/plinth-avplayer/` | Swift | Xcode / Swift Package Manager |
| `plinth-android` | `packages/android/plinth-android/` | Kotlin | Gradle |
| `plinth-media3` | `packages/android/plinth-media3/` | Kotlin | Gradle |
| Web demo | `samples/web/` | TypeScript | `pnpm` |

## Build Commands

```bash
# Rust core — native
cargo build -p plinth-core
cargo test -p plinth-core
cargo test -p plinth-core -- <test_name>   # run single test

# Rust core — Wasm
wasm-pack build crates/plinth-core --target web --out-dir packages/web/plinth-js/wasm

# JS packages (from repo root or package dir)
pnpm install
pnpm -r test                               # run all web tests
pnpm --filter @plinth/js test              # run one package's tests

# Web demo server
pnpm --filter @plinth/dev start            # serves at http://localhost:3000
                                           # Shaka demo at http://localhost:3000/shaka

# Swift (from packages/apple/plinth-apple/)
swift test

# Android
./gradlew :plinth-android:test
./gradlew :plinth-media3:test
```
