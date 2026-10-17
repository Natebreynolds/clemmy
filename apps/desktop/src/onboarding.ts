import type { SetupCompleteRecord } from './setup-state.js';

/** The canonical daemon URL keeps its bootstrap query; only the first-run
 * page changes. Re-evaluate this when a window is recreated or repointed. */
export function initialDesktopDashboardUrl(dashboardUrl: string, needsOnboarding: boolean): string {
  if (!needsOnboarding) return dashboardUrl;
  const url = new URL(dashboardUrl);
  url.pathname = '/console/onboarding';
  return url.toString();
}

export function isCurrentOnboardingMainFrame(
  sender: { senderId: number; senderFrameRoutingId: number | null },
  current: { webContentsId: number; mainFrameRoutingId: number } | null,
): boolean {
  return current !== null && sender.senderId === current.webContentsId
    && sender.senderFrameRoutingId === current.mainFrameRoutingId;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Configuration availability from the authenticated daemon's own settings,
 * not proof of a successful paid model request. Another connected option
 * cannot stand in for the exact model currently selected for conversation. */
export function onboardingModelConfigured(settings: unknown): boolean {
  const roles = object(object(settings)?.modelRoles);
  const value = roles?.effectiveBrainValue;
  const brain = roles?.effectiveBrain;
  const resolvedModel = object(object(roles?.roles)?.brain)?.modelId;
  const choices = roles?.brainOptions;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
    || (brain !== 'codex_oauth' && brain !== 'claude_oauth' && brain !== 'api_key')
    || !Array.isArray(choices)) return false;
  const options = choices.map(object).filter(option => option?.value === value);
  const option = options[0];
  return options.length === 1 && option?.id === brain && option?.available === true
    && typeof option.modelId === 'string' && option.modelId.length > 0
    && option.modelId === option.modelId.trim() && value === `${brain}:${option.modelId}`
    && option.modelId === resolvedModel;
}

export interface NativeOnboardingCompletionPorts {
  hasCompletedSetup: () => boolean;
  readSettings: () => Promise<unknown>;
  writeSetupComplete: (record: Omit<SetupCompleteRecord, 'completedAt' | 'version'>) => unknown;
}

/** Finalize only the existing onboarding marker. Model/account/permission
 * changes belong to the daemon's normal settings APIs; no daemon restart is
 * needed. A retry or concurrent completion preserves the first retained mark. */
export async function completeNativeOnboarding(
  payload: unknown,
  ports: NativeOnboardingCompletionPorts,
): Promise<{ ok: true }> {
  const input = payload === undefined ? {} : object(payload);
  if (!input || Object.keys(input).some(key => key !== 'exploreWithoutModel')
    || (Object.hasOwn(input, 'exploreWithoutModel') && typeof input.exploreWithoutModel !== 'boolean')) {
    throw new Error('Choose whether to finish with a connected model or explore without one.');
  }
  if (ports.hasCompletedSetup()) return { ok: true };
  const exploring = Object.hasOwn(input, 'exploreWithoutModel') && input.exploreWithoutModel === true;
  if (!exploring) {
    const settings = await ports.readSettings();
    // An explicit exploration choice may have finished while this read was
    // pending. Do not replace that retained decision with a later response.
    if (ports.hasCompletedSetup()) return { ok: true };
    if (!onboardingModelConfigured(settings)) {
      throw new Error('Connect and select a model, or choose to explore without a model.');
    }
  }
  if (!ports.hasCompletedSetup()) ports.writeSetupComplete({ configured: {
    auth: exploring ? 'skipped' : 'connected',
    discord: false,
    composio: false,
    workspaceCount: 0,
    profileSet: false,
  } });
  return { ok: true };
}
