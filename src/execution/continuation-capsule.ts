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
 * written atomically (tmp + rename) and validated on every load. The HANDOFF
 * state that decides which executor owns the task lives in a transactional
 * store instead (handoff-store.ts): a capsule is content that verifies itself,
 * but ownership is a compare-and-swap and needs a real transaction.
 */
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import { summarizeWorkManifest } from '../runtime/harness/work-manifest.js';
import { presentationEventFromCompletionData } from '../runtime/harness/turn-outcome.js';
import { getActiveGoalForSession } from '../agents/plan-proposals.js';
import {
  advanceHandoff,
  handoffRank,
  importLegacyHandoffRecord,
  listHandoffRecords,
  listUnsettledHandoffRecords,
  loadHandoffRecord,
  bindHandoffBackgroundTask,
  reservedBackgroundTaskId,
  HANDOFF_ORDER,
  type HandoffProposal,
  type HandoffRecord,
  type HandoffState,
  type HandoffWrite,
} from './handoff-store.js';

export type { HandoffRecord, HandoffState, HandoffWrite } from './handoff-store.js';

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
  /**
   * Monotonic version of THIS logical task's capsule. The capsule is
   * re-checkpointed at every durable lifecycle boundary, so its digest changes
   * legitimately and cannot be what a worker validates against. The revision is
   * what orders those rewrites: a worker may follow a capsule that moved
   * FORWARD since it was admitted, and must refuse one that moved backwards.
   */
  revision: number;
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

export type CapsuleInput = Omit<ContinuationCapsule, 'version' | 'capsuleId' | 'digest' | 'updatedAt' | 'revision'>
  & { capsuleId?: string; revision?: number };

/** The revision is never caller-supplied. Spreading a loaded capsule into a new
 *  checkpoint is the ordinary call shape, and honouring the revision carried in
 *  that spread would freeze it — every later rewrite would claim to be the same
 *  version of the record. It always advances from what is durable. */
function nextCapsuleRevision(logicalTaskId: string): number {
  return (loadCapsule(logicalTaskId)?.revision ?? 0) + 1;
}

/**
 * Checkpoint the capsule. Called after every durable work settlement,
 * pending transition, safe park, and BEFORE acknowledging a background
 * handoff — the acknowledgement is only honest once this is durable.
 */
export function checkpointCapsule(input: CapsuleInput, now = new Date().toISOString()): ContinuationCapsule {
  const dir = capsuleDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // The revision advances from what is DURABLE, not from what the caller was
  // holding: two lifecycle boundaries settling close together would otherwise
  // both write revision N+1 from the same stale read and lose one rewrite.
  const durable = loadCapsule(input.logicalTaskId);
  // Spreading a LOADED capsule into a new checkpoint is the natural call shape,
  // and it carries the previous digest/version/revision along with the content.
  // Those are computed here, so they are stripped rather than trusted — leaving
  // a stale digest inside the hashed body produces a capsule that fails its own
  // verification the moment it is read back.
  const { digest: _staleDigest, updatedAt: _staleUpdatedAt, version: _staleVersion, revision: _staleRevision,
    ...content } = input as CapsuleInput & { digest?: string; updatedAt?: string; version?: number };
  void _staleDigest; void _staleUpdatedAt; void _staleVersion; void _staleRevision;
  const body = {
    version: CONTINUATION_CAPSULE_VERSION as typeof CONTINUATION_CAPSULE_VERSION,
    capsuleId: input.capsuleId ?? durable?.capsuleId ?? `cap_${randomUUID()}`,
    ...content,
    revision: nextCapsuleRevision(input.logicalTaskId),
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
    if (!Number.isInteger(parsed.revision) || parsed.revision < 1) return undefined;
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
 *
 * The state itself lives in a transactional store (handoff-store.ts) because
 * ownership is decided by a compare-and-swap, and a CAS spread across a file
 * read and a file rename is not a CAS at all. This module keeps the public
 * shape and adds the durable-projection and reconciliation entry points.
 */

function legacyHandoffPath(acceptedAttemptId: string): string {
  return path.join(capsuleDir(), `handoff-${encodeURIComponent(acceptedAttemptId)}.json`);
}

function parseLegacyHandoffFile(file: string): HandoffRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as HandoffRecord;
    if (parsed?.version !== 1 || !parsed.acceptedAttemptId || !parsed.state) return undefined;
    // Records written before revisions existed start at 1 rather than
    // disappearing: an in-flight handoff must survive the upgrade.
    return { ...parsed, revision: Number.isInteger(parsed.revision) && parsed.revision > 0 ? parsed.revision : 1 };
  } catch {
    return undefined;
  }
}

