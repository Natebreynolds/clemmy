/**
 * The durable continuation capsule (E5.1) — server-owned structural state
 * that survives compaction, restart, brain switch, and the foreground →
 * background handoff.
 *
 * The predecessor relied on telling the model to read `session_history` and
 * infer what not to redo. That is an instruction, not a mechanism: a
 * compacted transcript, a restarted daemon, or a different brain silently
 * loses the objective, the constraints, the bound account, the pending
 * question, and the list of completed items.
 *
 * A capsule carries REFS and bounded summaries, never raw payloads: full
 * tool results, documents, worker transcripts, and artifacts stay in their
 * own stores. Its size therefore stays bounded as item counts grow — the
 * per-item entries are ids plus a receipt/artifact ref.
 *
 * Storage is one JSON document per logical task under CLEMENTINE_HOME,
 * written atomically (tmp + rename) and validated on every load.
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';

export const CONTINUATION_CAPSULE_VERSION = 1;

export interface CapsuleItemProgress {
  itemId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** Durable receipt/artifact refs — never inline payloads. */
  receiptRef?: string;
  artifactRef?: string;
}

export interface ContinuationCapsule {
  version: typeof CONTINUATION_CAPSULE_VERSION;
  capsuleId: string;
  /** Logical task identity — stable across activations and owners. */
  logicalTaskId: string;
  sessionId: string;
  acceptedSource: string;
  activationId: string;
  /** What the user actually asked for, and what "done" means. */
  objective: string;
  successCriteria: string[];
  /** Constraints and accepted decisions the user already gave. */
  constraints: string[];
  decisions: string[];
  /** Anything the run is waiting on, with the exact authority identity. */
  pending?: {
    kind: 'question' | 'slot' | 'approval';
    prompt: string;
    authorityRef?: string;
  };
  /** Scoped entity/account/timezone references (identifiers, not payloads). */
  scopeRefs: Record<string, string>;
  /** Capability envelope + binding revision + selected procedure/schema. */
  capabilityRefs: {
    envelopeDigest?: string;
    revisionDigest?: string;
    procedureArtifactId?: string;
    schemaFingerprint?: string;
  };
  /** Work manifest identity and per-item progress (refs only). */
  manifest?: {
    manifestId: string;
    contractVersion: string;
    items: CapsuleItemProgress[];
    reducerId?: string;
    reducerStatus?: 'pending' | 'ran';
  };
  /** External-effect reservations/receipts/observations and ambiguity. */
  effectRefs: Array<{ reservationRef: string; receiptRef?: string; observationRef?: string; ambiguous?: boolean }>;
  /** Durable deliverable refs. */
  deliverableRefs: string[];
  /** The last committed terminal (or the pending public edge). */
  lastTerminal?: { outcomeId: string; status: string; pendingEdge?: boolean };
  /** What may safely run next after a resume. */
  nextSafeActions: string[];
  /** Compaction watermark — history below it is summarized, never required. */
  compactionWatermark?: number;
  updatedAt: string;
  /** Digest over the structural content above (excluding updatedAt). */
  digest: string;
}

function capsuleDir(): string {
  return path.join(BASE_DIR, 'state', 'continuation-capsules', getMachineId());
}

function capsulePath(logicalTaskId: string): string {
  return path.join(capsuleDir(), `${encodeURIComponent(logicalTaskId)}.json`);
}

function digestOf(capsule: Omit<ContinuationCapsule, 'digest' | 'updatedAt'>): string {
  return createHash('sha256').update(JSON.stringify(capsule), 'utf-8').digest('hex').slice(0, 32);
}

export type CapsuleInput = Omit<ContinuationCapsule, 'version' | 'capsuleId' | 'digest' | 'updatedAt'>
  & { capsuleId?: string };

/**
 * Checkpoint the capsule. Called after every durable work settlement,
 * pending transition, safe park, and BEFORE acknowledging a background
 * handoff — the acknowledgement is only honest once this is durable.
 */
