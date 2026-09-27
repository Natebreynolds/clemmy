/**
 * The background jobs that keep memory current — one registry.
 *
 * Every memory job has one stable id. The usage channel (`memory:<id>`), the
 * operational event actor, the route seam and the Memory tab's grouping all
 * key off it, so a job is named the same way in the ledger and on screen.
 * Owner-facing words live with the apps (packages/chat-engine memory-work.ts),
 * never in these ids.
 *
 * `modelOwner` says whose model does the job's thinking:
 *   memory  — the "memory" model role (Settings → Models);
 *   checker — "Checks the work", on purpose: its value is independence;
 *   local   — a model that runs on this machine (the search index);
 *   none    — no model, rules only.
 */

export type MemoryJobId =
  | 'learn'
  | 'reconcile'
  | 'patterns'
  | 'skills'
  | 'identity'
  | 'import'
  | 'standing'
  | 'verify'
  | 'index'
  | 'tidy';

export type MemoryJobModelOwner = 'memory' | 'checker' | 'local' | 'none';

export type MemoryJobTrigger =
  | 'after_conversation'
  | 'after_message'
  | 'on_save'
  | 'after_success'
  | 'after_correction'
  | 'every_few_minutes'
  | 'hourly'
  | 'daily'
  | 'nightly'
  | 'on_request';

export interface MemoryJobSpec {
  id: MemoryJobId;
  modelOwner: MemoryJobModelOwner;
  /** The trigger the Memory tab shows as "next". */
  trigger: MemoryJobTrigger;
}

export const MEMORY_JOBS: Readonly<Record<MemoryJobId, MemoryJobSpec>> = Object.freeze({
  learn: { id: 'learn', modelOwner: 'memory', trigger: 'after_conversation' },
  reconcile: { id: 'reconcile', modelOwner: 'memory', trigger: 'on_save' },
  patterns: { id: 'patterns', modelOwner: 'memory', trigger: 'nightly' },
  skills: { id: 'skills', modelOwner: 'memory', trigger: 'after_success' },
  identity: { id: 'identity', modelOwner: 'memory', trigger: 'daily' },
  import: { id: 'import', modelOwner: 'memory', trigger: 'on_request' },
  standing: { id: 'standing', modelOwner: 'checker', trigger: 'after_message' },
  verify: { id: 'verify', modelOwner: 'checker', trigger: 'nightly' },
  index: { id: 'index', modelOwner: 'local', trigger: 'every_few_minutes' },
  tidy: { id: 'tidy', modelOwner: 'none', trigger: 'nightly' },
});

export const MEMORY_JOB_IDS: readonly MemoryJobId[] = Object.freeze(Object.keys(MEMORY_JOBS) as MemoryJobId[]);

export function isMemoryJobId(value: unknown): value is MemoryJobId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MEMORY_JOBS, value);
}

/** The usage-ledger channel every model call of this job carries. */
export function memoryJobChannel(job: MemoryJobId): string {
  return `memory:${job}`;
}

/** The job named by a `memory:<id>` channel, or null. */
export function memoryJobFromChannel(channel: string | undefined): MemoryJobId | null {
  const value = (channel ?? '').trim();
  if (!value.startsWith('memory:')) return null;
  const id = value.slice('memory:'.length);
  return isMemoryJobId(id) ? id : null;
}

/** Jobs whose model the owner's memory choice governs. */
export function memoryJobUsesMemoryModel(job: MemoryJobId): boolean {
  return MEMORY_JOBS[job].modelOwner === 'memory';
}