/**
 * Adopt a handoff written by an older build exactly once. The file is renamed
 * after import so a later crash cannot re-import a state the store has since
 * moved past — a re-import would be a regression wearing a migration's clothes.
 */
function migrateLegacyHandoffFile(file: string): HandoffRecord | undefined {
  const legacy = parseLegacyHandoffFile(file);
  if (!legacy) return undefined;
  try {
    importLegacyHandoffRecord(legacy);
  } catch {
    return undefined;
  }
  try { renameSync(file, `${file}.imported`); } catch { /* the row is durable; the file is now inert */ }
  return loadHandoffRecord(legacy.acceptedAttemptId);
}

function adoptLegacyHandoffIfPresent(acceptedAttemptId: string): HandoffRecord | undefined {
  const file = legacyHandoffPath(acceptedAttemptId);
  if (!existsSync(file)) return undefined;
  return migrateLegacyHandoffFile(file);
}

/** Import every legacy JSON handoff still on disk. Reconciliation runs this
 *  first so a pre-upgrade in-flight transfer is reconciled, not stranded. */
function adoptAllLegacyHandoffs(): void {
  const dir = capsuleDir();
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith('handoff-') || !entry.endsWith('.json')) continue;
    migrateLegacyHandoffFile(path.join(dir, entry));
  }
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
 *   revision is already spent. Both rules are evaluated inside the store's
 *   single transaction, so they hold across processes and not merely inside one.
 */
export function advanceHandoffState(
  record: Omit<HandoffRecord, 'version' | 'revision' | 'updatedAt'>,
  options: { expectedRevision: number; now?: string },
): HandoffWrite {
  if (!loadHandoffRecord(record.acceptedAttemptId)) adoptLegacyHandoffIfPresent(record.acceptedAttemptId);
  return advanceHandoff(record as HandoffProposal, options);
}

/**
 * Take ONE rung, pinned to what is durably there right now.
 *
 * Callers read-then-pin through this helper rather than firing an unpinned
 * write and moving on, so a refusal is a value they have to look at. Returning
 * the CURRENT record on refusal is deliberate: the only safe response to losing
 * a rung is to follow the owner that won it, and that needs its record.
 */
export function stepHandoff(
  proposal: Omit<HandoffRecord, 'version' | 'revision' | 'updatedAt'>,
  now = new Date().toISOString(),
): HandoffWrite {
  const current = loadHandoffState(proposal.acceptedAttemptId);
  return advanceHandoffState(proposal, { expectedRevision: current?.revision ?? 0, now });
}

/** End a handoff from wherever it is. The abort edge, pinned like every other
 *  write so it cannot stomp a concurrent owner that is still making progress. */
export function endHandoff(
  proposal: Omit<HandoffRecord, 'version' | 'revision' | 'updatedAt' | 'state'>,
  reason: string,
  now = new Date().toISOString(),
): HandoffWrite {
  const current = loadHandoffState(proposal.acceptedAttemptId);
  return advanceHandoffState(
    { ...proposal, state: 'terminal', reason },
    { expectedRevision: current?.revision ?? 0, now },
  );
}

/** Advance, keeping the durable record when the write is refused. Callers that
 *  cannot act on a refusal still must not be handed a forged record. */
export function recordHandoffState(
  record: Omit<HandoffRecord, 'version' | 'revision' | 'updatedAt'>,
  now = new Date().toISOString(),
): HandoffRecord {
  const written = stepHandoff(record, now);
  if (written.ok) return written.record;
  return written.current ?? { version: 1, ...record, revision: 0, updatedAt: now };
}