export function checkpointCapsule(input: CapsuleInput, now = new Date().toISOString()): ContinuationCapsule {
  const dir = capsuleDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = {
    version: CONTINUATION_CAPSULE_VERSION as typeof CONTINUATION_CAPSULE_VERSION,
    capsuleId: input.capsuleId ?? `cap_${randomUUID()}`,
    ...input,
  };
  const capsule: ContinuationCapsule = {
    ...body,
    digest: digestOf(body as Omit<ContinuationCapsule, 'digest' | 'updatedAt'>),
    updatedAt: now,
  };
  const file = capsulePath(capsule.logicalTaskId);
  const temporary = path.join(dir, `.${encodeURIComponent(capsule.logicalTaskId)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(capsule, null, 2)}\n`, 'utf-8');
  renameSync(temporary, file);
  return capsule;
}

/**
 * Load and VALIDATE a capsule; an unknown version, torn file, or content that
 * no longer matches its own digest misses.
 *
 * The digest comparison is the load-bearing half. A capsule is resume
 * authority — objective, decisions, completed items, next safe actions — so a
 * capsule edited underneath us (a partial write, a stale sync, an edited file)
 * would otherwise be obeyed. Recomputing here means the only capsule that can
 * steer a resume is one this build wrote whole.
 */
export function loadCapsule(logicalTaskId: string): ContinuationCapsule | undefined {
  try {
    const file = capsulePath(logicalTaskId);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ContinuationCapsule;
    if (parsed?.version !== CONTINUATION_CAPSULE_VERSION) return undefined;
    if (!parsed.logicalTaskId || !parsed.objective || !Array.isArray(parsed.nextSafeActions)) return undefined;
    if (typeof parsed.digest !== 'string' || !parsed.digest) return undefined;
    const { digest, updatedAt, ...body } = parsed;
    void updatedAt;
    if (digestOf(body as Omit<ContinuationCapsule, 'digest' | 'updatedAt'>) !== digest) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Items whose work is already durably complete — never redone on resume. */
export function completedItemIds(capsule: ContinuationCapsule | undefined): string[] {
  return (capsule?.manifest?.items ?? [])
    .filter((item) => item.status === 'completed')
    .map((item) => item.itemId);
}

/**
 * The hard foreground → background handoff state machine (E5.2). Each state
 * is durable; a crash at any point resumes or repairs exactly ONE owner,
 * and the background task record carries the capsule id rather than an
 * instruction to infer completed work from history.
 */
export type HandoffState =
  | 'requested'
  | 'foreground_commit_fenced'
  | 'capsule_checkpointed'
  | 'background_admitted'
  | 'background_owner_active'
  | 'foreground_released';

export interface HandoffRecord {
  version: 1;
  logicalTaskId: string;
  /** The exact accepted attempt — also the idempotency key: a double-click,
   *  lost response, or restart REJOINS this task instead of forking one. */
  acceptedAttemptId: string;
  sessionId: string;
  sourceUserSeq: number;
  capsuleId?: string;
  backgroundTaskId?: string;
  state: HandoffState;
  /** Monotonic, opaque to callers. A writer that does not hold the current
   *  revision is a writer working from a stale view of who owns this task. */
  revision: number;
  updatedAt: string;
}

/** The state machine is a LADDER: ownership only ever moves forward. */
const HANDOFF_ORDER: HandoffState[] = [
  'requested',
  'foreground_commit_fenced',
  'capsule_checkpointed',
  'background_admitted',
  'background_owner_active',
  'foreground_released',
];

function handoffRank(state: HandoffState): number {
  const index = HANDOFF_ORDER.indexOf(state);
  return index < 0 ? -1 : index;
}

export type HandoffWrite =
  | { ok: true; record: HandoffRecord }
  | { ok: false; reason: string; current: HandoffRecord | undefined };

function handoffPath(acceptedAttemptId: string): string {
  return path.join(capsuleDir(), `handoff-${encodeURIComponent(acceptedAttemptId)}.json`);
}

/**
 * Advance the handoff. Two rules, and both exist because their absence is how
 * a task ends up with two live owners:
 *
 *   MONOTONIC — the state may only move forward along the ladder. A late
 *   writer replaying "requested" over "background_owner_active" would hand the
 *   foreground back a task the background is already running.
 *
 *   CAS — a caller may pin the revision it read. Two activations racing to
 *   claim the same attempt cannot both win, because the loser's expected
 *   revision is already spent.
 */
export function advanceHandoffState(
  record: Omit<HandoffRecord, 'version' | 'revision' | 'updatedAt'>,
  options: { expectedRevision?: number; now?: string } = {},
): HandoffWrite {
  const dir = capsuleDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = loadHandoffState(record.acceptedAttemptId);
  if (current && options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
    return { ok: false, reason: `expected revision ${options.expectedRevision}, found ${current.revision}`, current };
  }
  if (current && handoffRank(record.state) < handoffRank(current.state)) {
    return { ok: false, reason: `handoff cannot regress from ${current.state} to ${record.state}`, current };
  }
  const next: HandoffRecord = {
    version: 1,
    ...record,
    revision: (current?.revision ?? 0) + 1,
    updatedAt: options.now ?? new Date().toISOString(),
  };
  const file = handoffPath(record.acceptedAttemptId);
  const temporary = path.join(dir, `.handoff-${encodeURIComponent(record.acceptedAttemptId)}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  renameSync(temporary, file);
  return { ok: true, record: next };
}

/** Advance, keeping the durable record when the write is refused. Callers that
 *  cannot act on a refusal still must not be handed a forged record. */
export function recordHandoffState(
  record: Omit<HandoffRecord, 'version' | 'revision' | 'updatedAt'>,
  now = new Date().toISOString(),
): HandoffRecord {
  const written = advanceHandoffState(record, { now });
  if (written.ok) return written.record;
  return written.current ?? { version: 1, ...record, revision: 0, updatedAt: now };
}

export function loadHandoffState(acceptedAttemptId: string): HandoffRecord | undefined {
  try {
    const file = handoffPath(acceptedAttemptId);
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as HandoffRecord;
    if (parsed?.version !== 1) return undefined;
    // Records written before revisions existed start at 0 rather than
    // disappearing: an in-flight handoff must survive the upgrade.
    return { ...parsed, revision: Number.isInteger(parsed.revision) ? parsed.revision : 0 };
  } catch {
    return undefined;
  }
}

/**
 * Deterministic crash repair: given the durable handoff record, what should
 * the next activation do? Exactly one owner results in every case.
 */
export function repairHandoff(record: HandoffRecord | undefined): {
  action: 'start_fresh' | 'rejoin_existing' | 'resume_admission' | 'checkpoint_then_admit' | 'release_foreground';
  reason: string;
} {
  if (!record) return { action: 'start_fresh', reason: 'no durable handoff exists for this accepted attempt' };
  switch (record.state) {
    case 'requested':
      return { action: 'checkpoint_then_admit', reason: 'the handoff was requested but nothing was checkpointed' };
    case 'foreground_commit_fenced':
      return { action: 'checkpoint_then_admit', reason: 'the foreground fenced its commit; the capsule is not yet durable' };
    case 'capsule_checkpointed':
      return { action: 'resume_admission', reason: 'the capsule is durable; admit the background task with the same identities' };
    case 'background_admitted':
    case 'background_owner_active':
      return { action: 'rejoin_existing', reason: 'a background owner already exists for this accepted attempt' };
    case 'foreground_released':
      return { action: 'rejoin_existing', reason: 'the handoff completed; the background task owns the work' };
    default:
      return { action: 'start_fresh', reason: 'unknown handoff state' };
  }
}
