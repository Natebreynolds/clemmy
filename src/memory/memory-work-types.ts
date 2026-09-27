/**
 * Memory at work — the daemon's copy of the snapshot contract.
 *
 * The apps build against `packages/chat-engine/src/memory-work.ts`; the daemon
 * cannot import packages/ (its rootDir is src), so every type the routes
 * return is mirrored here with the same field names and unions.
 * `memory-work-types.test.ts` compares the two sources and fails on any drift.
 * The job ids and their owners come from the one job registry.
 */

export type { MemoryJobId, MemoryJobModelOwner, MemoryJobTrigger } from './memory-jobs.js';
import type { MemoryJobId, MemoryJobModelOwner, MemoryJobTrigger } from './memory-jobs.js';

export type MemoryWorkState = 'working' | 'resting' | 'waiting' | 'off' | 'unknown';

export type MemoryWorkOutcome = 'ok' | 'nothing_new' | 'failed' | 'waiting';

/** Why a model call could not run. Never a provider name. */
export type MemoryModelProblem = 'quota' | 'credit' | 'not_connected' | 'timeout' | 'error';

export interface MemoryWorkSource {
  kind: 'conversation' | 'workflow' | 'owner' | 'schedule' | 'tool';
  sessionId?: string;
  /** The conversation or workflow title when the daemon knows it. */
  title?: string;
}

export interface MemoryWorkRunning {
  job: MemoryJobId;
  startedAt: string;
  source?: MemoryWorkSource | null;
  /** A long conversation is read in parts. */
  part?: number;
  parts?: number;
}

export interface MemoryWorkWaiting {
  /** busy: something is running and learning yields to it;
   *  model_paused: the provider asked Clem to back off until `until`;
   *  model_unavailable: the memory model cannot be reached right now. */
  reason: 'busy' | 'model_paused' | 'model_unavailable';
  since?: string;
  until?: string;
  problem?: MemoryModelProblem;
  /** What learning is waiting behind, when `reason` is busy. */
  blocker?: { kind: 'chat' | 'workflow' | 'background' | 'other'; startedAt?: string } | null;
}

export interface MemoryWorkQueue {
  /** Parts of finished conversations not read yet. */
  toLearn: number | null;
  /** Claims set aside for a second look (they overlap an existing memory). */
  setAside: number | null;
  /** Parts that failed every retry. */
  failed: number | null;
}

export interface MemoryWorkModel {
  /** chosen = the owner picked it in Settings; automatic = Clem picks. */
  source: 'chosen' | 'automatic';
  /** The model the next memory job will ask for. Null when none is available. */
  modelId: string | null;
  /** Automatic only: whose model memory work borrows today. */
  follows?: 'checker' | 'brain' | null;
  /** The model that actually answered the most recent memory call. */
  lastServed?: { modelId: string; at: string; standIn: boolean } | null;
  unavailable?: { problem: MemoryModelProblem; until?: string } | null;
}

export interface MemoryWorkTotals {
  runs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  learned: number;
  updated: number;
  faded: number;
}

export interface MemoryJobStatus {
  id: MemoryJobId;
  modelOwner: MemoryJobModelOwner;
  state: 'running' | 'idle' | 'waiting' | 'off';
  /** Last model that served this job (or, for a governed job that has not run
   *  yet, the one it would use). */
  modelId?: string | null;
  lastRun?: { at: string; outcome: MemoryWorkOutcome; durationMs?: number } | null;
  next?: { trigger: MemoryJobTrigger; at?: string } | null;
  today: MemoryWorkTotals;
}

export interface MemoryWorkToday extends MemoryWorkTotals {
  conversationsRead: number;
  claimsFound: number;
  /** Claims left out because the conversation did not support them. */
  leftOut: number;
  /** Claims set aside for a second look. */
  setAside: number;
  /** Priced spend when every call today has a known price; null otherwise. */
  costUsd?: number | null;
}

export interface MemoryWorkHour {
  hourStart: string;
  runs: number;
  modelCalls: number;
  learned: number;
}

export interface MemoryWorkDay {
  day: string;
  runs: number;
  modelCalls: number;
  learned: number;
  inputTokens: number;
  outputTokens: number;
}

export interface MemoryWorkProduced {
  claims?: number;
  learned?: number;
  updated?: number;
  reinforced?: number;
  leftOut?: number;
  setAside?: number;
  faded?: number;
  restored?: number;
  patterns?: number;
  skills?: number;
  proposals?: number;
  embedded?: number;
  entities?: number;
  /** A check passed (a standing instruction, a memory repair). */
  approved?: number;
  /** A check stopped a change. */
  declined?: number;
}

/** Every count a memory-work record may carry, in one list. */
export const MEMORY_WORK_PRODUCED_KEYS: readonly (keyof MemoryWorkProduced)[] = Object.freeze([
  'claims', 'learned', 'updated', 'reinforced', 'leftOut', 'setAside', 'faded',
  'restored', 'patterns', 'skills', 'proposals', 'embedded', 'entities', 'approved', 'declined',
]);

export interface MemoryWorkFact {
  id: string;
  /** Current text of the memory, read when the snapshot was built. */
  text: string;
  change: 'learned' | 'updated' | 'reinforced' | 'faded' | 'restored';
  /** Whether the memory is active now (a later undo or fade turns it off). */
  active: boolean;
}

export interface MemoryWorkEvent {
  id: string;
  job: MemoryJobId;
  at: string;
  startedAt?: string;
  outcome: MemoryWorkOutcome;
  model?: { modelId: string; standIn: boolean } | null;
  usage?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    durationMs?: number;
  } | null;
  source?: MemoryWorkSource | null;
  produced: MemoryWorkProduced;
  facts?: MemoryWorkFact[];
  /** Present only while undo would still change something:
   *  forget = turn off what this run learned; restore = bring back what it faded. */
  undo?: { kind: 'forget' | 'restore'; count: number } | null;
  failure?: { problem: MemoryModelProblem } | null;
  /** When this record ages out of the detailed history. */
  expiresAt: string;
}

export interface MemoryWorkSnapshot {
  generatedAt: string;
  state: MemoryWorkState;
  running: MemoryWorkRunning[];
  waiting?: MemoryWorkWaiting | null;
  lastWorkAt?: string | null;
  queue: MemoryWorkQueue;
  model: MemoryWorkModel;
  /** The local search-index model, read-only. */
  embedder?: { modelId: string | null; local: boolean } | null;
  jobs: MemoryJobStatus[];
  today: MemoryWorkToday;
  /** Last 24 hours, oldest first. */
  hourly: MemoryWorkHour[];
  /** Last 30 days, oldest first. */
  daily: MemoryWorkDay[];
  /** Newest first. */
  recent: MemoryWorkEvent[];
  retention: { detailDays: number; summaryDays: number };
}

export type MemoryWorkUndoResult =
  | { ok: true; changed: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'nothing_to_undo' | 'failed' };