export function loadHandoffState(acceptedAttemptId: string): HandoffRecord | undefined {
  return loadHandoffRecord(acceptedAttemptId) ?? adoptLegacyHandoffIfPresent(acceptedAttemptId);
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
    case 'capsule_checkpointed':
      return { action: 'resume_admission', reason: 'the capsule is durable; admit the background task with the same identities' };
    case 'background_admitted':
    case 'foreground_commit_fenced':
      return { action: 'rejoin_existing', reason: 'a background owner already exists for this accepted attempt' };
    case 'foreground_released':
      return { action: 'rejoin_existing', reason: 'the handoff completed; the background task owns the work' };
    case 'terminal':
      return { action: 'start_fresh', reason: 'the handoff ended without a background owner; nothing is running for it' };
    default:
      return { action: 'start_fresh', reason: 'unknown handoff state' };
  }
}

// ── Projecting a capsule from durable state ──────────────────────────────────

/** The subset of the durable background-task record a capsule projects from.
 *  Structural on purpose: background-tasks.ts already imports this module, so
 *  a type-only shape keeps the dependency one-directional. */
export interface DurableHandoffTask {
  id: string;
  prompt?: string;
  foregroundHandoff?: {
    sourceUserSeq?: number;
    throughSeq?: number;
    capsuleId?: string;
    logicalTaskId?: string;
  };
}

function acceptedUserEventText(sessionId: string, sourceUserSeq: number | undefined): string {
  if (!sessionId || sourceUserSeq === undefined) return '';
  try {
    const accepted = listEvents(sessionId, {
      sinceSeq: sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    })[0];
    if (!accepted || accepted.seq !== sourceUserSeq) return '';
    const data = accepted.data as { text?: unknown; displayText?: unknown };
    const displayText = typeof data.displayText === 'string' ? data.displayText.trim() : '';
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return displayText || text;
  } catch {
    return '';
  }
}

function durableItemStatus(
  phases: Record<string, { status: string }>,
  complete: boolean,
): CapsuleItemProgress['status'] {
  if (complete) return 'completed';
  const states = Object.values(phases ?? {}).map((phase) => phase.status);
  if (states.some((status) => status === 'failed' || status === 'invalidated')) return 'failed';
  if (states.some((status) => status === 'running')) return 'running';
  return 'pending';
}

/**
 * Project a capsule from what the system durably RECORDED, not from what a
 * caller narrated. A capsule is resume authority, so every field it carries
 * must be traceable to a durable source: the work manifest reduced from the
 * event log, the read receipts that lane appended, the last committed terminal,
 * and the session's active goal contract. Where a durable source is absent the
 * field stays EMPTY — an invented success criterion or a guessed completed item
 * is worse than an honest gap, because a resume would act on it.
 *
 * `objective` is accepted from the caller only when the caller resolved it from
 * durable identity (the accepted user event, the goal contract); otherwise the
 * accepted user event's own text is used.
 */
