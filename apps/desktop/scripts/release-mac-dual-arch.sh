#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

ELECTRON_VERSION="$(cd "$DESKTOP_DIR" && node -p "require('./node_modules/electron/package.json').version")"
REBUILD_BIN="$DESKTOP_DIR/node_modules/.bin/electron-rebuild"
BUILDER_BIN="$DESKTOP_DIR/node_modules/.bin/electron-builder"
SQLITE_NODE="$ROOT_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
ARM64_UPDATE_FEED="$(mktemp "${TMPDIR:-/tmp}/clementine-latest-mac-arm64.XXXXXX")"

restore_host_native() {
  echo "-> Restoring better-sqlite3 for host Node ABI"
  (cd "$ROOT_DIR" && npm rebuild better-sqlite3 >/dev/null 2>&1) || true
}

cleanup() {
  rm -f "$ARM64_UPDATE_FEED"
  restore_host_native
}

trap cleanup EXIT

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

verify_whisper_packaged() {
  local arch="$1"
  local target="$2"
  local expected_arch="$3"
  local found=""
  while IFS= read -r app; do
    local binary="$app/Contents/Resources/daemon/vendor/whisper/$target/whisper-cli"
    local license="$app/Contents/Resources/daemon/vendor/whisper/$target/LICENSE.whisper.cpp"
    if [[ -f "$binary" ]]; then
      found="$binary"
      echo "   whisper.cpp present: $binary"
      [[ "$(file "$binary")" == *"$expected_arch"* ]] \
        || { echo "::error::vendored whisper.cpp for $arch has the wrong architecture: $(file "$binary")"; exit 1; }
      if is_signed_release; then
        codesign -v --strict "$binary" \
          || { echo "::error::vendored whisper.cpp for $arch is not validly signed: $binary"; exit 1; }
      else
        echo "   whisper.cpp codesign: skipped (unsigned build)"
      fi
      [[ -f "$license" ]] \
        || { echo "::error::whisper.cpp MIT license notice is missing: $license"; exit 1; }
      [[ "$(shasum -a 256 "$license" | awk '{print $1}')" == "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d" ]] \
        || { echo "::error::whisper.cpp license notice has an unexpected checksum: $license"; exit 1; }
    fi
  done < <(find "$DESKTOP_DIR/release" -maxdepth 2 -name "Clementine.app" -type d 2>/dev/null)
  if [[ -z "$found" ]]; then
    echo "::error::vendored whisper.cpp ($target) is MISSING from the $arch app — local meeting transcription would be unavailable"
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

verify_notch_helper_packaged() {
  local arch="$1"
  local expected_arch="$2"
  local found=""
  while IFS= read -r app; do
    local helper="$app/Contents/Resources/notch-helper/ClementineNotchHelper"
    if [[ -f "$helper" ]]; then
      found="$helper"
      echo "   notch click helper present: $helper"
      [[ -x "$helper" ]] \
        || { echo "::error::packaged notch helper is not executable: $helper"; exit 1; }
      [[ "$(file "$helper")" == *"$expected_arch"* ]] \
        || { echo "::error::notch helper for $arch has the wrong architecture: $(file "$helper")"; exit 1; }
      /usr/bin/lipo "$helper" -verify_arch arm64 x86_64 \
        || { echo "::error::packaged notch helper is not universal arm64+x86_64: $helper"; exit 1; }
      local probe
      probe="$("$helper" --probe)"
      NOTCH_HELPER_PROBE="$probe" node --input-type=module -e \
        'const value=JSON.parse(process.env.NOTCH_HELPER_PROBE); if(value?.type!=="probe"||value?.protocol!==1) process.exit(1)' \
        || { echo "::error::packaged notch helper failed its protocol probe: $probe"; exit 1; }
      if is_signed_release; then
        codesign -v --strict "$helper" \
          || { echo "::error::packaged notch helper is not validly signed: $helper"; exit 1; }
        local signature
        signature="$(codesign -dvvv "$helper" 2>&1)"
        [[ "$signature" == *"TeamIdentifier=${APPLE_TEAM_ID}"* ]] \
          || { echo "::error::packaged notch helper has an unexpected signing team: $helper"; exit 1; }
        [[ "$signature" == *"flags="*"runtime"* ]] \
          || { echo "::error::packaged notch helper is missing hardened runtime: $helper"; exit 1; }
      else
        echo "   notch helper codesign: skipped (unsigned build)"
      fi
    fi
  done < <(find "$DESKTOP_DIR/release" -maxdepth 2 -name "Clementine.app" -type d 2>/dev/null)
  if [[ -z "$found" ]]; then
    echo "::error::native notch helper is MISSING from the $arch app — the top-edge dog would not accept clicks"
    exit 1
  fi
}

is_signed_release() {
  [[ "${CSC_IDENTITY_AUTO_DISCOVERY:-}" != "false" && "${APPLE_NOTARIZE_SKIP:-}" != "true" ]]
}

# Recall publishes an ARM64-only macOS recorder even though Clementine also
# ships an Intel build. Prove the Apple Silicon artifact contains the pinned
# SDK plus correctly-architected native binaries, and prove the Intel runtime
# reports Recall as unsupported before it can import/launch those binaries.
verify_recall_packaged() {
  local arch="$1"
  local app="$2"
  local executable="$3"
  local resources="$app/Contents/Resources"
  local recall_root="$resources/app.asar.unpacked/node_modules/@recallai/desktop-sdk"
  local expected_version
  local runtime_supported
  expected_version="$(cd "$DESKTOP_DIR" && node -p "require('./package.json').optionalDependencies['@recallai/desktop-sdk']")"

  runtime_supported="$(
    cd "$resources"
    ELECTRON_RUN_AS_NODE=1 "$executable" --input-type=module -e \
      "const m=await import('./app.asar/dist/recall-capture.js'); process.stdout.write(String(m.getRecallPlatformSupport().supported));"
  )"

  if [[ "$arch" == "arm64" ]]; then
    [[ "$runtime_supported" == "true" ]] \
      || { echo "::error::arm64 app does not expose Recall meeting capture as supported"; exit 1; }
    [[ -f "$recall_root/package.json" ]] \
      || { echo "::error::Recall Desktop SDK is missing from the arm64 app"; exit 1; }
    local actual_version
    actual_version="$(node -p "require('$recall_root/package.json').version")"
    [[ "$actual_version" == "$expected_version" ]] \
      || { echo "::error::packaged Recall SDK $actual_version != pinned $expected_version"; exit 1; }
    local actual_commit
    actual_commit="$(node -p "require('$recall_root/package.json').commit_sha")"
    [[ "$actual_commit" == "90d670e842200a4d546cbe36cc0b9c48fbe6a204" ]] \
      || { echo "::error::packaged Recall SDK has unexpected commit $actual_commit"; exit 1; }
    RECALL_ROOT="$recall_root" node --input-type=module -e '
      import fs from "node:fs";
      import path from "node:path";
      const manifest = JSON.parse(fs.readFileSync(path.join(process.env.RECALL_ROOT, "clementine-native-manifest.json"), "utf8"));
      if (manifest.sdkVersion !== "2.0.25"
        || manifest.sdkCommit !== "90d670e842200a4d546cbe36cc0b9c48fbe6a204"
        || manifest.platform !== "darwin"
        || manifest.archiveBytes !== 50971984
        || manifest.archiveSha256 !== "e3125c49cdf6d54593e6334024df2ecbed99e0c6b1d2e410a4187ab19421433b") {
        throw new Error(`packaged Recall native provenance is invalid: ${JSON.stringify(manifest)}`);
      }
    '

    local native
    for native in \
      "$recall_root/desktop_sdk_macos_exe" \
      "$recall_root/Frameworks/libui_recorder.dylib" \
      "$recall_root/Frameworks/liblibbot_desktop_rs.dylib"; do
      [[ -f "$native" ]] || { echo "::error::Recall native binary is missing: $native"; exit 1; }
      [[ "$(file "$native")" == *"arm64"* ]] \
        || { echo "::error::Recall native binary is not arm64: $native"; exit 1; }
    done
    echo "   Recall SDK: $actual_version (arm64 native capture verified)"
  else
    [[ "$runtime_supported" == "false" ]] \
      || { echo "::error::Intel app incorrectly exposes ARM64-only Recall capture as supported"; exit 1; }
    echo "   Recall SDK: correctly reported unsupported on Intel Mac"
  fi
}

