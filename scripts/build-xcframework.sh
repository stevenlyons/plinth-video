#!/usr/bin/env bash
# build-xcframework.sh
#
# Builds plinth-core as a static library for all supported Apple targets and
# packages the result as PlinthCoreFFI.xcframework.
#
# Targets:
#   iOS device        arm64-apple-ios
#   iOS simulator     arm64-apple-ios-sim  (Apple Silicon Mac)
#                     x86_64-apple-ios     (Intel Mac)
#   macOS             aarch64-apple-darwin (Apple Silicon)
#                     x86_64-apple-darwin  (Intel)
#
# Usage:
#   ./scripts/build-xcframework.sh [--release]
#
# The xcframework is written to:
#   PlinthCoreFFI.xcframework/   (repo root, gitignored)
#
# For use in Package.swift, replace the .target("PlinthCoreFFI") systemLibrary
# with a .binaryTarget pointing at this xcframework.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$REPO_ROOT/crates/plinth-core"
HEADER="$REPO_ROOT/packages/apple/plinth-apple/Sources/PlinthCoreFFI/plinth_core.h"
OUT="$REPO_ROOT/PlinthCoreFFI.xcframework"

PROFILE="debug"
CARGO_FLAGS=""
if [[ "${1:-}" == "--release" ]]; then
    PROFILE="release"
    CARGO_FLAGS="--release"
fi

# Require rustup-managed cargo (needed for cross-compilation targets)
CARGO="$HOME/.cargo/bin/cargo"
if [[ ! -x "$CARGO" ]]; then
    echo "error: rustup cargo not found at $CARGO" >&2
    exit 1
fi

echo "==> Building plinth-core (profile: $PROFILE)"

build_target() {
    local target="$1"
    echo "  -> $target"
    "$CARGO" build -p plinth-core --target "$target" $CARGO_FLAGS 2>&1
}

# ── Add required rustup targets ────────────────────────────────────────────────
TARGETS=(
    "aarch64-apple-ios"
    "aarch64-apple-ios-sim"
    "x86_64-apple-ios"
    "aarch64-apple-darwin"
    "x86_64-apple-darwin"
)

for t in "${TARGETS[@]}"; do
    "$HOME/.cargo/bin/rustup" target add "$t" --quiet
done

# ── Build each target ──────────────────────────────────────────────────────────
for t in "${TARGETS[@]}"; do
    build_target "$t"
done

# ── Helper: path to a compiled static lib ─────────────────────────────────────
lib_path() {
    echo "$REPO_ROOT/target/$1/$PROFILE/libplinth_core.a"
}

# ── Create fat libraries for multi-arch slices ────────────────────────────────
echo "==> Creating fat/universal libraries"

STAGING="$REPO_ROOT/target/xcframework-staging"
rm -rf "$STAGING"
mkdir -p \
    "$STAGING/ios-device" \
    "$STAGING/ios-simulator" \
    "$STAGING/macos"

# iOS device: arm64 only (single arch, lipo for consistency)
lipo -create \
    "$(lib_path aarch64-apple-ios)" \
    -output "$STAGING/ios-device/libplinth_core.a"

# iOS simulator: arm64-sim + x86_64
lipo -create \
    "$(lib_path aarch64-apple-ios-sim)" \
    "$(lib_path x86_64-apple-ios)" \
    -output "$STAGING/ios-simulator/libplinth_core.a"

# macOS: arm64 + x86_64
lipo -create \
    "$(lib_path aarch64-apple-darwin)" \
    "$(lib_path x86_64-apple-darwin)" \
    -output "$STAGING/macos/libplinth_core.a"

echo "==> Verifying fat lib archs"
for slice in ios-device ios-simulator macos; do
    echo "  $slice: $(lipo -archs "$STAGING/$slice/libplinth_core.a")"
done

# ── Package as XCFramework ─────────────────────────────────────────────────────
echo "==> Creating $OUT"
rm -rf "$OUT"

xcodebuild -create-xcframework \
    -library "$STAGING/ios-device/libplinth_core.a"    -headers "$(dirname "$HEADER")" \
    -library "$STAGING/ios-simulator/libplinth_core.a" -headers "$(dirname "$HEADER")" \
    -library "$STAGING/macos/libplinth_core.a"         -headers "$(dirname "$HEADER")" \
    -output "$OUT"

echo ""
echo "Done: $OUT"
echo ""
echo "To use in Package.swift, add a binary target:"
echo '  .binaryTarget(name: "PlinthCoreFFI", path: "../../PlinthCoreFFI.xcframework")'