export function projectCapsuleFromDurableState(
  logicalTaskId: string,
  sessionId: string,
  acceptedAttemptId: string,
  durable: {
    objective?: string;
    sourceUserSeq?: number;
    throughSeq?: number;
    capsuleId?: string;
    backgroundTask?: DurableHandoffTask;
  } = {},
): CapsuleInput {
  const sourceUserSeq = durable.sourceUserSeq ?? durable.backgroundTask?.foregroundHandoff?.sourceUserSeq;
  const objective = (durable.objective ?? '').trim() || acceptedUserEventText(sessionId, sourceUserSeq);

  let successCriteria: string[] = [];
  try {
    const goal = getActiveGoalForSession(sessionId);
    const plan = goal ? (goal.approvedPlan ?? goal.plan) : undefined;
    successCriteria = Array.isArray(plan?.successCriteria) ? [...plan.successCriteria] : [];
  } catch { /* no durable goal contract ⇒ no criteria, never invented ones */ }

  let manifest: ContinuationCapsule['manifest'];
  try {
    const summary = summarizeWorkManifest(sessionId);
    if (summary) {
      manifest = {
        manifestId: summary.manifestId,
        contractVersion: summary.contractVersion,
        items: summary.items.map((item) => ({
          itemId: item.id,
          status: durableItemStatus(item.phases as Record<string, { status: string }>, item.complete),
        })),
      };
    }
  } catch { /* no durable manifest ⇒ no item progress */ }

  const effectRefs: ContinuationCapsule['effectRefs'] = [];
  let pending: ContinuationCapsule['pending'];
  let lastTerminal: ContinuationCapsule['lastTerminal'];
  try {
    // THE ACTIVATION INTERVAL, not the session. A reusable chat carries earlier
    // turns' receipts, approvals and terminals; sweeping those in would tell the
    // resume that work belonging to a different request was already done for
    // THIS one. The interval opens at the accepted source event and closes at
    // the detach boundary.
    for (const event of listEvents(sessionId, {
      types: ['read_receipt', 'conversation_completed'],
      ...(sourceUserSeq === undefined ? {} : { sinceSeq: sourceUserSeq }),
    })) {
      if (durable.throughSeq !== undefined && event.seq > durable.throughSeq) break;
      if (event.type === 'read_receipt') {
        const record = (event.data as { record?: { receiptId?: string; identifier?: string } }).record;
        if (record?.receiptId) {
          effectRefs.push({
            reservationRef: record.identifier ?? record.receiptId,
            receiptRef: record.receiptId,
          });
        }
        continue;
      }
      const presentation = presentationEventFromCompletionData(event.data);
      if (!presentation) continue;
      lastTerminal = {
        outcomeId: presentation.outcomeId,
        status: presentation.status,
        pendingEdge: presentation.status === 'needs_input',
      };
      pending = presentation.status === 'needs_input'
        ? {
            kind: presentation.needs?.kind === 'approval' ? 'approval' : 'question',
            prompt: presentation.text,
            ...(presentation.approvalId ? { authorityRef: presentation.approvalId } : {}),
          }
        : undefined;
    }
  } catch { /* an unreadable event log yields an empty projection, not a guess */ }

  return {
    ...(durable.capsuleId ? { capsuleId: durable.capsuleId } : {}),
    logicalTaskId,
    sessionId,
    acceptedSource: sourceUserSeq === undefined ? sessionId : `${sessionId}:${sourceUserSeq}`,
    activationId: acceptedAttemptId,
    objective,
    successCriteria,
    constraints: [],
    decisions: [],
    ...(pending ? { pending } : {}),
    scopeRefs: {},
    capabilityRefs: {},
    ...(manifest ? { manifest } : {}),
    effectRefs,
    deliverableRefs: [],
    ...(lastTerminal ? { lastTerminal } : {}),
    nextSafeActions: ['continue from the last durable settlement recorded for this task'],
    ...(durable.throughSeq !== undefined ? { compactionWatermark: durable.throughSeq } : {}),
  };
}

/**
 * Re-checkpoint the live handoff capsule for a session from durable state.
 *
 * Called at each durable lifecycle boundary — an item/phase settling, an effect
 * receipt becoming durable, a committed terminal. A capsule written once at
 * detach and never again describes the world as it was BEFORE all of that, so a
 * worker starting later would redo settled work and re-issue settled effects.
 * Re-projecting from durable state is what keeps "already done" true rather
 * than merely true-at-detach.
 *
 * Deliberately total: no live handoff, no capsule, or an unreadable event log
 * all return undefined rather than throwing. Every caller is a settlement path
 * whose own commit already succeeded, and none may fail because bookkeeping did.
 */
export function checkpointCapsuleForSession(
  sessionId: string,
  sourceUserSeq?: number,
): ContinuationCapsule | undefined {
  try {
    if (!sessionId) return undefined;
    const record = listHandoffRecords()
      .filter((row) => row.sessionId === sessionId
        && row.state !== 'terminal'
        && (sourceUserSeq === undefined || row.sourceUserSeq === sourceUserSeq))
      .at(-1);
    if (!record) return undefined;
    const existing = loadCapsule(record.logicalTaskId);
    const projected = projectCapsuleFromDurableState(
      record.logicalTaskId,
      record.sessionId,
      record.acceptedAttemptId,
      {
        sourceUserSeq: record.sourceUserSeq,
        capsuleId: record.capsuleId ?? existing?.capsuleId,
        // NO upper bound here. The detach watermark bounds how much ORIGIN
        // HISTORY is context; it is not the end of the activation interval.
        // Effects this task settles after the handoff are exactly the ones a
        // resume must not redo, so clipping the scan at detach would leave the
        // capsule permanently blind to the worker's own work.
        ...(existing?.objective ? { objective: existing.objective } : {}),
      },
    );
    if (!projected.objective) return undefined;
    return checkpointCapsule({
      ...projected,
      // Carried forward unchanged: the history boundary was decided once, at
      // the moment the user handed the work over.
      ...(existing?.compactionWatermark !== undefined
        ? { compactionWatermark: existing.compactionWatermark }
        : {}),
    });
  } catch {
    return undefined;
  }
}

