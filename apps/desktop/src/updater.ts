/**
 * Auto-update wiring for Clementine.app.
 *
 * Hooks `electron-updater` to GitHub Releases via the `publish` block
 * in package.json. The flow:
 *
 *   on app ready    → check once
 *   every 4 hours   → check again
 *   update found    → download in background, never blocks the user
 *   download done   → tray label changes to "Restart to install vX.Y.Z"
 *   user clicks it  → quitAndInstall() → installer replaces the bundle
 *
 * Logger is wired into the existing supervisor log file so the user
 * (and we) can see what the updater did without staring at Console.app.
 *
 * In dev mode (`npm start` from source) electron-updater is a no-op —
 * autoUpdater silently exits when run from an unpackaged build. We
 * still register the handlers so future packaging changes don't break
 * the integration surface, but the periodic check is skipped.
 */
import { app, dialog, Notification } from 'electron';
import electronUpdater, { type UpdateInfo } from 'electron-updater';
import path from 'node:path';

// electron-updater is published as CommonJS. Under Node ESM the named
// `autoUpdater` export isn't statically detected, so we have to pull it
// off the default export instead.
const { autoUpdater } = electronUpdater;
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MOVE_TO_APPLICATIONS_MESSAGE =
  'Clementine is running from a read-only or translocated location. Move Clementine to /Applications to enable auto-updates.';

export interface UpdaterStatus {
  /** Highest-level state — what to show in the tray. */
  state:
    | 'idle'
    | 'checking'
    | 'no-update'
    | 'available'
    | 'downloading'
    | 'ready-to-install'
    | 'error';
  /** Version string of the pending update, when available. */
  version?: string;
  /** Release notes (HTML or text from the GitHub release body). */
  releaseNotes?: string;
  /** 0..100 during 'downloading'. */
  progressPct?: number;
  /** Most recent error message, if state === 'error'. */
  error?: string;
  /** Actionable install-location issue that prevents auto-update apply. */
  installBlocker?: 'move-to-applications';
  /** Current app executable path, useful for diagnostics. */
  appPath?: string;
  /** Last successful check timestamp (ISO). */
  lastCheckedAt?: string;
}

let status: UpdaterStatus = { state: 'idle' };
let onStatusChangeListeners: Array<(s: UpdaterStatus) => void> = [];
let periodicHandle: NodeJS.Timeout | null = null;
let downloadInFlight = false;

function updateStatus(next: Partial<UpdaterStatus>): void {
  status = { ...status, ...next, ...getInstallBlockerStatus() };
  for (const listener of onStatusChangeListeners) {
    try {
      listener(status);
    } catch {
      // listeners should never block updater events
    }
  }
}

export function getUpdaterStatus(): UpdaterStatus {
  return { ...status, ...getInstallBlockerStatus() };
}

export function onUpdaterStatusChange(listener: (status: UpdaterStatus) => void): () => void {
  onStatusChangeListeners.push(listener);
  return () => {
    onStatusChangeListeners = onStatusChangeListeners.filter((entry) => entry !== listener);
  };
}

/**
 * Manually trigger an update check. Returns the new status. Used by
 * the tray menu's "Check for Updates" item and any dashboard hook.
 */
