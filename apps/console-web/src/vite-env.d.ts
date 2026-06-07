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
}

interface Window {
  __CLEM_BOOTSTRAP__?: ClemBootstrap;
  /** Electron preload bridge (apps/desktop/src/preload.ts). Absent in a plain browser. */
  clemmy?: Record<string, unknown>;
}
