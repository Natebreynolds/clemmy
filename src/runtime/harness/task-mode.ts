/** Explicit user-selected task mode. Absence preserves legacy request hashes. */
import { createHash } from 'node:crypto';

export interface PlanRevisionRef { planId: string; revision: number; digest: string }
export type TaskMode =
  | { version: 1; kind: 'normal' | 'plan' }
  | { version: 1; kind: 'execute'; executeRef: PlanRevisionRef };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('INVALID_TASK_MODE');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join('\0') !== keys.sort().join('\0')) throw new Error('INVALID_TASK_MODE');
}
export function parsePlanRevisionRef(value: unknown): PlanRevisionRef {
  const input = record(value);
  exactKeys(input, ['planId', 'revision', 'digest']);
  if (typeof input.planId !== 'string' || !input.planId.trim() || input.planId !== input.planId.trim()
    || input.planId.length > 200 || /[\u0000-\u001f/\\]/u.test(input.planId)
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1
    || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest)) throw new Error('INVALID_PLAN_REVISION_REF');
  return { planId: input.planId, revision: input.revision as number, digest: input.digest };
}
export function parseTaskMode(value: unknown): TaskMode | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (input.version !== 1 || !['normal', 'plan', 'execute'].includes(String(input.kind))) throw new Error('INVALID_TASK_MODE');
  if (input.kind === 'execute') {
    exactKeys(input, ['version', 'kind', 'executeRef']);
    return { version: 1, kind: 'execute', executeRef: parsePlanRevisionRef(input.executeRef) };
  }
  exactKeys(input, ['version', 'kind']);
  return { version: 1, kind: input.kind as 'normal' | 'plan' };
}
export function taskModeDigest(mode: TaskMode | undefined): string {
  return createHash('sha256').update(JSON.stringify(parseTaskMode(mode) ?? null)).digest('hex');
}
/** Omit absent mode: callers spread this into their existing hash material. */
export function taskModeFields(mode: TaskMode | undefined): { taskMode?: TaskMode } {
  const parsed = parseTaskMode(mode);
  return parsed ? { taskMode: parsed } : {};
}
