#!/usr/bin/env bash
# release-npm.sh
#
# Builds, versions, and publishes all @wirevice web packages to npm.
#
# Usage:
#   ./scripts/release-npm.sh <patch|minor|major>
#
# The script:
#   1. Validates the working tree is clean
#   2. Compiles plinth-core to WebAssembly via wasm-pack
#   3. Runs all web tests
#   4. Bumps versions across all packages with pnpm version
#   5. Builds each package
#   6. Publishes to npm
#   7. Commits the version bump and creates a git tag

set -euo pipefail

RELEASE_TYPE="${1:-}"
PACKAGES_DIR="packages/web"
PACKAGES=(plinth-js plinth-hlsjs plinth-shaka plinth-dashjs)

# ── Validate arguments ────────────────────────────────────────────────────────

if [[ -z "$RELEASE_TYPE" ]]; then
  echo "Usage: $0 <patch|minor|major>" >&2
  exit 1
fi

if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Error: release type must be patch, minor, or major (got: $RELEASE_TYPE)" >&2
  exit 1
fi

# ── Working tree must be clean ────────────────────────────────────────────────

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes. Commit or stash them first." >&2
  exit 1
fi

# ── Build Wasm ────────────────────────────────────────────────────────────────

echo "==> Building plinth-core Wasm..."
(cd crates/plinth-core && PATH="$HOME/.cargo/bin:$PATH" wasm-pack build --target web --out-dir ../../packages/web/plinth-js/wasm)

# ── Run tests ─────────────────────────────────────────────────────────────────

echo "==> Running web tests..."
pnpm -r test

# ── Bump versions ─────────────────────────────────────────────────────────────

echo "==> Bumping $RELEASE_TYPE version..."
for pkg in "${PACKAGES[@]}"; do
  (cd "$PACKAGES_DIR/$pkg" && pnpm version "$RELEASE_TYPE" --no-git-tag-version)
done

# Read the new version from plinth-js (all packages are versioned in lockstep).
NEW_VERSION=$(node -p "require('./$PACKAGES_DIR/plinth-js/package.json').version")
echo "    New version: $NEW_VERSION"

# ── Build ─────────────────────────────────────────────────────────────────────

echo "==> Building packages..."
for pkg in "${PACKAGES[@]}"; do
  echo "    Building $pkg..."
  (cd "$PACKAGES_DIR/$pkg" && pnpm build)
done

# ── npm login ─────────────────────────────────────────────────────────────────

echo "==> Logging in to npm..."
pnpm login

# ── Publish ───────────────────────────────────────────────────────────────────

echo "==> Publishing to npm..."
for pkg in "${PACKAGES[@]}"; do
  echo "    Publishing @wirevice/$pkg@$NEW_VERSION..."
  (cd "$PACKAGES_DIR/$pkg" && pnpm publish --no-git-checks)
done

# ── Commit and tag ────────────────────────────────────────────────────────────

echo "==> Committing version bump..."
git add $(printf "$PACKAGES_DIR/%s/package.json " "${PACKAGES[@]}")
git commit -m "chore: release npm packages v$NEW_VERSION"
git tag "npm/v$NEW_VERSION"

echo ""
echo "Released @wirevice/* v$NEW_VERSION"
echo "Push with: git push && git push origin npm/v$NEW_VERSION"
