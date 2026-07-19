import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  powerMonitor,
  screen,
  shell,
  Tray,
  type Display,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { DaemonSupervisor, locateDaemonProjectRoot, type SupervisorEvent } from './daemon-supervisor.js';
import { needsSetup, hasCompletedSetup, writeSetupComplete, type SetupConfiguredSummary } from './setup-state.js';
import { createSetupWindow } from './setup-window.js';
import { RecallDesktopCapture, type RecallCaptureSettings } from './recall-capture.js';
import {
  LocalMeetingRecorder,
  type LocalMeetingRecording,
} from './local-meeting-recorder.js';
import { isBenignPipeError } from './pipe-errors.js';
import { isTrustedDashboardMediaUrl } from './media-permissions.js';
import {
  applyUpdate,
  checkForUpdatesNow,
  disposeAutoUpdater,
  getUpdaterStatus,
  initAutoUpdater,
  moveAppToApplicationsFolder,
  onUpdaterStatusChange,
  repairAppOwnership,
} from './updater.js';
import {
  deleteCredential,
  ensureWebhookSecret,
  listCredentialRows,
  migrateKeychainToFileVault,
  resetAllCredentials,
  setCredential,
  type CredentialName,
} from './credentials-bridge.js';
import { addWorkspaceDir, ensureHomeEnv, saveUserProfile, setHomeEnv, type ProfilePatch } from './setup-bridge.js';
import { importUsableCodexOAuthTokens, persistCodexOAuthTokens, runCodexOAuthLogin } from './codex-oauth.js';
import { hasPersistedCodexGrant } from './auth-grant.js';
import { redactSensitiveText } from './redaction.js';
import {
  computeClementineLiveGeometry,
  DEFAULT_CLEMENTINE_LIVE_DORMANT_SIZE,
  normalizeClementineLiveSize,
  resolveClementineLiveShortcut,
  type ClementineLiveLayoutRequest,
  type ClementineLivePresentation,
  type ClementineLiveSize,
} from './live-window-geometry.js';
import {
  CLEMENTINE_LIVE_WINDOW_INTERACTION_OPTIONS,
  CLEMENTINE_LIVE_WINDOW_LEVEL,
  planClementineLivePanelToggle,
} from './live-window-interaction.js';
import {
  isExactClementineLiveIpcSender,
  isExactClementineNotchSettingsIpcSender,
} from './live-ipc-security.js';
import {
  clementineLiveMountFromUrl,
  clementineLiveUrlForDashboard,
  createClementineLiveMountIdentity,
  isCurrentClementineLiveMount,
  isValidClementineLiveMountIdentity,
  type ClementineLiveMountIdentity,
} from './live-mount-handshake.js';
import {
  DEFAULT_CLEMENTINE_NOTCH_PREFERENCES,
  clementineNotchPreferencesPath,
  loadClementineNotchPreferences,
  patchClementineNotchPreferences,
  saveClementineNotchPreferences,
  type ClementineNotchPreferences,
} from './notch-preferences.js';
import {
  recallCaptureRequiresVisibleControls,
  sanitizeRecallEventForNotch,
  sanitizeRecallStatusForNotch,
} from './notch-meeting.js';
import {
  ClementineNotchClickHelper,
  resolveNotchClickHelperPath,
  toDisplayLocalNotchFrame,
  type NotchClickHelperHealth,
} from './notch-click-helper.js';

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
 *      http://127.0.0.1:PORT/console after one-time local session bootstrap
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

// Disable Chromium's password manager + macOS Passwords AutoFill so the
// dashboard's API-key inputs don't trigger "Use Passwords?" / Keychain
// prompts every page load. These must run before app.whenReady.
app.commandLine.appendSwitch('password-store', 'basic');
app.commandLine.appendSwitch(
  'disable-features',
  'PasswordManagerEnabledForApp,AutofillEnableAccountWalletStorage,AutofillServerCommunication',
);

let supervisor: DaemonSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let clementineLiveWindow: BrowserWindow | null = null;
let clementineNotchClickHelper: ClementineNotchClickHelper | null = null;
let clementineNotchClickHelperHealth: NotchClickHelperHealth = 'stopped';
let clementineNotchClickHelperError: string | null = null;
let clementineLiveDisplayId: number | null = null;
const clementineLiveNativeAnchors = new Map<number, { x: number; y: number; topInset: number }>();
let clementineLiveSize: ClementineLiveSize = { ...DEFAULT_CLEMENTINE_LIVE_DORMANT_SIZE };
let clementineLivePresentation: ClementineLivePresentation = 'dormant';
let clementineLiveLastLayoutId = 0;
let clementineLiveShellInitialized = false;
type ClementineLiveAvailability = 'loading' | 'ready' | 'unavailable';
let clementineLiveAvailability: ClementineLiveAvailability = 'unavailable';
let clementineLiveRetryAttempts = 0;
let clementineLiveRetryTimer: NodeJS.Timeout | null = null;
let clementineLiveHandshakeTimer: NodeJS.Timeout | null = null;
let clementineLiveNavigationGeneration = 0;
let clementineLiveCurrentMount: ClementineLiveMountIdentity | null = null;
const CLEMENTINE_LIVE_MAX_RETRIES = 3;
const CLEMENTINE_LIVE_HANDSHAKE_TIMEOUT_MS = 3_000;
let clementineNotchPreferencesFile = '';
let clementineNotchPreferences: ClementineNotchPreferences = {
  ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES,
};
let clementineLiveRegisteredShortcut: string | null = null;
let clementineLiveShortcutError: string | null = null;
let clementineLivePendingReveal: 'manual' | 'passive' | null = null;
let clementineLivePendingRevealPresentation: ClementineLivePresentation | null = null;
// Voice companion: a dedicated global shortcut reveals the notch and starts a
// spoken request ("hey, pull up my pipeline") — the notch records, transcribes,
// and sends the text to Clementine. Separate accelerator from the show/hide
// toggle so speaking is always one keystroke away.
const DEFAULT_CLEMENTINE_VOICE_SHORTCUT = 'CommandOrControl+Shift+V';
let clementineLiveVoiceRegisteredShortcut: string | null = null;
// Set when the shortcut fires before the renderer is ready; emitted on mount.
let clementineLivePendingVoice = false;
// Set when the open/expand shortcut fires before the renderer is ready.
let clementineLivePendingToggle = false;
// Native top-edge activations are explicit/idempotent expands. Keeping this
// separate from shortcut toggles prevents duplicate AppKit/Chromium delivery
// from immediately collapsing the surface again.
let clementineLivePendingExpand = false;
// The current display's menu-bar/notch inset, delivered to the renderer so it can
// pad its content below the physical notch.
let clementineLiveLastTopInset = 0;
let dashboardUrl = '';
let pendingDashboardUrl = '';
let dashboardNavigationGeneration = 0;
let recallCapture: RecallDesktopCapture | null = null;
const localMeetingRecorder = new LocalMeetingRecorder();
let quitPrepared = false;
const RECALL_TRAY_STATE_EVENTS = new Set([
  'recording-start-requested',
  'recording-started',
  'recording-ended',
  'recording-stop-requested',
  'shutdown',
  'error',
]);

const CLEMENTINE_NOTCH_PATCH_KEYS = new Set([
  'enabled',
  'behavior',
  'autoHideAfterCompletion',
  'promptForDetectedMeetings',
  'shortcut',
  'preferredDisplay',
]);

function managedClementineLiveShortcut(): string | null {
  const managed = process.env.CLEMMY_LIVE_SHORTCUT?.trim();
  return managed ? resolveClementineLiveShortcut(managed) : null;
}

function effectiveClementineLiveShortcut(
  preferences: ClementineNotchPreferences = clementineNotchPreferences,
): string {
  return managedClementineLiveShortcut() ?? resolveClementineLiveShortcut(preferences.shortcut);
}

function clementineLiveCaptureRequiresControls(): boolean {
  // Recall reports an accepted Notch start intent as `starting` before any
  // asynchronous initialization or auto-record persistence. This makes the
  // same native guard cover the entire operation, not only the SDK handshake.
  return recallCaptureRequiresVisibleControls(recallCapture?.status());
}

function initializeClementineNotchPreferencesStore(): void {
  clementineNotchPreferencesFile = clementineNotchPreferencesPath(app.getPath('userData'));
  if (existsSync(clementineNotchPreferencesFile)) {
    clementineNotchPreferences = loadClementineNotchPreferences(clementineNotchPreferencesFile);
  } else {
    clementineNotchPreferences = { ...DEFAULT_CLEMENTINE_NOTCH_PREFERENCES };
  }
  // Task-driven auto-presentation is intentionally gated until the preview is
  // replaced by authoritative run data. Never silently run that mode as if it
  // were connected.
  if (clementineNotchPreferences.behavior === 'working') {
    clementineNotchPreferences = { ...clementineNotchPreferences, behavior: 'manual' };
  }
}

function validateClementineNotchPatch(patch: unknown): string | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Invalid notch settings update.';
  const raw = patch as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => !CLEMENTINE_NOTCH_PATCH_KEYS.has(key));
  if (unknown) return `Unknown notch setting: ${unknown}`;
  for (const key of ['enabled', 'autoHideAfterCompletion', 'promptForDetectedMeetings'] as const) {
    if (key in raw && typeof raw[key] !== 'boolean') return `${key} must be true or false.`;
  }
  if ('behavior' in raw && !['manual', 'working', 'always'].includes(String(raw.behavior))) {
    return 'Invalid notch behavior.';
  }
  if (raw.behavior === 'working') {
    return 'Show while working will be available when the notch is connected to live task data.';
  }
  if ('preferredDisplay' in raw && !['pointer', 'primary'].includes(String(raw.preferredDisplay))) {
    return 'Invalid preferred display.';
  }
  if ('shortcut' in raw) {
    if (typeof raw.shortcut !== 'string') return 'Shortcut must be text.';
    const shortcut = raw.shortcut.trim();
    if (!shortcut || shortcut.length > 80 || /[\u0000-\u001f\u007f]/.test(shortcut)) {
      return 'Choose a valid keyboard shortcut.';
    }
    if (process.env.CLEMMY_LIVE_SHORTCUT?.trim()) {
      return 'The shortcut is managed by CLEMMY_LIVE_SHORTCUT in this environment.';
    }
  }
  return null;
}

/** Register the replacement before dropping the old accelerator. A conflict
 * therefore leaves the working shortcut untouched. */
function registerClementineLiveShortcut(shortcut: string): boolean {
  const next = resolveClementineLiveShortcut(shortcut);
  if (clementineLiveRegisteredShortcut === next && globalShortcut.isRegistered(next)) {
    clementineLiveShortcutError = null;
    return true;
  }
  let registered = false;
  try {
    registered = globalShortcut.register(next, () => { toggleClementineLivePanel(); });
  } catch {
    registered = false;
  }
  if (!registered) {
    clementineLiveShortcutError = 'That shortcut is already in use.';
    console.warn(`[main] Clementine notch shortcut is unavailable: ${next}`);
    return false;
  }
  const previous = clementineLiveRegisteredShortcut;
  clementineLiveRegisteredShortcut = next;
  clementineLiveShortcutError = null;
  if (previous && previous !== next) globalShortcut.unregister(previous);
  rebuildTrayMenu();
  return true;
}

/** Register the global "start talking" accelerator. Best-effort: a conflict just
 * leaves voice reachable via the in-notch mic button. */
function registerClementineVoiceShortcut(): void {
  const next = DEFAULT_CLEMENTINE_VOICE_SHORTCUT;
  if (clementineLiveVoiceRegisteredShortcut === next && globalShortcut.isRegistered(next)) return;
  let registered = false;
  try {
    registered = globalShortcut.register(next, () => { startClementineLiveVoice(); });
  } catch {
    registered = false;
  }
  if (registered) {
    clementineLiveVoiceRegisteredShortcut = next;
  } else {
    console.warn(`[main] Clementine voice shortcut is unavailable: ${next}`);
  }
}

interface ClementineLiveShortcutReservation {
  ok: boolean;
  shortcut: string;
  newlyRegistered: boolean;
}

/** Reserve a candidate without releasing the currently working shortcut.
 * The caller commits the swap only after durable preference persistence. */
function reserveClementineLiveShortcut(shortcut: string): ClementineLiveShortcutReservation {
  const next = resolveClementineLiveShortcut(shortcut);
  if (clementineLiveRegisteredShortcut === next && globalShortcut.isRegistered(next)) {
    return { ok: true, shortcut: next, newlyRegistered: false };
  }
  let registered = false;
  try {
    registered = globalShortcut.register(next, () => { toggleClementineLivePanel(); });
  } catch {
    registered = false;
  }
  if (!registered) {
    clementineLiveShortcutError = 'That shortcut is already in use.';
    console.warn(`[main] Clementine notch shortcut is unavailable: ${next}`);
  }
  return { ok: registered, shortcut: next, newlyRegistered: registered };
}

function clementineNotchSnapshot() {
  return {
    supported: process.platform === 'darwin',
    preview: true,
    taskDrivenBehaviorAvailable: false,
    shortcutManagedByEnvironment: Boolean(managedClementineLiveShortcut()),
    preferences: {
      ...clementineNotchPreferences,
      shortcut: effectiveClementineLiveShortcut(),
    },
    runtime: {
      availability: clementineLiveAvailability,
      visible: clementineLiveWindow?.isVisible() ?? false,
      shortcutRegistered: Boolean(clementineLiveRegisteredShortcut),
      shortcutError: clementineLiveShortcutError ?? undefined,
      clickHelper: clementineNotchClickHelperHealth,
      clickHelperError: clementineNotchClickHelperError ?? undefined,
      canOpenPreview: Boolean(
        clementineNotchPreferences.enabled
        && clementineLiveAvailability === 'ready'
        && clementineLiveWindow
        && !clementineLiveWindow.isDestroyed(),
      ),
    },
    meetingCapture: sanitizeRecallStatusForNotch(recallCapture?.status()),
  };
}

