/// <reference types="vite/client" />

declare module 'cytoscape-fcose';

interface ImportMetaEnv {
  /** Dev-only auth token appended as ?token= by lib/api.ts. */
  readonly VITE_CLEM_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface ClemBootstrap {
  token?: string;
  version?: string;
  /** Server feature flags injected by the daemon (src/dashboard/console-spa.ts). */
  flags?: { memory3d?: boolean };
}

interface ClementineLiveBounds {
  width: number;
  height: number;
  presentation: 'dormant' | 'panel';
  layoutId: number;
}

interface ClementineLiveLayoutResult {
  ok: boolean;
  applied: boolean;
  layoutId: number;
}

interface ClementineLiveMountAck {
  generation: number;
  nonce: string;
}

interface ClementineLiveBridge {
  resize?: (bounds: ClementineLiveBounds) => ClementineLiveLayoutResult | Promise<ClementineLiveLayoutResult>;
  mounted?: (mount: ClementineLiveMountAck) => void | Promise<void>;
  openConsole?: () => void | Promise<void>;
  dismiss?: () => void | Promise<void>;
  meetingStatus?: () => unknown | Promise<unknown>;
  recordDetectedMeeting?: (windowId: string) => unknown | Promise<unknown>;
  alwaysRecordMeeting?: (windowId: string) => unknown | Promise<unknown>;
  dismissMeetingPrompt?: (windowId: string) => unknown | Promise<unknown>;
  stopMeetingRecording?: (windowId: string) => unknown | Promise<unknown>;
  requestMeetingPermissions?: () => unknown | Promise<unknown>;
  onPreview?: (callback: (payload: unknown) => void) => void | (() => void);
  onMeetingEvent?: (callback: (payload: unknown) => void) => void | (() => void);
}

interface Window {
  __CLEM_BOOTSTRAP__?: ClemBootstrap;
  /** Electron preload bridge (apps/desktop/src/preload.ts). Absent in a plain browser. */
  clemmy?: Record<string, unknown>;
  /** Optional native Clementine Live helper bridge. Absent in browser preview. */
  clementineLive?: ClementineLiveBridge;
}
