# Feature PRD: Android Framework & Media3 Integration

## Overview

Add Android platform support to plinth-video by implementing two new layers following the established three-layer architecture:

- **`plinth-android`** — Layer 2 Kotlin platform framework wrapping the Rust core via JNI
- **`plinth-media3`** — Layer 3 Media3 player integration

This mirrors the Swift/AVPlayer implementation (`plinth-swift` + `plinth-avplayer`) and brings the same QoE measurement capability to Android applications using [Jetpack Media3](https://developer.android.com/media/media3) (the successor to ExoPlayer).

---

## Goals

- Provide a production-quality Android SDK that application developers can integrate in a few lines of Kotlin
- Reuse the Rust core without modification — all state machine, metrics, and beacon logic stays in `plinth-core`
- Match the public API shape and behavior already established in the Swift and JS implementations
- Ship a working Android sample app that demonstrates end-to-end beacon collection
