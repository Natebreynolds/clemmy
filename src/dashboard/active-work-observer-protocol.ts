/** Private observation protocol. None of its values grant execution authority. */
import { createHash } from 'node:crypto';
import type { InstallQuiescenceSnapshot } from './install-quiescence-read.js';

export const ACTIVE_WORK_OBSERVER_LIMITS = Object.freeze({
  rows: 30_000, events: 8_000, files: 2_000, fileBytes: 2_000_000,
  totalBytes: 24_000_000, policyInputs: 1_024, policyBytes: 4_000_000,
  policyItemBytes: 128_000, dtoBytes: 2_000_000, deadlineMs: 15_000,
});
const BOUND_REASONS = ['rows', 'total_bytes', 'file_bytes', 'files', 'events', 'policy_inputs',
  'policy_bytes', 'policy_item_bytes', 'dto_bytes', 'deadline'] as const;
type ObservationBoundReason = typeof BOUND_REASONS[number];
export type ObservationIssueCode = 'active_work_observation_unverified' | `active_work_observation_${ObservationBoundReason}_bound`;
const boundIssues = new Set<string>(BOUND_REASONS.map(reason => `active_work_observation_${reason}_bound`));
/** Only known guard sites create these errors; arbitrary exception text stays private. */
export class ObservationBoundError extends Error {
  readonly issueCode: ObservationIssueCode;
  constructor(reason: ObservationBoundReason) {
    super('observation_bound');
    this.issueCode = `active_work_observation_${reason}_bound`;
  }
}
/** Worker failure codes are diagnostics only, never an accepted worker snapshot. */
export function observationIssueCode(value: unknown): ObservationIssueCode {
  return typeof value === 'string' && boundIssues.has(value) ? value as ObservationIssueCode : 'active_work_observation_unverified';
}
export function observationFailureIssue(error: unknown): ObservationIssueCode {
  return observationIssueCode(error instanceof ObservationBoundError ? error.issueCode : undefined);
}
export interface ObservationIdentity {
  nonce: string; epoch: string; build: string; baseDir: string; workflowDir: string;
  schema: number; requestedAt: number; deadline: number;
  artifacts: { file: string; generation: string; digest: string }[];
}
export type PolicyKind = 'effect' | 'shape' | 'targets' | 'sealed';
export interface PolicyInput { key: string; kind: PolicyKind; value: unknown }
export interface PolicyValue { key: string; output: unknown }
export interface ActiveWorkSnapshot extends InstallQuiescenceSnapshot {
  activeSessions: number; pendingApprovals: number; activeBackgroundTasks: number;
  items: unknown[]; trackedActivitySummary?: string; activityAvailable?: boolean;
}
export function observationDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Identity is a closed typed tuple, independent of JavaScript key insertion order. */
export function observationIdentityDigest(value: ObservationIdentity): string {
  const keys = ['nonce', 'epoch', 'build', 'baseDir', 'workflowDir', 'schema', 'requestedAt', 'deadline', 'artifacts'];
  const record = value as unknown as Record<string, unknown>;
  const text = (input: unknown, maximum: number) => typeof input === 'string' && input.length > 0 && input.length <= maximum;
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))
    || !text(value.nonce, 128) || !text(value.epoch, 128) || !text(value.build, 128)
    || !text(value.baseDir, 4_096) || !text(value.workflowDir, 4_096)
    || !Number.isSafeInteger(value.schema) || value.schema < 1
    || !Number.isSafeInteger(value.requestedAt) || value.requestedAt < 1
    || !Number.isSafeInteger(value.deadline) || value.deadline < value.requestedAt
    || !Array.isArray(value.artifacts) || value.artifacts.length > 2
    || value.artifacts.some(pin => !pin || typeof pin !== 'object' || Array.isArray(pin)
      || Object.keys(pin).length !== 3 || !['file', 'generation', 'digest'].every(key => Object.hasOwn(pin, key))
      || !text(pin.file, 4_096) || !text(pin.generation, 256) || !/^[a-f0-9]{64}$/.test(pin.digest))) {
    throw new Error('observation_identity');
  }
  return observationDigest([value.nonce, value.epoch, value.build, value.baseDir, value.workflowDir,
    value.schema, value.requestedAt, value.deadline, value.artifacts.map(pin => [pin.file, pin.generation, pin.digest])]);
}
export function policyInput(kind: PolicyKind, value: unknown): PolicyInput {
  return { key: observationDigest([kind, value === undefined ? ['undefined'] : ['value', value]]), kind, value };
}
export function policyMapDigest(inputs: readonly PolicyInput[], values: readonly PolicyValue[]): string {
  return observationDigest([inputs, values]);
}
export type ObserverToMain =
  | { type: 'policy'; identity: ObservationIdentity; inputs: PolicyInput[] }
  | { type: 'candidate'; identity: ObservationIdentity; policyDigest: string; snapshot: ActiveWorkSnapshot }
  | { type: 'result'; identity: ObservationIdentity; policyDigest: string; snapshot: ActiveWorkSnapshot; issueCode?: ObservationIssueCode };
export type MainToObserver =
  | { type: 'policy'; identity: ObservationIdentity; values: PolicyValue[]; policyDigest: string }
  | { type: 'validate'; identity: ObservationIdentity; policyDigest: string };
