import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script — bridges a narrow, typed API onto window.clemmy in
 * the renderer. The renderer is sandboxed; this is the only way it
 * can talk to the main process (which is the only process that can
 * touch the SecretStore + Keychain).
 *
 * Renderer code calls e.g.:
 *   await window.clemmy.supervisorStatus();
 *   await window.clemmy.restartDaemon();
 *   const { lines } = await window.clemmy.tailLog(500);
 *
 * Adding a new method here requires three steps:
 *   1. Define the IPC handler in main.ts (ipcMain.handle).
 *   2. Add the method here.
 *   3. Update the .d.ts type ambient if you want type completion in
 *      the console renderer.
 */

const api = {
  /** Current daemon status (running flag, chosen port, dashboard URL). */
  supervisorStatus: () => ipcRenderer.invoke('clemmy:supervisor-status') as Promise<{ running: boolean; port: number; url: string }>,
  /** Stop + start the daemon. Renderer should show a spinner — main
   *  emits supervisor events during the cycle. */
  restartDaemon: () => ipcRenderer.invoke('clemmy:restart-daemon') as Promise<{ ok: boolean }>,
  /** Recent N lines from the supervisor log. */
  tailLog: (maxLines?: number) => ipcRenderer.invoke('clemmy:tail-log', maxLines) as Promise<{ lines: string[] }>,
  /** Open the log file in the OS default viewer. */
  openLogs: () => ipcRenderer.invoke('clemmy:open-logs') as Promise<{ opened: boolean }>,
  /** Optional Recall.ai Desktop Recording SDK integration. */
  recallStatus: () => ipcRenderer.invoke('clemmy:recall-status') as Promise<Record<string, unknown> | null>,
  recallConfigure: (settings: Record<string, unknown>) => ipcRenderer.invoke('clemmy:recall-configure', settings) as Promise<Record<string, unknown> | null>,
  recallRequestPermissions: () => ipcRenderer.invoke('clemmy:recall-request-permissions') as Promise<Record<string, unknown> | null>,
  recallStartManual: () => ipcRenderer.invoke('clemmy:recall-start-manual') as Promise<Record<string, unknown> | null>,
  /** Primary "RECORD MEETING" button — records a detected online-meeting
   *  window, or returns concrete permission/no-window guidance. */
  recallRecordActive: () => ipcRenderer.invoke('clemmy:recall-record-active') as Promise<Record<string, unknown> | null>,
  /** Start recording a specific window the SDK has detected. Drives
   *  the "Record this meeting" prompt button. */
  recallRecordDetected: (windowId: string) => ipcRenderer.invoke('clemmy:recall-record-detected', { windowId }) as Promise<Record<string, unknown> | null>,
  /** Flip autoRecord on AND start recording this window — the
   *  "Always record" prompt button. */
  recallAutoRecord: (windowId: string) => ipcRenderer.invoke('clemmy:recall-auto-record', { windowId }) as Promise<Record<string, unknown> | null>,
  recallStop: () => ipcRenderer.invoke('clemmy:recall-stop') as Promise<Record<string, unknown> | null>,
  /** Forces an SDK init (if enabled) and returns the full status incl.
   *  permissionStatuses + detectedWindows. Use this for the dashboard's
   *  "Test Connection" diagnostic button. */
  recallTest: () => ipcRenderer.invoke('clemmy:recall-test') as Promise<Record<string, unknown> | null>,

  /** Local/offline in-person meeting capture. Audio arrives from the sandboxed
   * renderer as small 16 kHz mono PCM chunks and is streamed straight to disk
   * by the main process. */
  localMeetingStatus: () => ipcRenderer.invoke('clemmy:local-meeting-status') as Promise<Record<string, unknown>>,
  localMeetingStart: (payload?: { title?: string }) => ipcRenderer.invoke('clemmy:local-meeting-start', payload ?? {}) as Promise<Record<string, unknown>>,
  localMeetingAppend: (sessionId: string, chunk: ArrayBuffer) => ipcRenderer.invoke(
    'clemmy:local-meeting-append',
    { sessionId, chunk },
  ) as Promise<Record<string, unknown>>,
  localMeetingStop: (sessionId: string) => ipcRenderer.invoke('clemmy:local-meeting-stop', { sessionId }) as Promise<Record<string, unknown>>,
  localMeetingCancel: (sessionId: string) => ipcRenderer.invoke('clemmy:local-meeting-cancel', { sessionId }) as Promise<Record<string, unknown>>,

  /** Auto-updater status (checking/no-update/available/downloading/ready/error). */
  updaterStatus: () => ipcRenderer.invoke('clemmy:updater-status') as Promise<Record<string, unknown>>,
  /** Manually trigger a one-shot update check. Returns the new status. */
  updaterCheck: () => ipcRenderer.invoke('clemmy:updater-check') as Promise<Record<string, unknown>>,
  /** Download an available update, or quit+install once it is ready. */
  updaterApply: () => ipcRenderer.invoke('clemmy:updater-apply') as Promise<Record<string, unknown>>,
  /** Move the packaged app to /Applications so macOS auto-updates can apply. */
  updaterMoveToApplications: () => ipcRenderer.invoke('clemmy:updater-move-to-applications') as Promise<Record<string, unknown>>,
  /** Repair /Applications/Clementine.app ownership so auto-updates can apply. */
  updaterRepairOwnership: () => ipcRenderer.invoke('clemmy:updater-repair-ownership') as Promise<Record<string, unknown>>,
  onUpdaterEvent: (cb: (event: Record<string, unknown>) => void) => {
    const handler = (_event: unknown, payload: Record<string, unknown>) => cb(payload);
    ipcRenderer.on('clemmy:updater-event', handler);
    return () => ipcRenderer.removeListener('clemmy:updater-event', handler);
  },
  onRecallEvent: (cb: (event: Record<string, unknown>) => void) => {
    const handler = (_event: unknown, payload: Record<string, unknown>) => cb(payload);
    ipcRenderer.on('clemmy:recall-event', handler);
    return () => ipcRenderer.removeListener('clemmy:recall-event', handler);
  },
  /** Subscribe to supervisor lifecycle events (starting/running/ready/exit/restart). */
  onSupervisorEvent: (cb: (event: Record<string, unknown>) => void) => {
    const handler = (event: CustomEvent<Record<string, unknown>>) => cb(event.detail);
    // Splash uses window.addEventListener('supervisor', …). Renderer
    // can also call this for parity.
    window.addEventListener('supervisor', handler as EventListener);
    return () => window.removeEventListener('supervisor', handler as EventListener);
  },

  // ─── Setup wizard (only used by the first-run window) ──────────
  /** First-run state — { needsSetup, hasKeychain }. */
  setupStatus: () => ipcRenderer.invoke('clemmy:setup-status') as Promise<{ needsSetup: boolean; hasKeychain: boolean }>,
  /** Per-credential listing for the dashboard / wizard. */
  credentialsList: () => ipcRenderer.invoke('clemmy:credentials-list') as Promise<{ rows: Array<Record<string, unknown>> }>,
  /** Write a credential through main into Clementine's local vault. */
  credentialsSet: (name: string, value: string) => ipcRenderer.invoke('clemmy:credentials-set', { name, value }) as Promise<Record<string, unknown>>,
  /** Persist a workspace path to ~/.clementine-next/.env's WORKSPACE_DIRS. */
  setupSaveWorkspace: (absPath: string) => ipcRenderer.invoke('clemmy:setup-save-workspace', { path: absPath }) as Promise<{ ok: boolean }>,
  /** Native folder picker for the setup wizard's workspace step. */
  setupPickWorkspaceFolder: () => ipcRenderer.invoke('clemmy:setup-pick-workspace-folder') as Promise<{ path: string }>,
  /** Run the Codex OAuth flow from the main process — opens the user's
   *  default browser, listens on localhost for the callback, and
   *  persists the resulting tokens. Returns { ok, accountId } on success
   *  or { ok: false, error } on failure (user cancel, network, etc.). */
  setupCodexLogin: () => ipcRenderer.invoke('clemmy:setup-codex-login') as Promise<
    | { ok: true; accountId: string; lastRefresh: string; reused?: boolean }
    | { ok: false; error: string }
  >,
  /** Persist a profile patch to ~/.clementine-next/state/user-profile.json. */
  setupSaveProfile: (patch: Record<string, unknown>) => ipcRenderer.invoke('clemmy:setup-save-profile', patch) as Promise<{ ok: boolean }>,
  /** Wizard finished — close setup window, signal main to boot dashboard. */
  setupComplete: (record: Record<string, unknown>) => ipcRenderer.invoke('clemmy:setup-complete', record) as Promise<{ ok: boolean }>,
  /** Wizard skipped — close + boot dashboard anyway. */
  setupSkip: () => ipcRenderer.invoke('clemmy:setup-skip') as Promise<{ ok: boolean }>,
  /** Validate a Discord bot token; on success returns clientId/appName/installUrl. */
  setupDiscordVerify: (token: string) => ipcRenderer.invoke('clemmy:setup-discord-verify', { token }) as Promise<
    | { ok: true; clientId: string; appName: string; installUrl: string }
    | { ok: false; error: string }
  >,
  /** Open an http(s) URL in the user's default browser. */
  setupOpenExternal: (url: string) => ipcRenderer.invoke('clemmy:setup-open-external', { url }) as Promise<{ ok: boolean }>,
  /** Persist DISCORD_CLIENT_ID and/or DISCORD_DM_ALLOWED_USERS to ~/.clementine-next/.env. */
  setupSaveDiscordConfig: (payload: { clientId?: string; ownerId?: string }) => ipcRenderer.invoke('clemmy:setup-save-discord-config', payload) as Promise<{ ok: boolean }>,
};

contextBridge.exposeInMainWorld('clemmy', api);

export type ClemmyDesktopApi = typeof api;
