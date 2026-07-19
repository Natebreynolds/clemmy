# Desktop release guide

This guide documents the repository's release inputs without publishing any
operator-specific account, certificate, or signing identity.

## Release channels

- macOS releases are signed, notarized, and stapled.
- Windows packaging produces an NSIS installer. Public distribution should use
  a configured Windows code-signing certificate.
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
| `WINDOWS_CSC_LINK` | Optional for GitHub Windows releases | Base64-encoded Windows signing certificate |
| `WINDOWS_CSC_KEY_PASSWORD` | Optional for GitHub Windows releases | Password for the Windows signing certificate |

Windows packaging still produces artifacts when the optional Windows signing
inputs are absent, but those artifacts are unsigned.

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
packaged-runtime, and updater-feed checks. To inspect the packaged application
locations afterward:

```bash
find apps/desktop/release -maxdepth 2 -name Clementine.app -type d -print
```

## GitHub release

Configure the five required macOS secrets (`APPLE_ID`, `APPLE_APP_PASSWORD`,
`APPLE_TEAM_ID`, `CSC_LINK`, and `CSC_KEY_PASSWORD`) in GitHub Actions. The
workflow in `.github/workflows/release-desktop.yml` validates tests, type checks,
release assets, and evaluation gates before packaging. Production tags must be
stable SemVer tags on the exact `origin/main` commit. Windows certificate
secrets remain optional; without them, the Windows job produces unsigned
artifacts.

Do not paste credential values into workflow logs, issues, pull requests, or
release notes. If a credential is ever committed, revoke it immediately before
rewriting repository history.
