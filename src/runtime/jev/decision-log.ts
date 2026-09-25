import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