function updateClementineNotchPreferences(patch: unknown) {
  const validationError = validateClementineNotchPatch(patch);
  if (validationError) return { ok: false as const, error: validationError, snapshot: clementineNotchSnapshot() };
  if (process.platform !== 'darwin') {
    return { ok: false as const, error: 'The notch is available in the macOS app.', snapshot: clementineNotchSnapshot() };
  }

  const raw = patch as Record<string, unknown>;
  const previous = clementineNotchPreferences;
  const next = patchClementineNotchPreferences(previous, patch);
  if (raw.enabled === false && clementineLiveCaptureRequiresControls()) {
    return {
      ok: false as const,
      error: 'Stop the active meeting recording before turning off Clementine in the notch.',
      snapshot: clementineNotchSnapshot(),
    };
  }
  const shortcutChanged = Object.prototype.hasOwnProperty.call(raw, 'shortcut');
  const needsShortcutRegistration = next.enabled
    && (shortcutChanged || !previous.enabled || !clementineLiveRegisteredShortcut);
  const reservation = needsShortcutRegistration
    ? reserveClementineLiveShortcut(effectiveClementineLiveShortcut(next))
    : null;
  if (reservation && !reservation.ok) {
    return { ok: false as const, error: clementineLiveShortcutError ?? 'That shortcut could not be registered.', snapshot: clementineNotchSnapshot() };
  }

  try {
    clementineNotchPreferences = saveClementineNotchPreferences(clementineNotchPreferencesFile, next);
  } catch (error) {
    // The previous accelerator was deliberately retained during the write.
    // Rollback only the uncommitted candidate, leaving native state truthful.
    if (reservation?.newlyRegistered) globalShortcut.unregister(reservation.shortcut);
    clementineNotchPreferences = previous;
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : 'Could not save notch settings.',
      snapshot: clementineNotchSnapshot(),
    };
  }

  if (reservation?.ok) {
    const previousRegisteredShortcut = clementineLiveRegisteredShortcut;
    clementineLiveRegisteredShortcut = reservation.shortcut;
    clementineLiveShortcutError = null;
    if (previousRegisteredShortcut && previousRegisteredShortcut !== reservation.shortcut) {
      globalShortcut.unregister(previousRegisteredShortcut);
    }
  } else if (!next.enabled || shortcutChanged) {
    clementineLiveShortcutError = null;
  }

  if (!clementineNotchPreferences.enabled) {
    disposeClementineLiveShell();
    clementineLiveShortcutError = null;
  } else {
    initializeClementineLiveShell();
    ensureClementineLiveWindow();
    positionClementineLiveWindow(true);
    if (clementineNotchPreferences.behavior === 'always') {
      if (!showClementineLive(false)) {
        clementineLivePendingReveal = 'passive';
        clementineLivePendingRevealPresentation = 'dormant';
      }
    }
  }
  rebuildTrayMenu();
  return { ok: true as const, snapshot: clementineNotchSnapshot() };
}

function revealWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
  if (process.platform === 'darwin') {
    try {
      app.focus({ steal: true });
    } catch {
      app.focus();
    }
  }
  win.focus();
}

function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (dashboardUrl) {
      mainWindow = createMainWindow(dashboardUrl);
    } else {
      return;
    }
  }
  revealWindow(mainWindow);
}
let quitPreparing = false;
let installQuitFallback: NodeJS.Timeout | null = null;
let cachedWebhookSecret = '';

type RendererSurface = 'dashboard' | 'live' | 'setup' | 'splash';

function dashboardOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const rawUrl of [dashboardUrl, pendingDashboardUrl]) {
    if (!rawUrl) continue;
    try { origins.add(new URL(rawUrl).origin); }
    catch { /* ignore invalid transition URLs */ }
  }
  return origins;
}

function currentSupervisorDashboardUrl(): string {
  if (!supervisor?.getPort()) return dashboardUrl;
  return supervisor.getDashboardUrl(getWebhookSecret());
}

function repointDashboardToLiveDaemon(): void {
  const nextUrl = currentSupervisorDashboardUrl();
  if (!nextUrl) return;
  const navigationGeneration = ++dashboardNavigationGeneration;
  const win = mainWindow;
  if (!win || win.isDestroyed()) {
    dashboardUrl = nextUrl;
    pendingDashboardUrl = '';
    void repointClementineLiveWindow(nextUrl);
    return;
  }

  // Keep both the old and new origins trusted while Electron performs the
  // main-process-owned navigation. Commit the new origin only after loadURL
  // succeeds, so a failed load leaves the old renderer able to use recovery
  // IPC. Reload even when the port is unchanged: a ready event means a new
  // daemon instance and its page/session should be bootstrapped afresh.
  // Finalize any active local capture FIRST — this navigation replaces the
  // renderer that owns the mic pump, so waiting preserves the recorded prefix
  // instead of orphaning it (belt: did-start-navigation catches this too, but
  // awaiting here guarantees the stop lands before the page is torn down).
  pendingDashboardUrl = nextUrl;
  void finalizeOrphanedLocalCapture('the daemon restarted').then(() => win.loadURL(nextUrl)).then(() => {
    if (dashboardNavigationGeneration !== navigationGeneration) return;
    dashboardUrl = nextUrl;
    pendingDashboardUrl = '';
    void repointClementineLiveWindow(nextUrl);
  }).catch((error) => {
    if (dashboardNavigationGeneration === navigationGeneration) pendingDashboardUrl = '';
    const message = error instanceof Error ? error.message : String(error);
    console.error('[main] failed to reconnect dashboard to live daemon:', redactSensitiveText(message));
  });
}

function isSafeExternalHttps(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'discord.com'
      || host.endsWith('.discord.com')
      || host === 'dashboard.composio.dev'
      || host === 'app.composio.dev'
      || host === 'platform.openai.com'
      || host === 'auth.openai.com'
      || host === 'github.com';
  } catch {
    return false;
  }
}

/**
 * Should a link the user CLICKS in the dashboard open in their external
 * browser? Any well-formed http(s) URL qualifies. Clementine surfaces links
 * to anything — a Salesforce record, a client's site, a doc — and a curated
 * host allowlist (the old `isSafeExternalHttps` gate) silently swallowed every
 * link not on it. That was the "I can't click links in the desktop app" bug.
 * We still block non-web schemes (file:, javascript:, custom app schemes) so a
 * crafted link can't trigger a local handler via shell.openExternal.
 * `isSafeExternalHttps` stays the tighter allowlist for PROGRAMMATIC opens
 * (the setup auth flow), where the narrow set is the correct posture.
 */
function isExternalHttpUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function senderSurface(url: string): RendererSurface | null {
  if (url.startsWith('data:text/html')) return 'splash';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      const filePath = fileURLToPath(parsed);
      const setupRoot = path.join(app.getPath('userData'), 'wizard');
      if (filePath.startsWith(setupRoot + path.sep) || filePath === path.join(setupRoot, 'setup.html')) return 'setup';
    }
    if (dashboardOrigins().has(parsed.origin)) {
      if (/^\/console\/notch(?:\/|$)/i.test(parsed.pathname)) return 'live';
      return 'dashboard';
    }
  } catch {
    return null;
  }
  return null;
}

function assertIpcSender(event: IpcMainInvokeEvent, allowed: RendererSurface[]): void {
  const url = event.senderFrame?.url || event.sender.getURL();
  const surface = senderSurface(url);
  if (!surface || !allowed.includes(surface)) {
    throw new Error(`Blocked IPC call from unauthorized renderer: ${redactSensitiveText(url || 'unknown')}`);
  }
}

/** Non-web protocols that should be handed to the OS (the dialer, mail client,
 *  etc.) rather than navigated to — clicking a `tel:` link inside a Workspace
 *  view would otherwise blank the iframe (Electron has no tel: handler). */
function isExternalProtocol(rawUrl: string): boolean {
  return /^(tel:|callto:|sms:|mailto:|facetime:|facetime-audio:|maps:|webcal:|zoommtg:|msteams:)/i.test(rawUrl || '');
}

