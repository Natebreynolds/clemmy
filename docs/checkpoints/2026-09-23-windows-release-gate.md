# Windows release gate — 2026-09-23

Handoff for the agent landing this before the next tag. Branch
`windows-release-gate` (draft PR #97) is based on `origin/main` so that pushing
it published nothing but this work. Land it by cherry-picking its commits onto
local `main`.

## What landed on the branch

1. **`.gitattributes`: `* text=auto eol=lf`.** The CI Windows smoke job had
   never passed. A Windows checkout rewrote the committed
   `src/runtime/harness/implementation-artifacts/emitted/*.cjs` to CRLF, their
   SHA-256 stopped matching `manifest.json`, and the daemon refused to boot.
   Every tracked file is already LF, and `git add --renormalize .` stages
   nothing, both on `origin/main` and on local `main` at `e77215d00`. Nothing
   changes on macOS.
2. **`scripts/platform-runtime-probe.mjs`.** This runs, under the exact
   production binary and in a throwaway home with credential-shaped env keys
   dropped (no model call):
   - seal-key provisioning and `initHome`
   - the SQLite event log
   - the model-request provenance record every host turn writes before dispatch
   - result spill, artifact bundle, workspace snapshot, and the Composio
     staged blob
   - workflow code steps (node and python) through the scrubbed runner env
   - a supervisor-style `service` boot that must answer `/api/status` with no
     error-level log lines

   Every probe reports, and the process exits 1 if any fail.
3. **CI changes.**
   - `windows-smoke` now builds `dist` and runs the probe. Build and probe run
     even after an earlier step fails.
   - `release-windows` probes `win-unpacked/Clementine.exe` after the installer
     upload. A candidate keeps its installer, and a failing probe still blocks
     a production publish.
   - `docs/guides/desktop-releases.md` describes the gate.

## Verified before handoff

- **On local `main` `e77215d00`:**
  - The commit cherry-picks cleanly.
  - `npm run build` passes, and the probe passes 11 of 11 on macOS.
  - `test:release-assets` passes, including `scripts/release-workflow.test.mjs`
    at 22 of 22.
  - The tracked-files guard passes.
- **Negative check:** under simulated Windows filesystem semantics, the turn,
  spill, bundle, workspace and Composio probes fail.

## Tag impact

- **None for a `[mac-only]` tag.** That marker skips the Windows job, so the
  probe cannot gate macOS.
- **`windows-smoke` on `main` stays red.** It now fails on the five known probe
  failures below instead of at boot.

**Pre-existing tag blocker (not from this branch).** `npm run
check:public-hygiene` fails on local `main`, and the release preflight runs it.
The findings are:
- `personal-home-path` in `docs/NEXT-TAG-HANDOFF-2026-09-22.md`, line 18
- `personal-email-address` in
  `docs/checkpoints/2026-09-22-authoring-spaces-latency.md`, line 22

## Observed on windows-latest

Both runs gave the same result:
- the dev `dist` under Node 22, in PR #97's Test run 35932814377
- the packaged app under Electron 43, in candidate `3.18.20-windows.1`, Release
  run 35932813998

| Probe | Result |
| --- | --- |
| seal key, `initHome`, SQLite, code steps (node and python), `service` boot | pass |
| `turn_provenance` (every chat turn) | `provenance_record_unavailable ← authority_payload_storage_failed` |
| result spill, artifact bundle, workspace snapshot | `EPERM: operation not permitted, fsync` |
| Composio staged blob | `staged-file blob store is not a 0700 directory` |

**Correction to the 2026-09-23 survey.** The scrubbed code-step env (no
`SystemRoot`) does not break Python on Windows, so it is not a blocker.

## Remaining Windows work (none of it blocks a `[mac-only]` tag)

1. **Storage fixes.**
   - **Directory fsync.** Windows opens the directory, but fsync fails with
     EPERM. Use one win32-guarded helper, following the pattern of
     `syncDirectory` in `src/execution/workflow-call-receipts.ts`, across the
     unguarded copies:
     - `authority-encrypted-payload-store.ts`
     - `result-payload-storage.ts`
     - `artifact-bundle-core.ts`
     - `workspace-snapshot.ts`
     - `staged-file-blob-store.ts`
     - `legacy-job-record.ts`
     - the attested transport source behind the emitted `transport-*.cjs`
       (re-emit, which gives a new manifest digest)
   - **Mode assertions.** The 0600/0700 checks cannot hold on Windows, where
     modes read 0666/0777. The owner decides the policy. Recommended: skip them
     on win32 as the credentials vault already does.
   - **Unit-test pins.** The Claude CLI lane is not probed, so pin two issues
     with unit tests: `claude.cmd` is spawned without a shell (EINVAL), and
     `env.PATH` is set on a copy keyed `Path`.
2. **Signing.**
   - No Windows signing secrets exist.
   - The `.pfx` in `WINDOWS_CSC_LINK` design cannot be satisfied for a new
     certificate, because keys must be hardware-held.
   - Route: Azure Artifact Signing through electron-builder
     `win.azureSignOptions`.
   - Swap the workflow secret check and the signing inputs to match.
3. **Parity decisions.** Several Mac-only features have no Windows path: the
   notch and all global shortcuts, meeting-detected toast click, open
   file/project, terminal hand-off, DOCX export, CLI catalog detection, manual
   restart-to-update, and the default Electron menu.
4. **Installed-app acceptance.** Run it on a real Windows machine.
