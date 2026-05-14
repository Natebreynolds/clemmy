# Clementine Desktop

The native Electron shell. Wraps the existing Clementine daemon, opens
the local dashboard as the first-run experience, and brings the agent
into a normal app surface (tray, notifications, log viewer, restarts).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Electron App (this package)                              │
│   - Main process (src/main.ts)                           │
│       • Daemon supervisor (spawn / restart / log tail)   │
│       • Splash window during boot                        │
│       • Tray icon + menu                                 │
│       • Native notifications                             │
│       • IPC bridge (Keychain access via SecretStore)     │
│   - Preload (src/preload.ts) — narrow window.clemmy API  │
│   - Renderer = the existing /console + /dashboard pages  │
│     served by the daemon                                 │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼ child_process.spawn
┌──────────────────────────────────────────────────────────┐
│ Clementine Daemon (../../)                               │
│   - Discord bot · OpenAI / Codex runtime                 │
│   - Memory / indexer / autonomy v2                       │
│   - Background tasks · Composio                          │
│   - Dashboard API server (http://localhost:8520)         │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼ keytar (lazy-loaded)
┌──────────────────────────────────────────────────────────┐
│ SecretStore (../../src/runtime/secrets)                  │
│   keychain → file → env, never destructive               │
│   Service name: com.clemmy.desktop.v1                    │
└──────────────────────────────────────────────────────────┘
```

The CLI continues to work unchanged. Advanced users can `npm run service`
from the parent project; the desktop app is a layer on top, not a
replacement.

## Run it (dev)

```bash
cd apps/desktop
npm install
npm run dev      # tsx-launched main process for fastest iteration
# or
npm run build && npm run start   # compiled-then-electron
```

The first launch:
1. Splash window appears.
2. Daemon child process spawns from `../../` (this repo's parent project).
3. Supervisor probes the dashboard URL until ready (≤30s).
4. Main window loads `http://localhost:PORT/console?token=…`.
5. Tray icon appears with daemon status + quick actions.

Quit via Cmd-Q or tray → Quit Clementine. The supervisor sends SIGTERM
to the daemon and escalates to SIGKILL after 5s if needed.

## Package for distribution

```bash
npm run package:mac     # dmg + zip for macOS
npm run package:dist    # platform-default
```

The `extraResources` in `package.json` copies the compiled daemon
(`../../dist`) into the app bundle's Resources directory. The
supervisor's `locateDaemonProjectRoot()` finds the daemon there
automatically when running packaged.

## Credentials

The desktop app is the first surface where Keychain becomes the
canonical secret store. The Phase 1 `SecretStore` abstraction at
`../../src/runtime/secrets` already handles this:

- Keychain entries use service `com.clemmy.desktop.v1` (versioned —
  never changes once shipped).
- `.env` and the file vault remain transparent fallbacks for dev,
  CLI users, and migration.
- Reset flow scopes its delete to our service name only — won't
  corrupt other apps' keychain entries.

A user's "Repair Keychain" / "Reset Credentials" flow lives in the
Credentials Health panel of the dashboard, which the renderer reaches
via the standard REST API. IPC is reserved for Keychain operations
that must happen in the main process (raw secret reads), so the
renderer never sees them.

## First-run experience

When a user opens Clementine.app for the first time (no credentials,
no `~/.clementine-next/state/setup-complete.json`), the **setup
wizard** opens before the daemon ever boots:

```
┌────────────────────────────────────────────────────────────┐
│ CLEMENTINE // SETUP                          STEP 1 OF 6  │
├────────────────────────────────────────────────────────────┤
│ Step 0  Welcome — what Clementine is, where data lives    │
│ Step 1  Auth path: OpenAI key · Codex OAuth · Skip        │
│ Step 2  Discord token (optional)                          │
│ Step 3  Composio key (optional)                           │
│ Step 4  Workspace folders (optional)                      │
│ Step 5  Profile + LAUNCH CLEMENTINE                       │
└────────────────────────────────────────────────────────────┘
            │
            ▼ wizard's "Launch" button writes credentials
              via SecretStore (keychain or file vault) →
              workspace paths to ~/.clementine-next/.env →
              user profile JSON → writes setup-complete.json
            │
            ▼ main process launches the daemon, splash window,
              then the dashboard at /console
```

Subsequent launches skip the wizard and go straight to the dashboard.
Settings → Credentials in the dashboard handles edits afterward; a
future "Reset setup" admin action will clear the marker so the
wizard can run again.

## Credentials path

Three layers, in priority order:

1. **Keychain** — service name `com.clemmy.desktop.v1`. Used by the
   packaged Electron app when keytar is installable. Versioned so a
   future v2 can coexist for safe rollback.
2. **File vault** — `~/.clementine-next/state/secrets-vault.json`,
   0600 perms, atomic writes. Used when keychain isn't available
   (Linux without Secret Service, dev daemon outside Electron).
3. **.env** — transparent fallback. NEVER written, NEVER deleted by
   the app. Dev/CLI users keep working as-is.

Metadata (which source, last set, last validated, status) is in
`~/.clementine-next/state/secrets-meta.json` — but the secret values
themselves NEVER appear there. Tested with an explicit assertion.

Recovery flows live in the dashboard's Settings → Credentials block:

- **Repair Keychain** — re-probes keytar, force-reads every known
  credential. In daemon-only / CLI mode (no keytar) returns a clean
  "not available" message instead of crashing.
- **Reset Credentials** — double-confirmed destructive action. Scoped
  to entries under `com.clemmy.desktop.v1` and the file vault. Never
  touches `.env`.

## Run it (dev)

```bash
cd apps/desktop
npm install
npm run dev      # tsx-launched main process for fastest iteration
# or
npm run build && npm run start   # compiled-then-electron
```

The first launch:
1. Either the setup wizard window opens (first-run path)
2. Or the splash → daemon → dashboard sequence kicks off
3. Tray icon appears with daemon status + quick actions

Quit via Cmd-Q or tray → Quit Clementine. The supervisor sends SIGTERM
to the daemon and escalates to SIGKILL after 5s if needed.

To re-run the wizard, delete `~/.clementine-next/state/setup-complete.json`
and reopen the app.

## Package for distribution

```bash
npm run package:mac     # dmg + zip for macOS
npm run package:dist    # platform-default
```

The `extraResources` in `package.json` copies the compiled daemon
(`../../dist`) into the app bundle's Resources directory. The
supervisor's `locateDaemonProjectRoot()` finds the daemon there
automatically when running packaged.

## Status

Phase 3 — Electron app:

- ✅ Main process + daemon supervisor (spawn, port-pick, readiness-
     poll, log capture, restart, SIGTERM→SIGKILL on quit)
- ✅ Splash window during daemon boot
- ✅ Tray icon with status indicator (programmatically generated
     SVG → nativeImage, no shipped asset needed)
- ✅ Tray menu (open console, restart, logs, quit)
- ✅ Native notifications on daemon restart events
- ✅ First-run setup wizard window (6 steps: welcome, auth,
     Discord, Composio, workspaces, profile)
- ✅ First-run detection — auto-routes new users through setup,
     existing users straight to dashboard
- ✅ setup-complete.json marker — wizard runs once
- ✅ Credentials IPC bridge — main process writes to keychain/file
     vault; renderer never sees raw values
- ✅ Workspace + profile bridges — wizard writes to .clementine-next
     home env / user-profile.json
- ✅ Auto-generated WEBHOOK_SECRET on first launch when missing
- ✅ Credentials Health panel in dashboard Settings (live, talks to
     the daemon's SecretStore via REST; future IPC variant for the
     packaged build is a polish item)
- ⏭ DMG signing + notarization for distribution
- ⏭ Re-run setup admin action in dashboard