function guardWindow(win: BrowserWindow, allowed: RendererSurface[]): void {
  function allowedUrl(rawUrl: string): boolean {
    const surface = senderSurface(rawUrl);
    return Boolean(surface && allowed.includes(surface));
  }
  // Shared nav guard for the top frame AND sub-frames (Workspace views render in
  // an iframe, so tel:/mailto: clicks arrive via will-frame-navigate).
  const guardNav = (event: { preventDefault: () => void }, url: string): void => {
    if (isExternalProtocol(url)) { event.preventDefault(); void shell.openExternal(url); return; }
    if (allowedUrl(url)) return; // in-app navigation (incl. /console/spaces/:id/view) is fine
    event.preventDefault();
    if (isExternalHttpUrl(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    // A clicked link (target=_blank / window.open) → hand off to the OS.
    if (isExternalProtocol(url) || isExternalHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => guardNav(event, url));
  // Sub-frame navigations (the Workspace iframe). Without this a tel: click in a
  // Workspace view navigates the iframe to tel: and blanks it.
  win.webContents.on('will-frame-navigate', (event) => guardNav(event, event.url));
}

function clearClementineLiveRetryTimer(): void {
  if (!clementineLiveRetryTimer) return;
  clearTimeout(clementineLiveRetryTimer);
  clementineLiveRetryTimer = null;
}

function clearClementineLiveHandshakeTimer(): void {
  if (!clementineLiveHandshakeTimer) return;
  clearTimeout(clementineLiveHandshakeTimer);
  clementineLiveHandshakeTimer = null;
}

function setClementineLiveAvailability(next: ClementineLiveAvailability): void {
  clementineLiveAvailability = next;
  const win = clementineLiveWindow;
  if (next !== 'ready' && win && !win.isDestroyed() && win.isVisible()) win.hide();
  syncClementineNotchClickHelper();
  rebuildTrayMenu();
}

function markClementineLiveRendererReady(
  win: BrowserWindow,
  mount: ClementineLiveMountIdentity,
): boolean {
  if (win !== clementineLiveWindow || win.isDestroyed() || win.webContents.isDestroyed()
      || !isCurrentClementineLiveMount(clementineLiveCurrentMount, mount)) return false;
  const becameReady = clementineLiveAvailability !== 'ready';
  clearClementineLiveRetryTimer();
  clearClementineLiveHandshakeTimer();
  clementineLiveRetryAttempts = 0;
  if (becameReady) {
    setClementineLiveAvailability('ready');
    emitClementineLiveShellState('ready');
    if (clementineLivePendingVoice) {
      clementineLivePendingVoice = false;
      emitClementineLivePreview({ kind: 'start-voice' });
    }
    if (clementineLivePendingToggle) {
      clementineLivePendingToggle = false;
      emitClementineLivePreview({ kind: 'toggle-expand' });
    }
    if (clementineLivePendingExpand) {
      clementineLivePendingExpand = false;
      emitClementineLivePreview({ kind: 'expand' });
    }
    revealClementineLiveAfterLayout(clementineLivePresentation);
    // Explicit panel intents are revealed by their acknowledged layout request,
    // not by readiness itself. With no pending transition, "always" may show
    // the already-sized dormant surface immediately.
    if (clementineNotchPreferences.enabled
        && !clementineLivePendingReveal
        && clementineNotchPreferences.behavior === 'always') {
      showClementineLive(false);
    }
  }
  return true;
}

function armClementineLiveHandshakeTimeout(
  win: BrowserWindow,
  mount: ClementineLiveMountIdentity,
): void {
  clearClementineLiveHandshakeTimer();
  if (win !== clementineLiveWindow || clementineLiveAvailability === 'ready'
      || !isCurrentClementineLiveMount(clementineLiveCurrentMount, mount)) return;
  clementineLiveHandshakeTimer = setTimeout(() => {
    clementineLiveHandshakeTimer = null;
    if (win !== clementineLiveWindow || win.isDestroyed() || clementineLiveAvailability === 'ready'
        || !isCurrentClementineLiveMount(clementineLiveCurrentMount, mount)) return;
    // A 401/404 document can finish loading successfully. Only the React
    // surface's explicit generation-bound acknowledgement proves that the
    // companion mounted. A timeout uses the same bounded recovery budget as a
    // failed navigation or renderer crash.
    scheduleClementineLiveRecovery(win, 'mount handshake timeout');
  }, CLEMENTINE_LIVE_HANDSHAKE_TIMEOUT_MS);
}

function scheduleClementineLiveRecovery(win: BrowserWindow, reason: string): void {
  if (win !== clementineLiveWindow || win.isDestroyed()) return;
  clearClementineLiveHandshakeTimer();
  if (clementineLiveRetryTimer) return;
  if (clementineLiveRetryAttempts >= CLEMENTINE_LIVE_MAX_RETRIES) {
    console.error(`[main] Clementine Live unavailable after ${clementineLiveRetryAttempts} retries (${reason})`);
    clementineLiveCurrentMount = null;
    setClementineLiveAvailability('unavailable');
    return;
  }
  const scheduledMount = clementineLiveCurrentMount;
  clementineLiveRetryAttempts += 1;
  setClementineLiveAvailability('loading');
  const delayMs = 400 * clementineLiveRetryAttempts;
  clementineLiveRetryTimer = setTimeout(() => {
    clementineLiveRetryTimer = null;
    if (scheduledMount && !isCurrentClementineLiveMount(clementineLiveCurrentMount, scheduledMount)) return;
    if (clementineLiveAvailability === 'ready') return;
    if (win !== clementineLiveWindow || win.isDestroyed() || !dashboardUrl) {
      clementineLiveCurrentMount = null;
      setClementineLiveAvailability('unavailable');
      return;
    }
    if (win.webContents.isDestroyed()) {
      clementineLiveWindow = null;
      win.destroy();
      ensureClementineLiveWindow(false);
      return;
    }
    void loadClementineLiveDocument(win, dashboardUrl, false);
  }, delayMs);
}

async function loadClementineLiveDocument(
  win: BrowserWindow,
  nextDashboardUrl: string,
  resetRetryBudget: boolean,
): Promise<void> {
  if (resetRetryBudget) {
    clementineLiveRetryAttempts = 0;
    clearClementineLiveRetryTimer();
  }
  clearClementineLiveHandshakeTimer();
  const mount = createClementineLiveMountIdentity(clementineLiveNavigationGeneration);
  clementineLiveNavigationGeneration = mount.generation;
  clementineLiveCurrentMount = mount;
  setClementineLiveAvailability('loading');
  try {
    await win.loadURL(clementineLiveUrlForDashboard(nextDashboardUrl, mount));
    if (win !== clementineLiveWindow || win.isDestroyed()
        || !isCurrentClementineLiveMount(clementineLiveCurrentMount, mount)) return;
    armClementineLiveHandshakeTimeout(win, mount);
  } catch (error) {
    if (!isCurrentClementineLiveMount(clementineLiveCurrentMount, mount)) return;
    const message = error instanceof Error ? error.message : String(error);
    if (/ERR_ABORTED|operation was aborted/i.test(message)) return;
    console.error('[main] failed to load Clementine Live:', redactSensitiveText(message));
    scheduleClementineLiveRecovery(win, 'load failure');
  }
}

function resolveClementineLiveDisplay(preferPointer = false): Display {
  if (clementineNotchPreferences.preferredDisplay === 'primary') return screen.getPrimaryDisplay();
  if (preferPointer) return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const remembered = clementineLiveDisplayId === null
    ? undefined
    : screen.getAllDisplays().find((display) => display.id === clementineLiveDisplayId);
  return remembered ?? screen.getPrimaryDisplay();
}

function positionClementineLiveWindow(preferPointer = false): void {
  const win = clementineLiveWindow;
  if (!win || win.isDestroyed()) return;
  const display = resolveClementineLiveDisplay(preferPointer);
  const nativeAnchor = clementineLiveNativeAnchors.get(display.id);
  const computedGeometry = computeClementineLiveGeometry({
    bounds: display.bounds,
    workArea: display.workArea,
    requestedSize: clementineLiveSize,
    presentation: clementineLivePresentation,
    topInsetOverride: nativeAnchor?.topInset,
  });
  const dormantAnchor = clementineLivePresentation === 'dormant' ? nativeAnchor : undefined;
  const anchoredX = dormantAnchor ? Math.round(display.bounds.x + dormantAnchor.x) : computedGeometry.x;
  const anchoredY = dormantAnchor ? Math.round(display.bounds.y + dormantAnchor.y) : computedGeometry.y;
  const geometry = dormantAnchor
    && anchoredX >= display.bounds.x
    && anchoredY >= display.bounds.y
    && anchoredX + computedGeometry.width <= display.bounds.x + display.bounds.width
    && anchoredY + computedGeometry.height <= display.bounds.y + display.bounds.height
    ? { ...computedGeometry, x: anchoredX, y: anchoredY }
    : computedGeometry;
  if (clementineLiveLastTopInset !== geometry.topInset) {
    clementineLiveLastTopInset = geometry.topInset;
    emitClementineLiveShellState('inset');
  }
  const cur = win.getBounds();
  const alreadyPlaced = clementineLiveDisplayId === display.id
    && cur.x === geometry.x && cur.y === geometry.y
    && cur.width === geometry.width && cur.height === geometry.height;
  clementineLiveDisplayId = display.id;
  if (alreadyPlaced) {
    syncClementineNotchClickHelper();
    return;
  }
  // macOS notch apps are most reliable when their native window matches the
  // visible surface and remains interactive for its whole lifetime. Resize the
  // frame first, then reassert its level and top-edge position last so AppKit
  // cannot retain a stale/clamped frame from the previous presentation.
  win.setBounds({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
  }, false);
  win.setAlwaysOnTop(
    true,
    CLEMENTINE_LIVE_WINDOW_LEVEL.name,
    CLEMENTINE_LIVE_WINDOW_LEVEL.relativeLevel,
  );
  win.setPosition(geometry.x, geometry.y, false);
  syncClementineNotchClickHelper();
}

function syncClementineNotchClickHelper(): void {
  const helper = clementineNotchClickHelper;
  const win = clementineLiveWindow;
  if (!helper || !win || win.isDestroyed()) return;
  const windowFrame = win.getBounds();
  const display = screen.getAllDisplays().find((candidate) => candidate.id === clementineLiveDisplayId)
    ?? screen.getDisplayMatching(windowFrame);
  // Always give AppKit the dormant target geometry, even while the Electron
  // panel is expanded. This lets the helper continuously report NSScreen safe
  // areas without deriving the notch boundary from a 392px panel envelope.
  const nativeAnchor = clementineLiveNativeAnchors.get(display.id);
  const dormantGeometry = computeClementineLiveGeometry({
    bounds: display.bounds,
    workArea: display.workArea,
    requestedSize: DEFAULT_CLEMENTINE_LIVE_DORMANT_SIZE,
    presentation: 'dormant',
    topInsetOverride: nativeAnchor?.topInset,
  });
  const anchoredDormant = nativeAnchor
    ? {
      ...dormantGeometry,
      x: Math.round(display.bounds.x + nativeAnchor.x),
      y: Math.round(display.bounds.y + nativeAnchor.y),
    }
    : dormantGeometry;
  const globalFrame = anchoredDormant.x >= display.bounds.x
    && anchoredDormant.y >= display.bounds.y
    && anchoredDormant.x + anchoredDormant.width <= display.bounds.x + display.bounds.width
    && anchoredDormant.y + anchoredDormant.height <= display.bounds.y + display.bounds.height
    ? anchoredDormant
    : dormantGeometry;
  helper.configure({
    enabled: clementineNotchPreferences.enabled
      && clementineLiveAvailability === 'ready'
      && win.isVisible()
      && clementineLivePresentation === 'dormant',
    state: clementineLivePresentation,
    displayId: display.id,
    frame: toDisplayLocalNotchFrame(globalFrame, display.bounds),
  });
}

function emitClementineLivePreview(payload: unknown): void {
  const win = clementineLiveWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send('clemmy:live-preview', payload);
  } catch {
    // A renderer can disappear between the liveness check and send. Its
    // render-process-gone handler owns bounded recovery.
  }
}

function emitClementineLiveMeetingPresentation(expanded: boolean): void {
  emitClementineLivePreview({ kind: expanded ? 'meeting-expand' : 'meeting-collapse' });
}

function revealClementineLiveAfterLayout(presentation: ClementineLivePresentation): void {
  if (!clementineLivePendingReveal
      || clementineLivePendingRevealPresentation !== presentation
      || clementineLiveAvailability !== 'ready') return;
  const activate = clementineLivePendingReveal === 'manual';
  clementineLivePendingReveal = null;
  clementineLivePendingRevealPresentation = null;
  showClementineLive(activate);
}

function handleClementineLiveRecallEvent(event: Record<string, unknown>): void {
  if (!clementineNotchPreferences.enabled) return;
  const safeEvent = sanitizeRecallEventForNotch(event);
  if (!safeEvent) return;
  const win = ensureClementineLiveWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    try {
      win.webContents.send('clemmy:live-meeting-event', safeEvent);
    } catch {
      // Status hydration on the next mount recovers the authoritative phase.
    }
  }

  const shouldReveal = safeEvent.type === 'recording-start-requested'
    || safeEvent.type === 'recording-started'
    || safeEvent.type === 'recording-start-failed'
    || safeEvent.type === 'recording-blocked'
    || (safeEvent.type === 'meeting-prompt-required'
      && clementineNotchPreferences.promptForDetectedMeetings);
  if (!shouldReveal) return;
  if (!clementineLiveWindow?.isVisible()) {
    clementineLivePendingReveal = 'passive';
    clementineLivePendingRevealPresentation = 'panel';
  }
}

function emitClementineLiveShellState(reason: string): void {
  emitClementineLivePreview({
    kind: 'shell-state',
    reason,
    visible: clementineLiveWindow?.isVisible() ?? false,
    shortcut: effectiveClementineLiveShortcut(),
    topInset: clementineLiveLastTopInset,
  });
}

async function repointClementineLiveWindow(nextDashboardUrl: string): Promise<void> {
  const win = clementineLiveWindow;
  if (process.platform !== 'darwin' || !win || win.isDestroyed()) return;
  await loadClementineLiveDocument(win, nextDashboardUrl, true);
}

function ensureClementineLiveWindow(resetRetryBudget = true): BrowserWindow | null {
  if (process.platform !== 'darwin' || !clementineNotchPreferences.enabled || !dashboardUrl) return null;
  if (clementineLiveWindow
      && !clementineLiveWindow.isDestroyed()
      && !clementineLiveWindow.webContents.isDestroyed()) {
    if (clementineLiveAvailability !== 'unavailable' || !resetRetryBudget) return clementineLiveWindow;
    // A user retry, shortcut, or safety-critical meeting event must be able to
    // recover after the bounded automatic retry budget was exhausted.
    const unavailableWindow = clementineLiveWindow;
    clementineLiveWindow = null;
    unavailableWindow.destroy();
  }
  if (clementineLiveWindow && !clementineLiveWindow.isDestroyed()) clementineLiveWindow.destroy();
  clementineLiveWindow = null;

  const display = resolveClementineLiveDisplay();
  clementineLiveDisplayId = display.id;
  const geometry = computeClementineLiveGeometry({
    bounds: display.bounds,
    workArea: display.workArea,
    requestedSize: clementineLiveSize,
    presentation: clementineLivePresentation,
  });
  clementineLiveLastTopInset = geometry.topInset;
  const win = new BrowserWindow({
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Keep this a normal, focusable BrowserWindow so the dormant dog accepts its
    // first click. The exact frame is always interactive; there is no large
    // click-through overlay whose input mode must change while the pointer moves.
    ...CLEMENTINE_LIVE_WINDOW_INTERACTION_OPTIONS,
    enableLargerThanScreen: true,
    hiddenInMissionControl: true,
    title: 'Clementine',
    webPreferences: {
      partition: 'clementine-dashboard',
      preload: clementineLivePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  clementineLiveWindow = win;
  clementineLiveAvailability = 'loading';
  guardWindow(win, ['live']);
  // Native notch panels sit just above NSMainMenuWindowLevel. The screen-saver
  // level can paint over the reserved strip, but macOS may still route clicks to
  // its menu-bar layer; main-menu + 3 remains above that layer and accepts input.
  win.setAlwaysOnTop(
    true,
    CLEMENTINE_LIVE_WINDOW_LEVEL.name,
    CLEMENTINE_LIVE_WINDOW_LEVEL.relativeLevel,
  );
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(false);
  win.on('close', (event) => {
    if (!(app as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      if (clementineLiveCaptureRequiresControls()) {
        const phase = recallCapture?.status().capturePhase;
        emitClementineLiveMeetingPresentation(phase !== 'recording');
        win.showInactive();
        win.moveTop();
      } else {
        win.hide();
      }
    }
  });
  win.on('show', () => {
    syncClementineNotchClickHelper();
    emitClementineLiveShellState('shown');
    rebuildTrayMenu();
  });
  win.on('hide', () => {
    syncClementineNotchClickHelper();
    emitClementineLiveShellState('dismissed');
    rebuildTrayMenu();
  });
  win.on('closed', () => {
    if (clementineLiveWindow === win) {
      clementineLiveWindow = null;
      clementineLiveAvailability = 'unavailable';
      clementineLiveCurrentMount = null;
      clearClementineLiveRetryTimer();
      clearClementineLiveHandshakeTimer();
    }
    clementineNotchClickHelper?.configure({
      enabled: false,
      state: 'panel',
      displayId: 0,
      frame: { x: 0, y: 0, width: 1, height: 1 },
    });
    rebuildTrayMenu();
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    const failedMount = clementineLiveMountFromUrl(url);
    if (!failedMount || !isCurrentClementineLiveMount(clementineLiveCurrentMount, failedMount)) return;
    console.error('[main] Clementine Live did-fail-load', code, description, redactSensitiveText(url));
    scheduleClementineLiveRecovery(win, `navigation error ${code}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] Clementine Live renderer exited:', details.reason);
    scheduleClementineLiveRecovery(win, `renderer ${details.reason}`);
  });
  void loadClementineLiveDocument(win, dashboardUrl, resetRetryBudget);
  rebuildTrayMenu();
  return win;
}

function showClementineLive(activate = true): boolean {
  if (!clementineNotchPreferences.enabled) return false;
  const win = clementineLiveWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed() || clementineLiveAvailability !== 'ready') return false;
  positionClementineLiveWindow(true);
  if (activate) win.show();
  else win.showInactive();
  win.moveTop();
  if (activate) win.focus();
  clementineLivePendingReveal = null;
  clementineLivePendingRevealPresentation = null;
  return true;
}

function dismissClementineLive(): boolean {
  clementineLivePendingReveal = null;
  clementineLivePendingRevealPresentation = null;
  const win = clementineLiveWindow;
  if (!win || win.isDestroyed()) return false;
  if (clementineLiveCaptureRequiresControls()) {
    const phase = recallCapture?.status().capturePhase;
    emitClementineLiveMeetingPresentation(phase !== 'recording');
    win.showInactive();
    win.moveTop();
    return false;
  }
  win.hide();
  return true;
}

function toggleClementineLive(): boolean {
  if (!clementineNotchPreferences.enabled) return false;
  const win = ensureClementineLiveWindow();
  if (!win || win.isDestroyed()) {
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = clementineLiveCaptureRequiresControls() ? 'panel' : clementineLivePresentation;
    return false;
  }
  if (clementineLiveCaptureRequiresControls()) {
    emitClementineLiveMeetingPresentation(true);
    if (showClementineLive(true)) return true;
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
    return false;
  }
  if (win.isVisible()) {
    dismissClementineLive();
    return false;
  }
  if (showClementineLive()) return true;
  clementineLivePendingReveal = 'manual';
  clementineLivePendingRevealPresentation = clementineLivePresentation;
  return false;
}

/** The configurable notch shortcut OPENS (expands) the always-present notch —
 * it no longer hides the window (the dormant logo stays put). Mirrors clicking
 * the logo: toggle the panel open/closed. */
function toggleClementineLivePanel(): boolean {
  if (!clementineNotchPreferences.enabled) return false;
  if (clementineLiveCaptureRequiresControls()) return toggleClementineLive();
  const win = ensureClementineLiveWindow();
  if (!win || win.isDestroyed()) {
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
    return false;
  }
  const plan = planClementineLivePanelToggle({
    availability: clementineLiveAvailability,
    visible: win.isVisible(),
  });
  if (plan === 'defer') {
    clementineLivePendingToggle = true;
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
    return false;
  }
  if (plan === 'show-and-toggle') {
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
  }
  clementineLivePendingToggle = false;
  win.moveTop();
  emitClementineLivePreview({ kind: 'toggle-expand' });
  return true;
}

/** Keep explicit open requests idempotent so settings and deferred shell
 * intents always converge on an expanded panel instead of toggling twice. */
function expandClementineLivePanel(): boolean {
  if (!clementineNotchPreferences.enabled) return false;
  if (clementineNotchClickHelperHealth === 'degraded') {
    clementineNotchClickHelper?.retry();
  }
  const win = ensureClementineLiveWindow();
  if (!win || win.isDestroyed()) {
    clementineLivePendingExpand = true;
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
    return false;
  }
  if (clementineLiveAvailability !== 'ready') {
    clementineLivePendingExpand = true;
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
    return false;
  }
  if (!win.isVisible()) {
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
  }
  clementineLivePendingExpand = false;
  win.moveTop();
  win.focus();
  emitClementineLivePreview({ kind: 'expand' });
  return true;
}

function startClementineLiveVoice(): boolean {
  if (!clementineNotchPreferences.enabled) return false;
  const win = ensureClementineLiveWindow();
  // A voice request always needs an activated panel. Arm the reveal even when
  // the dormant window is already visible so macOS can grant renderer focus for
  // microphone permission and the acknowledged voice layout opens in place.
  clementineLivePendingReveal = 'manual';
  clementineLivePendingRevealPresentation = 'panel';
  if (!win || win.isDestroyed()) {
    clementineLivePendingVoice = true;
    return false;
  }
  // Reveal the notch (activated, so the renderer holds focus for the mic prompt)
  // and tell it to open a voice session. If the surface isn't mounted yet, defer
  // the signal until the renderer acknowledges readiness.
  if (clementineLiveAvailability !== 'ready') {
    clementineLivePendingVoice = true;
    return false;
  }
  clementineLivePendingVoice = false;
  emitClementineLivePreview({ kind: 'start-voice' });
  return true;
}

function openConsoleFromClementineLive(): void {
  if (clementineLiveCaptureRequiresControls()) {
    const phase = recallCapture?.status().capturePhase;
    emitClementineLiveMeetingPresentation(phase !== 'recording');
  } else {
    dismissClementineLive();
  }
  revealMainWindow();
}

function handleClementineLiveDisplayChange(): void {
  const currentDisplayIds = new Set(screen.getAllDisplays().map((display) => display.id));
  for (const displayId of clementineLiveNativeAnchors.keys()) {
    if (!currentDisplayIds.has(displayId)) clementineLiveNativeAnchors.delete(displayId);
  }
  if (clementineLiveDisplayId !== null
      && !screen.getAllDisplays().some((display) => display.id === clementineLiveDisplayId)) {
    clementineLiveDisplayId = null;
  }
  positionClementineLiveWindow();
}

function initializeClementineLiveShell(): void {
  if (process.platform !== 'darwin' || !clementineNotchPreferences.enabled || clementineLiveShellInitialized) return;
  clementineLiveShellInitialized = true;
  clementineNotchClickHelper = new ClementineNotchClickHelper({
    executablePath: resolveNotchClickHelperPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    onActivate: () => {
      // A physical click on the dormant Clementine is the voice-first entry
      // point. The renderer then streams interim dictation and auto-sends after
      // silence; explicit settings/shortcut opens can still show status.
      startClementineLiveVoice();
      const rearmTimer = setTimeout(() => syncClementineNotchClickHelper(), 750);
      rearmTimer.unref?.();
    },
    onHover: (active) => emitClementineLivePreview({ kind: 'native-hover', active }),
    onHealth: (health, reason) => {
      clementineNotchClickHelperHealth = health;
      clementineNotchClickHelperError = health === 'degraded'
        ? (reason ?? 'The native notch click target is unavailable.')
        : null;
      rebuildTrayMenu();
    },
    onAnchor: (event) => {
      const display = screen.getAllDisplays().find((candidate) => candidate.id === event.displayId);
      if (!display) return;
      const next = {
        x: Math.round(event.x),
        y: Math.round(event.y),
        topInset: Math.round(event.topInset),
      };
      const previous = clementineLiveNativeAnchors.get(event.displayId);
      if (previous?.x === next.x && previous.y === next.y && previous.topInset === next.topInset) return;
      clementineLiveNativeAnchors.set(event.displayId, next);
      if (clementineLiveDisplayId === event.displayId && clementineLivePresentation === 'dormant') {
        positionClementineLiveWindow();
      }
    },
    onDiagnostic: (message) => console.warn(`[notch-helper] ${message}`),
  });
  clementineNotchClickHelper.start();
  screen.on('display-added', handleClementineLiveDisplayChange);
  screen.on('display-removed', handleClementineLiveDisplayChange);
  screen.on('display-metrics-changed', handleClementineLiveDisplayChange);
  registerClementineLiveShortcut(effectiveClementineLiveShortcut());
  registerClementineVoiceShortcut();
}

function disposeClementineLiveShell(): void {
  if (clementineLiveShellInitialized) {
    clementineLiveShellInitialized = false;
    if (clementineLiveRegisteredShortcut) globalShortcut.unregister(clementineLiveRegisteredShortcut);
    clementineLiveRegisteredShortcut = null;
    if (clementineLiveVoiceRegisteredShortcut) globalShortcut.unregister(clementineLiveVoiceRegisteredShortcut);
    clementineLiveVoiceRegisteredShortcut = null;
    screen.removeListener('display-added', handleClementineLiveDisplayChange);
    screen.removeListener('display-removed', handleClementineLiveDisplayChange);
    screen.removeListener('display-metrics-changed', handleClementineLiveDisplayChange);
  }
  clearClementineLiveRetryTimer();
  clearClementineLiveHandshakeTimer();
  clementineNotchClickHelper?.stop();
  clementineNotchClickHelper = null;
  clementineNotchClickHelperHealth = 'stopped';
  clementineNotchClickHelperError = null;
  const win = clementineLiveWindow;
  clementineLiveWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
  clementineLiveDisplayId = null;
  clementineLiveAvailability = 'unavailable';
  clementineLiveRetryAttempts = 0;
  clementineLiveCurrentMount = null;
  clementineLivePendingReveal = null;
  clementineLivePendingRevealPresentation = null;
  clementineLivePendingToggle = false;
  clementineLivePendingExpand = false;
  clementineLivePendingVoice = false;
  clementineLiveNativeAnchors.clear();
  clementineLiveSize = { ...DEFAULT_CLEMENTINE_LIVE_DORMANT_SIZE };
  clementineLivePresentation = 'dormant';
  clementineLiveLastLayoutId = 0;
}

function assertClementineLiveIpcSender(event: IpcMainInvokeEvent): void {
  const win = clementineLiveWindow;
  const expected = win && !win.isDestroyed() && !win.webContents.isDestroyed()
    ? {
        webContentsId: win.webContents.id,
        mainFrameRoutingId: win.webContents.mainFrame.routingId,
      }
    : null;
  const frameRoutingId = event.senderFrame?.routingId ?? null;
  const exactSender = isExactClementineLiveIpcSender({
    senderId: event.sender.id,
    senderFrameRoutingId: frameRoutingId,
  }, expected);
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!exactSender || senderSurface(senderUrl) !== 'live') {
    throw new Error(`Blocked Clementine Live IPC call from unauthorized renderer: ${redactSensitiveText(senderUrl || 'unknown')}`);
  }
}

function assertClementineNotchSettingsIpcSender(event: IpcMainInvokeEvent): void {
  const win = mainWindow;
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  const expected = win
    && !win.isDestroyed()
    && !win.webContents.isDestroyed()
    ? { webContentsId: win.webContents.id, mainFrameRoutingId: win.webContents.mainFrame.routingId }
    : null;
  const allowed = isExactClementineNotchSettingsIpcSender({
    senderId: event.sender.id,
    senderFrameRoutingId: event.senderFrame?.routingId ?? null,
  }, expected, senderUrl, senderSurface(senderUrl) === 'dashboard');
  if (!allowed) {
    throw new Error(`Blocked notch settings IPC call from unauthorized renderer: ${redactSensitiveText(senderUrl || 'unknown')}`);
  }
}

function liveMeetingWindowId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Meeting window id required.');
  }
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, 'windowId')) {
    throw new Error('Meeting window id required.');
  }
  const id = typeof record.windowId === 'string'
    ? record.windowId.trim()
    : '';
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error('Meeting window id required.');
  }
  return id;
}

function assertPendingLiveMeeting(windowId: string): void {
  const status = recallCapture?.status();
  if (status?.capturePhase !== 'prompt' || status.pendingMeeting?.windowId !== windowId) {
    throw new Error('That meeting prompt is no longer active.');
  }
}

function safeLiveMeetingActionError(error: unknown, fallback: string): Error {
  const raw = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (/screen recording|screen-capture|permission/i.test(raw)) {
    return new Error('Review Screen Recording permission in Clementine Meetings, then try again.');
  }
  if (/prompt is no longer active|meeting prompt is no longer active|no longer the active recording/i.test(raw)) {
    return new Error(raw);
  }
  if (/turn on recall|not supported|unsupported|preparing to shut down|already (starting|recording|stopping)/i.test(raw)) {
    return new Error(raw);
  }
  if (/auto-record.*rolled back|rolled back.*auto-record/i.test(raw)) {
    return new Error('The meeting did not start, but auto-record may still be on. Review meeting capture settings now.');
  }
  if (/auto-record/i.test(raw)) {
    return new Error('Clementine could not save auto-record, so this meeting was not started. Try again or review meeting capture settings.');
  }
  return new Error(fallback);
}

function parseClementineLiveResizeRequest(payload: unknown): ClementineLiveLayoutRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Clementine Live resize requires width, height, presentation, and layoutId');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys[0] !== 'height' || keys[1] !== 'layoutId'
      || keys[2] !== 'presentation' || keys[3] !== 'width'
      || typeof record.width !== 'number' || !Number.isFinite(record.width) || record.width <= 0
      || typeof record.height !== 'number' || !Number.isFinite(record.height) || record.height <= 0
      || typeof record.layoutId !== 'number' || !Number.isSafeInteger(record.layoutId) || record.layoutId <= 0
      || (record.presentation !== 'dormant' && record.presentation !== 'panel')) {
    throw new Error('Invalid Clementine Live resize bounds');
  }
  return {
    ...normalizeClementineLiveSize({ width: record.width, height: record.height }),
    presentation: record.presentation,
    layoutId: record.layoutId,
  };
}

function parseClementineLiveMountAck(payload: unknown): ClementineLiveMountIdentity {
  if (!isValidClementineLiveMountIdentity(payload)) {
    throw new Error('Invalid Clementine mount acknowledgement');
  }
  return payload;
}

function getWebhookSecret(): string {
  if (cachedWebhookSecret) return cachedWebhookSecret;
  // Read the same secret the daemon will read so the dashboard URL we
  // load matches the daemon's auth.
  // The daemon's home is ~/.clementine-next; .env is the dev path, and
  // the file vault is the fresh desktop setup path.
  const envFile = path.join(HOME, '.clementine-next', '.env');
  if (existsSync(envFile)) {
    try {
      for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
        const m = line.match(/^WEBHOOK_SECRET=(.*)$/);
        if (m) return m[1].trim();
      }
    } catch {
      // fall through to the file vault
    }
  }
  const vaultFile = path.join(HOME, '.clementine-next', 'state', 'secrets-vault.json');
  if (existsSync(vaultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(vaultFile, 'utf-8')) as { version?: string; entries?: Record<string, string> };
      const token = parsed.version === 'v1' ? parsed.entries?.webhook_secret : undefined;
      if (token) return token;
    } catch {
      // fall through to empty; boot should have generated this already
    }
  }
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
    webPreferences: {
      partition: 'clementine-splash',
      // Without the preload, window.clemmy isn't defined, so the
      // splash's status-text updater never wires up and the user
      // sees "starting daemon…" for the entire boot. The supervisor
      // events are still dispatched via executeJavaScript, but the
      // listener never registers.
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  guardWindow(win, ['splash']);
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
    acceptFirstMouse: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      // Use a non-persistent Electron session. The dashboard gets a
      // fresh local bootstrap URL on every launch, so it does not need
      // durable Chromium cookies/cache. Keeping this in-memory avoids
      // Electron/Chromium Safe Storage touching macOS Keychain just to
      // encrypt a local dashboard cookie.
      partition: 'clementine-dashboard',
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  guardWindow(win, ['dashboard']);
  // Live voice needs the renderer's getUserMedia(microphone) to be granted by
  // Electron's permission layer. The default for a `media` request is version-
  // dependent, so make it explicit: this window only ever loads our own
  // first-party dashboard over localhost (navigation is locked by guardWindow),
  // and in practice the only permission it requests is the microphone. macOS
  // still gates the actual capture behind the system mic prompt
  // (NSMicrophoneUsageDescription), so this does not bypass the OS consent.
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || webContents.getURL();
    const mediaTypes: string[] = 'mediaTypes' in details && Array.isArray(details.mediaTypes)
      ? details.mediaTypes
      : [];
    const audioOnly = mediaTypes.length > 0 && mediaTypes.every((type: string) => type === 'audio');
    callback(
      permission === 'media'
      && details.isMainFrame === true
      && audioOnly
      && isTrustedDashboardMediaUrl(requestingUrl, dashboardOrigins()),
    );
  });
  win.webContents.session.setPermissionCheckHandler((_webContents, permission, _requestingOrigin, details) => {
    return permission === 'media'
      && details.isMainFrame === true
      && details.mediaType === 'audio'
      && typeof details.requestingUrl === 'string'
      && isTrustedDashboardMediaUrl(details.requestingUrl, dashboardOrigins());
  });
  win.loadURL(url);
  // Keep DevTools opt-in for local testing; attached DevTools changes
  // focus/click behavior enough to make the dev app feel broken.
  if (!app.isPackaged && process.env.CLEMMY_DESKTOP_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'right' });
  }
  win.on('close', (event: { preventDefault(): void }) => {
    // On macOS we keep the app alive in the tray. Hide instead of
    // quit; cmd-Q exits explicitly.
    if (process.platform === 'darwin' && !(app as { isQuitting?: boolean }).isQuitting) {
      event.preventDefault();
      const activeCaptures = activeMeetingCaptureLabels();
      if (activeCaptures.length > 0) {
        // Never turn the red close button into an invisible microphone/screen
        // recording. The user can stop from the visible Meetings controls, or
        // quit Clementine explicitly (the quit path safely finalizes first).
        dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Keep Recording Window Open'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Meeting recording is active',
          message: activeCaptures.length === 1
            ? `${activeCaptures[0]} is still active.`
            : `${activeCaptures.join(' and ')} are still active.`,
          detail: 'Stop and transcribe the meeting from the Meetings page before hiding Clementine. You can also quit Clementine to finalize the recording safely.',
        });
        return;
      }
      win.hide();
    }
  });
  return win;
}

function activeMeetingCaptureLabels(): string[] {
  const labels: string[] = [];
  const local = localMeetingRecorder.status();
  // A STALE capture (producer dead, no PCM arriving) must never present as a
  // live recording — it reads as "interrupted" and self-heals via finalize.
  if (local.recording && !local.stale) labels.push('Local microphone recording');
  if (recallCapture?.status().recording) labels.push('Online meeting recording');
  return labels;
}

/**
 * Generate a 22×22 tray icon at runtime — no shipped image asset
 * required. Renders a filled circle (orange = daemon active, red = recording)
 * on a transparent background. Uses an inline SVG → nativeImage.createFromDataURL.
 */
function buildTrayIcon(active: boolean, recording = false): NativeImage {
  const color = recording ? '#ff3b30' : active ? '#ff5a35' : '#666c7a';
  const dot = recording ? '#ffffff' : active ? '#b9ff36' : '#3a3f4a';
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
  const activeCaptures = activeMeetingCaptureLabels();
  tray.setImage(buildTrayIcon(running, activeCaptures.length > 0));
  tray.setToolTip(activeCaptures.length > 0
    ? `Clementine — ${activeCaptures.join(' and ')}`
    : 'Clementine');
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  refreshTrayIcon();
  const running = supervisor?.isRunning() ?? false;
  const activeCaptures = activeMeetingCaptureLabels();
  const hasLiveWindow = Boolean(clementineLiveWindow
    && !clementineLiveWindow.isDestroyed()
    && !clementineLiveWindow.webContents.isDestroyed());
  const liveReady = hasLiveWindow && clementineLiveAvailability === 'ready';
  const recordingControlsRequired = clementineLiveCaptureRequiresControls();
  const liveLabel = !clementineNotchPreferences.enabled
    ? 'Clementine notch off'
    : recordingControlsRequired
      ? 'Show Meeting Recording Controls'
      : liveReady
        ? 'Toggle Clementine notch'
        : clementineLiveAvailability === 'loading'
          ? 'Clementine starting…'
          : 'Clementine unavailable';
  const menu = Menu.buildFromTemplate([
    {
      label: running ? `● Daemon running · port ${supervisor?.getPort()}` : '○ Daemon stopped',
      enabled: false,
    },
    ...(activeCaptures.length > 0 ? [
      {
        label: `● ${activeCaptures.join(' + ')}`,
        enabled: false,
      } as Electron.MenuItemConstructorOptions,
      {
        label: 'Open Clementine',
        click: () => revealMainWindow(),
      } as Electron.MenuItemConstructorOptions,
    ] : []),
    { type: 'separator' },
    ...(process.platform === 'darwin' ? [
      {
        label: liveLabel,
        accelerator: clementineNotchPreferences.enabled ? effectiveClementineLiveShortcut() : undefined,
        enabled: clementineNotchPreferences.enabled,
        click: () => { toggleClementineLivePanel(); },
      } as Electron.MenuItemConstructorOptions,
      { type: 'separator' as const },
    ] : []),
    {
      label: 'Open Console',
      click: () => revealMainWindow(),
    },
    { label: 'Open Console in Browser', click: () => dashboardUrl && shell.openExternal(dashboardUrl) },
    { label: 'Open Log File', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Restart Daemon', click: () => supervisor?.restart() },
    { label: 'Stop Daemon', click: () => supervisor?.stop() },
    { type: 'separator' },
    ...buildUpdaterMenuItems(),
    { label: 'Quit Clementine', click: () => quitCleanly() },
  ]);
  tray.setContextMenu(menu);
}

function buildUpdaterMenuItems(): Electron.MenuItemConstructorOptions[] {
  const u = getUpdaterStatus();
  // We always show ONE updater entry plus a divider. The label changes
  // by state so the tray flip ("Restart to install vX.Y.Z") is the
  // durable affordance to the user.
  let label = 'Check for Updates';
  let click: (() => void) | undefined = () => { void checkForUpdatesNow(); };
  let enabled = true;

  if (u.state === 'checking') {
    label = 'Checking for updates…';
    enabled = false;
    click = undefined;
  } else if (u.installBlocker === 'move-to-applications') {
    label = 'Move to Applications to enable updates';
    click = () => { moveAppToApplicationsFolder(); };
  } else if (u.installBlocker === 'app-not-writable') {
    label = 'Repair ownership & enable updates';
    click = () => { void repairUpdateOwnershipFromUi(); };
  } else if (u.state === 'available') {
    label = `Download update v${u.version || ''}`;
    click = () => { void applyUpdateFromUi(); };
  } else if (u.state === 'downloading') {
    label = u.progressPct
      ? `Downloading v${u.version || ''} · ${u.progressPct}%`
      : `Downloading v${u.version || ''}…`;
    enabled = false;
    click = undefined;
  } else if (u.state === 'ready-to-install') {
    label = `Restart to install v${u.version || ''}`;
    click = () => { void applyUpdateFromUi(); };
  } else if (u.state === 'no-update') {
    label = 'Clementine is up to date';
  } else if (u.state === 'error') {
    label = `Update error: ${u.error?.slice(0, 60) || 'unknown'} — retry`;
  }

  return [
    { label, click, enabled },
    { type: 'separator' as const },
  ];
}

async function prepareForQuit(): Promise<void> {
  if (quitPrepared || quitPreparing) return;
  quitPreparing = true;
  disposeClementineLiveShell();
  disposeAutoUpdater();
  await recallCapture?.prepareForShutdown().catch((error) => {
    // Still continue into SDK shutdown, but never silently skip the drain:
    // it owns start-in-flight, stop-in-flight, and natural-end completion.
    console.error('[recall] failed to prepare meeting capture during quit:', error instanceof Error ? error.message : error);
  });
  await recallCapture?.shutdown().catch(() => { /* ignore */ });
  const localRecording = await localMeetingRecorder.shutdown().catch((error) => {
    console.error('[local-meeting] failed to finalize during quit:', error instanceof Error ? error.message : error);
    return null;
  });
  if (localRecording) await ingestLocalMeeting(localRecording).catch((error) => {
    // The finalized WAV + metadata stay on disk for recovery even if the daemon
    // is already unavailable. Never discard a meeting just to finish quitting.
    console.error('[local-meeting] finalized but could not queue during quit:', error instanceof Error ? error.message : error);
  });
  await supervisor?.stop().catch(() => { /* ignore */ });
  quitPrepared = true;
  quitPreparing = false;
}

function markUpdateInstallIntent(): void {
  (app as { isQuitting?: boolean; isInstallingUpdate?: boolean }).isQuitting = true;
  (app as { isInstallingUpdate?: boolean }).isInstallingUpdate = true;
}

function clearUpdateInstallIntent(): void {
  (app as { isQuitting?: boolean; isInstallingUpdate?: boolean }).isQuitting = false;
  (app as { isInstallingUpdate?: boolean }).isInstallingUpdate = false;
}

async function prepareForUpdateInstall(): Promise<void> {
  markUpdateInstallIntent();
  disposeClementineLiveShell();
  await recallCapture?.prepareForShutdown().catch((error) => {
    console.error('[recall] failed to prepare meeting capture before update shutdown:', error instanceof Error ? error.message : error);
  });
  await recallCapture?.shutdown().catch(() => { /* ignore */ });
  const localRecording = await localMeetingRecorder.shutdown().catch(() => null);
  if (localRecording) await ingestLocalMeeting(localRecording).catch(() => { /* durable WAV remains for recovery */ });
  await supervisor?.stop().catch(() => { /* ignore */ });
}

function scheduleInstallQuitFallback(): void {
  if (installQuitFallback) return;
  installQuitFallback = setTimeout(() => {
    installQuitFallback = null;
    markUpdateInstallIntent();
    app.quit();
    setTimeout(() => {
      app.exit(0);
    }, 8_000).unref?.();
  }, process.platform === 'darwin' ? 15_000 : 1_000);
  installQuitFallback.unref?.();
}

/**
 * Probe the daemon for "is anything actively running right now?" so
 * the install flow can warn before killing user work. Returns null on
 * any failure (daemon not ready, port not bound, parse error, etc.) —
 * the caller treats that as "proceed without prompting" because we
 * can't get worse than the prior behavior of installing blind.
 *
 * Counts: non-chat sessions in active/paused (workflow, execution,
 * agent), pending harness approvals, in-flight background tasks.
 * Chat sessions are excluded — they stay 'active' by design and would
 * always trip the warning otherwise.
 */
async function probeActiveWorkBeforeInstall(): Promise<{
  total: number;
  summary: string;
} | null> {
  const captureSummary: string[] = [];
  if (localMeetingRecorder.status().recording) captureSummary.push('1 local meeting recording');
  if (recallCapture?.status().recording) captureSummary.push('1 online meeting recording');
  try {
    const payload = await fetchDaemonJson<{ total?: unknown; summary?: unknown }>(
      '/api/console/active-work',
    );
    const daemonTotal = typeof payload.total === 'number' ? payload.total : 0;
    const total = daemonTotal + captureSummary.length;
    const daemonSummary = typeof payload.summary === 'string' && payload.summary !== 'no active work'
      ? payload.summary
      : '';
    const summary = [daemonSummary, ...captureSummary].filter(Boolean).join(', ') || 'no active work';
    return { total, summary };
  } catch {
    return captureSummary.length > 0
      ? { total: captureSummary.length, summary: captureSummary.join(', ') }
      : null;
  }
}

async function finalizeMeetingCaptureBeforeInstall(): Promise<void> {
  // This must be unconditional: visible `recording` becomes false before a
  // native stop and /complete finish, and it remains false while a start is
  // still waiting for its upload token.
  await recallCapture?.prepareForShutdown();
  const localRecording = await localMeetingRecorder.shutdown();
  if (localRecording) {
    await ingestLocalMeeting(localRecording).catch((error) => {
      // Safe to proceed: both the repaired WAV and its final sidecar remain on
      // disk and the daemon's startup recovery will retry the queue operation.
      console.error('[local-meeting] finalized before update but could not queue:', error instanceof Error ? error.message : error);
    });
  }
}

async function applyUpdateFromUi(): Promise<ReturnType<typeof getUpdaterStatus> & { applyResult: ReturnType<typeof applyUpdate> }> {
  // BEFORE quitAndInstall — check whether anything's mid-flight. If
  // active work is present, give the user a clear choice: defer
  // (preserve the work) or install anyway (kill it). Without this
  // check, the user clicks "Install Now" assuming benign UX and
  // unknowingly drops a multi-hour workflow.
  const activeWork = await probeActiveWorkBeforeInstall();
  if (activeWork && activeWork.total > 0) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Defer Install', 'Install Anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Active work in progress',
      message: `Clementine has ${activeWork.summary}.`,
      detail:
        'Installing the update now will quit Clementine and stop this work. Runs will not auto-resume; active meeting recordings will be finalized before the installer takes over.\n\n'
        + 'Defer to install later — Clementine will keep this update ready and prompt again when no work is active.\n\n'
        + 'Install Anyway to proceed (recommended only if you are sure these runs are safe to stop).',
    });
    if (choice === 0) {
      return {
        ...getUpdaterStatus(),
        applyResult: {
          ok: false,
          reason: `Install deferred — ${activeWork.summary} in progress. Try again when those finish.`,
        },
      };
    }
    // choice === 1: user explicitly chose to install anyway. Fall through.
  }

  const wasReadyToInstall = getUpdaterStatus().state === 'ready-to-install';
  if (wasReadyToInstall) {
    // quitAndInstall may trigger Electron's native before-quit immediately.
    // Finalize meeting capture before handing control to it so the last PCM
    // chunks and Recall completion event cannot be cut off by process exit.
    try {
      await finalizeMeetingCaptureBeforeInstall();
    } catch (error) {
      return {
        ...getUpdaterStatus(),
        applyResult: {
          ok: false,
          reason: `Install deferred — Clementine could not safely finalize the active meeting: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    // Mark intent before quitAndInstall so before-quit does not block the
    // native updater. Do not stop the daemon until quitAndInstall accepts
    // the handoff; otherwise a synchronous updater failure leaves Clem
    // half-closed with no install.
    markUpdateInstallIntent();
  }
  const result = applyUpdate();
  if (!result.ok && wasReadyToInstall) {
    clearUpdateInstallIntent();
  }
  if (result.ok && result.action === 'installing') {
    scheduleInstallQuitFallback();
    await prepareForUpdateInstall();
  }
  return { ...getUpdaterStatus(), applyResult: result };
}

async function repairUpdateOwnershipFromUi(): Promise<ReturnType<typeof getUpdaterStatus> & { repairResult: Awaited<ReturnType<typeof repairAppOwnership>> }> {
  const result = await repairAppOwnership().catch((err: unknown) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));
  if (result.ok) {
    new Notification({
      title: 'Clementine updates repaired',
      body: 'Ownership is fixed. Checking for updates again…',
      silent: true,
    }).show();
  } else {
    dialog.showErrorBox(
      'Clementine could not repair updates',
      result.reason || 'Ownership repair failed. Reinstall Clementine from the latest DMG, then try again.',
    );
  }
  rebuildTrayMenu();
  return { ...getUpdaterStatus(), repairResult: result };
}

async function quitCleanly(): Promise<void> {
  (app as { isQuitting?: boolean }).isQuitting = true;
  await prepareForQuit();
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
  // CRITICAL: use fileURLToPath, NOT new URL(import.meta.url).pathname.
  // The .pathname getter returns URL-encoded paths — '/Users/jane%20smith/...'
  // for any user whose home or install path contains spaces, unicode,
  // or other percent-encoded characters. Electron's preload loader
  // expects a real filesystem path and silently fails to attach when
  // given an encoded one. The renderer then shows "Setup bridge
  // unavailable" because window.clemmy never materializes.
  //
  // fileURLToPath decodes the URL properly. This is the Node.js
  // recommended idiom (see https://nodejs.org/api/url.html#urlfileurltopathurl).
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs');
}

function clementineLivePreloadPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'live-preload.cjs');
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
  cachedWebhookSecret = await ensureWebhookSecret();

  // Keychain is now explicit only. Even a one-time `findCredentials`
  // migration can raise a macOS Keychain prompt on clean installs or
  // after a signature change, which is worse than asking legacy users
  // to click Settings → Credentials → Import Legacy Keychain. Keep the
  // old startup migration reachable behind an operator flag for manual
  // recovery/testing, but never run it during normal launch.
  if (process.env.CLEMMY_ENABLE_LEGACY_KEYCHAIN_MIGRATION === '1') {
    try {
      const result = await migrateKeychainToFileVault();
      if (result.ran && result.migrated.length > 0) {
        try {
          appendFileSync(LOG_FILE, `\n=== Keychain migration ${new Date().toISOString()} ===\nmoved to file vault: ${result.migrated.join(', ')}\n`);
        } catch { /* log is best-effort */ }
      }
    } catch (err) {
      try {
        appendFileSync(LOG_FILE, `\n=== Keychain migration failed ${new Date().toISOString()} ===\n${err instanceof Error ? err.message : String(err)}\n`);
      } catch { /* swallow */ }
    }
  }

  if (needsSetup()) {
    openSetupWindow();
  } else {
    await launchDaemon();
  }
}

/**
 * Convert any thrown error in the boot path into a visible dialog +
 * structured log line. Without this, an unhandled rejection inside
 * boot() leaves the user staring at a launched-but-blank Electron app
 * (this is exactly how the 0.2.3 keytar interop bug presented).
 *
 * The dialog is informational — we don't auto-quit because the user
 * may want to copy the error before closing. Tray + auto-updater still
 * arm so they can install a fix once one ships.
 */
function reportBootFailure(stage: string, err: unknown): void {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  // Log to the daemon supervisor log file so a later "Open Log File"
  // tray action surfaces the error even after the dialog is dismissed.
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `\n=== Boot failure (${stage}) at ${new Date().toISOString()} ===\n${message}\n`);
  } catch {
    // If we can't even append to the log, fall through to the dialog.
  }
  try {
    dialog.showErrorBox(
      `Clementine couldn't ${stage}`,
      `${message}\n\nLog file: ${LOG_FILE}\n\nTry quitting Clementine and relaunching. If this keeps happening, open the log and share it from Advanced → Diagnostics.`,
    );
  } catch {
    // dialog may not be ready (e.g. app.on('ready') hasn't fired yet);
    // the log line is the durable record.
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
  guardWindow(setupWindow, ['setup']);
  setupWindow.on('closed', () => { setupWindow = null; });
}

async function launchDaemon(): Promise<void> {
  splashWindow = createSplashWindow();

  const daemonRoot = locateDaemonProjectRoot();
  if (!recallCapture) {
    recallCapture = new RecallDesktopCapture({
      getDaemonBaseUrl: () => supervisor?.getPort() ? `http://127.0.0.1:${supervisor.getPort()}` : '',
      getWebhookToken: () => getWebhookSecret(),
      emit: (event) => {
        mainWindow?.webContents.send('clemmy:recall-event', event);
        handleClementineLiveRecallEvent(event);
        // Recording lifecycle events must immediately update the persistent
        // tray indicator. Transcript/realtime events can arrive many times per
        // second, so never rebuild a native menu/image for those hot events.
        const type = typeof event.type === 'string' ? event.type : '';
        if (RECALL_TRAY_STATE_EVENTS.has(type)) {
          rebuildTrayMenu();
        }
      },
    });
  }

  supervisor = new DaemonSupervisor({
    daemonProjectRoot: daemonRoot,
    logFile: LOG_FILE,
    onEvent: (event) => {
      // Forward to the splash + tray + notifications.
      splashWindow?.webContents.executeJavaScript(
        `window.dispatchEvent(new CustomEvent('supervisor', { detail: ${JSON.stringify(event)} }));`,
      ).catch(() => { /* splash gone */ });
      // A crash/restart can select a different free port. Keep the canonical
      // URL current and move an already-open dashboard off the dead origin as
      // soon as the replacement daemon is ready.
      if (event.type === 'ready') repointDashboardToLiveDaemon();
      rebuildTrayMenu();
      showSupervisorEventNotification(event);
    },
  });

  try {
    const info = await supervisor.start();
    const token = getWebhookSecret();
    dashboardUrl = supervisor.getDashboardUrl(token);
    await recoverLocalMeetingsAfterCrash().catch((error) => {
      console.error('[local-meeting] crash recovery failed:', error instanceof Error ? error.message : error);
    });
    // Apply cancellation intent after crash recovery. If a crash interrupted
    // local file deletion, recovery may briefly re-register its sidecar; the
    // tombstone must win and remove that daemon record afterward.
    try {
      markRecoveredLocalMeetingCancellationsReady();
    } catch (error) {
      // Do not issue cleanup from an unconfirmed tombstone: without the ready
      // marker, the regular status worker deliberately leaves it alone.
      console.error('[local-meeting] could not arm recovered cancellation intent:', error instanceof Error ? error.message : error);
    }
    await retryPendingLocalMeetingCancellations().catch((error) => {
      // Tombstones remain on disk and the five-second local status path retries.
      console.error('[local-meeting] pending cancellation recovery failed:', error instanceof Error ? error.message : error);
    });
    await syncRecallCaptureFromDaemon().catch((error) => {
      console.error('[recall] initial sync failed:', error instanceof Error ? error.message : error);
    });
    mainWindow = createMainWindow(dashboardUrl);
    mainWindow.once('ready-to-show', () => {
      revealWindow(mainWindow);
      ensureClementineLiveWindow();
      splashWindow?.close();
      splashWindow = null;
    });
    // Surface real renderer failures (rare) so a packaged user can see
    // them in Console.app instead of staring at a blank window.
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[main] renderer did-fail-load', code, desc, redactSensitiveText(url));
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('[main] renderer process gone', JSON.stringify(details));
      // The renderer owned the mic pump — finalize any active local capture
      // instead of letting the tray show "Recording" over a dead producer.
      void finalizeOrphanedLocalCapture('the app window crashed');
    });
    // A manual reload (Cmd+R) or any top-frame navigation also kills the mic
    // pump, and will-navigate does NOT fire for reloads — catch it here.
    // COMMIT-time ('did-navigate', not 'did-start-navigation'): a navigation
    // that gets CANCELLED (e.g. a will-navigate preventDefault, a drag-drop
    // attempt) never tears down the renderer, and finalizing on start-time
    // would kill a live recording for it (2026-07-14 review, empirically
    // confirmed in Electron 43). At commit the old document — and the mic
    // pump — are gone for real. Same-document SPA navigations never commit a
    // new document, so they can't reach this.
    mainWindow.webContents.on('did-navigate', () => {
      void finalizeOrphanedLocalCapture('the page reloaded');
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

async function fetchDaemonJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const port = supervisor?.getPort();
  const token = getWebhookSecret();
  if (!port || !token) throw new Error('daemon is not ready');
  const url = new URL(pathname, `http://127.0.0.1:${port}`);
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: unknown }).error)
      : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload as T;
}

function postDaemonJson<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
  return fetchDaemonJson<T>(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface PendingLocalMeetingCancellation {
  sessionId: string;
  requestedAt: string;
  localCleanupCompletedAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
}

interface LocalMeetingCancellationRetryStatus {
  pendingCount: number;
  pendingSessionIds: string[];
}

let pendingLocalCancellationRetry: Promise<LocalMeetingCancellationRetryStatus> | null = null;

function localMeetingCancellationTombstonePath(): string {
  return path.join(app.getPath('userData'), 'pending-local-meeting-cancellations.json');
}

function readPendingLocalMeetingCancellations(): PendingLocalMeetingCancellation[] {
  const filePath = localMeetingCancellationTombstonePath();
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      cancellations?: Array<Partial<PendingLocalMeetingCancellation>>;
    };
    if (!Array.isArray(parsed.cancellations)) return [];
    const bySession = new Map<string, PendingLocalMeetingCancellation>();
    for (const entry of parsed.cancellations) {
      const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : '';
      if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) continue;
      bySession.set(sessionId, {
        sessionId,
        requestedAt: typeof entry.requestedAt === 'string' && Number.isFinite(Date.parse(entry.requestedAt))
          ? new Date(entry.requestedAt).toISOString()
          : new Date().toISOString(),
        localCleanupCompletedAt: typeof entry.localCleanupCompletedAt === 'string'
          && Number.isFinite(Date.parse(entry.localCleanupCompletedAt))
          ? new Date(entry.localCleanupCompletedAt).toISOString()
          : undefined,
        lastAttemptAt: typeof entry.lastAttemptAt === 'string' && Number.isFinite(Date.parse(entry.lastAttemptAt))
          ? new Date(entry.lastAttemptAt).toISOString()
          : undefined,
        lastError: typeof entry.lastError === 'string' ? entry.lastError.slice(0, 500) : undefined,
      });
    }
    return Array.from(bySession.values());
  } catch {
    // Fail closed: retain the unreadable file for support. A subsequent user
    // cancellation writes a fresh, validated snapshot alongside it atomically.
    return [];
  }
}

