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
  /** Write a credential through main → SecretStore (keychain when
   *  packaged, file vault otherwise). */
  credentialsSet: (name: string, value: string) => ipcRenderer.invoke('clemmy:credentials-set', { name, value }) as Promise<Record<string, unknown>>,
  /** Persist a workspace path to ~/.clementine-next/.env's WORKSPACE_DIRS. */
  setupSaveWorkspace: (absPath: string) => ipcRenderer.invoke('clemmy:setup-save-workspace', { path: absPath }) as Promise<{ ok: boolean }>,
  /** Persist a profile patch to ~/.clementine-next/state/user-profile.json. */
  setupSaveProfile: (patch: Record<string, unknown>) => ipcRenderer.invoke('clemmy:setup-save-profile', patch) as Promise<{ ok: boolean }>,
  /** Wizard finished — close setup window, signal main to boot dashboard. */
  setupComplete: (record: Record<string, unknown>) => ipcRenderer.invoke('clemmy:setup-complete', record) as Promise<{ ok: boolean }>,
  /** Wizard skipped — close + boot dashboard anyway. */
  setupSkip: () => ipcRenderer.invoke('clemmy:setup-skip') as Promise<{ ok: boolean }>,
};

contextBridge.exposeInMainWorld('clemmy', api);

export type ClemmyDesktopApi = typeof api;
