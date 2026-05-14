import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { DaemonSupervisor, locateDaemonProjectRoot, type SupervisorEvent } from './daemon-supervisor.js';
import { needsSetup, hasCompletedSetup, writeSetupComplete, type SetupConfiguredSummary } from './setup-state.js';
import { createSetupWindow } from './setup-window.js';
import {
  deleteCredential,
  ensureWebhookSecret,
  isKeychainAvailable,
  listCredentialRows,
  resetAllCredentials,
  setCredential,
  type CredentialName,
} from './credentials-bridge.js';
import { addWorkspaceDir, ensureHomeEnv, saveUserProfile, type ProfilePatch } from './setup-bridge.js';

/**
 * Clementine Desktop — Electron main process.
 *
 * Lifecycle:
 *   1. App ready
 *   2. Create splash window ("Starting Clementine…")
 *   3. Locate daemon project (dev or packaged)
 *   4. Start DaemonSupervisor — spawns the child, picks a port, waits
 *      for readiness
 *   5. Replace splash with dashboard BrowserWindow pointing at
 *      http://localhost:PORT/console?token=WEBHOOK_SECRET
 *   6. Tray icon for quick access + status
 *   7. On window-all-closed: hide instead of quitting (Mac tray pattern)
 *   8. On app quit: stop daemon, drain log stream, exit
 *
 * IPC surface (preload bridges these to the renderer):
 *   clemmy:supervisor-status → returns { running, port, url }
 *   clemmy:restart-daemon    → calls supervisor.restart()
 *   clemmy:open-logs         → opens the log file in the OS default viewer
 *   clemmy:tail-log          → returns last N log lines
 *   clemmy:secret-health     → returns SecretStore.health() snapshot
 *   clemmy:secret-set        → writes a secret via SecretStore
 *   clemmy:repair-keychain   → runs the keychain repair routine
 *   clemmy:reset-credentials → calls SecretStore.resetAll() with confirmation gate
 *
 * The renderer can also fall back to fetch() against the dashboard's
 * REST API — IPC is for things that need direct access to the
 * Electron-only Keychain layer (which the renderer should never see
 * raw secrets from).
 */

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.clementine-next', 'logs', 'desktop');
const LOG_FILE = path.join(LOG_DIR, 'supervisor.log');

let supervisor: DaemonSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let dashboardUrl = '';

function getWebhookSecret(): string {
  // Read the same secret the daemon will read so the dashboard URL we
  // load matches the daemon's auth.
  // The daemon's home is ~/.clementine-next; the .env file there is the
  // canonical place for WEBHOOK_SECRET in dev.
  const envFile = path.join(HOME, '.clementine-next', '.env');
  if (!existsSync(envFile)) return '';
  try {
    for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
      const m = line.match(/^WEBHOOK_SECRET=(.*)$/);
      if (m) return m[1].trim();
    }
  } catch { /* fall through */ }
  return '';
}

function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 280,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#07070a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>Clementine</title>
<style>
  body {
    margin: 0; height: 100vh;
    background: #07070a; color: #e5e5ea;
    font: 13px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 18px;
    background-image: repeating-linear-gradient(to bottom, transparent 0 3px, rgba(255,255,255,0.012) 3px 4px);
  }
  .brand { letter-spacing: 0.22em; font-size: 14px; }
  .brand .sub { color: #ff5a35; }
  .status { color: #a0a0aa; font-size: 11px; letter-spacing: 0.16em; min-height: 14px; text-align: center; }
  .pulse {
    width: 10px; height: 10px; border-radius: 50%;
    background: #b9ff36;
    box-shadow: 0 0 12px rgba(185, 255, 54, 0.55);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1;transform:scale(1);} 50%{opacity:0.4;transform:scale(0.7);} }
</style></head><body>
  <div class="pulse"></div>
  <div class="brand">CLEMENTINE // <span class="sub">CONSOLE</span></div>
  <div class="status" id="status">starting daemon…</div>
  <script>
    if (window.clemmy?.onSupervisorEvent) {
      window.clemmy.onSupervisorEvent((event) => {
        const el = document.getElementById('status');
        if (!el) return;
        if (event.type === 'starting') el.textContent = 'starting daemon · port ' + event.port + '…';
        if (event.type === 'running')  el.textContent = 'daemon running · waiting for dashboard…';
        if (event.type === 'ready')    el.textContent = 'ready';
        if (event.type === 'exit')     el.textContent = 'daemon exited · restarting…';
        if (event.type === 'restart-scheduled') el.textContent = 'restart in ' + Math.round(event.delayMs/1000) + 's…';
      });
    }
  </script>
</body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return win;
}

function createMainWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    title: 'Clementine',
    backgroundColor: '#07070a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(path.dirname(new URL(import.meta.url).pathname), 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(url);
  win.on('close', (event: { preventDefault(): void }) => {
    // On macOS we keep the app alive in the tray. Hide instead of
    // quit; cmd-Q exits explicitly.
    if (process.platform === 'darwin' && !(app as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}

/**
 * Generate a 22×22 tray icon at runtime — no shipped image asset
 * required. Renders a filled circle (orange = active) on a transparent
 * background. Uses an inline SVG → nativeImage.createFromDataURL.
 */
function buildTrayIcon(active: boolean): NativeImage {
  const color = active ? '#ff5a35' : '#666c7a';
  const dot = active ? '#b9ff36' : '#3a3f4a';
  // 22x22 is the Electron-recommended template size for menubar icons
  // on macOS retina. We use a colored variant (not template mode)
  // because the operational aesthetic wants the accent colors visible.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="9" fill="${color}" opacity="0.18" />
    <circle cx="11" cy="11" r="6" fill="none" stroke="${color}" stroke-width="1.4" />
    <circle cx="11" cy="11" r="2.6" fill="${dot}" />
  </svg>`;
  const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf-8').toString('base64');
  const image = nativeImage.createFromDataURL(dataUrl);
  // Don't mark template — we want the color to appear (some platforms
  // render template mode as monochrome-by-system-theme).
  image.setTemplateImage(false);
  return image;
}

function setupTray(): void {
  tray = new Tray(buildTrayIcon(false));
  tray.setTitle(''); // keep the menubar quiet — icon does the work
  tray.setToolTip('Clementine');
  rebuildTrayMenu();
}

function refreshTrayIcon(): void {
  if (!tray) return;
  const running = supervisor?.isRunning() ?? false;
  tray.setImage(buildTrayIcon(running));
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  refreshTrayIcon();
  const running = supervisor?.isRunning() ?? false;
  const menu = Menu.buildFromTemplate([
    {
      label: running ? `● Daemon running · port ${supervisor?.getPort()}` : '○ Daemon stopped',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Console',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          if (dashboardUrl) {
            mainWindow = createMainWindow(dashboardUrl);
          }
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { label: 'Open Dashboard in Browser', click: () => dashboardUrl && shell.openExternal(dashboardUrl) },
    { label: 'Open Log File', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Restart Daemon', click: () => supervisor?.restart() },
    { label: 'Stop Daemon', click: () => supervisor?.stop() },
    { type: 'separator' },
    { label: 'Quit Clementine', click: () => quitCleanly() },
  ]);
  tray.setContextMenu(menu);
}

async function quitCleanly(): Promise<void> {
  (app as { isQuitting?: boolean }).isQuitting = true;
  await supervisor?.stop().catch(() => { /* ignore */ });
  app.quit();
}

function showSupervisorEventNotification(event: SupervisorEvent): void {
  if (event.type === 'restart-scheduled' && event.attempt >= 3) {
    new Notification({
      title: 'Clementine daemon restarting',
      body: `Attempt ${event.attempt} · waiting ${Math.round(event.delayMs / 1000)}s`,
      silent: true,
    }).show();
  }
  if (event.type === 'restart-skipped') {
    new Notification({
      title: 'Clementine daemon — restart skipped',
      body: event.reason,
      urgency: 'critical',
    }).show();
  }
}

function preloadPath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), 'preload.cjs');
}

/**
 * Boot flow:
 *   1. If first-run (no credentials, no setup-complete marker) →
 *      open setup wizard window. Don't start the daemon yet — the
 *      wizard writes credentials BEFORE the daemon reads them.
 *   2. Otherwise → splash → daemon → dashboard window.
 *
 * The setup wizard's "complete" handler kicks off step 2 by calling
 * launchDaemon() once credentials are persisted.
 */
async function boot(): Promise<void> {
  // Make sure a WEBHOOK_SECRET exists before anything else — both the
  // daemon and the dashboard URL need it. ensureWebhookSecret() reads
  // env first, then falls back to generating a new one stored in the
  // file vault (which the daemon's SecretStore reads at boot).
  await ensureWebhookSecret();

  if (needsSetup()) {
    openSetupWindow();
  } else {
    await launchDaemon();
  }
}

function openSetupWindow(): void {
  setupWindow = createSetupWindow({
    preloadPath: preloadPath(),
    onComplete: async (record) => {
      // The IPC handler already wrote the setup-complete marker and
      // closed this window — this callback fires from the wizard's
      // setupComplete IPC handler chain.
      await launchDaemon();
    },
    onSkip: async () => {
      await launchDaemon();
    },
  });
  setupWindow.on('closed', () => { setupWindow = null; });
}

async function launchDaemon(): Promise<void> {
  splashWindow = createSplashWindow();

  const daemonRoot = locateDaemonProjectRoot();

  supervisor = new DaemonSupervisor({
    daemonProjectRoot: daemonRoot,
    logFile: LOG_FILE,
    onEvent: (event) => {
      // Forward to the splash + tray + notifications.
      splashWindow?.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('supervisor', { detail: ${JSON.stringify(event)} }));`,
      ).catch(() => { /* splash gone */ });
      rebuildTrayMenu();
      showSupervisorEventNotification(event);
    },
  });

  try {
    const info = await supervisor.start();
    const token = getWebhookSecret();
    dashboardUrl = token ? `${info.url}/console?token=${encodeURIComponent(token)}` : `${info.url}/console`;
    mainWindow = createMainWindow(dashboardUrl);
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show();
      splashWindow?.close();
      splashWindow = null;
    });
    rebuildTrayMenu();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    splashWindow?.close();
    splashWindow = null;
    dialog.showErrorBox(
      'Clementine couldn\'t start the daemon',
      `${msg}\n\nLog file: ${LOG_FILE}\n\nTry restarting Clementine or open the log to investigate.`,
    );
  }
}