// ── Boot reconciliation ──────────────────────────────────────────────────────

export interface HandoffReconciliation {
  acceptedAttemptId: string;
  from: HandoffState;
  action: 'released_foreground' | 'confirmed_background_owner' | 'reenqueued' | 'ended';
  reason: string;
  backgroundTaskId?: string;
}

/**
 * Converge every unsettled handoff to exactly ONE owner at boot.
 *
 * A handoff is the only durable record that a turn changed hands, so a daemon
 * that starts without reading it can leave the previous process's outcome
 * standing forever: a foreground fenced by a kill latch nobody will clear, or a
 * transfer intent whose background task never got admitted. Each rung has one
 * correct convergence and it is derived from repairHandoff, so the crash-repair
 * decision and the boot action can never drift apart.
 *
 * Dynamic imports: background-tasks.ts and background-promote.ts both import
 * this module, and boot reconciliation is the one place that needs to call back
 * into them.
 */
export async function reconcileIncompleteHandoffs(): Promise<HandoffReconciliation[]> {
  adoptAllLegacyHandoffs();
  const unsettled = listUnsettledHandoffRecords();
  if (unsettled.length === 0) return [];

  const { listBackgroundTasks } = await import('./background-tasks.js');
  const tasks = listBackgroundTasks({ includeArchived: true });
  const { clearKill, getActiveRunAttempt } = await import('../runtime/harness/eventlog.js');
  const results: HandoffReconciliation[] = [];

  for (const record of unsettled) {
    // The reserved id makes "does an owner exist" answerable without trusting
    // the row to have recorded it: a crash between admitting the task and
    // naming it on the handoff is exactly the window this closes.
    const reservedId = reservedBackgroundTaskId(record.acceptedAttemptId);
    const task = tasks.find((candidate) => candidate.id === reservedId)
      ?? (record.backgroundTaskId ? tasks.find((candidate) => candidate.id === record.backgroundTaskId) : undefined)
      ?? tasks.find((candidate) => candidate.foregroundHandoff?.attemptId === record.acceptedAttemptId);
    const repair = repairHandoff(record);

    // A durable background task IS the owner, whatever rung the crash left
    // behind. Walk the ladder up to admission so the row agrees with reality,
    // then stop — nothing here may enqueue a second worker.
    if (task) {
      let cursor: HandoffRecord | undefined = record;
      let refusal = '';
      while (cursor && handoffRank(cursor.state) < handoffRank('background_admitted')) {
        const next = HANDOFF_ORDER[handoffRank(cursor.state) + 1];
        const write = advanceHandoff(
          { ...cursor, backgroundTaskId: task.id, state: next },
          { expectedRevision: cursor.revision },
        );
        if (!write.ok) { refusal = write.reason; break; }
        cursor = write.record;
      }
      results.push({
        acceptedAttemptId: record.acceptedAttemptId,
        from: record.state,
        action: 'confirmed_background_owner',
        reason: refusal || repair.reason,
        backgroundTaskId: task.id,
      });
      continue;
    }

    // No background task exists. Either the foreground is still alive and must
    // be handed its work back, or nothing owns the turn and one owner must be
    // created from durable state.
    let live = false;
    try { live = getActiveRunAttempt(record.sessionId)?.attemptId === record.acceptedAttemptId; } catch { live = false; }
    if (live) {
      // The fence was latched for a transfer that never happened. Clearing it
      // returns the turn to its original owner rather than leaving it stopped.
      try { clearKill(record.sessionId, { attemptId: record.acceptedAttemptId }); } catch { /* best effort */ }
      endHandoff(record, 'no background owner was admitted; the live foreground keeps the work');
      results.push({
        acceptedAttemptId: record.acceptedAttemptId,
        from: record.state,
        action: 'released_foreground',
        reason: 'the foreground attempt is still live; its stop latch was cleared',
      });
      continue;
    }

    // A handoff that never got its capsule written is still ACCEPTED WORK. The
    // user asked for it and the system recorded that it did; rebuilding the
    // capsule from the accepted event and the durable goal is recovery, not
    // invention, and it is strictly better than discarding the request because
    // the process happened to die one instruction early.
    let built = loadCapsule(record.logicalTaskId);
    let cursor: HandoffRecord = record;
    if (!built) {
      const rebuilt = projectCapsuleFromDurableState(
        record.logicalTaskId,
        record.sessionId,
        record.acceptedAttemptId,
        { sourceUserSeq: record.sourceUserSeq },
      );
      if (rebuilt.objective) built = checkpointCapsule(rebuilt);
    }
    if (!built?.objective) {
      endHandoff(record, `${repair.reason}; nothing durable names what the work was`);
      results.push({
        acceptedAttemptId: record.acceptedAttemptId,
        from: record.state,
        action: 'ended',
        reason: 'no durable objective survives for this handoff',
      });
      continue;
    }
    if (cursor.state === 'requested') {
      const checkpointed = stepHandoff({ ...cursor, capsuleId: built.capsuleId, state: 'capsule_checkpointed' });
      if (!checkpointed.ok) {
        results.push({
          acceptedAttemptId: record.acceptedAttemptId,
          from: record.state,
          action: 'confirmed_background_owner',
          reason: checkpointed.reason,
        });
        continue;
      }
      cursor = checkpointed.record;
    }

    const { enqueueDurableChatTask } = await import('./background-promote.js');
    try {
      const admitted = enqueueDurableChatTask({
        message: built.objective,
        composedPrompt: [
          `Objective: ${built.objective}`,
          '',
          'You are RESUMING this task after a restart interrupted its handoff.',
          'The durable continuation capsule is authoritative for what is already done; do not redo completed work.',
        ].join('\n'),
        sessionId: record.sessionId,
        source: 'daemon',
        explicitId: reservedId,
        goal: { objective: built.objective },
        foregroundHandoff: {
          sessionId: record.sessionId,
          attemptId: record.acceptedAttemptId,
          sourceUserSeq: record.sourceUserSeq,
          throughSeq: built.compactionWatermark ?? 0,
          capsuleId: built.capsuleId,
          capsuleDigest: built.digest,
          capsuleRevision: built.revision,
          logicalTaskId: record.logicalTaskId,
        },
      });
      // A row below admission takes the rung; one already past it only needs to
      // NAME the owner it now has, which is identity rather than a state change.
      if (handoffRank(cursor.state) < handoffRank('background_admitted')) {
        advanceHandoff(
          { ...cursor, capsuleId: built.capsuleId, backgroundTaskId: admitted.id, state: 'background_admitted' },
          { expectedRevision: cursor.revision },
        );
      } else {
        bindHandoffBackgroundTask(record.acceptedAttemptId, admitted.id);
      }
      results.push({
        acceptedAttemptId: record.acceptedAttemptId,
        from: record.state,
        action: 'reenqueued',
        reason: 'accepted work had no owner; exactly one was admitted from durable state',
        backgroundTaskId: admitted.id,
      });
      continue;
    } catch (error) {
      endHandoff(cursor, `re-enqueue failed: ${error instanceof Error ? error.message : String(error)}`);
      results.push({
        acceptedAttemptId: record.acceptedAttemptId,
        from: record.state,
        action: 'ended',
        reason: 'the capsule could not be re-admitted; the handoff owns nothing',
      });
      continue;
    }
  }
  return results;
}