function writePendingLocalMeetingCancellations(entries: PendingLocalMeetingCancellation[]): void {
  const filePath = localMeetingCancellationTombstonePath();
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ schemaVersion: 1, cancellations: entries }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameSync(tempPath, filePath);
}

function rememberPendingLocalMeetingCancellation(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(sessionId)) {
    throw new Error('invalid local meeting session ID');
  }
  const entries = readPendingLocalMeetingCancellations();
  if (entries.some((entry) => entry.sessionId === sessionId)) return;
  entries.push({ sessionId, requestedAt: new Date().toISOString() });
  writePendingLocalMeetingCancellations(entries);
}

function markPendingLocalMeetingCancellationReady(sessionId: string): void {
  const entries = readPendingLocalMeetingCancellations();
  const existing = entries.find((entry) => entry.sessionId === sessionId);
  if (!existing) throw new Error('pending local meeting cancellation was not persisted');
  if (existing.localCleanupCompletedAt) return;
  existing.localCleanupCompletedAt = new Date().toISOString();
  writePendingLocalMeetingCancellations(entries);
}

function markRecoveredLocalMeetingCancellationsReady(): void {
  const entries = readPendingLocalMeetingCancellations();
  let changed = false;
  const completedAt = new Date().toISOString();
  for (const entry of entries) {
    if (entry.localCleanupCompletedAt) continue;
    entry.localCleanupCompletedAt = completedAt;
    changed = true;
  }
  if (changed) writePendingLocalMeetingCancellations(entries);
}

