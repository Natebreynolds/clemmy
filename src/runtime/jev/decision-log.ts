import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { modelUsageAttributionStorage } from '../usage-log.js';
import type { SystemOneAnswer } from './system-one.js';

/**
 * One line per Jev decision and one per host outcome, joined by id, so each
 * lane's coverage (how often Jev settles its decision) and error (how often a
 * settled decision proved wrong) can be measured before its thresholds are
 * trusted. Answers, confidences and host candidate ids only: never the state
 * Jev was shown.
 */
const DECISION_DIR = path.join(BASE_DIR, 'state', 'jev-decisions');

export type CompactJevAnswer =
  | { choice: string; confidence: number }
  | { noul: number }
  | { score: number };

export function compactJevAnswers(answers: Record<string, SystemOneAnswer>): Record<string, CompactJevAnswer> {
  const out: Record<string, CompactJevAnswer> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === 'choice') out[id] = { choice: answer.choice, confidence: answer.confidence };
    else if (answer.type === 'noul') out[id] = { noul: answer.noul };
    else out[id] = { score: answer.score };
  }
  return out;
}

function append(row: Record<string, unknown>): void {
  const at = typeof row.at === 'string' ? row.at : new Date().toISOString();
  if (!existsSync(DECISION_DIR)) mkdirSync(DECISION_DIR, { recursive: true });
  appendFileSync(path.join(DECISION_DIR, `${at.slice(0, 10)}.ndjson`), `${JSON.stringify(row)}\n`, 'utf-8');
}

/** Record one Jev call and return its id; recording never breaks a decision. */
export function recordJevDecision(row: {
  lane: string;
  sessionId?: string;
  requestedModel: string;
  servedModel?: string;
  ok: boolean;
  failReason?: string;
  durationMs: number;
  inputTokens?: number;
  answers?: Record<string, CompactJevAnswer>;
  context?: Record<string, unknown>;
}): string {
  const id = randomUUID();
  try {
    const attribution = modelUsageAttributionStorage.getStore();
    const sessionId = row.sessionId?.trim() || attribution?.sessionId;
    append({
      id,
      at: new Date().toISOString(),
      ...row,
      ...(sessionId ? { sessionId } : {}),
      ...(attribution?.sourceUserSeq ? { sourceUserSeq: attribution.sourceUserSeq } : {}),
    });
  } catch { /* the decision log is observability, never a dependency */ }
  return id;
}

/** What the host did with a decision: applied, declined and why. */
export function noteJevDecisionOutcome(
  id: string | undefined,
  outcome: string,
  detail?: Record<string, unknown>,
): void {
  if (!id) return;
  try {
    append({ id, at: new Date().toISOString(), outcome, ...(detail ? { detail } : {}) });
  } catch { /* observability only */ }
}

/** A call the host decided not to make, and why, so the log shows every
 *  question Jev was not asked beside the ones it was. Never read back as a
 *  call: it has no answers and no tokens. */
export function recordJevSkip(row: {
  lane: string;
  sessionId?: string;
  reason: string;
  context?: Record<string, unknown>;
}): void {
  try {
    const attribution = modelUsageAttributionStorage.getStore();
    const sessionId = row.sessionId?.trim() || attribution?.sessionId;
    append({
      id: randomUUID(),
      at: new Date().toISOString(),
      skipped: true,
      ...row,
      ...(sessionId ? { sessionId } : {}),
      ...(attribution?.sourceUserSeq ? { sourceUserSeq: attribution.sourceUserSeq } : {}),
    });
  } catch { /* observability only */ }
}

/** One recorded call with the host's outcome joined on. */
export interface JevDecisionRecord {
  id: string;
  at: string;
  lane: string;
  ok: boolean;
  inputTokens?: number;
  context?: Record<string, unknown>;
  /** What the host did with it; absent when nothing was noted. */
  outcome?: string;
}

/**
 * The calls one lane made over the last `days` daily files, each with its
 * outcome. Skipped calls and unreadable lines are left out. Bounded by the
 * files it reads; a missing day is simply absent.
 */
export function readRecentJevDecisions(lane: string, days = 14, nowMs = Date.now()): JevDecisionRecord[] {
  const calls = new Map<string, JevDecisionRecord>();
  const outcomes = new Map<string, string>();
  for (let back = days - 1; back >= 0; back--) {
    const day = new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10);
    const file = path.join(DECISION_DIR, `${day}.ndjson`);
    if (!existsSync(file)) continue;
    let text: string;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) continue;
      if (typeof row.outcome === 'string') { outcomes.set(id, row.outcome); continue; }
      if (row.lane !== lane || row.skipped === true) continue;
      calls.set(id, {
        id,
        at: typeof row.at === 'string' ? row.at : '',
        lane,
        ok: row.ok === true,
        ...(typeof row.inputTokens === 'number' ? { inputTokens: row.inputTokens } : {}),
        ...(row.context && typeof row.context === 'object' ? { context: row.context as Record<string, unknown> } : {}),
      });
    }
  }
  return [...calls.values()].map((call) => (outcomes.has(call.id) ? { ...call, outcome: outcomes.get(call.id) } : call));
}
