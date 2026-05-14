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

## Status

Phase 3 scaffold:
- ✅ Main process + daemon supervisor + splash + main window
- ✅ Tray menu (open console, restart, logs, quit)
- ✅ Native notifications on daemon restart events
- ✅ IPC bridge (supervisor status / restart / tail-log / open-logs)
- ⏭ Setup wizard window for first-run (next phase)
- ⏭ Credentials Health panel + Repair / Reset flows (uses existing
     SecretStore, just needs UI)
- ⏭ Keychain-stored secrets fully replacing `.env` in the packaged
     build (foundation is shipped; migration UX lives in setup)
