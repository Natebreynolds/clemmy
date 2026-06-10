import { apiGet, api } from './api';

export interface UserProfile {
  displayName?: string;
  preferredName?: string;
  role?: string;
  timezone?: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  communicationTone?: 'terse' | 'balanced' | 'verbose';
  formality?: 'casual' | 'professional' | 'formal';
  urgencyTolerance?: 'low' | 'normal' | 'high';
  notes?: string;
}

export interface BudgetSettings {
  preset?: 'standard' | 'long' | 'unlimited';
  maxTurns?: number;
  toolCallsPerTurn?: number;
  checkInMinutes?: number;
  autoContinueOnLimit?: boolean;
}

export interface Policy {
  enabled?: boolean;
  mode?: 'watch' | 'balanced' | 'hands_on';
  autoApproveScope?: 'strict' | 'balanced' | 'workspace' | 'yolo';
  checkInMinutes?: number;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  allowComposioActions?: boolean;
  allowComputerActions?: boolean;
  allowDiscordCheckIns?: boolean;
  requireWorkflowApprovalForExecution?: boolean;
}

export interface ModelTriple { fast: string; primary: string; deep: string }
export interface ModelsSnapshot {
  models: ModelTriple;
  defaults: ModelTriple;
  presets: { id: string; label: string }[];
}

export type ModelRoutingMode = 'off' | 'worker' | 'all_in';
export interface ModelBackend {
  mode: ModelRoutingMode;
  baseURL: string;
  modelId: string;
  judgeId: string;
  workerModel: string;
  providerLabel: string;
  hasKey: boolean;
  configured: boolean;
}
export interface ModelBackendPatch {
  mode: ModelRoutingMode;
  baseURL: string;
  apiKey?: string;
  modelId: string;
  judgeId?: string;
  workerModel?: string;
  providerLabel?: string;
}

export interface SettingsSnapshot {
  profile?: UserProfile;
  proactivity?: { policy?: Policy };
  // The daemon returns the budget snapshot shape { settings, presets, envKeys }
  // — the live values live under `.settings`, NOT flat on runtimeBudget.
  runtimeBudget?: {
    settings?: BudgetSettings & Record<string, unknown>;
    presets?: { id: string; label: string; description?: string }[];
    envKeys?: Record<string, string>;
  };
  models?: ModelsSnapshot;
  modelBackend?: ModelBackend;
}

export const getSettings = () => apiGet<SettingsSnapshot>('/api/console/settings');

const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const patchProfile = (p: Partial<UserProfile>) =>
  patch<{ profile: UserProfile }>('/api/console/settings/profile', p);
export const patchPolicy = (p: Partial<Policy>) =>
  patch<{ policy: Policy }>('/api/console/settings/policy', p);
export const patchBudget = (p: Partial<BudgetSettings>) =>
  patch<{ runtimeBudget: BudgetSettings }>('/api/console/settings/runtime-budget', p);
export const patchModels = (p: Partial<ModelTriple>) =>
  patch<{ models: ModelsSnapshot }>('/api/console/settings/models', p);
export const patchModelBackend = (p: ModelBackendPatch) =>
  patch<{ modelBackend: ModelBackend; models: ModelsSnapshot }>('/api/console/settings/model-backend', p);