verify_packaged_app() {
  local arch="$1"
  local expected_arch="$2"
  local expected_desktop_version
  local expected_daemon_version
  local app=""
  expected_desktop_version="$(cd "$DESKTOP_DIR" && node -p "require('./package.json').version")"
  expected_daemon_version="$(cd "$ROOT_DIR" && node -p "require('./package.json').version")"

  while IFS= read -r candidate; do
    app="$candidate"
    break
  done < <(find "$DESKTOP_DIR/release" -maxdepth 2 -name "Clementine.app" -type d 2>/dev/null \
    | while IFS= read -r candidate; do
        file "$candidate/Contents/MacOS/Clementine" | grep -q "$expected_arch" && printf '%s\n' "$candidate"
      done)

  [[ -n "$app" ]] || { echo "::error::packaged $arch app was not found"; exit 1; }
  local executable="$app/Contents/MacOS/Clementine"
  local daemon="$app/Contents/Resources/daemon"
  local bundle_version
  local daemon_version
  bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
  daemon_version="$(node -p "require('$daemon/package.json').version")"
  [[ "$bundle_version" == "$expected_desktop_version" ]] \
    || { echo "::error::$arch bundle version $bundle_version != $expected_desktop_version"; exit 1; }
  [[ "$daemon_version" == "$expected_daemon_version" ]] \
    || { echo "::error::$arch daemon version $daemon_version != $expected_daemon_version"; exit 1; }
  [[ "$(file "$executable")" == *"$expected_arch"* ]] \
    || { echo "::error::$arch main executable has the wrong architecture"; exit 1; }
  [[ "$(file "$daemon/node_modules/better-sqlite3/build/Release/better_sqlite3.node")" == *"$expected_arch"* ]] \
    || { echo "::error::$arch packaged better-sqlite3 has the wrong architecture"; exit 1; }

  verify_recall_packaged "$arch" "$app" "$executable"

  if is_signed_release; then
    codesign --verify --deep --strict --verbose=2 "$app"
    xcrun stapler validate "$app"
    spctl --assess --type execute --verbose=4 "$app"

    local app_signature
    app_signature="$(codesign -dvvv "$app" 2>&1)"
    [[ "$app_signature" == *"TeamIdentifier=${APPLE_TEAM_ID}"* ]] \
      || { echo "::error::$arch app has an unexpected signing team"; exit 1; }

    local macho_manifest
    macho_manifest="$(mktemp "${TMPDIR:-/tmp}/clementine-macho-$arch.XXXXXX")"
    find "$app" -type f -print0 | xargs -0 file > "$macho_manifest"
    while IFS= read -r entry; do
      [[ "$entry" == *": Mach-O "* ]] || continue
      local binary="${entry%%: Mach-O *}"
      local signature
      signature="$(codesign -dvv "$binary" 2>&1)"
      if [[ "$signature" != *"flags="*"runtime"* ]]; then
        echo "::error::$arch Mach-O is missing hardened runtime: $binary"
        rm -f "$macho_manifest"
        exit 1
      fi
    done < "$macho_manifest"
    rm -f "$macho_manifest"
  fi

  # Exercise the exact packaged discovery module from the cwd used by the
  # desktop daemon. Boot discovery must remain stat-only and preserve the seal.
  local probe_home
  probe_home="$(mktemp -d "${TMPDIR:-/tmp}/clementine-packaged-probe-$arch.XXXXXX")"
  (
    cd "$daemon"
    CLEMENTINE_HOME="$probe_home" ELECTRON_RUN_AS_NODE=1 "$executable" \
      --input-type=module \
      -e "const m=await import('./dist/runtime/cli-discovery.js'); await m.fullScan({concurrency:1});"
  )
  rm -rf "$probe_home"
  if is_signed_release; then
    codesign --verify --deep --strict --verbose=2 "$app"
  fi
}

