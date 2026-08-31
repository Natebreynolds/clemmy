import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { withFileLockSyncStrict } from '../runtime/atomic-json.js';
import {
  addNotification,
  markNotificationsReadByCheckInId,
  markNotificationsReadByQuestionId,
} from '../runtime/notifications.js';

/**
 * Agent check-ins: a structured "I need an answer from you" mechanism.
 *
 * Distinct from existing primitives:
 *   - `notify_user` is one-way ("FYI"). No expectation of response.
 *   - The approval flow is tool-scoped — pauses a specific tool call
 *     waiting on yes/no.
 *   - `Execution.blocker` is a freeform reason string with no answer slot.
 *
 * A check-in is the missing primitive: the agent has a real question
 * that prevents progress on a task, surfaces it to the user, and
 * resumes work the moment the answer lands. That's the heart of
 * "never stops until done; checks in when it has questions."
 *
 * Storage: one JSON file per check-in under
 *   ~/.clementine-next/check-ins/<id>.json
 * Lifecycle:
 *   open      → user can see it, agent should wait for an answer
 *   answered  → user replied; agent's next cycle picks up the answer
 *   closed    → dismissed without an answer (user said "nevermind")
 *
 * When an answered check-in lands, the resolver appends an inbox item
 * to the agent's pending inbox so the next autonomy cycle wakes up
 * with the answer in context. No daemon polling required.
 */

export const CHECK_INS_DIR = path.join(BASE_DIR, 'check-ins');
const AGENT_INBOX_DIR = path.join(BASE_DIR, 'agents-inbox');

// -------- Question quality validator --------
//
// "I want check-ins that are accurate." That means: the agent should
// not ask low-value questions. A good check-in question is specific,
// references information only the user has, and gives the user enough
// context to answer without re-reading the conversation.
//
// Rejected shapes:
//  - Too short to be specific (under 20 chars)
//  - Generic punts ("what should I do?", "is this ok?")
//  - Yes/no questions under 50 chars (almost always answerable
//    without asking — and the agent should make the call)
//  - Trivial confirmations ("can I proceed?", "should I start?")

const GENERIC_PUNT_PATTERNS = [
  /^what\s+should\s+i\s+do\??$/i,
  /^what\s+next\??$/i,
  /^what\s+now\??$/i,
  /^is\s+(this|that|it)\s+(ok|okay|fine|right)\s*\??$/i,
  /^are\s+you\s+sure\??$/i,
  /^should\s+i\s+(proceed|continue|go\s+ahead|start)\s*\??$/i,
  /^can\s+i\s+(proceed|continue|go\s+ahead|start)\s*\??$/i,
  /^do\s+you\s+want\s+me\s+to\s+(continue|proceed|start)\??$/i,
];

const YES_NO_LEADERS = /^(is|are|can|could|should|would|will|do|does|did|may|might)\s/i;

export interface CheckInValidation {
  ok: boolean;
  reason?: string;
}

export function validateCheckInQuestion(question: string, contextSummary?: string): CheckInValidation {
  const trimmed = question.trim();

  // Generic-punt match runs first so the rejection reason is the most
  // useful — "what should I do" is a punt regardless of length.
  for (const pattern of GENERIC_PUNT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        ok: false,
        reason: `"${trimmed.slice(0, 60)}" is a generic punt — the user can\'t answer this usefully. Ask for the specific decision, value, or preference you need. Example: "Which Stripe account should I sync to: the personal one (acct_...) or the company one (acct_...)?"`,
      };
    }
  }

  if (trimmed.length < 20) {
    return {
      ok: false,
      reason: 'Question is too short to be specific. Spell out what decision or information you need from the user, and why you can\'t determine it yourself.',
    };
  }

  // Yes/no questions under 50 chars are almost always trivial. The
  // agent should make the call itself or rephrase as a substantive ask.
  if (YES_NO_LEADERS.test(trimmed) && trimmed.length < 50) {
    return {
      ok: false,
      reason: 'Short yes/no question. Either make the call yourself or rephrase to ask for the substantive information you actually need (e.g. an option choice, a value, a constraint).',
    };
  }

  // A useful check-in often carries context. If neither the question
  // itself nor the contextSummary mentions a concrete thing (project,
  // execution, decision), warn but don't block — agents need leeway
  // for genuinely simple questions.
  // (No rejection here; soft guidance lives in the tool description.)

  return { ok: true };
}

