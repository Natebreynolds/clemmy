# Signing and notarization

The Clementine desktop app is shipped as a signed + notarized macOS
`.dmg`. This document covers the one-time setup, the local release
workflow, and the GitHub Actions release workflow.

## What signing buys you

- **Signed**: macOS Gatekeeper recognizes the developer behind the
  app. Without signing, users get a "downloaded from the internet —
  cannot be opened" warning and need to right-click → Open.
- **Notarized**: Apple's automated malware check has cleared the app.
  Without notarization, even signed apps trigger a "could not verify"
  warning on first launch.
- **Stapled**: the notarization ticket is embedded in the app, so the
  Gatekeeper check works offline.

## Apple credentials (one-time)

You need three things, all stored in `~/.clementine-secrets/desktop.env`
(NOT committed):

```bash
export APPLE_ID="natebreynolds@icloud.com"      # Developer Program account
export APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx" # app-specific password
export APPLE_TEAM_ID="4AR3Y8XD72"               # 10-char Team ID
```

The Developer ID Application certificate must live in your local
macOS Keychain. To check:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

You should see:

```
1) 38F5E5E621BF68972C1AFA48FF73C375BD11EF0D "Developer ID Application: Nathan Reynolds (4AR3Y8XD72)"
```

## Local release

From the repo root:

```bash
cd apps/desktop
./scripts/release-local.sh
```

This:
1. Builds the desktop TypeScript (`apps/desktop/dist/`)
2. Builds the daemon (parent project `dist/`)
3. Runs `electron-builder --mac`, which:
   - Signs with the Developer ID Application cert from your keychain
   - Calls the `afterSign` hook (`build/notarize.cjs`)
   - Uploads the signed `.app` to Apple's notarytool service
   - Waits for approval (30 sec – 10 min depending on Apple's queue)
   - Staples the ticket to the `.app`
   - Packages into `.dmg` + `.zip` for both arm64 and x64

Output lands in `apps/desktop/release/`.

To verify the result is properly signed + notarized:

```bash
spctl --assess --type execute --verbose release/Clementine.app
# Should print:  release/Clementine.app: accepted
# source=Notarized Developer ID
```

## GitHub Actions release (one-line `curl` install)

The workflow at `.github/workflows/release-desktop.yml` builds + signs
+ notarizes + publishes to GitHub Releases whenever a tag matching
`v*` is pushed.

### Repository secrets to set

In GitHub: Settings → Secrets and variables → Actions → New
repository secret. Add:

| Name | Value |
| ---- | ----- |
| `APPLE_ID` | `natebreynolds@icloud.com` |
| `APPLE_APP_PASSWORD` | the 16-char app-specific password |
| `APPLE_TEAM_ID` | `4AR3Y8XD72` |
| `CSC_LINK` | base64-encoded `.p12` (see below) |
| `CSC_KEY_PASSWORD` | password you set when exporting the `.p12` |

### Exporting the certificate as `.p12`

GitHub runners don't have your keychain, so we export the cert once
and pass it as a secret.

1. Open **Keychain Access** on macOS.
2. In the search box, type `Developer ID Application`.
3. Right-click the entry **"Developer ID Application: Nathan Reynolds
   (4AR3Y8XD72)"** → **Export…**
4. Choose **Personal Information Exchange (.p12)** as the format. Save
   to e.g. `~/Desktop/developer-id.p12`.
5. macOS prompts for an export password — pick a strong one (e.g. via
   `openssl rand -base64 24`). This becomes `CSC_KEY_PASSWORD`.
6. macOS will then ask for your login password to confirm access.
7. Base64-encode the `.p12` for the `CSC_LINK` secret:

   ```bash
   base64 -i ~/Desktop/developer-id.p12 | pbcopy
   ```

   That's now on your clipboard — paste it as the value of `CSC_LINK`.
8. **Delete the .p12 from disk** after the secret is set:

   ```bash
   srm ~/Desktop/developer-id.p12 || rm ~/Desktop/developer-id.p12
   ```

### Cutting a release

```bash
# From the repo root
git tag v0.1.0
git push origin v0.1.0
```

The Action runs, builds + signs + notarizes, and uploads
`Clementine-0.1.0-arm64.dmg` + `Clementine-0.1.0-x64.dmg` (plus zips)
to a new GitHub Release at
`https://github.com/Natebreynolds/clemmy/releases/tag/v0.1.0`.

The `install.sh` at the repo root pulls from there:

```bash
curl -fsSL https://raw.githubusercontent.com/Natebreynolds/clemmy/main/install.sh | bash
```

## Troubleshooting

### "skipping notarization — missing APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID"

Either the secrets file doesn't exist, isn't being sourced, or the
env vars aren't named correctly. The `release-local.sh` script sources
`~/.clementine-secrets/desktop.env` automatically.

### "Failed to upload to notary service: HTTP error 401"

Wrong app-specific password, or the password was revoked. Generate a
new one at [appleid.apple.com](https://appleid.apple.com) and update
the secrets file (and the GitHub secret).

### "No identity found for signing"

Either the Developer ID Application cert isn't in your keychain, or
electron-builder isn't finding it. Check with:

```bash
security find-identity -v -p codesigning
```

If empty: download the cert from
[developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates/list)
and double-click to import.

### Stuck on notarization for >15 minutes

Sometimes Apple's queue is slow. Check status directly:

```bash
xcrun notarytool history \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --team-id "$APPLE_TEAM_ID"
```

You can also `--log` a specific submission ID for detailed feedback.