function updatePendingLocalMeetingCancellationError(sessionId: string, error: unknown): void {
  const entries = readPendingLocalMeetingCancellations();
  const existing = entries.find((entry) => entry.sessionId === sessionId);
  if (!existing) return;
  existing.lastAttemptAt = new Date().toISOString();
  existing.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  writePendingLocalMeetingCancellations(entries);
}

function forgetPendingLocalMeetingCancellation(sessionId: string): void {
  const entries = readPendingLocalMeetingCancellations();
  const next = entries.filter((entry) => entry.sessionId !== sessionId);
  if (next.length !== entries.length) writePendingLocalMeetingCancellations(next);
}

async function sendPendingLocalMeetingCancellation(sessionId: string): Promise<{
  pending: boolean;
  error?: string;
}> {
  try {
    await postDaemonJson<Record<string, unknown>>('/api/console/meetings/local/cancel', { sessionId });
    forgetPendingLocalMeetingCancellation(sessionId);
    return { pending: false };
  } catch (error) {
    updatePendingLocalMeetingCancellationError(sessionId, error);
    return { pending: true, error: error instanceof Error ? error.message : String(error) };
  }
}

async function requestDaemonLocalMeetingCancellation(sessionId: string): Promise<{
  pending: boolean;
  error?: string;
}> {
  // Persist intent before touching the daemon. If the process exits after the
  // daemon received /start but before its response reached Electron, this is
  // the durable evidence startup/status retry needs to remove the ghost.
  rememberPendingLocalMeetingCancellation(sessionId);
  // The status poll must not delete the daemon record (and its audio path)
  // while local cancellation is still queued behind PCM writes. Only expose
  // this tombstone to retries after the writer has closed and files are gone.
  markPendingLocalMeetingCancellationReady(sessionId);
  return sendPendingLocalMeetingCancellation(sessionId);
}

