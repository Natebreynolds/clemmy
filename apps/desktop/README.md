# Clementine Desktop

`apps/desktop` is Clementine's native Electron shell. It supervises the local daemon, presents the daemon-served console as a desktop app, and owns the operating-system integrations that do not belong in the web renderer.

For the product overview, installation path, privacy boundaries, and platform status, start with the [root README](../../README.md). Security-sensitive changes must also follow the [security policy](../../SECURITY.md).

## Responsibilities

The Electron main process owns:

- first-run setup, splash, main, log, and native notch windows;
- daemon discovery, startup, readiness probing, liveness checks, restart backoff, log capture, and clean shutdown;
- selection of an available loopback port and propagation of the resulting daemon URL;
- tray controls, native notifications, global shortcuts, and application updates;
- narrow, sender-validated IPC bridges for setup, credentials, preferences, permissions, and meeting capture;
- native media permissions and the Recall Desktop SDK lifecycle;
- macOS notch positioning, preferences, meeting prompts, and recording controls.

The renderer is the React console served by the daemon. It does not choose a daemon port and should not hardcode a dashboard origin. The supervisor selects an available loopback address, starts the daemon with that configuration, waits for readiness, bootstraps a local dashboard session, and then loads the resulting `/console` URL.

```text
Electron main process
├── setup / splash / tray / updater / native windows
├── daemon supervisor ── child process on a selected loopback URL
├── validated preload + IPC bridges
└── native permissions / Recall / macOS notch
                         │
                         └── daemon-served React console
```

On macOS, closing the main window leaves the supervised daemon running; quitting Clementine stops the child process after a graceful shutdown window. On Windows and Linux, closing the final window quits the app and stops the child process.

## Development setup

Use Node.js `>=22.15.0`. Install the root and nested dependencies from the repository root:

```bash
npm ci
npm --prefix apps/console-web ci
npm --prefix apps/mobile-web ci
npm --prefix apps/desktop ci
```

Build the daemon and web surfaces before launching the compiled Electron app:

```bash
npm run build
npm run build:console-web
npm run build:mobile-web
npm --prefix apps/desktop run build
npm --prefix apps/desktop start
```

When changing only desktop TypeScript, the normal contributor loop is:

```bash
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build
npm --prefix apps/desktop start
```

The desktop `build` compiles the main process and both preload entries, then renames the compiled preloads to `.cjs` for Electron. Rebuild whenever a preload or IPC contract changes.

Run the affected tests from the repository root:

```bash
npm test
npm run test:release-assets
```

## Credentials

Normal credential writes go to:

```text
~/.clementine-next/state/secrets-vault.json
```

The file vault is plaintext JSON written atomically. On macOS and other POSIX systems, Clementine writes it with owner-only `0600` permissions. On Windows, it lives in per-user app state and relies on the operating-system profile and ACL boundary. It is **not encrypted at rest**. The runtime reads the file vault first and can fall back to explicitly configured environment variables.

macOS Keychain is not the canonical store. Keychain support remains for importing credentials written by older Clementine versions and for explicit repair or reset operations. Passive launch and dashboard health checks avoid Keychain reads so they do not raise unexpected macOS authorization prompts.

Raw credential values must not cross into the dashboard renderer, logs, notifications, or error messages. New credential work should use the existing registry and file-vault abstractions rather than adding another storage path.

## Notch and meeting capture boundaries

The notch window is a macOS-only surface. It sends dictated requests to the local agent, follows live task and approval status from the shared activity snapshot, and provides native Recall meeting prompts and recording controls.

Recall native support is narrower than Clementine desktop support:

| Platform | Recall Desktop SDK boundary |
| --- | --- |
| Apple Silicon macOS | Supported native Recall capture path. |
| Intel macOS | Clementine runs, but Recall capture is unavailable because Recall's macOS recorder is ARM64-only. |
| x64 Windows | Recall's native runtime is supported, but the macOS notch and Mac-specific permission flows are not available. |
| Linux | Native Recall capture is not packaged. |

Recall capture is optional and uploads media and transcript data to Recall under the user's selected retention policy. Do not describe it as an offline or entirely local recording path. Clementine also has a separate local in-person recording and transcription path; keep the two boundaries distinct in code and copy.

Native capture work must preserve the existing safety properties: platform checks before SDK import, explicit permission state, one authoritative active recording, visible Stop controls, sanitized renderer payloads, and safe shutdown/reconciliation.

## Packaging and releases

Useful package commands are defined in [package.json](package.json):

```bash
# Signed/notarized dual-architecture macOS release flow
npm --prefix apps/desktop run package:mac

# Local unsigned macOS packaging for controlled smoke testing
npm --prefix apps/desktop run package:mac:unsigned

# Windows NSIS packaging; run on Windows
npm --prefix apps/desktop run package:win
```

macOS production artifacts are signed, notarized, and stapled by the release flow. Windows artifacts may be unsigned unless the Windows signing secrets are configured. Do not place signing identities, account emails, certificate fingerprints, passwords, or encoded certificates in this repository.

See the [desktop release guide](../../docs/guides/desktop-releases.md) for the supported local and GitHub Actions release workflow.

## Review checklist

Before requesting review for desktop changes, verify the relevant items:

- the daemon starts on a selected loopback URL and the renderer loads without a hardcoded port;
- first-run and returning-user paths both reach the console;
- preload APIs remain narrow and IPC senders are validated;
- active meeting capture cannot lose its visible Stop path;
- unsupported Recall platforms fail clearly before native SDK loading;
- no raw secret, meeting identifier, transcript, or local absolute path reaches renderer-facing errors;
- typecheck, desktop build, focused tests, and applicable release-asset tests pass.