export async function checkForUpdatesNow(): Promise<UpdaterStatus> {
  if (!app.isPackaged) {
    updateStatus({ state: 'no-update', error: 'Updates are only checked in the packaged Clementine.app' });
    return getUpdaterStatus();
  }
  const blocker = getInstallBlockerStatus();
  if (blocker.installBlocker) {
    updateStatus({
      state: 'error',
      error: MOVE_TO_APPLICATIONS_MESSAGE,
      ...blocker,
    });
    return getUpdaterStatus();
  }
  try {
    updateStatus({ state: 'checking', error: undefined });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    updateStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return getUpdaterStatus();
}

/**
 * Trigger the next user-facing update action:
 *   - available: start/retry the update download now
 *   - downloading: report that work is already in progress
 *   - ready-to-install: quit+install immediately
 *
 * Returns a result so the renderer can surface failures. The earlier
 * version was `void` and silently no-op'd when state !== 'ready-to-
 * install', so the in-app banner click "did nothing" with no signal
 * to the user — observed in production on v0.3.0.
 */
export function applyUpdate(): {
  ok: boolean;
  action?: 'download-started' | 'downloading' | 'installing' | 'move-required';
  reason?: string;
  installBlocker?: UpdaterStatus['installBlocker'];
} {
  if (!app.isPackaged) {
    return {
      ok: false,
      reason: 'Updates can only be applied from the packaged Clementine.app.',
    };
  }
  const blocker = getInstallBlockerStatus();
  if (blocker.installBlocker) {
    updateStatus({
      state: 'error',
      error: MOVE_TO_APPLICATIONS_MESSAGE,
      ...blocker,
    });
    return {
      ok: false,
      action: 'move-required',
      reason: MOVE_TO_APPLICATIONS_MESSAGE,
      installBlocker: blocker.installBlocker,
    };
  }

  if (status.state === 'available') {
    if (downloadInFlight) {
      return { ok: true, action: 'downloading', reason: 'Update download is already running.' };
    }
    try {
      downloadInFlight = true;
      updateStatus({ state: 'downloading', progressPct: status.progressPct ?? 0, error: undefined });
      void autoUpdater.downloadUpdate()
        .catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          updateStatus({ state: 'error', error: reason });
        })
        .finally(() => {
          downloadInFlight = false;
        });
      return { ok: true, action: 'download-started' };
    } catch (err) {
      downloadInFlight = false;
      const reason = err instanceof Error ? err.message : String(err);
      updateStatus({ state: 'error', error: reason });
      return { ok: false, reason };
    }
  }

  if (status.state === 'downloading') {
    return { ok: true, action: 'downloading', reason: 'Update download is already running.' };
  }

  if (status.state !== 'ready-to-install') {
    return {
      ok: false,
      reason: `Not ready to install (state: ${status.state}). Use Check For Updates from the tray, then try again once a download is available.`,
    };
  }

  try {
    // isSilent=false: show the standard installer UI.
    // isForceRunAfter=true: relaunch Clementine post-update so the user
    //   doesn't have to manually re-open it.
    autoUpdater.quitAndInstall(false, true);
    return { ok: true, action: 'installing' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}

export function moveAppToApplicationsFolder(): { ok: boolean; action?: 'already-installed' | 'moving'; reason?: string } {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'Moving to /Applications is only available on macOS.' };
  }
  if (!app.isPackaged) {
    return { ok: false, reason: 'Only the packaged Clementine.app can be moved to /Applications.' };
  }
  if (app.isInApplicationsFolder()) {
    updateStatus({ state: status.state, error: undefined, installBlocker: undefined });
    return { ok: true, action: 'already-installed' };
  }

  const choice = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Move to Applications', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Move Clementine to Applications?',
    message: 'Move Clementine to /Applications?',
    detail: 'macOS is running this copy from a read-only or translocated location, so auto-update cannot replace it. Clementine will relaunch after the move.',
  });
  if (choice !== 0) {
    return { ok: false, reason: 'Move canceled.' };
  }

  try {
    const moved = app.moveToApplicationsFolder({
      conflictHandler: (conflictType) => {
        const conflictChoice = dialog.showMessageBoxSync({
          type: 'question',
          buttons: ['Replace Existing App', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: 'Replace existing Clementine?',
          message: 'Clementine already exists in /Applications.',
          detail: conflictType === 'existsAndRunning'
            ? 'The existing app is already running. Continue to switch to that copy.'
            : 'Replace the existing copy so future auto-updates can install correctly.',
        });
        return conflictChoice === 0;
      },
    });
    return moved
      ? { ok: true, action: 'moving' }
      : { ok: false, reason: 'Move canceled or blocked by macOS.' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    updateStatus({ state: 'error', error: reason, ...getInstallBlockerStatus() });
    return { ok: false, reason };
  }
}

/**
 * Wire up electron-updater. Call once from main.ts after app is ready.
 * `logFile` is the supervisor log path — updater events get appended
 * so the existing log-tailing flow works for them too.
 */
export function initAutoUpdater(opts: { logFile: string }): void {
  ensureLogDir(opts.logFile);
  const log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void => {
    try {
      const line = JSON.stringify({
        level: level === 'error' ? 50 : level === 'warn' ? 40 : 30,
        time: Date.now(),
        pid: process.pid,
        hostname: process.env.HOSTNAME || '',
        name: 'clementine-next.updater',
        msg,
        ...(extra ?? {}),
      });
      appendFileSync(opts.logFile, line + '\n', 'utf-8');
    } catch {
      // Logging must never throw — drop the line.
    }
  };

  // Pipe electron-updater's internal logs into our supervisor file so
  // they appear alongside daemon events. The package accepts any
  // logger with info/warn/error methods, plus the optional transports
  // property our format doesn't use.
  autoUpdater.logger = {
    info: (msg: string) => log('info', String(msg)),
    warn: (msg: string) => log('warn', String(msg)),
    error: (msg: string) => log('error', String(msg)),
    debug: () => {},
  } as unknown as typeof autoUpdater.logger;

  // We download in the background but do not ask Squirrel.Mac to stage
  // the native install until the user explicitly clicks Restart. With
  // tray-resident apps, autoInstallOnAppQuit can leave ShipIt waiting
  // behind the scenes while the main app stays alive.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    log('info', 'checking for updates');
    updateStatus({ state: 'checking', error: undefined });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log('info', 'update available', { version: info.version });
    updateStatus({
      state: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      progressPct: 0,
      error: undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    log('info', 'no update available');
    updateStatus({
      state: 'no-update',
      lastCheckedAt: new Date().toISOString(),
      error: undefined,
    });
  });

  autoUpdater.on('download-progress', (progress: { percent: number }) => {
    downloadInFlight = true;
    updateStatus({ state: 'downloading', progressPct: Math.round(progress.percent) });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloadInFlight = false;
    log('info', 'update downloaded — ready to install', { version: info.version });
    updateStatus({
      state: 'ready-to-install',
      version: info.version,
      progressPct: 100,
    });
    // A silent tray-only signal is the right default — the user is
    // mid-flow and we don't want to interrupt. The tray label flip
    // ("Restart to install vX.Y.Z") is the durable affordance.
    new Notification({
      title: `Clementine ${info.version} is ready`,
      body: 'Restart Clementine when you have a moment to apply the update.',
      silent: true,
    }).show();
  });

  autoUpdater.on('error', (err: Error) => {
    downloadInFlight = false;
    log('error', 'updater error', { err: err.message });
    updateStatus({
      state: 'error',
      error: err.message,
    });
  });

  // Initial check + periodic refresh. Only in packaged builds —
  // unpackaged dev runs would just spam "DEV mode — auto updater
  // disabled" errors.
  if (app.isPackaged) {
    log('info', 'auto-updater armed');
    const blocker = getInstallBlockerStatus();
    if (blocker.installBlocker) {
      log('warn', MOVE_TO_APPLICATIONS_MESSAGE, blocker);
      updateStatus({
        state: 'error',
        error: MOVE_TO_APPLICATIONS_MESSAGE,
        ...blocker,
      });
      return;
    }
    autoUpdater.checkForUpdates().catch(() => { /* logged above */ });
    periodicHandle = setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => { /* logged above */ });
    }, CHECK_INTERVAL_MS);
    // Don't keep the event loop alive just for the timer.
    periodicHandle.unref?.();
  } else {
    log('info', 'dev mode — auto-updater inert (still wired for IPC)');
  }
}

export function disposeAutoUpdater(): void {
  if (periodicHandle) {
    clearInterval(periodicHandle);
    periodicHandle = null;
  }
  onStatusChangeListeners = [];
}

function ensureLogDir(logFile: string): void {
  const dir = path.dirname(logFile);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

function getInstallBlockerStatus(): Pick<UpdaterStatus, 'installBlocker' | 'appPath'> {
  if (process.platform !== 'darwin' || !app.isPackaged) return {};
  try {
    if (app.isInApplicationsFolder()) return { installBlocker: undefined, appPath: process.execPath };
    return { installBlocker: 'move-to-applications', appPath: process.execPath };
  } catch {
    return { installBlocker: undefined, appPath: process.execPath };
  }
}