async function retryPendingLocalMeetingCancellations(): Promise<LocalMeetingCancellationRetryStatus> {
  if (pendingLocalCancellationRetry) return pendingLocalCancellationRetry;
  const pending = (async () => {
    const entries = readPendingLocalMeetingCancellations();
    for (const entry of entries.filter((candidate) => candidate.localCleanupCompletedAt)) {
      const result = await sendPendingLocalMeetingCancellation(entry.sessionId);
      if (result.pending) {
        console.warn('[local-meeting] daemon cancellation remains pending:', entry.sessionId, result.error ?? 'unknown error');
      }
    }
    const remaining = readPendingLocalMeetingCancellations();
    return {
      pendingCount: remaining.length,
      pendingSessionIds: remaining.map((entry) => entry.sessionId),
    };
  })();
  pendingLocalCancellationRetry = pending;
  try {
    return await pending;
  } finally {
    if (pendingLocalCancellationRetry === pending) pendingLocalCancellationRetry = null;
  }
}

async function ingestLocalMeeting(recording: LocalMeetingRecording): Promise<Record<string, unknown>> {
  return postDaemonJson<Record<string, unknown>>('/api/console/meetings/local/ingest', {
    sessionId: recording.sessionId,
    audioPath: recording.audioPath,
    endedAt: recording.endedAt,
    durationSeconds: recording.durationSeconds,
    bytes: recording.bytes,
  });
}

// ORPHANED-CAPTURE FINALIZER (2026-07-14 review). The PCM producer lives in the
// RENDERER (LocalMeetingCapture's mic pump); the durable WAV writer lives HERE.
// If the renderer dies (crash, hard reload) or the window navigates to a fresh
// daemon page, the producer is gone forever — LocalMeetingCapture has no
// reattach path — while main's recorder + tray kept showing "Recording" with a
// frozen byte count and the rest of the meeting silently lost. Finalizing
// (stop + ingest) converts that silent loss into an honest, transcribed
// partial recording, mirroring the Meetings screen's own unmount rationale.
let orphanFinalizeInFlight: Promise<void> | null = null;
/** First-stale observation for the two-observation confirm in the status poll. */
let staleObservation: { sessionId: string; bytes: number; atNs: bigint } | null = null;
function finalizeOrphanedLocalCapture(reason: string): Promise<void> {
  if (!orphanFinalizeInFlight) {
    orphanFinalizeInFlight = (async () => {
      const status = localMeetingRecorder.status();
      if (!status.recording || !status.sessionId) return;
      console.warn('[local-meeting] finalizing orphaned capture:', reason, status.sessionId);
      try {
        const recording = await localMeetingRecorder.stop(status.sessionId);
        try {
          await ingestLocalMeeting(recording);
        } catch (error) {
          // The WAV + sidecar are durable — daemon-side sidecar recovery picks
          // it up when the daemon is reachable again.
          console.error('[local-meeting] orphaned capture saved but could not queue:', error instanceof Error ? error.message : error);
        }
        const minutes = Math.max(1, Math.round((recording.durationSeconds ?? 0) / 60));
        try {
          new Notification({
            title: 'Meeting capture interrupted',
            body: `Recording stopped because ${reason}. About ${minutes} minute${minutes === 1 ? '' : 's'} were saved and queued for transcription.`,
          }).show();
        } catch { /* notification is best-effort */ }
      } catch (error) {
        console.error('[local-meeting] failed to finalize orphaned capture:', error instanceof Error ? error.message : error);
      } finally {
        rebuildTrayMenu();
      }
    })().finally(() => { orphanFinalizeInFlight = null; });
  }
  return orphanFinalizeInFlight;
}

async function recoverLocalMeetingsAfterCrash(): Promise<void> {
  const recordings = await localMeetingRecorder.recoverInterruptedRecordings();
  for (const recording of recordings) {
    try {
      // /start is idempotent for the same session/path. Re-registering first
      // covers both daemon persistence and a daemon state file lost in the
      // same crash that interrupted the Electron process.
      await postDaemonJson<Record<string, unknown>>('/api/console/meetings/local/start', {
        sessionId: recording.sessionId,
        title: recording.title,
        audioPath: recording.audioPath,
        startedAt: recording.startedAt,
        sampleRate: recording.sampleRate,
        channels: recording.channels,
      });
      await ingestLocalMeeting(recording);
      console.info('[local-meeting] recovered interrupted recording', recording.sessionId);
    } catch (error) {
      // The repaired WAV and final sidecar remain durable. A future launch can
      // retry without ever overwriting or deleting the user's audio.
      console.error('[local-meeting] recovered audio but could not queue it:', error instanceof Error ? error.message : error);
    }
  }
}

async function syncRecallCaptureFromDaemon(): Promise<void> {
  const payload = await fetchDaemonJson<{ settings?: RecallCaptureSettings }>('/api/console/meetings/recall');
  if (payload.settings) {
    await recallCapture?.configure(payload.settings);
  }
}

// ─── IPC handlers ──────────────────────────────────────────────────

ipcMain.handle('clemmy:notch-status', (event: IpcMainInvokeEvent) => {
  assertClementineNotchSettingsIpcSender(event);
  return clementineNotchSnapshot();
});