verify_dmg_artifacts() {
  is_signed_release || return 0
  local found=0
  while IFS= read -r dmg; do
    found=1
    codesign --verify --verbose=2 "$dmg"
    xcrun stapler validate "$dmg"
    spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
  done < <(find "$DESKTOP_DIR/release" -maxdepth 1 -name 'Clementine-*.dmg' -type f -print)
  (( found == 1 )) || { echo "::error::no packaged DMGs found"; exit 1; }
}

build_arch() {
  local arch="$1"
  local expected="$2"
  local builder_args=(--mac dmg zip "--$arch" --publish never)

  # The desktop config pins the production Developer ID. Override it explicitly
  # for local unsigned rehearsals; disabling auto-discovery alone does not win
  # over a configured identity.
  if ! is_signed_release; then
    builder_args+=(--config.mac.identity=null)
  fi

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
  (cd "$DESKTOP_DIR" && "$BUILDER_BIN" "${builder_args[@]}")

  # Notarization/stapling mutates the DMG after electron-builder generated its
  # first blockmap and feed hash. Rebuild both from the final distributable.
  if is_signed_release; then
    echo "-> Refreshing updater metadata after DMG notarization ($arch)"
    (cd "$ROOT_DIR" && node scripts/refresh-notarized-dmg-metadata.mjs \
      --feed apps/desktop/release/latest-mac.yml)
  fi

  local uvtarget
  case "$arch" in
    arm64) uvtarget="aarch64-apple-darwin" ;;
    x64)   uvtarget="x86_64-apple-darwin" ;;
    *) echo "::error::unknown arch $arch for uv verification"; exit 1 ;;
  esac
  echo "-> Verifying vendored uv shipped + signed ($arch)"
  verify_uv_packaged "$arch" "$uvtarget"

  local whispertarget
  case "$arch" in
    arm64) whispertarget="aarch64-apple-darwin" ;;
    x64)   whispertarget="x86_64-apple-darwin" ;;
    *) echo "::error::unknown arch $arch for whisper.cpp verification"; exit 1 ;;
  esac
  echo "-> Verifying vendored whisper.cpp shipped + signed ($arch)"
  verify_whisper_packaged "$arch" "$whispertarget" "$expected"

  echo "-> Verifying console-web bundle shipped ($arch)"
  verify_console_web_packaged "$arch"

  echo "-> Verifying native notch click helper shipped + signed ($arch)"
  verify_notch_helper_packaged "$arch" "$expected"

  echo "-> Verifying packaged app identity, architecture, and stat-only boot scan ($arch)"
  verify_packaged_app "$arch" "$expected"
}

