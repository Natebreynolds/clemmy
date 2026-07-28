# Desktop release guide

This guide documents the repository's release inputs without publishing any
operator-specific account, certificate, or signing identity.

## Release channels

- macOS releases are signed, notarized, and stapled.
- Windows packaging produces an NSIS installer. Production Windows releases
  require a configured code-signing certificate and post-build Authenticode
  verification.
- Manual workflow runs create private candidate artifacts. Stable `v*` tags on
  the exact `main` commit publish a GitHub Release.

## Signing inputs

Local and GitHub-hosted releases use different certificate sources. Never place
real values in this repository or its documentation.

| Input | Where it is required | Purpose |
| --- | --- | --- |
| `APPLE_ID` | Local and GitHub macOS releases | Apple Developer account email |
| `APPLE_APP_PASSWORD` | Local and GitHub macOS releases | Apple app-specific password |
| `APPLE_TEAM_ID` | Local and GitHub macOS releases | Apple Developer team identifier |
| Developer ID Application identity | Local macOS releases | Certificate and private key installed in the current macOS Keychain |
| `CSC_LINK` | GitHub macOS releases | Base64-encoded Developer ID certificate (`.p12`) imported by the runner |
| `CSC_KEY_PASSWORD` | GitHub macOS releases | Password for the exported Developer ID certificate |
| `WINDOWS_CSC_LINK` | Required for production GitHub Windows releases; optional for private manual candidates | Base64-encoded Windows signing certificate |
| `WINDOWS_CSC_KEY_PASSWORD` | Required for production GitHub Windows releases; optional for private manual candidates | Password for the Windows signing certificate |

A private manual release candidate still exercises Windows packaging and may be
unsigned when the Windows signing inputs are absent. A production tag fails
before packaging unless both inputs are present. After packaging, the workflow
also verifies valid Authenticode signatures and signer certificates on both the
installer and packaged application before accepting or uploading the artifacts.

The only production exception is an explicit `[mac-only]` marker in the tagged
commit message. That marker skips the entire Windows job, so the published
release contains only the macOS assets. Use it deliberately for a release that
is intentionally unavailable on Windows, not to bypass a signing failure.

Use placeholders in examples:

```bash
export APPLE_ID="developer@example.com"
export APPLE_APP_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<apple-team-id>"
```

## Local macOS release

Install a Developer ID Application certificate and its private key in the
current Keychain. Put only the three Apple notarization values in
`~/.clementine-secrets/desktop.env`, then protect and load that file:

```bash
chmod 600 ~/.clementine-secrets/desktop.env
set -a
source ~/.clementine-secrets/desktop.env
set +a

npm --prefix apps/desktop run package:mac
```

Run the command from the repository root after installing the root, desktop,
mobile-web, and console-web dependencies. The release flow vendors and verifies
the pinned Recall, uv, and whisper.cpp assets; builds the desktop shell, daemon,
mobile surface, and console; creates Apple Silicon and Intel packages; signs,
notarizes, and staples them; and writes the artifacts under
`apps/desktop/release/`.

The release command performs code-signing, stapling, Gatekeeper, architecture,
packaged-runtime, and updater-feed checks.

The native-dependency gate is architecture-specific. Apple Silicon packages
must contain ARM64 `better-sqlite3`, Sharp/libvips, and ONNX Runtime payloads.
Intel packages must contain x86_64 `better-sqlite3` and Sharp/libvips; because
upstream ONNX Runtime no longer publishes a macOS x86_64 Node binding, the
Intel package omits that incompatible native module and uses the packaged WASM
backend for local semantic embeddings. Packaging runs a real 384-dimensional
embedding through the Intel executable and fails closed if that fallback does
not work.

To inspect the packaged application locations afterward:

```bash
find apps/desktop/release -maxdepth 2 -name Clementine.app -type d -print
```

## GitHub release

Configure the five required macOS secrets (`APPLE_ID`, `APPLE_APP_PASSWORD`,
`APPLE_TEAM_ID`, `CSC_LINK`, and `CSC_KEY_PASSWORD`) in GitHub Actions. The
workflow in `.github/workflows/release-desktop.yml` validates tests, type checks,
release assets, and evaluation gates before packaging. Production tags must be
stable SemVer tags on the exact `origin/main` commit. Production Windows signing
inputs are required unless the exact tagged commit deliberately opts into the
documented `[mac-only]` release exception. Private manual candidates may remain
unsigned so the full packaging path can still be rehearsed safely.

Do not paste credential values into workflow logs, issues, pull requests, or
release notes. If a credential is ever committed, revoke it immediately before
rewriting repository history.
