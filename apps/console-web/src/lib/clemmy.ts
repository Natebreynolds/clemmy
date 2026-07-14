/**
 * Typed, defensive accessor for the Electron preload bridge
 * (apps/desktop/src/preload.ts), exposed as `window.clemmy`. It is
 * ABSENT in a plain browser (vite dev) and in any non-Electron host, so
 * every call is optional-chained and feature-detected. UI that depends on
 * it (updater chip, meeting capture, supervisor reconnect) must degrade
 * gracefully when this returns null.
 */
export interface UpdaterEvent {
  type: string;
  [k: string]: unknown;
}

interface ClemmyBridge {
  supervisorStatus?: () => Promise<{ running: boolean; port: number; url: string }>;
  restartDaemon?: () => Promise<unknown>;
  openLogs?: () => Promise<unknown>;
  updaterStatus?: () => Promise<unknown>;
  updaterCheck?: () => Promise<unknown>;
  onUpdaterEvent?: (cb: (event: UpdaterEvent) => void) => void;
  // Recall.ai meeting capture (Electron-only; absent in a browser).
  recallStatus?: () => Promise<Record<string, unknown> | null>;
  recallConfigure?: (settings: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  recallRequestPermissions?: () => Promise<Record<string, unknown> | null>;
  recallRecordActive?: () => Promise<Record<string, unknown> | null>;
  recallStop?: () => Promise<Record<string, unknown> | null>;
  recallTest?: () => Promise<Record<string, unknown> | null>;
  onRecallEvent?: (cb: (event: Record<string, unknown>) => void) => (() => void) | void;
  // Local/offline in-person meeting capture (Electron-only).
  localMeetingStatus?: () => Promise<Record<string, unknown>>;
  localMeetingStart?: (payload?: { title?: string }) => Promise<Record<string, unknown>>;
  localMeetingAppend?: (sessionId: string, chunk: ArrayBuffer) => Promise<Record<string, unknown>>;
  localMeetingStop?: (sessionId: string) => Promise<Record<string, unknown>>;
  localMeetingCancel?: (sessionId: string) => Promise<Record<string, unknown>>;
}

export function clemmy(): ClemmyBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as Window & { clemmy?: unknown }).clemmy;
  return bridge && typeof bridge === 'object' ? (bridge as ClemmyBridge) : null;
}

/** True when running inside the Electron desktop shell. */
export function isDesktop(): boolean {
  return clemmy() !== null;
}
