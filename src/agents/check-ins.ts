import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from '../config.js';
import { addNotification } from '../runtime/notifications.js';

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
  status: CheckInStatus;
  askedAt: string;
  answeredAt?: string;
  closedAt?: string;
  answer?: string;
  closeReason?: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function checkInPath(id: string): string {
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
}

/**
 * Open a new check-in. Writes the record and queues a notification of
 * kind 'approval' (the closest existing notification kind for "user
 * action needed") with metadata.checkInId so downstream UIs can route
 * it to a "Questions for you" panel.
 */
export function createCheckIn(input: CreateCheckInInput): CheckInRecord {
  const question = input.question.trim();
  if (!question) throw new Error('createCheckIn: question is required');
  if (!input.agentSlug.trim()) throw new Error('createCheckIn: agentSlug is required');

  const record: CheckInRecord = {
    id: `chk-${randomUUID().slice(0, 8)}`,
    agentSlug: input.agentSlug,
    question: question.slice(0, 1200),
    urgency: input.urgency ?? 'normal',
    contextExecutionId: input.contextExecutionId,
    contextSummary: input.contextSummary?.slice(0, 600),
    linkedTaskId: input.linkedTaskId,
    status: 'open',
    askedAt: new Date().toISOString(),
  };
  atomicWriteCheckIn(record);

  addNotification({
    id: `${Date.now()}-checkin-${record.id}`,
    kind: 'approval',
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
    },
  });

  return record;
}

export function getCheckIn(id: string): CheckInRecord | null {
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
    },
  });
  // Same atomic-rename pattern so concurrent inbox readers never see
  // a half-written file.
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

export function answerCheckIn(id: string, answer: string): CheckInRecord | null {
  const existing = getCheckIn(id);
  if (!existing) return null;
  if (existing.status !== 'open') return existing;

  const updated: CheckInRecord = {
    ...existing,
    status: 'answered',
    answer: answer.trim().slice(0, 4000),
    answeredAt: new Date().toISOString(),
  };
  atomicWriteCheckIn(updated);

  enqueueAnswerInbox(updated);

  // Store unification (2026-07-22): a check-in linked to a parked background
  // task resumes THAT task with the same answer — answering the check-in copy
  // used to resolve only this store, so the task sat awaiting_input forever
  // and the agent's next cycle spawned a duplicate. Lazy import avoids a
  // module cycle; idempotent (queue no-ops unless the task is still parked).
  if (updated.linkedTaskId) {
    void (async () => {
      try {
        const { getBackgroundTask, queueBackgroundTaskInputResolution } = await import('../execution/background-tasks.js');
        const task = getBackgroundTask(updated.linkedTaskId as string);
        if (task?.status === 'awaiting_input' && task.pendingQuestionId) {
          queueBackgroundTaskInputResolution(task.pendingQuestionId, updated.answer ?? '');
        }
      } catch { /* the check-in answer is recorded regardless; the origin-chat bridge remains the fallback */ }
    })();
  }

  addNotification({
    id: `${Date.now()}-checkin-${id}-answered`,
    kind: 'system',
    title: `Answer recorded for ${existing.agentSlug}`,
    body: `Q: ${existing.question}\nA: ${answer}`,
    createdAt: new Date().toISOString(),
    read: false,
    metadata: { checkInId: id, agentSlug: existing.agentSlug, status: 'answered' },
  });

  return updated;
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
  return updated;
}

/**
 * Hard delete. Used by tests and by a future "GC old check-ins" path.
 */
export function deleteCheckIn(id: string): boolean {
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