// ─── IPC handlers ──────────────────────────────────────────────────

ipcMain.handle('clemmy:supervisor-status', () => ({
  running: supervisor?.isRunning() ?? false,
  port: supervisor?.getPort() ?? 0,
  url: dashboardUrl,
}));

ipcMain.handle('clemmy:restart-daemon', async () => {
  await supervisor?.restart();
  rebuildTrayMenu();
  return { ok: true };
});

ipcMain.handle('clemmy:tail-log', (_evt: IpcMainInvokeEvent, maxLines?: number) => {
  return { lines: supervisor?.tailLog(maxLines ?? 200) ?? [] };
});

ipcMain.handle('clemmy:open-logs', async () => {
  await shell.openPath(LOG_FILE);
  return { opened: true };
});

// ─── Setup wizard IPC handlers ─────────────────────────────────────

ipcMain.handle('clemmy:setup-status', async () => ({
  needsSetup: needsSetup(),
  hasCompleted: hasCompletedSetup(),
  hasKeychain: await isKeychainAvailable(),
}));

ipcMain.handle('clemmy:credentials-list', async () => {
  const rows = await listCredentialRows();
  return { rows };
});

ipcMain.handle('clemmy:credentials-set', async (_evt: IpcMainInvokeEvent, payload: { name: string; value: string }) => {
  const knownNames: CredentialName[] = [
    'openai_api_key', 'discord_bot_token', 'composio_api_key',
    'codex_oauth_access_token', 'codex_oauth_refresh_token', 'webhook_secret',
  ];
  if (!knownNames.includes(payload.name as CredentialName)) {
    throw new Error('unknown credential name: ' + payload.name);
  }
  return setCredential(payload.name as CredentialName, payload.value);
});

ipcMain.handle('clemmy:credentials-delete', async (_evt: IpcMainInvokeEvent, payload: { name: string }) => {
  const knownNames: CredentialName[] = [
    'openai_api_key', 'discord_bot_token', 'composio_api_key',
    'codex_oauth_access_token', 'codex_oauth_refresh_token', 'webhook_secret',
  ];
  if (!knownNames.includes(payload.name as CredentialName)) {
    throw new Error('unknown credential name: ' + payload.name);
  }
  await deleteCredential(payload.name as CredentialName);
  return { ok: true };
});

ipcMain.handle('clemmy:credentials-reset', async () => {
  return resetAllCredentials();
});

ipcMain.handle('clemmy:setup-save-workspace', async (_evt: IpcMainInvokeEvent, payload: { path: string }) => {
  const p = (payload?.path ?? '').trim();
  if (!p) throw new Error('path required');
  addWorkspaceDir(p);
  return { ok: true };
});

ipcMain.handle('clemmy:setup-save-profile', async (_evt: IpcMainInvokeEvent, patch: ProfilePatch) => {
  saveUserProfile(patch);
  return { ok: true };
});

ipcMain.handle('clemmy:setup-complete', async (_evt: IpcMainInvokeEvent, record: { configured: SetupConfiguredSummary }) => {
  writeSetupComplete({ configured: record.configured });
  // Close the wizard, kick the daemon, transition to dashboard.
  const win = setupWindow;
  setupWindow = null;
  win?.close();
  await launchDaemon();
  return { ok: true };
});

ipcMain.handle('clemmy:setup-skip', async () => {
  writeSetupComplete({
    configured: { auth: 'skipped', discord: false, composio: false, workspaceCount: 0, profileSet: false },
  });
  const win = setupWindow;
  setupWindow = null;
  win?.close();
  await launchDaemon();
  return { ok: true };
});

// ─── App lifecycle ─────────────────────────────────────────────────

app.on('ready', () => { void boot(); setupTray(); });
app.on('window-all-closed', () => {
  // macOS tray-resident pattern. On Linux/Windows we still quit when
  // all windows are gone unless the user is explicitly tray-only.
  if (process.platform !== 'darwin') quitCleanly();
});
app.on('activate', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  } else if (dashboardUrl) {
    mainWindow = createMainWindow(dashboardUrl);
  }
});
app.on('before-quit', () => { void quitCleanly(); });