/**
 * Boot gate. Reconciliation is not optional background hygiene: until it runs,
 * the daemon cannot say which turns still have an owner, and accepting fresh
 * ingress in that state is how a resumed worker and a live foreground end up
 * both writing. A failure here therefore fails READINESS — reporting healthy
 * while unable to read the ownership record is the dishonest option.
 */
export async function reconcileHandoffsForBoot(
  options: { probe?: () => void } = {},
): Promise<HandoffReconciliation[]> {
  (options.probe ?? (() => { listUnsettledHandoffRecords(); }))();
  return reconcileIncompleteHandoffs();
}

// ── The transferred foreground terminal ──────────────────────────────────────

export interface HandoffTransfer {
  backgroundTaskId: string;
  logicalTaskId: string;
  /** What the background now owns, taken from the capsule the handoff wrote. */
  objective: string;
  /** Public terminal text. It names the WORK rather than the task id: the id is
   *  carried as typed metadata for clients, not read out to the user. */
  text: string;
}

/**
 * A foreground attempt that was stopped to hand its work to the background did
 * not get CANCELLED — it changed owners. The terminal committer asks this
 * before it publishes a stopped terminal, so the user reads "this moved to the
 * background" instead of "this was cancelled" for work that is still running.
 * Only a handoff that reached a durable background owner qualifies; a fenced
 * intent with no admitted task really is a stop.
 */
