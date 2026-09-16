import type { UsageStatusLike } from '@clem/chat-engine';
import { apiGet } from './api';

// Live model-account status for the usage meters (top bar, Settings › Connected,
// and the phone). One daemon builder owns it; see src/runtime/harness/model-status.ts.
// Codex and Claude expose 5h + weekly windows; Grok and API-key providers expose
// request/token limits with what is left; every account has today's ledger spend.
export interface QuotaWindow {
  usedPercent: number;
  resetAt?: number; // epoch ms
  windowMinutes?: number;
}
export interface ScopedQuotaWindow extends QuotaWindow {
  modelLabel?: string;
  active: boolean;
}
export type ModelStatus = UsageStatusLike & {
  openai: { connected: boolean };
  /** Back-compat alias kept for older renderers/tests; prefer byoProviders. */
  together: { connected: boolean };
  updatedAt: number;
};

export const getModelStatus = () => apiGet<ModelStatus>('/api/console/model-status');
