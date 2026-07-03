import { apiGet } from './api';

// Live model status for the top-bar chips. Codex/Claude expose real 5h + weekly
// quota windows (captured from provider rate-limit headers); OpenAI and BYO
// providers are connection-status only (their balances aren't exposed here).
export interface QuotaWindow {
  usedPercent: number;
  resetAt?: number; // epoch ms
  windowMinutes?: number;
}
export interface ModelStatus {
  codex: { connected: boolean; primary?: QuotaWindow; secondary?: QuotaWindow; capturedAt?: number };
  claude: {
    connected: boolean;
    fiveHour?: QuotaWindow;
    weekly?: QuotaWindow;
    status?: string;
    representativeClaim?: string;
    capturedAt?: number;
  };
  openai: { connected: boolean };
  byoProviders?: Array<{ id: string; label: string; modelIds: string[]; connected: boolean }>;
  /** Back-compat alias kept for older renderers/tests; prefer byoProviders. */
  together: { connected: boolean };
  updatedAt: number;
}

export const getModelStatus = () => apiGet<ModelStatus>('/api/console/model-status');