export type CheckInUrgency = 'low' | 'normal' | 'high';
export type CheckInStatus = 'open' | 'answered' | 'closed';

export interface CheckInRecord {
  id: string;
  agentSlug: string;
  question: string;
  urgency: CheckInUrgency;
  contextExecutionId?: string;
  contextSummary?: string;
  /** The parked background task this question belongs to — see CreateCheckInInput. */
  linkedTaskId?: string;
  /** Immutable identity of the exact question generation on linkedTaskId. A
   * task may ask Q1, resume, then ask Q2 under the same task id; answers and UI
   * dedupe must compare both fields so a stale Q1 can never resolve Q2. */
  linkedQuestionId?: string;
  status: CheckInStatus;
  askedAt: string;
  answeredAt?: string;
  /** Durable acknowledgement that the exact linked task accepted (or had
   * already accepted) this answer's stable resolution request. */
  linkedResolutionRequestId?: string;
  linkedResolutionQueuedAt?: string;
  closedAt?: string;
  answer?: string;
  closeReason?: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isCheckInId(id: string): boolean {
  return /^chk-[A-Za-z0-9_-]{1,80}$/.test(id);
}

function checkInPath(id: string): string {
  if (!isCheckInId(id)) throw new Error('Invalid check-in id.');
  return path.join(CHECK_INS_DIR, `${id}.json`);
}

function safeReadCheckIn(filePath: string): CheckInRecord | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as CheckInRecord;
  } catch {
    return null;
  }
}

/**
 * Atomic write via temp + rename so concurrent readers never see a
 * half-written file. Same pattern as proactivity-policy.ts.
 */
function atomicWriteCheckIn(record: CheckInRecord): void {
  ensureDir(CHECK_INS_DIR);
  const target = checkInPath(record.id);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(tmp, target);
}

export interface CreateCheckInInput {
  agentSlug: string;
  question: string;
  urgency?: CheckInUrgency;
  contextExecutionId?: string;
  contextSummary?: string;
  /** The parked background task this question belongs to (2026-07-22 store
   *  unification): stamping the correlation at WRITE time is what lets an
   *  answer through EITHER store resume the task — the missing link that
   *  caused the answered-check-in/duplicate-task incident. */
  linkedTaskId?: string;
  /** Usually omitted: linked check-ins mint this before the background task
   * parks, and the task adopts it as pendingQuestionId at settlement. Tests and
   * migration bridges may provide an already-canonical question id. */
  linkedQuestionId?: string;
}

/**
 * Open a new check-in. Writes the record and queues a normal execution
 * notification with metadata.checkInId so downstream UIs can route it to a
 * "Questions for you" panel. A question is not an approval: projecting it as
 * kind `approval` made Discord attach approval-card chrome to an ordinary
 * answer slot (live 2026-08-13).
 */
export function createCheckIn(input: CreateCheckInInput): CheckInRecord {
  const question = input.question.trim();
  if (!question) throw new Error('createCheckIn: question is required');
  if (!input.agentSlug.trim()) throw new Error('createCheckIn: agentSlug is required');

  const id = `chk-${randomUUID().slice(0, 8)}`;
  const linkedTaskId = input.linkedTaskId?.trim() || undefined;
  if (input.linkedQuestionId && !linkedTaskId) {
    throw new Error('createCheckIn: linkedQuestionId requires linkedTaskId');
  }
  const linkedQuestionId = linkedTaskId
    ? input.linkedQuestionId?.trim() || `bgq-${id.slice('chk-'.length)}`
    : undefined;
  const record: CheckInRecord = {
    id,
    agentSlug: input.agentSlug,
    question: question.slice(0, 1200),
    urgency: input.urgency ?? 'normal',
    contextExecutionId: input.contextExecutionId,
    contextSummary: input.contextSummary?.slice(0, 600),
    linkedTaskId,
    linkedQuestionId,
    status: 'open',
    askedAt: new Date().toISOString(),
  };
  atomicWriteCheckIn(record);

  addNotification({
    id: `${Date.now()}-checkin-${record.id}`,
    kind: 'execution',
    title: `Question from ${input.agentSlug}: ${question.slice(0, 80)}`,
    body: input.contextSummary
      ? `${question}\n\nContext: ${input.contextSummary}`
      : question,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: {
      checkInId: record.id,
      agentSlug: input.agentSlug,
      urgency: record.urgency,
      contextExecutionId: input.contextExecutionId,
      linkedTaskId,
      linkedQuestionId,
    },
  });

  return record;
}

