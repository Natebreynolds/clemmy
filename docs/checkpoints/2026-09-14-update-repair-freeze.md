# Update repair freeze after 3.18.6

The owner installed signed 3.18.6 (32269b1e) successfully, then the Repair updates action froze the desktop. ShipIt records successful replacement and launch at 09:59 Pacific. The installed bundle is root:wheel. The app immediately diagnoses this as app-not-writable and disables automatic checks.

The process sample at 10:03 captures the main thread inside NSAlert runModal/layout, called from a libuv child-exit callback. The repair failure UI uses synchronous dialog.showErrorBox after the osascript callback. Accessibility requests timed out while the daemon continued to beacon. A normal termination request did not release the frozen desktop; the daemon was asked to shut down, the frozen main process was terminated, and the app reopened. Home became responsive. No user database was edited or deleted.

## Changes

- Root ownership alone no longer blocks checks/download/install. Squirrel's native updater chooses privileged installation when the bundle or parent is not writable. It already performed the owner's successful update. The location/translocation check remains.
- The explicit legacy ownership-repair operation retains its exact /Applications/Clementine.app boundary and OS authorization. Automatic update checks no longer launch recursive chown.
- Repair failure returns through the existing updater status/IPC path and is logged; it no longer opens synchronous NSAlert. The actual repair error is retained rather than overwritten by generic ownership text.
- The console banner shows that specific error.

Reference: https://github.com/Squirrel/Squirrel.Mac/blob/master/Squirrel/SQRLUpdater.m (shipItLauncher chooses privileged when target or parent is not writable).

## Validation

The real updater module executes under mocked Electron/OS boundaries, covering root-owned startup/check/native install with zero ownership commands, retained translocation refusal, and cancelled explicit repair followed by a working update check. A source-bound guard protects the exact repair UI callback from reintroducing synchronous dialogs. The original 32269b1e source fails three of the four regressions; the corrected code and existing updater-error tests pass 11/11. Desktop build and console typecheck both exited 0. Logs are in output/update-repair-2026-09-14. The test runner did not perform its isolated-home sentinel because the live daemon owns the home; this is not an isolated-home qualification.

## Local recovery

A same-version signed copy was staged under /Applications/.clementine-ownership-recovery-20260914 and passed strict deep code-signature verification. macOS denied renaming the original root-owned bundle; no replacement occurred. An external macOS administrator prompt was then requested for chown of the original bundle, separate from Clementine's faulty dialog. The administrator command failed with Operation not permitted (exit 1), and the installed bundle remains root:wheel. No replacement occurred. Home was reverified responsive through accessibility; the ownership banner remains. See output/update-repair-2026-09-14/local-recovery.json. Do not repeat the installed Repair action: its synchronous error dialog is still present in 3.18.6. The staged signed copy remains available, but macOS protection prevented replacement; no further attempt to bypass it was made. The permanent source fixes above are not yet installed or released; v3.18.6 remains immutable.
