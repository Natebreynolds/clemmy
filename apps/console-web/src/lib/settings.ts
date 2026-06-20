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
  modelProviders?: ModelProvider[];
  claudeAuth?: ClaudeAuth;
  activeBrain?: ActiveBrain;
  fusion?: FusionSettings;
  modelRoles?: ModelRolesSnapshot;
}

// Role→model registry: which model serves each role (brain/worker/judge), the
// source of that choice, and the models available grouped by CONNECTED provider.
export type ModelRoleName = 'brain' | 'worker' | 'judge';
export interface ResolvedRole {
  modelId: string;
  provider: 'codex' | 'claude' | 'byo';
  source: 'default' | 'settings' | 'chat-rule' | 'session';
  inactiveBinding?: {
    modelId: string;
    provider: 'codex' | 'claude' | 'byo';
    source: 'settings' | 'chat-rule' | 'session';
    reason: string;
  };
}
export interface ModelRolesSnapshot {
  roles: { brain: ResolvedRole; worker: ResolvedRole; judge: ResolvedRole };
  bindings: { role: ModelRoleName; modelId: string; whenIntent?: string; source: string }[];
  available: { provider: string; label: string; models: { id: string; label: string }[] }[];
  roleOptions?: {
    worker: { provider: string; label: string; models: { id: string; label: string }[] }[];
    judge: { provider: string; label: string; models: { id: string; label: string }[] }[];
  };
  // The brain picker: Codex / Claude / a BYO model, each flagged by availability.
  brainOptions?: { id: ActiveBrain; label: string; available: boolean; modelId?: string }[];
  // The brain the wire actually uses (all-in BYO → 'api_key' regardless of AUTH_MODE).
  effectiveBrain?: ActiveBrain;
  activeBrain: ActiveBrain;
}
// Set (or clear) a worker/judge role model. Brain is a provider login switch
// (setActiveBrain). Applies on the next message, no restart.
export const patchModelRole = (p: { role: 'worker' | 'judge'; modelId?: string; whenIntent?: string; clear?: boolean }) =>
  patch<{ modelRoles: ModelRolesSnapshot }>('/api/console/settings/models/roles', p);

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

// Multi-provider BYO registry. Each connected provider routes its own model ids
// to its own key+endpoint, so the brain/worker/judge picker is the source of
// truth across every added model. 'default' is the legacy single-backend slot;
// the first provider you add becomes it. Connecting one returns the full list +
// the routing mode (a fresh connect bumps mode 'off' → 'worker' so it's live).
export interface ModelProvider {
  id: string;
  label: string;
  baseURL: string;
  modelIds: string[];
  hasKey: boolean;
  configured: boolean;
  isDefault: boolean;
}
export interface ModelProvidersSnapshot { providers: ModelProvider[]; mode: ModelRoutingMode }
export interface AddModelProviderInput {
  id?: string;
  label: string;
  baseURL: string;
  apiKey?: string;
  modelIds: string[];
  mode?: ModelRoutingMode;
}
export const listModelProviders = () =>
  apiGet<ModelProvidersSnapshot>('/api/console/settings/model-providers');
export const addModelProvider = (p: AddModelProviderInput) =>
  api<ModelProvidersSnapshot>('/api/console/settings/model-providers', { method: 'POST', body: JSON.stringify(p) });
export const removeModelProvider = (id: string) =>
  api<ModelProvidersSnapshot>(`/api/console/settings/model-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Claude (Anthropic) subscription OAuth login.
export interface ClaudeAuth { configured: boolean; reason?: string; plan?: string; expiresAt?: string }
export const beginClaudeLogin = () =>
  api<{ flowId: string; authorizeUrl: string }>('/api/console/auth/claude/begin', { method: 'POST', body: '{}' });
export const completeClaudeLogin = (flowId: string, code: string) =>
  api<{ ok: boolean; snapshot?: ClaudeAuth }>('/api/console/auth/claude/complete', { method: 'POST', body: JSON.stringify({ flowId, code }) });

// Active brain (which model orchestrates everything). 'codex_oauth' is the
// default; 'claude_oauth' runs Clementine on the Claude subscription. Switching
// applies live on the next message — no daemon restart.
export type ActiveBrain = 'codex_oauth' | 'claude_oauth' | 'api_key';
export const setActiveBrain = (brain: ActiveBrain) =>
  patch<{ activeBrain: ActiveBrain; claudeAuth: ClaudeAuth }>('/api/console/settings/active-brain', { brain });

// Fusion (multi-model) — both flagships draft a turn, a judge reconciles. A live
// toggle: mode/judge apply on the next message, no restart. Needs BOTH a Claude
// and a Codex login; otherwise Clementine runs single-brain on the primary.
export type FusionMode = 'off' | 'high' | 'all';
export type FusionStrategy = 'debate' | 'verify';
export interface FusionSettings {
  mode: FusionMode;
  judge: 'claude' | 'codex';
  judgeRole?: ResolvedRole;
  strategy: FusionStrategy;
  brainsAvailable: { claude: boolean; codex: boolean };
  active: boolean;
}
export const patchFusion = (p: { mode: FusionMode; judge: 'claude' | 'codex'; strategy?: FusionStrategy }) =>
  patch<{ fusion: FusionSettings }>('/api/console/settings/fusion', p);