echo "-> Installing checksum-pinned Recall Desktop SDK native payload"
(cd "$DESKTOP_DIR" && npm run vendor:recall-native -- --platform darwin)

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

# Local transcription executes whisper.cpp directly from the sealed app. Build
# both Intel and Apple Silicon targets before the first electron-builder pass so
# every extraResources source exists in a clean release checkout.
echo "-> Building pinned whisper.cpp runtimes (required for local meeting transcription)"
if is_signed_release; then
  (cd "$ROOT_DIR" && npm run vendor:whisper -- --target aarch64-apple-darwin --force)
  (cd "$ROOT_DIR" && npm run vendor:whisper -- --target x86_64-apple-darwin --force)
elif [[ "${WHISPER_ALLOW_VALIDATED_CACHE:-}" == "true" ]]; then
  echo "   unsigned rehearsal: adopting cache only after provenance, license, architecture, version, size, and SHA-256 validation"
  (cd "$ROOT_DIR" && npm run vendor:whisper -- --target aarch64-apple-darwin --adopt-validated-cache)
  (cd "$ROOT_DIR" && npm run vendor:whisper -- --target x86_64-apple-darwin --adopt-validated-cache)
else
  (cd "$ROOT_DIR" && npm run vendor:whisper -- --target aarch64-apple-darwin --force)
  (cd "$ROOT_DIR" && npm run vendor:whisper -- --target x86_64-apple-darwin --force)
fi

build_arch arm64 arm64
cp "$DESKTOP_DIR/release/latest-mac.yml" "$ARM64_UPDATE_FEED"
build_arch x64 x86_64

echo "-> Merging arm64 + x64 updater metadata"
(cd "$ROOT_DIR" && node scripts/merge-mac-update-feeds.mjs \
  --arm64 "$ARM64_UPDATE_FEED" \
  --x64 apps/desktop/release/latest-mac.yml \
  --output apps/desktop/release/latest-mac.yml)

echo "-> Verifying desktop release artifacts + updater feed"
RELEASE_VERSION="$(cd "$DESKTOP_DIR" && node -p "require('./package.json').version")"
(cd "$ROOT_DIR" && node scripts/verify-desktop-release-assets.mjs --dir apps/desktop/release --version "$RELEASE_VERSION")

echo "-> Verifying signed + stapled DMG containers"
verify_dmg_artifacts
