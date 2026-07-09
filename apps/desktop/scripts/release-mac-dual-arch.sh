#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

ELECTRON_VERSION="$(cd "$DESKTOP_DIR" && node -p "require('./node_modules/electron/package.json').version")"
REBUILD_BIN="$DESKTOP_DIR/node_modules/.bin/electron-rebuild"
BUILDER_BIN="$DESKTOP_DIR/node_modules/.bin/electron-builder"
SQLITE_NODE="$ROOT_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

restore_host_native() {
  echo "-> Restoring better-sqlite3 for host Node ABI"
  (cd "$ROOT_DIR" && npm rebuild better-sqlite3 >/dev/null 2>&1) || true
}

trap restore_host_native EXIT

verify_native_arch() {
  local arch="$1"
  local expected="$2"
  local actual
  actual="$(file "$SQLITE_NODE")"
  echo "   better-sqlite3 native: $actual"
  if [[ "$actual" != *"$expected"* ]]; then
    echo "::error::better-sqlite3 native module is not $expected for $arch build"
    exit 1
  fi
}

# Prove the vendored uv binary actually shipped INSIDE the built .app and is
# validly signed (hardened-runtime + Developer ID via electron-builder's
# osx-sign). This is the only honest check — smoke-markitdown.mjs resolves uv
# against the dev tree, so it passes green while the bundle is broken. A missing
# or unsigned uv = the file/image-conversion feature is dead on a fresh install,
# so fail the build loudly instead of shipping it.
verify_uv_packaged() {
  local arch="$1"
  local uvtarget="$2"
  local found=""
  # Presence is ALWAYS required. A valid Developer-ID signature is only required
  # on a real signed release; an unsigned local build (package:mac:unsigned sets
  # CSC_IDENTITY_AUTO_DISCOVERY=false / APPLE_NOTARIZE_SKIP) just confirms the
  # binary shipped.
  local require_signed="true"
  if [[ "${CSC_IDENTITY_AUTO_DISCOVERY:-}" == "false" || -n "${APPLE_NOTARIZE_SKIP:-}" ]]; then
    require_signed="false"
  fi
  while IFS= read -r app; do
    local uvbin="$app/Contents/Resources/daemon/vendor/uv/$uvtarget/uv"
    if [[ -f "$uvbin" ]]; then
      echo "   uv present: $uvbin"
      found="$uvbin"
      if codesign -v --strict "$uvbin" 2>/dev/null; then
        echo "   uv codesign: OK"
      elif [[ "$require_signed" == "true" ]]; then
        echo "::error::vendored uv for $arch ($uvtarget) is present but NOT validly signed: $uvbin"
        exit 1
      else
        echo "   uv codesign: skipped (unsigned build)"
      fi
    fi
  done < <(find "$DESKTOP_DIR/release" -maxdepth 2 -name "Clementine.app" -type d 2>/dev/null)
  if [[ -z "$found" ]]; then
    echo "::error::vendored uv ($uvtarget) is MISSING from the $arch .app — file/image conversion would be dead on fresh install"
    exit 1
  fi
}

verify_console_web_packaged() {
  local arch="$1"
  local found=""
  while IFS= read -r app; do
    local idx="$app/Contents/Resources/daemon/apps/console-web/dist/index.html"
    if [[ -f "$idx" ]]; then
      echo "   console-web present: $idx"
      found="$idx"
    fi
  done < <(find "$DESKTOP_DIR/release" -maxdepth 2 -name "Clementine.app" -type d 2>/dev/null)
  if [[ -z "$found" ]]; then
    echo "::error::console-web dist is MISSING from the $arch .app — the new desktop console would silently fall back to legacy on fresh install"
    exit 1
  fi
}

build_arch() {
  local arch="$1"
  local expected="$2"
  echo "-> Rebuilding daemon native modules for Electron $ELECTRON_VERSION ($arch)"
  (cd "$ROOT_DIR" && "$REBUILD_BIN" \
    --version "$ELECTRON_VERSION" \
    --module-dir . \
    --types prod \
    --force \
    --only better-sqlite3 \
    --arch "$arch")
  verify_native_arch "$arch" "$expected"

  echo "-> Building macOS artifacts ($arch)"
  (cd "$DESKTOP_DIR" && "$BUILDER_BIN" --mac dmg zip "--$arch" --publish never)

  local uvtarget
  case "$arch" in
    arm64) uvtarget="aarch64-apple-darwin" ;;
    x64)   uvtarget="x86_64-apple-darwin" ;;
    *) echo "::error::unknown arch $arch for uv verification"; exit 1 ;;
  esac
  echo "-> Verifying vendored uv shipped + signed ($arch)"
  verify_uv_packaged "$arch" "$uvtarget"

  echo "-> Verifying console-web bundle shipped ($arch)"
  verify_console_web_packaged "$arch"
}

echo "-> Building desktop shell"
(cd "$DESKTOP_DIR" && npm run build)

echo "-> Building daemon"
(cd "$ROOT_DIR" && npm run build)

echo "-> Building mobile web app"
(cd "$ROOT_DIR" && npm run build:mobile-web)

echo "-> Building console web app (new desktop UI)"
(cd "$ROOT_DIR" && npm run build:console-web)

# The release directory is an output cache, not source. Clean it before building
# so local releases cannot accidentally upload old Clementine-*.dmg/zip assets
# from a previous version alongside the new latest-mac.yml.
echo "-> Cleaning previous desktop release artifacts"
rm -rf "$DESKTOP_DIR/release"
mkdir -p "$DESKTOP_DIR/release"

# Vendor the uv runtime binaries BEFORE packaging — file/image conversion
# (markitdown) needs them inside the .app, and they're gitignored so they are
# NOT present in a fresh CI checkout. Without this, extraResources copies an
# empty dir and the shipped feature is dead on every machine.
echo "-> Vendoring uv runtime binaries (required for file/image conversion)"
(cd "$ROOT_DIR" && npm run vendor:uv)

build_arch arm64 arm64
build_arch x64 x86_64

echo "-> Verifying desktop release artifacts + updater feed"
RELEASE_VERSION="$(cd "$DESKTOP_DIR" && node -p "require('./package.json').version")"
(cd "$ROOT_DIR" && node scripts/verify-desktop-release-assets.mjs --dir apps/desktop/release --version "$RELEASE_VERSION")