export function handoffTransferForAttempt(
  sessionId: string,
  acceptedAttemptId: string | undefined,
): HandoffTransfer | undefined {
  if (!sessionId || !acceptedAttemptId) return undefined;
  return transferFor(sessionId, loadHandoffState(acceptedAttemptId));
}

/**
 * Called by the ONE terminal-commit authority once a turn's final public
 * outcome is durable. If that turn was transferred, its foreground has now
 * genuinely stopped — no further model or tool work can occur for it — so the
 * fence and the release are recorded here rather than optimistically at detach,
 * where the run was still executing.
 *
 * Both rungs at one seam because they describe the same instant from two sides:
 * the foreground can no longer act, and the background is now sole owner.
 */
export function fenceAndReleaseHandoffAtTerminal(sessionId: string, sourceUserSeq: number | undefined): void {
  if (!sessionId || sourceUserSeq === undefined) return;
  const record = listHandoffRecords()
    .filter((row) => row.sessionId === sessionId && row.sourceUserSeq === sourceUserSeq)
    .at(-1);
  if (!record || !record.backgroundTaskId) return;
  // A committed terminal is a durable lifecycle boundary: the capsule must
  // record the edge that just settled, or a resume re-opens it.
  checkpointCapsuleForSession(sessionId, sourceUserSeq);
  let cursor: HandoffRecord = record;
  for (const rung of ['foreground_commit_fenced', 'foreground_released'] as const) {
    if (handoffRank(cursor.state) >= handoffRank(rung)) continue;
    const write = stepHandoff({ ...cursor, state: rung });
    // A refusal means another owner moved this handoff already. Following it is
    // correct; forcing our rung over it is not.
    if (!write.ok) return;
    cursor = write.record;
  }
}

/** Same question asked by accepted SOURCE event, for terminal committers that
 *  reduce a turn without a physical attempt id in hand. */
export function handoffTransferForSource(
  sessionId: string,
  sourceUserSeq: number | undefined,
): HandoffTransfer | undefined {
  if (!sessionId || sourceUserSeq === undefined) return undefined;
  const record = listHandoffRecords()
    .filter((row) => row.sessionId === sessionId && row.sourceUserSeq === sourceUserSeq)
    .at(-1);
  return transferFor(sessionId, record);
}

/**
 * The typed terminal a moved turn commits. 'transferred' is its own status
 * rather than a cancellation carrying a note: a cancelled turn is work that
 * stopped, and every reader downstream — board, report-back, resume, the user —
 * acts on that difference. Encoding a live transfer as cancelled makes the
 * taxonomy lie about the one thing it exists to state.
 */
export function transferredTurnOutcome(
  sessionId: string,
  acceptedAttemptId: string,
): { status: 'transferred'; text: string; transferredToTaskId: string; logicalTaskId: string } | undefined {
  const transfer = handoffTransferForAttempt(sessionId, acceptedAttemptId);
  if (!transfer) return undefined;
  return {
    status: 'transferred',
    text: transfer.text,
    transferredToTaskId: transfer.backgroundTaskId,
    logicalTaskId: transfer.logicalTaskId,
  };
}

function transferFor(sessionId: string, record: HandoffRecord | undefined): HandoffTransfer | undefined {
  if (!record || record.sessionId !== sessionId || !record.backgroundTaskId) return undefined;
  if (record.state === 'terminal') return undefined;
  const objective = loadCapsule(record.logicalTaskId)?.objective?.trim() ?? '';
  return {
    backgroundTaskId: record.backgroundTaskId,
    logicalTaskId: record.logicalTaskId,
    objective,
    text: objective
      ? `Moved to the background — I'm still working on "${objective}" there, and I'll report back here when it's done.`
      : 'Moved to the background — I\'m still working on this there, and I\'ll report back here when it\'s done.',
  };
}
