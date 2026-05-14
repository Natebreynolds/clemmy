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
};

contextBridge.exposeInMainWorld('clemmy', api);

export type ClemmyDesktopApi = typeof api;
