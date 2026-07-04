# Signing and release credentials

The Clementine desktop app ships through GitHub Releases. macOS is
signed + notarized today; Windows packaging is wired through GitHub
Actions and can build an unsigned NSIS installer until Windows signing
credentials are added.

## What signing buys you

- **Signed**: macOS Gatekeeper recognizes the developer behind the
  app. Without signing, users get a "downloaded from the internet —
  cannot be opened" warning and need to right-click → Open.
- **Notarized**: Apple's automated malware check has cleared the app.
  Without notarization, even signed apps trigger a "could not verify"
  warning on first launch.
- **Stapled**: the notarization ticket is embedded in the app, so the
  Gatekeeper check works offline.
- **Windows code signing**: Windows can verify the publisher on the
  `.exe` installer and app binaries. A new publisher may still hit
  SmartScreen warnings until the signing identity builds reputation.

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

## GitHub Actions release

The workflow at `.github/workflows/release-desktop.yml` builds and
publishes desktop artifacts whenever a tag matching `v*` is pushed:

- `release-mac`: signed + notarized `.dmg` and `.zip`.
- `release-windows`: NSIS `.exe` installer. It is unsigned unless the
  Windows signing secrets below are configured.

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

## Windows releases

The repo now has a Windows packaging path, but this machine cannot run
the final installer locally. The practical test path is GitHub Actions:

1. Push a semver tag such as `v0.12.51`, or run the release workflow
   manually and select a semver tag as the ref.
2. Let the `release-windows` job run on `windows-latest`.
3. Download the `.exe` from the GitHub Release and test it on a real
   Windows machine or VM.

Without Windows signing secrets, the job should still produce an
unsigned test installer. That is good enough for internal boot testing,
but not ideal for public distribution.

### Current supported signing path: PFX certificate

The current workflow is wired for electron-builder's ordinary PFX/P12
code-signing flow. Add these GitHub Actions secrets when ready:

| Name | Value |
| ---- | ----- |
| `WINDOWS_CSC_LINK` | base64-encoded Windows code-signing `.pfx` / `.p12` |
| `WINDOWS_CSC_KEY_PASSWORD` | password for that `.pfx` / `.p12` private key |

To create the base64 value on macOS:

```bash
base64 -i windows-codesign.pfx | pbcopy
```

To create it on Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\windows-codesign.pfx")) | Set-Clipboard
```

The password is not generated by GitHub. It is the export password you
choose when creating/exporting the `.pfx`. Store it only as the GitHub
secret value.

Relevant electron-builder docs:

- https://www.electron.build/docs/features/code-signing/
- https://www.electron.build/docs/features/code-signing/code-signing-win/

### Later option: Azure Artifact Signing

Logging into Azure is not enough by itself. Azure Artifact Signing
(formerly Trusted Signing) is a different signing path from the PFX
flow above, and it is not wired into this repo yet.

To use Azure later, we would need:

1. A paid Azure subscription that is eligible for Artifact Signing.
2. An Artifact Signing account.
3. Completed identity validation.
4. A certificate profile.
5. A CI identity with the `Artifact Signing Certificate Profile Signer`
   role.
6. GitHub secrets for Azure auth and signing metadata, for example:
   `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
   `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_CODE_SIGNING_NAME`, and
   `AZURE_CERT_PROFILE_NAME`.
7. A workflow change to install/use the Azure signing tooling or action
   after the Windows build produces the installer.

Microsoft's setup docs are here:

- https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations

Until that work is done, use the unsigned Windows installer for smoke
testing or the PFX path for signed public releases.

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
