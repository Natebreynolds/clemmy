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

export type CheckInUrgency = 'low' | 'normal' | 'high';
export type CheckInStatus = 'open' | 'answered' | 'closed';

export interface CheckInRecord {
  id: string;
  agentSlug: string;
  question: string;
  urgency: CheckInUrgency;
  contextExecutionId?: string;
  contextSummary?: string;
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
