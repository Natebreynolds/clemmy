/**
 * Session-scoped role-model overrides (owner ask, 2026-07-24: pin models per
 * WORKFLOW at authoring to cut tokens). The workflow runner registers a
 * step session's pinned worker model here; the worker dispatch seams
 * (run_worker, code-mode workers, sub-agent builder) consult it before the
 * global role default. In-memory and bounded — an override lives only as
 * long as its step run and is best-effort by design (a missed cleanup is
 * capped out; a daemon restart simply reverts to global routing).
 */

const MAX_ENTRIES = 500;

const workerOverrides = new Map<string, string>();

export function setSessionWorkerModelOverride(sessionId: string, modelId: string): void {
  if (!sessionId.trim() || !modelId.trim()) return;
  if (workerOverrides.size >= MAX_ENTRIES) {
    const oldest = workerOverrides.keys().next().value;
    if (oldest !== undefined) workerOverrides.delete(oldest);
  }
  workerOverrides.set(sessionId, modelId.trim());
}

export function getSessionWorkerModelOverride(sessionId: string | undefined | null): string | undefined {
  if (!sessionId) return undefined;
  return workerOverrides.get(sessionId);
}

export function clearSessionWorkerModelOverride(sessionId: string): void {
  workerOverrides.delete(sessionId);
}

export function _resetSessionRoleOverridesForTests(): void {
  workerOverrides.clear();
}
