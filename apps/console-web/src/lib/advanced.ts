import { apiGet } from './api';

export interface UsageRollup {
  date?: string;
  totalTokens?: number;
  totalCalls?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  bySource?: Array<{ source: string; tokens: number; calls: number; kind?: string }>;
  byModel?: Record<string, { tokens: number; calls: number }>;
  byKind?: Record<string, { tokens: number; calls: number }>;
  [k: string]: unknown;
}

export interface ToolRow { name: string; description?: string; category?: string; needsApproval?: boolean }

export const getUsage = () => apiGet<UsageRollup>('/api/console/usage');
export const getTools = () => apiGet<{ tools?: ToolRow[] }>('/api/console/tools');
export const getDiagnostics = () => apiGet<Record<string, unknown>>('/api/console/diagnostics');
export const getSettings = () => apiGet<Record<string, unknown>>('/api/console/settings');
export const getBuildInfo = () => apiGet<{ version?: string; name?: string }>('/api/console/build-info');
export const getAutoresearchReport = () => apiGet<Record<string, unknown>>('/api/console/autoresearch/report');

export const fmtNum = (n?: number) => (typeof n === 'number' ? n.toLocaleString() : '—');