ipcMain.handle('clemmy:notch-update', (event: IpcMainInvokeEvent, patch: unknown) => {
  assertClementineNotchSettingsIpcSender(event);
  return updateClementineNotchPreferences(patch);
});

ipcMain.handle('clemmy:notch-open', (event: IpcMainInvokeEvent) => {
  assertClementineNotchSettingsIpcSender(event);
  if (!clementineNotchPreferences.enabled) {
    return { ok: false, error: 'Turn on Clementine in the notch first.', snapshot: clementineNotchSnapshot() };
  }
  ensureClementineLiveWindow();
  const expanded = expandClementineLivePanel();
  if (!expanded) {
    clementineLivePendingReveal = 'manual';
    clementineLivePendingRevealPresentation = 'panel';
  }
  return { ok: true, pending: !expanded, snapshot: clementineNotchSnapshot() };
});

ipcMain.handle('clemmy:live-resize', (event: IpcMainInvokeEvent, payload: unknown) => {
  assertClementineLiveIpcSender(event);
  const layout = parseClementineLiveResizeRequest(payload);
  if (layout.layoutId < clementineLiveLastLayoutId) {
    return {
      ok: true,
      applied: false,
      layoutId: layout.layoutId,
      currentLayoutId: clementineLiveLastLayoutId,
      bounds: clementineLiveWindow?.getBounds() ?? null,
    };
  }
  clementineLiveLastLayoutId = layout.layoutId;
  clementineLiveSize = { width: layout.width, height: layout.height };
  clementineLivePresentation = layout.presentation;
  positionClementineLiveWindow();
  revealClementineLiveAfterLayout(layout.presentation);
  return {
    ok: true,
    applied: true,
    layoutId: layout.layoutId,
    bounds: clementineLiveWindow?.getBounds() ?? null,
  };
});

ipcMain.handle('clemmy:live-mounted', (event: IpcMainInvokeEvent, payload: unknown) => {
  assertClementineLiveIpcSender(event);
  const mount = parseClementineLiveMountAck(payload);
  const senderMount = clementineLiveMountFromUrl(event.senderFrame?.url || event.sender.getURL());
  const win = clementineLiveWindow;
  const ready = Boolean(win
    && senderMount
    && isCurrentClementineLiveMount(senderMount, mount)
    && markClementineLiveRendererReady(win, mount));
  return { ok: ready };
});

ipcMain.handle('clemmy:live-open-console', (event: IpcMainInvokeEvent) => {
  assertClementineLiveIpcSender(event);
  openConsoleFromClementineLive();
  return { ok: true };
});

ipcMain.handle('clemmy:live-dismiss', (event: IpcMainInvokeEvent) => {
  assertClementineLiveIpcSender(event);
  dismissClementineLive();
  return { ok: true };
});

ipcMain.handle('clemmy:live-meeting-status', (event: IpcMainInvokeEvent) => {
  assertClementineLiveIpcSender(event);
  return sanitizeRecallStatusForNotch(recallCapture?.status());
});

ipcMain.handle('clemmy:live-meeting-record', async (event: IpcMainInvokeEvent, payload: unknown) => {
  assertClementineLiveIpcSender(event);
  const windowId = liveMeetingWindowId(payload);
  assertPendingLiveMeeting(windowId);
  const start = recallCapture?.recordPromptedWindow(windowId);
  rebuildTrayMenu();
  try {
    await start;
    return sanitizeRecallStatusForNotch(recallCapture?.status());
  } catch (error) {
    throw safeLiveMeetingActionError(error, 'Meeting recording could not start. Review meeting permissions and try again.');
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:live-meeting-always-record', async (event: IpcMainInvokeEvent, payload: unknown) => {
  assertClementineLiveIpcSender(event);
  const windowId = liveMeetingWindowId(payload);
  assertPendingLiveMeeting(windowId);
  const start = recallCapture?.enableAutoRecordAndRecordPrompted(windowId);
  rebuildTrayMenu();
  try {
    await start;
    return sanitizeRecallStatusForNotch(recallCapture?.status());
  } catch (error) {
    throw safeLiveMeetingActionError(error, 'Meeting recording and auto-record could not start. Review Meetings and try again.');
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:live-meeting-dismiss', (event: IpcMainInvokeEvent, payload: unknown) => {
  assertClementineLiveIpcSender(event);
  const windowId = liveMeetingWindowId(payload);
  assertPendingLiveMeeting(windowId);
  return sanitizeRecallStatusForNotch(recallCapture?.dismissDetectedWindow(windowId));
});

ipcMain.handle('clemmy:live-meeting-stop', async (event: IpcMainInvokeEvent, payload: unknown) => {
  assertClementineLiveIpcSender(event);
  const windowId = liveMeetingWindowId(payload);
  try {
    await recallCapture?.cancelOrStopPromptedRecording(windowId);
    return sanitizeRecallStatusForNotch(recallCapture?.status());
  } catch (error) {
    throw safeLiveMeetingActionError(error, 'Clementine could not stop the meeting recording safely. Open Clementine and try again.');
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:live-meeting-request-permissions', async (event: IpcMainInvokeEvent) => {
  assertClementineLiveIpcSender(event);
  const status = recallCapture?.status();
  if (!status?.enabled) throw new Error('Turn on Recall meeting capture from Meetings first.');
  if (!status.platformSupport.supported) {
    throw new Error(status.platformSupport.message ?? 'Recall meeting capture is not supported on this computer.');
  }
  try {
    return sanitizeRecallStatusForNotch(await recallCapture?.requestPermissions());
  } catch (error) {
    throw safeLiveMeetingActionError(error, 'Meeting permissions could not be opened. Review them from Clementine Meetings.');
  }
});

ipcMain.handle('clemmy:supervisor-status', (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  return {
  running: supervisor?.isRunning() ?? false,
  port: supervisor?.getPort() ?? 0,
  url: currentSupervisorDashboardUrl(),
  };
});

ipcMain.handle('clemmy:restart-daemon', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  await supervisor?.restart();
  rebuildTrayMenu();
  return { ok: true };
});

ipcMain.handle('clemmy:tail-log', (evt: IpcMainInvokeEvent, maxLines?: number) => {
  assertIpcSender(evt, ['dashboard']);
  return { lines: (supervisor?.tailLog(maxLines ?? 200) ?? []).map((line) => redactSensitiveText(line)) };
});

ipcMain.handle('clemmy:open-logs', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  await shell.openPath(LOG_FILE);
  return { opened: true };
});

ipcMain.handle('clemmy:recall-status', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  await syncRecallCaptureFromDaemon().catch(() => { /* status still returns local state */ });
  return recallCapture?.status() ?? null;
});

ipcMain.handle('clemmy:recall-configure', async (evt: IpcMainInvokeEvent, settings: Partial<RecallCaptureSettings>) => {
  assertIpcSender(evt, ['dashboard']);
  return recallCapture?.configure(settings ?? {}) ?? null;
});

ipcMain.handle('clemmy:recall-request-permissions', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  return recallCapture?.requestPermissions() ?? null;
});

ipcMain.handle('clemmy:recall-start-manual', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  try {
    return await recallCapture?.startManualRecording() ?? null;
  } finally {
    rebuildTrayMenu();
  }
});

