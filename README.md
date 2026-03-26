# plinth-telemetry

A proof-of-concept multi-platform Video Quality of Experience (QoE) SDK. Measures playback metrics (Video Start Time, Rebuffer Time, Played Time, Watched Time) and reports them via HTTP beacons.

## Architecture

Three-layer design to minimize per-platform code:

```
plinth-core (Rust)
  ├── → wasm target  → plinth-js (TypeScript)  → plinth-hlsjs / plinth-shaka / plinth-dashjs
  └── → native .a    → plinth-apple (Swift)    → plinth-avplayer (AVPlayer)
                     → plinth-android (Kotlin)  → plinth-media3 (ExoPlayer)
```

## Prerequisites

| Tool | Purpose |
|---|---|
| [Rust via rustup](https://rustup.rs) | Build plinth-core — **must use rustup-managed Rust**, not Homebrew Rust |
| [wasm-pack](https://rustwasm.github.io/wasm-pack/) | Compile core to WebAssembly |
| Node.js 22+ | Run JS tests and web demo |
| [pnpm](https://pnpm.io) | JS package manager (version pinned via `packageManager` field — use [corepack](https://nodejs.org/api/corepack.html)) |
| Xcode + Swift | Build and test Apple packages |
| Android Studio + JDK | Build and test Android packages |
| [Gradle](https://gradle.org/install/) | Generate the `gradlew` wrapper (one-time setup) |

Enable corepack to use the pinned pnpm version automatically:

```bash
corepack enable
```

## Setup

```bash
# Install JS dependencies
pnpm install

# Build the Rust core (required before running Swift tests)
cargo build -p plinth-core

# Generate the Gradle wrapper for Android (one-time, requires Gradle installed — e.g. brew install gradle)
gradle wrapper

# Build the Wasm target (required before running JS tests against real Wasm)
# Must run from the crate dir; --out-dir is relative to it.
# PATH prefix ensures rustup's rustc is used, not Homebrew's (which lacks the wasm32 target).
cd crates/plinth-core && PATH="$HOME/.cargo/bin:$PATH" wasm-pack build --target web --out-dir ../../packages/web/plinth-js/wasm && cd ../..
```

## Running Tests

### Rust

```bash
cargo test -p plinth-core                  # all tests
cargo test -p plinth-core -- <test_name>   # single test
```

### JavaScript / TypeScript

```bash
pnpm -r test                               # all web packages
pnpm --filter @wirevice/plinth-js test              # plinth-js only
pnpm --filter @wirevice/plinth-hlsjs test           # plinth-hlsjs only
pnpm --filter @wirevice/plinth-shaka test           # plinth-shaka only
pnpm --filter @wirevice/plinth-dashjs test          # plinth-dashjs only
```

### Swift

```bash
# From packages/apple/plinth-apple/
swift test
```

### Android

```bash
./gradlew :plinth-android:test
./gradlew :plinth-media3:test
```

## Web Demo Server

The demo server bundles the TypeScript entry points and serves player demo pages.

```bash
pnpm --filter @wirevice/plinth-dev start
```

| URL | Player |
|---|---|
| http://localhost:3000 | Home |
| http://localhost:3000/hlsjs | HLS.js |
| http://localhost:3000/shaka | Shaka Player |
| http://localhost:3000/dashjs | dash.js |

The server also receives beacons at `POST http://localhost:3000/beacon` and logs them to the console.

## Building

### Rust core (native)

```bash
cargo build -p plinth-core
cargo build -p plinth-core --release
```

### Rust core (WebAssembly)

If you have Homebrew Rust installed alongside rustup, prefix the command to ensure rustup's toolchain is used (Homebrew Rust does not include the `wasm32-unknown-unknown` target):

```bash
cd crates/plinth-core && PATH="$HOME/.cargo/bin:$PATH" wasm-pack build --target web --out-dir ../../packages/web/plinth-js/wasm && cd ../..
```

### Apple XCFramework (iOS + macOS)

```bash
./scripts/build-xcframework.sh
```

### Android native libraries

```bash
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 build -p plinth-core --release
```

Output `.so` files land in `packages/android/plinth-android/src/main/jniLibs/`.