export function getCheckIn(id: string): CheckInRecord | null {
  if (!isCheckInId(id)) return null;
  const filePath = checkInPath(id);
  if (!existsSync(filePath)) return null;
  return safeReadCheckIn(filePath);
}

/**
 * List check-ins, optionally filtered by agent and/or status.
 * Defaults: all agents, only open. Sorted newest-first.
 */
export function listCheckIns(filter: { agentSlug?: string; status?: CheckInStatus | 'all' } = {}): CheckInRecord[] {
  if (!existsSync(CHECK_INS_DIR)) return [];
  const wantedStatus = filter.status ?? 'open';
  const out: CheckInRecord[] = [];
  for (const entry of readdirSync(CHECK_INS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const rec = safeReadCheckIn(path.join(CHECK_INS_DIR, entry));
    if (!rec) continue;
    if (filter.agentSlug && rec.agentSlug !== filter.agentSlug) continue;
    if (wantedStatus !== 'all' && rec.status !== wantedStatus) continue;
    out.push(rec);
  }
  return out.sort((a, b) => b.askedAt.localeCompare(a.askedAt));
}

export function listOpenCheckIns(agentSlug?: string): CheckInRecord[] {
  return listCheckIns({ agentSlug, status: 'open' });
}

/** Settle every open check-in copy of one exact background-task question.
 *
 * The background task owns whether a question generation is still current.
 * Once that generation is superseded or resolved, leaving its check-in file
 * `open` creates an unopenable Needs You gate on every compatibility surface.
 * Closing the exact pair (never task id alone) preserves Q2 when Q1 settles.
 */
export function settleOpenLinkedCheckInsForQuestion(input: {
  linkedTaskId: string;
  linkedQuestionId: string;
  reason: string;
}): CheckInRecord[] {
  const linkedTaskId = input.linkedTaskId.trim();
  const linkedQuestionId = input.linkedQuestionId.trim();
  if (!linkedTaskId || !linkedQuestionId) return [];
  const settled: CheckInRecord[] = [];
  for (const record of listOpenCheckIns()) {
    if (
      record.linkedTaskId !== linkedTaskId
      || record.linkedQuestionId !== linkedQuestionId
    ) continue;
    const closed = closeCheckIn(record.id, input.reason);
    if (closed?.status === 'closed') settled.push(closed);
  }
  // A task-side question carrier can exist without a check-in carrier (or the
  // check-in file may have been lost). Exact question identity is still enough
  // to retire only that obsolete delivery cursor.
  try {
    markNotificationsReadByQuestionId(linkedQuestionId, {
      linkedTaskId,
      linkedQuestionStatus: 'settled',
    });
  } catch { /* the task/check-in authorities remain durable */ }
  return settled;
}

/** Settle every still-open linked question for a task that definitively became
 * terminal/missing. This is deliberately separate from the exact-question
 * helper so an ordinary Q1 -> Q2 transition cannot accidentally close Q2. */
export function settleAllOpenLinkedCheckInsForTask(input: {
  linkedTaskId: string;
  reason: string;
}): CheckInRecord[] {
  const linkedTaskId = input.linkedTaskId.trim();
  if (!linkedTaskId) return [];
  const settled: CheckInRecord[] = [];
  for (const record of listOpenCheckIns()) {
    if (record.linkedTaskId !== linkedTaskId) continue;
    const closed = closeCheckIn(record.id, input.reason);
    if (closed?.status === 'closed') settled.push(closed);
  }
  return settled;
}

function comparableQuestion(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Locate the check-in created by the exact background turn that is now
 * parking. A single linked row is unambiguous; if several exist, only an exact
 * normalized question match may choose one. */
export function findOpenLinkedCheckIn(
  linkedTaskId: string,
  question?: string,
): CheckInRecord | null {
  const candidates = listOpenCheckIns().filter((record) => (
    record.linkedTaskId === linkedTaskId && Boolean(record.linkedQuestionId)
  ));
  if (question) {
    const wanted = comparableQuestion(question);
    const exact = candidates.filter((record) => comparableQuestion(record.question) === wanted);
    return exact.length === 1 ? exact[0] : null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export interface CheckInLinkedQuestionExpectation {
  linkedTaskId: string;
  linkedQuestionId: string;
}

/** Pure projection/route guard shared by desktop and mobile surfaces. */
export function checkInMatchesLinkedQuestion(
  record: Pick<CheckInRecord, 'linkedTaskId' | 'linkedQuestionId'>,
  expected: CheckInLinkedQuestionExpectation | null,
): boolean {
  if (!record.linkedTaskId) return expected === null;
  return Boolean(record.linkedQuestionId)
    && expected !== null
    && record.linkedTaskId === expected.linkedTaskId
    && record.linkedQuestionId === expected.linkedQuestionId;
}

interface InboxItemShape {
  id: string;
  type: string;
  createdAt: string;
  status: 'pending' | 'processed';
  fromAgent?: string;
  sourceKey?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append an inbox item to the agent's pending inbox so the next
 * autonomy cycle wakes up with the answer in context. Idempotent on
 * sourceKey — the same check-in answer can only enqueue once even if
 * answerCheckIn is called twice somehow.
 */
function enqueueAnswerInbox(record: CheckInRecord): void {
  ensureDir(AGENT_INBOX_DIR);
  const filePath = path.join(AGENT_INBOX_DIR, `${record.agentSlug}.json`);
  withFileLockSyncStrict(filePath, () => {
    const items: InboxItemShape[] = existsSync(filePath)
      ? (() => { try { return JSON.parse(readFileSync(filePath, 'utf-8')) as InboxItemShape[]; } catch { return []; } })()
      : [];

    const sourceKey = `checkin:${record.id}:answered`;
    if (items.some((item) => item.sourceKey === sourceKey)) return;

    items.push({
      id: randomUUID(),
      type: 'check_in_answered',
      createdAt: new Date().toISOString(),
      status: 'pending',
      sourceKey,
      content: `You asked: "${record.question}"\nUser answered: "${record.answer ?? ''}"`,
      metadata: {
        checkInId: record.id,
        contextExecutionId: record.contextExecutionId,
        linkedTaskId: record.linkedTaskId,
        linkedQuestionId: record.linkedQuestionId,
      },
    });
    // Same atomic-rename pattern so concurrent inbox readers never see
    // a half-written file.
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
    renameSync(tmp, filePath);
  });
}

export type CheckInAnswerResult =
  | { status: 'answered'; record: CheckInRecord }
  | { status: 'stale'; record: CheckInRecord }
  | { status: 'stale_link'; record: CheckInRecord }
  | { status: 'not_found' }
  | { status: 'storage_error'; reason: string };

function markLinkedResolutionProjected(record: CheckInRecord, requestId: string): void {
  try {
    withFileLockSyncStrict(checkInPath(record.id), () => {
      const current = getCheckIn(record.id);
      if (
        current?.status !== 'answered'
        || current.linkedTaskId !== record.linkedTaskId
        || current.linkedQuestionId !== record.linkedQuestionId
        || current.answer !== record.answer
        || current.linkedResolutionRequestId === requestId
      ) return;
      atomicWriteCheckIn({
        ...current,
        linkedResolutionRequestId: requestId,
        linkedResolutionQueuedAt: new Date().toISOString(),
      });
    });
  } catch {
    // The stable request id makes a later repair sweep harmless.
  }
}

async function projectLinkedCheckInAnswer(
  record: CheckInRecord,
): Promise<'queued' | 'recovered' | 'stale' | 'failed'> {
  if (
    record.status !== 'answered'
    || !record.answer
    || !record.linkedTaskId
    || !record.linkedQuestionId
  ) return 'stale';
  try {
    const {
      getBackgroundTask,
      queueBackgroundTaskInputResolution,
    } = await import('../execution/background-tasks.js');
    const requestId = `checkin:${record.id}`;
    const queued = queueBackgroundTaskInputResolution(record.linkedQuestionId, record.answer, { requestId });
    if (queued) {
      markLinkedResolutionProjected(record, requestId);
      return 'queued';
    }
    const current = getBackgroundTask(record.linkedTaskId);
    if (current?.lastInputResolutionRequestId === requestId) {
      markLinkedResolutionProjected(record, requestId);
      return 'recovered';
    }
    return 'stale';
  } catch {
    return 'failed';
  }
}

const DEFINITIVELY_NON_QUESTION_TASK_STATUSES = new Set([
  'awaiting_approval',
  'awaiting_continue',
  'done',
  'blocked',
  'failed',
  'aborted',
  'interrupted',
  'cancelling',
]);

/** Restart/self-heal sweep for open linked check-ins whose task authority has
 * already moved. The task record is the causal source of truth:
 *
 * - awaiting Q2 definitively supersedes Q1;
 * - an exact inputResolution/last request proves the answer committed;
 * - terminal, archived, or missing tasks cannot accept an answer;
 * - pending/running without a resolution receipt is left alone because this
 *   can be the tiny create-check-in -> park-question settlement window.
 *
 * Presentation reads also apply the same predicate synchronously. This sweep
 * is the restart backstop for a process death before those reads or the
 * transition-side projection run.
 */
export async function reconcileOpenLinkedCheckIns(): Promise<{
  inspected: number;
  closed: number;
  current: number;
  preparing: number;
  failed: number;
}> {
  const result = { inspected: 0, closed: 0, current: 0, preparing: 0, failed: 0 };
  let getBackgroundTask: ((id: string) => {
    id: string;
    status: string;
    archived?: boolean;
    pendingQuestionId?: string;
    inputResolution?: { questionId?: string; requestId?: string };
    lastInputResolutionRequestId?: string;
  } | null);
  try {
    ({ getBackgroundTask } = await import('../execution/background-tasks.js'));
  } catch {
    result.failed = listOpenCheckIns().filter((row) => Boolean(row.linkedTaskId)).length;
    return result;
  }

  for (const record of listOpenCheckIns()) {
    if (!record.linkedTaskId) continue;
    result.inspected += 1;
    try {
      const task = getBackgroundTask(record.linkedTaskId);
      const exactQuestion = Boolean(
        record.linkedQuestionId
        && task?.status === 'awaiting_input'
        && task.pendingQuestionId === record.linkedQuestionId,
      );
      if (exactQuestion) {
        result.current += 1;
        continue;
      }

      const exactResolutionCommitted = Boolean(record.linkedQuestionId && task && (
        task.inputResolution?.questionId === record.linkedQuestionId
        || task.lastInputResolutionRequestId === `checkin:${record.id}`
      ));
      const definitivelySuperseded = Boolean(
        !record.linkedQuestionId
        || !task
        || task.archived
        || exactResolutionCommitted
        || (task.status === 'awaiting_input' && task.pendingQuestionId !== record.linkedQuestionId)
        || DEFINITIVELY_NON_QUESTION_TASK_STATUSES.has(task.status),
      );
      if (!definitivelySuperseded) {
        result.preparing += 1;
        continue;
      }

      const reason = !task
        ? 'Auto-closed: the linked task no longer exists, so this question cannot be answered.'
        : exactResolutionCommitted
          ? 'Auto-closed: the exact linked answer was already committed and the task is resuming.'
          : task.status === 'awaiting_input'
            ? 'Auto-closed: the linked task advanced to a newer question.'
            : `Auto-closed: the linked task moved to ${task.status} and no longer accepts this question.`;
      const closed = closeCheckIn(record.id, reason);
      if (closed?.status === 'closed') result.closed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/** Restart/self-heal sweep for the only cross-store crash seam: the canonical
 * check-in answer committed, but the process stopped before its exact task
 * resolution was queued. The stable checkin:<id> request id makes replay
 * idempotent after the task has already accepted or consumed the answer. */
export async function repairLinkedCheckInAnswers(): Promise<{
  inspected: number;
  queued: number;
  recovered: number;
  stale: number;
  failed: number;
}> {
  // Close obsolete open generations before replaying committed answers. This
  // ordering makes a restart converge both cross-store crash seams in one tick:
  // an answer-before-task crash resumes the exact task, while a task-advanced-
  // before-check-in-cleanup crash retires the dead Needs You carrier.
  await reconcileOpenLinkedCheckIns();
  const result = { inspected: 0, queued: 0, recovered: 0, stale: 0, failed: 0 };
  for (const record of listCheckIns({ status: 'answered' })) {
    if (!record.linkedTaskId || !record.linkedQuestionId || !record.answer) continue;
    if (record.linkedResolutionRequestId === `checkin:${record.id}`) continue;
    result.inspected += 1;
    const status = await projectLinkedCheckInAnswer(record);
    result[status] += 1;
  }
  return result;
}

/** Claim an open check-in exactly once across every response surface. */
export function answerCheckInCas(
  id: string,
  answer: string,
  expectedLink?: CheckInLinkedQuestionExpectation | null,
): CheckInAnswerResult {
  if (!isCheckInId(id)) return { status: 'not_found' };
  let claimed: CheckInAnswerResult;
  ensureDir(CHECK_INS_DIR);
  try {
    claimed = withFileLockSyncStrict(checkInPath(id), () => {
      const existing = getCheckIn(id);
      if (!existing) return { status: 'not_found' as const };
      if (existing.status !== 'open') return { status: 'stale' as const, record: existing };
      // Legacy linked rows without an exact question generation are unsafe to
      // answer: the task may have advanced from Q1 to Q2 under the same id.
      if (existing.linkedTaskId && !existing.linkedQuestionId) {
        return { status: 'stale_link' as const, record: existing };
      }
      if (expectedLink !== undefined && !checkInMatchesLinkedQuestion(existing, expectedLink)) {
        return { status: 'stale_link' as const, record: existing };
      }

      const updated: CheckInRecord = {
        ...existing,
        status: 'answered',
        answer: answer.trim().slice(0, 4000),
        answeredAt: new Date().toISOString(),
      };
      atomicWriteCheckIn(updated);
      return { status: 'answered' as const, record: updated };
    });
  } catch (error) {
    return {
      status: 'storage_error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (claimed.status !== 'answered') {
    // A replay after the canonical answer write repairs a process death before
    // the task projection. Exact question routing keeps this harmless if the
    // task has since advanced to another generation.
    if (claimed.status === 'stale' && claimed.record.status === 'answered') {
      void projectLinkedCheckInAnswer(claimed.record);
    }
    return claimed;
  }

  const updated = claimed.record;
  // Everything below is a repairable projection after the canonical CAS. A
  // projection failure must not tell the user their committed answer failed.
  try { enqueueAnswerInbox(updated); } catch { /* autonomy can reconcile from the check-in record */ }

  // Store unification (2026-07-22): a check-in linked to a parked background
  // task resumes THAT task with the same answer — answering the check-in copy
  // used to resolve only this store, so the task sat awaiting_input forever
  // and the agent's next cycle spawned a duplicate. Lazy import avoids a
  // module cycle; idempotent (queue no-ops unless the task is still parked).
  if (updated.linkedTaskId && updated.linkedQuestionId) {
    void projectLinkedCheckInAnswer(updated);
  }

  try {
    markNotificationsReadByCheckInId(id, { resolvedFrom: 'check_in_authority' });
  } catch { /* durable check-in state remains authoritative */ }
  try {
    addNotification({
      id: `${Date.now()}-checkin-${id}-answered`,
      kind: 'system',
      title: `Answer recorded for ${updated.agentSlug}`,
      body: `Q: ${updated.question}\nA: ${updated.answer ?? ''}`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        checkInId: id,
        agentSlug: updated.agentSlug,
        status: 'answered',
        inboxOnly: true,
        linkedTaskId: updated.linkedTaskId,
        linkedQuestionId: updated.linkedQuestionId,
      },
    });
  } catch { /* terminal receipt can be rebuilt from the canonical answer */ }

  return claimed;
}

/** Backward-compatible record-returning facade for agent/tool callers. */
export function answerCheckIn(id: string, answer: string): CheckInRecord | null {
  const existing = getCheckIn(id);
  // An id-only compatibility call cannot prove that a linked task still owns
  // this question generation. Production channel/tool callers use
  // answerExactCheckIn (task + question CAS); fail closed here so a future
  // legacy caller cannot revive the Q1 false-success bug.
  if (existing?.linkedTaskId) return null;
  const result = answerCheckInCas(id, answer, null);
  if (result.status === 'answered' || result.status === 'stale' || result.status === 'stale_link') return result.record;
  if (result.status === 'storage_error') throw new Error(result.reason);
  return null;
}

/** Open check-ins older than this are dead — their executions are long gone
 *  and the "Needs you" card goes nowhere (observed live: open questions from
 *  May 14–28 pinned to Home for weeks with no dismiss path). */
const STALE_CHECK_IN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Check-in hygiene (boot + nightly): closes open check-ins past the stale
 * TTL with an audit closeReason. An answered/closed record is never touched.
 */
export function reapStaleCheckIns(nowMs: number = Date.now()): number {
  let closed = 0;
  for (const record of listCheckIns({ status: 'open' })) {
    const at = Date.parse(record.askedAt);
    if (!Number.isFinite(at) || nowMs - at <= STALE_CHECK_IN_MS) continue;
    closeCheckIn(record.id, 'Auto-closed: question went unanswered past the 7-day TTL and its originating work is no longer active.');
    closed += 1;
  }
  return closed;
}

export function closeCheckIn(id: string, reason = 'Dismissed by user.'): CheckInRecord | null {
  if (!isCheckInId(id)) return null;
  let didClose = false;
  ensureDir(CHECK_INS_DIR);
  const result = withFileLockSyncStrict(checkInPath(id), () => {
    const existing = getCheckIn(id);
    if (!existing) return null;
    if (existing.status !== 'open') return existing;

    const updated: CheckInRecord = {
      ...existing,
      status: 'closed',
      closedAt: new Date().toISOString(),
      closeReason: reason.slice(0, 600),
    };
    atomicWriteCheckIn(updated);
    didClose = true;
    return updated;
  });
  if (didClose) {
    try {
      markNotificationsReadByCheckInId(id, { resolvedFrom: 'check_in_closed' });
    } catch { /* canonical close remains authoritative */ }
    if (result?.linkedQuestionId) {
      try {
        markNotificationsReadByQuestionId(result.linkedQuestionId, {
          resolvedFrom: 'linked_check_in_closed',
          linkedTaskId: result.linkedTaskId,
          checkInId: result.id,
        });
      } catch { /* canonical close remains authoritative */ }
    }
  }
  return result;
}

/**
 * Hard delete. Used by tests and by a future "GC old check-ins" path.
 */
export function deleteCheckIn(id: string): boolean {
  if (!isCheckInId(id)) return false;
  const filePath = checkInPath(id);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/**
 * Render the open check-ins for an agent as a compact block to splice
 * into the autonomy cycle input. Lets the agent see "I'm already
 * waiting on X questions" so it doesn't re-ask the same thing.
 */
export function renderOpenCheckInsForAgent(agentSlug: string, maxChars = 1200): string {
  const open = listOpenCheckIns(agentSlug);
  if (open.length === 0) return '';
  const lines = ['Open check-ins (waiting on user — do NOT re-ask):'];
  for (const c of open) {
    const urgency = c.urgency !== 'normal' ? ` [${c.urgency}]` : '';
    const ctx = c.contextExecutionId ? ` exec=${c.contextExecutionId}` : '';
    lines.push(`- ${c.id}${urgency}${ctx}: ${c.question}`);
  }
  return lines.join('\n').slice(0, maxChars);
}