// Primary "RECORD MEETING" path — records the detected meeting window when
// one is open. When none is found it does NOT silently record desktop audio;
// it returns a `blocked` reason (usually "grant Screen Recording") so the
// dashboard can guide the user. See RecallDesktopCapture.recordActiveMeeting.
ipcMain.handle('clemmy:recall-record-active', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  try {
    return await recallCapture?.recordActiveMeeting() ?? null;
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:recall-record-detected', async (evt: IpcMainInvokeEvent, payload: { windowId: string }) => {
  assertIpcSender(evt, ['dashboard']);
  const id = (payload?.windowId ?? '').trim();
  if (!id) throw new Error('windowId required');
  try {
    return await recallCapture?.recordDetectedWindow(id) ?? null;
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:recall-auto-record', async (evt: IpcMainInvokeEvent, payload: { windowId: string }) => {
  assertIpcSender(evt, ['dashboard']);
  const id = (payload?.windowId ?? '').trim();
  if (!id) throw new Error('windowId required');
  try {
    return await recallCapture?.enableAutoRecordAndRecord(id) ?? null;
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:recall-stop', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  try {
    return await recallCapture?.stopRecording() ?? null;
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:recall-test', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  // Force an SDK init (if enabled) and return the full status incl.
  // permissionStatuses + detectedWindows so the dashboard's
  // "Test Connection" button can diagnose why recording isn't firing.
  await syncRecallCaptureFromDaemon().catch(() => { /* keep going on stale status */ });
  return recallCapture?.testConnection() ?? null;
});

// ─── Local in-person meeting capture ────────────────────────────────

ipcMain.handle('clemmy:local-meeting-status', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  const recorder = localMeetingRecorder.status();
  // Self-heal floor: if status observations find the capture stale (the
  // producer died via a path the event hooks missed), finalize — the 5s
  // dashboard poll makes this fast. TWO-OBSERVATION CONFIRM (2026-07-14
  // review): a single wall-clock-stale observation can be a sleep/wake or
  // NTP-step artifact, so require a second observation ≥5s of MONOTONIC time
  // later (hrtime pauses during sleep on macOS) with the SAME session and an
  // UNCHANGED byte count. A live producer clears it (bytes move or stale
  // flips false); a dead one finalizes ~5s after the first post-wake poll.
  if (recorder.recording && recorder.stale && recorder.sessionId) {
    const nowNs = process.hrtime.bigint();
    if (
      staleObservation
      && staleObservation.sessionId === recorder.sessionId
      && staleObservation.bytes === recorder.bytes
      && nowNs - staleObservation.atNs >= 5_000_000_000n
    ) {
      staleObservation = null;
      void finalizeOrphanedLocalCapture('audio stopped arriving from the app window');
    } else if (!staleObservation || staleObservation.sessionId !== recorder.sessionId || staleObservation.bytes !== recorder.bytes) {
      staleObservation = { sessionId: recorder.sessionId, bytes: recorder.bytes, atNs: nowNs };
    }
  } else {
    staleObservation = null;
  }
  const cancellations = await retryPendingLocalMeetingCancellations().catch(() => {
    const remaining = readPendingLocalMeetingCancellations();
    return {
      pendingCount: remaining.length,
      pendingSessionIds: remaining.map((entry) => entry.sessionId),
    };
  });
  // Pass the active recording session so the daemon can attach the live
  // transcript view for exactly this capture.
  const statusPath = recorder.recording && recorder.sessionId
    ? `/api/console/meetings/local/status?sessionId=${encodeURIComponent(recorder.sessionId)}`
    : '/api/console/meetings/local/status';
  const daemon = await fetchDaemonJson<Record<string, unknown>>(statusPath)
    .catch((error) => ({
      runtime: { available: false, reason: error instanceof Error ? error.message : String(error) },
    }));
  return {
    ...daemon,
    recorder,
    pendingCancellationCount: cancellations.pendingCount,
    pendingCancellationSessionIds: cancellations.pendingSessionIds,
  };
});

ipcMain.handle('clemmy:local-meeting-start', async (
  evt: IpcMainInvokeEvent,
  payload?: { title?: unknown },
) => {
  assertIpcSender(evt, ['dashboard']);
  const recorder = await localMeetingRecorder.start({ title: payload?.title });
  try {
    const daemon = await postDaemonJson<Record<string, unknown>>('/api/console/meetings/local/start', {
      sessionId: recorder.sessionId!,
      title: recorder.title,
      audioPath: recorder.audioPath!,
      startedAt: recorder.startedAt!,
      sampleRate: recorder.sampleRate,
      channels: recorder.channels,
    });
    return { recorder, daemon };
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    let tombstoneError: unknown;
    try {
      rememberPendingLocalMeetingCancellation(recorder.sessionId!);
    } catch (persistError) {
      tombstoneError = persistError;
    }
    let localCancelError: unknown;
    try {
      await localMeetingRecorder.cancel(recorder.sessionId!);
    } catch (cancelError) {
      localCancelError = cancelError;
    }
    if (localCancelError) {
      throw new Error(
        `${original} Clementine could not stop the local audio writer: ${localCancelError instanceof Error ? localCancelError.message : String(localCancelError)}${tombstoneError ? ` It also could not persist daemon cleanup: ${tombstoneError instanceof Error ? tombstoneError.message : String(tombstoneError)}` : ''}`,
      );
    }
    let cancellation: Awaited<ReturnType<typeof requestDaemonLocalMeetingCancellation>>;
    try {
      // This repeats the initial tombstone write intentionally. A transient
      // persistence failure above may have cleared after the local writer was
      // closed, and daemon cleanup still must never run without durable intent.
      cancellation = await requestDaemonLocalMeetingCancellation(recorder.sessionId!);
    } catch (cleanupError) {
      throw new Error(
        `${original} Local audio capture was stopped, but Clementine could not persist daemon cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    if (cancellation.pending) {
      throw new Error(
        `${original} Local audio capture was stopped, but daemon cleanup is pending and will retry automatically.`,
      );
    }
    throw error;
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:local-meeting-append', async (
  evt: IpcMainInvokeEvent,
  payload?: { sessionId?: unknown; chunk?: unknown },
) => {
  assertIpcSender(evt, ['dashboard']);
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  return localMeetingRecorder.append(sessionId, payload?.chunk);
});

ipcMain.handle('clemmy:local-meeting-stop', async (
  evt: IpcMainInvokeEvent,
  payload?: { sessionId?: unknown },
) => {
  assertIpcSender(evt, ['dashboard']);
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  try {
    const recording = await localMeetingRecorder.stop(sessionId);
    try {
      const daemon = await ingestLocalMeeting(recording);
      return { recording, queued: true, daemon };
    } catch (error) {
      // Recording success and transcription queueing are separate outcomes. The
      // WAV is durable, so report a recoverable queue error instead of pretending
      // the meeting itself was lost.
      return {
        recording,
        queued: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    rebuildTrayMenu();
  }
});

ipcMain.handle('clemmy:local-meeting-cancel', async (
  evt: IpcMainInvokeEvent,
  payload?: { sessionId?: unknown },
) => {
  assertIpcSender(evt, ['dashboard']);
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  try {
    rememberPendingLocalMeetingCancellation(sessionId);
    let result: Awaited<ReturnType<typeof localMeetingRecorder.cancel>>;
    try {
      result = await localMeetingRecorder.cancel(sessionId);
    } catch (error) {
      // The local recorder is still authoritative if its own cancellation
      // failed. Do not let the retry worker delete the daemon record while an
      // active writer may still exist.
      forgetPendingLocalMeetingCancellation(sessionId);
      throw error;
    }
    const cancellation = await requestDaemonLocalMeetingCancellation(sessionId);
    return {
      ...result,
      daemonCancellationPending: cancellation.pending,
      warning: cancellation.pending
        ? 'Local audio was discarded, but meeting-history cleanup is pending and will retry automatically.'
        : undefined,
    };
  } finally {
    rebuildTrayMenu();
  }
});

// ─── Auto-update IPC ────────────────────────────────────────────────

ipcMain.handle('clemmy:updater-status', (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  return getUpdaterStatus();
});

ipcMain.handle('clemmy:updater-check', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  return checkForUpdatesNow();
});

ipcMain.handle('clemmy:updater-apply', (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  return applyUpdateFromUi();
});

ipcMain.handle('clemmy:updater-move-to-applications', (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  const result = moveAppToApplicationsFolder();
  return { ...getUpdaterStatus(), moveResult: result };
});

ipcMain.handle('clemmy:updater-repair-ownership', (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  return repairUpdateOwnershipFromUi();
});

function sendUpdaterEvent(status: ReturnType<typeof getUpdaterStatus>): void {
  for (const win of [mainWindow, splashWindow, setupWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('clemmy:updater-event', status);
    }
  }
}

// ─── Setup wizard IPC handlers ─────────────────────────────────────

ipcMain.handle('clemmy:setup-status', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['setup']);
  return {
  needsSetup: needsSetup(),
  hasCompleted: hasCompletedSetup(),
  // Passive by design: do not even probe keytar here. On some macOS
  // machines a Keychain availability probe can foreground Keychain
  // Access and steal input from the setup/dashboard window. Explicit
  // Keychain actions still use the live keychain path.
  hasKeychain: false,
  };
});

ipcMain.handle('clemmy:credentials-list', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['setup']);
  const rows = await listCredentialRows();
  return { rows };
});

ipcMain.handle('clemmy:credentials-set', async (evt: IpcMainInvokeEvent, payload: { name: string; value: string }) => {
  assertIpcSender(evt, ['setup']);
  const knownNames: CredentialName[] = [
    'openai_api_key', 'discord_bot_token', 'composio_api_key', 'recall_api_key',
    'codex_oauth_access_token', 'codex_oauth_refresh_token', 'webhook_secret',
  ];
  if (!knownNames.includes(payload.name as CredentialName)) {
    throw new Error('unknown credential name: ' + payload.name);
  }
  return setCredential(payload.name as CredentialName, payload.value);
});

ipcMain.handle('clemmy:credentials-delete', async (evt: IpcMainInvokeEvent, payload: { name: string }) => {
  assertIpcSender(evt, ['setup']);
  const knownNames: CredentialName[] = [
    'openai_api_key', 'discord_bot_token', 'composio_api_key', 'recall_api_key',
    'codex_oauth_access_token', 'codex_oauth_refresh_token', 'webhook_secret',
  ];
  if (!knownNames.includes(payload.name as CredentialName)) {
    throw new Error('unknown credential name: ' + payload.name);
  }
  await deleteCredential(payload.name as CredentialName);
  return { ok: true };
});

ipcMain.handle('clemmy:credentials-reset', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['setup']);
  return resetAllCredentials();
});

ipcMain.handle('clemmy:setup-save-workspace', async (evt: IpcMainInvokeEvent, payload: { path: string }) => {
  assertIpcSender(evt, ['setup']);
  const p = (payload?.path ?? '').trim();
  if (!p) throw new Error('path required');
  addWorkspaceDir(p);
  return { ok: true };
});

ipcMain.handle('clemmy:setup-pick-workspace-folder', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['setup']);
  // Native folder picker so the wizard doesn't ask the user to type a
  // path. Resolves to { path } when the user picks a folder, or
  // { path: '' } when they cancel.
  const parent = setupWindow ?? mainWindow;
  const opts: Electron.OpenDialogOptions = {
    title: 'Pick a workspace folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: HOME,
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || result.filePaths.length === 0) return { path: '' };
  return { path: result.filePaths[0] };
});

ipcMain.handle('clemmy:setup-codex-login', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['setup', 'dashboard']);
  // Run the OAuth dance from the Electron main process so the user
  // never sees a terminal. Tokens are persisted to BOTH the daemon's
  // local auth store and the codex CLI compatibility file. We do not
  // mirror them into Keychain here; the runtime reads the native auth
  // store directly, and avoiding extra Keychain writes prevents repeated
  // macOS prompts during first-run setup.
  //
  // First-run path: importUsableCodexOAuthTokens() short-circuits when
  // the user already has fresh tokens (e.g. from a prior codex CLI
  // login). For the Settings RE-AUTHENTICATE button — which must ALWAYS
  // open the browser — use the dedicated `clemmy:codex-reauth` handler
  // below.
  try {
    const imported = await importUsableCodexOAuthTokens();
    const tokens = imported ?? await runCodexOAuthLogin();
    persistCodexOAuthTokens(tokens);
    return {
      ok: true as const,
      accountId: tokens.accountId ?? '',
      lastRefresh: tokens.lastRefresh,
      reused: Boolean(imported),
    };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

/**
 * Force-fresh Codex OAuth — backs the Settings → Credentials
 * RE-AUTHENTICATE button. Bypasses the import-and-reuse short-circuit
 * in `setup-codex-login` so the browser ALWAYS opens. Use case: the
 * user wants to switch accounts, or the runtime is failing on tokens
 * that look valid on disk but aren't accepted by the backend.
 *
 * Old tokens are left in place until the new flow succeeds; on cancel
 * or failure the user keeps the working credentials they had. On
 * success, persistCodexOAuthTokens overwrites with the fresh pair.
 *
 * Reported 2026-05-23: the original button wired to
 * `setup-codex-login` looked broken because fresh tokens import
 * silently with no UI signal. This handler fixes that surface.
 */
ipcMain.handle('clemmy:codex-reauth', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['dashboard']);
  try {
    // `prompt: 'select_account'` forces auth.openai.com to render the
    // account picker even when the user already has a ChatGPT session
    // cookie. Without this the IdP would silently issue tokens for the
    // currently-cached account, defeating the purpose of the
    // Settings RE-AUTHENTICATE button (account switch + force-fresh).
    const tokens = await runCodexOAuthLogin({ prompt: 'select_account' });
    persistCodexOAuthTokens(tokens);
    return {
      ok: true as const,
      accountId: tokens.accountId ?? '',
      lastRefresh: tokens.lastRefresh,
    };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

ipcMain.handle('clemmy:setup-discord-verify', async (evt: IpcMainInvokeEvent, payload: { token: string }) => {
  assertIpcSender(evt, ['setup']);
  const token = (payload?.token ?? '').trim();
  if (!token) return { ok: false as const, error: 'token required' };
  try {
    const response = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false as const, error: `Discord lookup failed (${response.status}): ${body.slice(0, 200)}` };
    }
    const data = await response.json() as { id?: string; name?: string };
    if (!data.id) return { ok: false as const, error: 'Discord lookup did not return an application id' };
    const permissions = '274878000128'; // ViewChannel|SendMessages|ReadHistory|EmbedLinks|AttachFiles|AddReactions
    const installUrl = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(data.id)}&scope=${encodeURIComponent('bot applications.commands')}&permissions=${permissions}`;
    return {
      ok: true as const,
      clientId: data.id,
      appName: data.name ?? '',
      installUrl,
    };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('clemmy:setup-open-external', async (evt: IpcMainInvokeEvent, payload: { url: string }) => {
  assertIpcSender(evt, ['setup']);
  const url = (payload?.url ?? '').trim();
  if (!url) throw new Error('url required');
  if (!isSafeExternalHttps(url)) throw new Error('URL is not on the Clementine setup allowlist');
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle('clemmy:setup-save-discord-config', async (evt: IpcMainInvokeEvent, payload: { clientId?: string; ownerId?: string }) => {
  assertIpcSender(evt, ['setup']);
  const env: Record<string, string> = {};
  if (payload?.clientId !== undefined) env.DISCORD_CLIENT_ID = payload.clientId.trim();
  if (payload?.ownerId !== undefined) {
    env.DISCORD_DM_ALLOWED_USERS = payload.ownerId.trim();
    env.DISCORD_ALLOWED_USERS = payload.ownerId.trim();
  }
  if (Object.keys(env).length > 0) setHomeEnv(env);
  return { ok: true };
});

ipcMain.handle('clemmy:setup-save-profile', async (evt: IpcMainInvokeEvent, patch: ProfilePatch) => {
  assertIpcSender(evt, ['setup']);
  saveUserProfile(patch);
  return { ok: true };
});

ipcMain.handle('clemmy:setup-complete', async (evt: IpcMainInvokeEvent, record: { configured: SetupConfiguredSummary }) => {
  assertIpcSender(evt, ['setup']);
  // Persist AUTH_MODE so the daemon reads the right runtime on boot.
  // Without this, a user who picked Codex OAuth still gets AUTH_MODE=
  // api_key (the config.ts default) and the runtime tries to use an
  // empty OPENAI_API_KEY → every agent call fails. Skip mode leaves
  // AUTH_MODE alone so a later credential drop can set it.
  //
  // VERIFY, don't trust: commit codex_oauth only when the grant actually
  // persisted to the auth store. The renderer gates its NEXT button on the
  // login IPC, but the main process is the enforcement point — a wizard bug
  // (or an older wizard) that finalized "codex" without tokens shipped users
  // into a boot loop (live report 2026-07-16). Unverified → leave AUTH_MODE
  // alone; the daemon boots and Settings → Re-authenticate completes it.
  if (record.configured.auth === 'codex') {
    if (hasPersistedCodexGrant()) {
      setHomeEnv({ AUTH_MODE: 'codex_oauth' });
    } else {
      console.error('[setup] codex chosen but no persisted grant — AUTH_MODE left unchanged; user must re-authenticate');
    }
  } else if (record.configured.auth === 'openai') {
    setHomeEnv({ AUTH_MODE: 'api_key' });
  }
  writeSetupComplete({ configured: record.configured });
  // Close the wizard, kick the daemon, transition to dashboard.
  const win = setupWindow;
  setupWindow = null;
  win?.close();
  await launchDaemon();
  return { ok: true };
});

ipcMain.handle('clemmy:setup-skip', async (evt: IpcMainInvokeEvent) => {
  assertIpcSender(evt, ['setup']);
  writeSetupComplete({
    configured: { auth: 'skipped', discord: false, composio: false, workspaceCount: 0, profileSet: false },
  });
  const win = setupWindow;
  setupWindow = null;
  win?.close();
  await launchDaemon();
  // Surface a one-time notification so the user knows the dashboard
  // they're about to see isn't fully wired. Without this the silent-
  // failure mode is: every agent call returns an empty error and the
  // user doesn't know why. Tray ownership-repair message style — fast,
  // honest, dismissible.
  try {
    new Notification({
      title: 'Clementine is open, but no AI auth is set',
      body: 'Add an OpenAI key or sign in with ChatGPT from Settings → Models & routing to make chat work.',
      silent: false,
    }).show();
  } catch {
    /* notifications can fail on locked-down machines — non-fatal */
  }
  return { ok: true };
});

// ─── App lifecycle ─────────────────────────────────────────────────

// Catch any unhandled rejection in the Electron main process so the
// next bug class doesn't silently freeze boot. The 0.2.3 keytar interop
// crash was an unhandled rejection inside ensureWebhookSecret() that
// wedged boot() — the app launched, no window appeared, no user-visible
// signal. These handlers convert any future silent freeze into a
// visible dialog the user can act on (or screenshot to file a bug).
// A broken pipe to an OPTIONAL child helper (most often the Recall.ai meeting
// recorder's native process) is recoverable and must NEVER crash the whole app.
// Before v0.5.64 any EPIPE became a fatal boot dialog, crash-looping the app on
// startup. Log it durably and continue. (See pipe-errors.ts.)
function logNonFatal(label: string, err: unknown): void {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `\n=== Non-fatal (${label}) at ${new Date().toISOString()} ===\n${message}\n`);
  } catch {
    /* best-effort — never let logging throw from an error handler */
  }
}
process.on('unhandledRejection', (reason: unknown) => {
  if (isBenignPipeError(reason)) { logNonFatal('ignored broken pipe (unhandledRejection)', reason); return; }
  reportBootFailure('handle a background error', reason);
});
process.on('uncaughtException', (err: Error) => {
  if (isBenignPipeError(err)) { logNonFatal('ignored broken pipe (uncaughtException)', err); return; }
  reportBootFailure('handle a fatal error', err);
});

// Single-instance lock. Without this, double-clicking Clementine.app
// while it's already running launches a SECOND Electron process whose
// own boot() runs against the same HOME — at minimum that pops the
// setup wizard a second time on a fresh install (because the marker
// write from instance #1 may not have landed yet); at worst it starts
// a competing daemon supervisor on a different port. We claim the
// lock here; if we can't, we hand focus to the existing instance and
// exit. This is the textbook Electron pattern.
const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!SINGLE_INSTANCE_LOCK) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  // Someone tried to launch Clementine again — bring our existing
  // window to the front instead of starting a duplicate boot loop.
  if (setupWindow && !setupWindow.isDestroyed()) {
    revealWindow(setupWindow);
  } else {
    revealMainWindow();
  }
});

app.on('ready', () => {
  initializeClementineNotchPreferencesStore();
  // Wrap boot() so any sync or async failure surfaces as a dialog
  // rather than a hung process. Tray + updater still arm so the user
  // can install a fix once one ships.
  boot().catch((err) => reportBootFailure('start up', err));
  // Wake grace for the capture staleness floor (2026-07-14 review): system
  // sleep freezes the mic pump AND the wall clock check, so the first
  // post-wake status poll would see stale=true and finalize a recording the
  // user expects to CONTINUE. Re-arm the floor at wake; if the producer truly
  // died across sleep, staleness re-trips 15s later and finalizes honestly.
  powerMonitor.on('resume', () => localMeetingRecorder.touchActivity());
  powerMonitor.on('unlock-screen', () => localMeetingRecorder.touchActivity());
  setupTray();
  initializeClementineLiveShell();
  // Arm auto-updater after boot kicks off. Status changes flip the
  // tray label so the user sees "Restart to install vX.Y.Z" when an
  // update is downloaded; no modal interrupts.
  initAutoUpdater({ logFile: LOG_FILE });
  onUpdaterStatusChange((status) => {
    rebuildTrayMenu();
    sendUpdaterEvent(status);
  });
});
app.on('window-all-closed', () => {
  // macOS tray-resident pattern. On Linux/Windows we still quit when
  // all windows are gone unless the user is explicitly tray-only.
  if (process.platform !== 'darwin') quitCleanly();
});
app.on('activate', () => {
  revealMainWindow();
});
app.on('before-quit', (event) => {
  if ((app as { isInstallingUpdate?: boolean }).isInstallingUpdate) {
    (app as { isQuitting?: boolean }).isQuitting = true;
    return;
  }
  if (quitPrepared) return;
  event.preventDefault();
  void quitCleanly();
});
app.on('will-quit', () => disposeClementineLiveShell());
