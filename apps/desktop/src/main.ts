import { app, BrowserWindow, dialog, Menu, shell, Tray, Notification, ipcMain, nativeImage } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { DaemonSupervisor, locateDaemonProjectRoot, type SupervisorEvent } from './daemon-supervisor.js';

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
      preload: path.join(path.dirname(new URL(import.meta.url).pathname), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(url);
  win.on('close', (event) => {
    // On macOS we keep the app alive in the tray. Hide instead of
    // quit; cmd-Q exits explicitly.
    if (process.platform === 'darwin' && !(app as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}

function setupTray(): void {
  // Bundled icon would be ideal; for now use a 16x16 transparent PNG
  // so the tray slot is reserved without shipping image assets in the
  // scaffold commit.
  const empty = nativeImage.createEmpty();
  tray = new Tray(empty);
  tray.setTitle('● Clementine');
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
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

async function boot(): Promise<void> {
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

ipcMain.handle('clemmy:tail-log', (_, maxLines?: number) => {
  return { lines: supervisor?.tailLog(maxLines ?? 200) ?? [] };
});

ipcMain.handle('clemmy:open-logs', async () => {
  await shell.openPath(LOG_FILE);
  return { opened: true };
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
