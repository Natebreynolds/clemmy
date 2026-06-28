import { apiGet } from './api';

// Live model status for the top-bar chips. Codex/Claude expose real 5h + weekly
// quota windows (captured from provider rate-limit headers); OpenAI and Together
// are connection-status only (their balances aren't exposed by their APIs).
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
  together: { connected: boolean };
  updatedAt: number;
}

export const getModelStatus = () => apiGet<ModelStatus>('/api/console/model-status');
