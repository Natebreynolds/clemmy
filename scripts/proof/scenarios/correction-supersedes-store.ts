/**
 * Catalog-only scenario — correction-supersedes-store: the ASPIRATIONAL half
 * of the correction contract, kept deliberately red until the class is fixed.
 *
 * `correction-sticks` (default gate) pins what is true today: a fresh session
 * answers with the corrected value and never repeats the stale one. This
 * scenario pins what is NOT yet true: that the superseded belief is retired in
 * the durable store — either deactivated immediately, or at minimum recorded in
 * the pending-memory-conflicts queue so the nightly resolver can retire it.
 *
 * Live evidence (2026-07-29, both brains, multiple runs): the pair is often
 * neither superseded nor queued — the conflict resolver's fail-open ADD ran
 * without recording the pending conflict, so the stale belief is orphaned
 * active forever. Until that write path tracks the pair, this stays red on
 * purpose. Do NOT green it by weakening the checks.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { Check, DaemonHandle, ScenarioDef, TurnResult } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

const STALE = 'Quillon-3317';
const CORRECTED = 'Verdanth-8846';

interface ProofScope { projectId: string | null; agentKey: string | null }
export interface CorrectionProofSource {
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  occurredAt: string;
  scope: ProofScope;
}
export interface CorrectionProofFact {
  id: number;
  kind: string;
  content: string;
  active: boolean;
  supersededByFactId: number | null;
  sourceSessionId: string | null;
  sourcePath: string | null;
  scope: ProofScope;
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sameScope = (a: ProofScope, b: ProofScope): boolean => a.projectId === b.projectId && a.agentKey === b.agentKey;
function exactSource(fact: CorrectionProofFact, source: CorrectionProofSource): boolean {
  return fact.sourceSessionId === source.sessionId && sameScope(fact.scope, source.scope)
    && [
      `conversation://${encodeURIComponent(source.sessionId)}/${encodeURIComponent(`auto-capture:user-source:${source.sourceUserSeq}`)}`,
      `conversation://${source.sessionId}/user-source:${source.sourceUserSeq}`,
    ].includes(fact.sourcePath ?? '');
}

/** Grade the retained relationship, never the presence of an unrelated queue
 * item. Queued means tracked for later review, not a completed correction. */
export function correctionSupersessionChecks(input: {
  statedSource: CorrectionProofSource | null;
  correctionSource: CorrectionProofSource | null;
  originalFacts: readonly CorrectionProofFact[] | null;
  currentFacts: readonly CorrectionProofFact[] | null;
  pendingConflicts: unknown;
  staleValue: string;
  correctedValue: string;
  nowMs: number;
}): Check[] {
  const { statedSource: stated, correctionSource: correction } = input;
  const validSources = Boolean(stated && correction && stated.sessionId === correction.sessionId
    && positive(stated.sourceUserSeq) && positive(correction.sourceUserSeq)
    && correction.sourceUserSeq > stated.sourceUserSeq && stated.sourceEventId && correction.sourceEventId
    && stated.sourceEventId !== correction.sourceEventId && sameScope(stated.scope, correction.scope)
    && Number.isFinite(Date.parse(stated.occurredAt)) && Date.parse(correction.occurredAt) >= Date.parse(stated.occurredAt)
    && Date.parse(correction.occurredAt) <= input.nowMs);
  const isStale = (fact: CorrectionProofFact): boolean => fact.content.includes(input.staleValue) && !fact.content.includes(input.correctedValue);
  const original = input.originalFacts?.filter(fact => fact.active && isStale(fact)) ?? [];
  const originalsQualified = validSources && original.length > 0
    && original.every(fact => positive(fact.id) && fact.supersededByFactId === null && exactSource(fact, stated!))
    && new Set(original.map(fact => fact.id)).size === original.length;
  const corrected = input.currentFacts?.filter(fact => fact.active && fact.content.includes(input.correctedValue)) ?? [];
  const candidate = corrected.length === 1 ? corrected[0] : undefined;
  const candidateQualified = Boolean(originalsQualified && candidate && positive(candidate.id)
    && candidate.supersededByFactId === null && exactSource(candidate, correction!)
    && original.every(fact => fact.id !== candidate.id && fact.kind === candidate.kind));
  const rows = Array.isArray(input.pendingConflicts) ? input.pendingConflicts : [];
  const tracked = new Set<number>();
  if (candidateQualified && candidate && correction) for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const at = typeof row.recordedAt === 'string' ? Date.parse(row.recordedAt) : NaN;
    if (row.candidateFactId !== candidate.id || !Array.isArray(row.similarFactIds)
      || !row.similarFactIds.length || row.similarFactIds.length > 10 || !row.similarFactIds.every(positive)
      || new Set(row.similarFactIds).size !== row.similarFactIds.length
      || !Number.isSafeInteger(row.attempts) || Number(row.attempts) < 0 || Number(row.attempts) >= 5
      || !Number.isFinite(at) || at < Date.parse(correction.occurredAt) || at > input.nowMs
      || input.nowMs - at > 14 * 24 * 60 * 60_000) continue;
    for (const fact of original) if (row.similarFactIds.includes(fact.id)) tracked.add(fact.id);
  }
  const currentById = new Map((input.currentFacts ?? []).map(fact => [fact.id, fact]));
  const covered = original.filter(before => {
    const after = currentById.get(before.id);
    if (!candidateQualified || !candidate || !after || after.kind !== before.kind || after.content !== before.content
      || after.sourceSessionId !== before.sourceSessionId || after.sourcePath !== before.sourcePath
      || !sameScope(after.scope, before.scope)) return false;
    return !after.active ? after.supersededByFactId === candidate.id
      : after.supersededByFactId === null && tracked.has(before.id);
  });
  const unexpectedStale = (input.currentFacts ?? []).some(fact => fact.active && isStale(fact)
    && !original.some(before => before.id === fact.id));
  return [{
    name: 'the original memory and correction have exact accepted sources and scope',
    pass: originalsQualified,
    detail: `original facts ${original.length}; exact ordered sources ${validSources}`,
  }, {
    name: 'the correction consolidated to exactly one active source-bound fact',
    pass: candidateQualified,
    detail: `active corrected facts ${corrected.length}; candidate ${candidate?.id ?? 'missing'}`,
  }, {
    name: 'every exact stale belief is retired by the correction OR freshly tracked with it',
    pass: candidateQualified && input.currentFacts !== null && !unexpectedStale && covered.length === original.length,
    detail: `covered originals ${covered.length}/${original.length}; exact queued targets ${tracked.size}; unexpected active stale ${unexpectedStale}`,
  }];
}

function sourceFor(daemon: DaemonHandle, turn: TurnResult, text: string): CorrectionProofSource | null {
  if (!positive(turn.sourceUserSeq)) return null;
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(daemon.home, 'state', 'harness.db'), { readonly: true, fileMustExist: true });
    const row = db.prepare(`SELECT e.id, e.created_at, e.data_json, c.identity_json, c.identity_digest
      FROM events e JOIN source_session_contexts_v1 c ON c.session_id=e.session_id AND c.source_user_seq=e.seq
      WHERE e.session_id=? AND e.seq=? AND e.type='user_input_received' AND e.role='user'`)
      .get(turn.sessionId, turn.sourceUserSeq) as { id: string; created_at: string; data_json: string; identity_json: string; identity_digest: string } | undefined;
    if (!row || typeof row.id !== 'string' || !row.id || !Number.isFinite(Date.parse(row.created_at))) return null;
    const data = JSON.parse(row.data_json);
    const context = JSON.parse(row.identity_json);
    const scope = context.memoryScope;
    const ownerText = typeof data.displayText === 'string' && data.displayText.trim() ? data.displayText : data.text;
    if (data.synthetic === true || ownerText !== text || context.version !== 1 || context.sessionId !== turn.sessionId
      || context.sourceUserSeq !== turn.sourceUserSeq || !scope || Array.isArray(scope)
      || ![scope.projectId, scope.agentKey].every(value => value === null || typeof value === 'string' && value.length > 0)
      || createHash('sha256').update(row.identity_json).digest('hex') !== row.identity_digest) return null;
    return { sessionId: turn.sessionId, sourceUserSeq: turn.sourceUserSeq, sourceEventId: row.id,
      occurredAt: row.created_at, scope: { projectId: scope.projectId, agentKey: scope.agentKey } };
  } catch { return null; } finally { db?.close(); }
}

function factSnapshot(home: string): CorrectionProofFact[] | null {
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(home, 'state', 'memory.db'), { readonly: true, fileMustExist: true });
    const snapshotDb = db;
    return db.transaction(() => {
      const rows = snapshotDb.prepare(`SELECT f.id, f.kind, f.content, f.active, f.superseded_by_fact_id AS successor,
        f.source_session_id AS sourceSessionId, f.source_path AS sourcePath,
        s.scope_project_id AS projectId, s.scope_agent_key AS agentKey
        FROM consolidated_facts f LEFT JOIN memory_scopes s ON s.target_kind='fact' AND s.target_id=CAST(f.id AS TEXT)
        WHERE instr(f.content, ?) > 0 OR instr(f.content, ?) > 0`).all(STALE, CORRECTED) as Array<{
          id: number; kind: string; content: string; active: number; successor: number | null;
          sourceSessionId: string | null; sourcePath: string | null; projectId: string | null; agentKey: string | null;
        }>;
      if (rows.some(row => ![0, 1].includes(row.active))) return null;
      return rows.map(row => ({ id: row.id, kind: row.kind, content: row.content, active: row.active === 1,
        supersededByFactId: row.successor, sourceSessionId: row.sourceSessionId, sourcePath: row.sourcePath,
        scope: { projectId: row.projectId, agentKey: row.agentKey } }));
    })();
  } catch { return null; } finally { db?.close(); }
}

export const correctionSupersedesStore: ScenarioDef = {
  name: 'correction-supersedes-store',
  summary: 'ASPIRATIONAL: a correction retires the stale belief in the store, or queues it for retirement',
  async run(daemon: DaemonHandle) {
    const session = `proof-supersede-${Date.now().toString(36)}`;
    const statedText = `Remember this: the deploy freeze codeword is ${STALE}.`;
    const correctedText = `Correction — the deploy freeze codeword is actually ${CORRECTED}, not ${STALE}. Retire the old one.`;
    const stated = await daemon.acceptedChat(statedText, session, PROOF_CLIENT_COMPLETION_TIMEOUT_MS);
    const statedSource = sourceFor(daemon, stated, statedText);
    const originalFacts = factSnapshot(daemon.home);
    const corrected = await daemon.acceptedChat(correctedText, session, PROOF_CLIENT_COMPLETION_TIMEOUT_MS);
    const correctionSource = sourceFor(daemon, corrected, correctedText);
    const currentFacts = factSnapshot(daemon.home);
    let pendingConflicts: unknown = null;
    try {
      const queueFile = path.join(daemon.home, 'state', 'pending-memory-conflicts.json');
      if (existsSync(queueFile)) {
        pendingConflicts = JSON.parse(readFileSync(queueFile, 'utf-8'));
      }
    } catch { /* surfaced below */ }

    const checks: Check[] = [{ name: 'both memory turns completed on their accepted ingress',
      pass: stated.httpStatus === 200 && corrected.httpStatus === 200,
      detail: `${stated.httpStatus}/${corrected.httpStatus}` }, ...correctionSupersessionChecks({
      statedSource, correctionSource, originalFacts, currentFacts, pendingConflicts, staleValue: STALE, correctedValue: CORRECTED, nowMs: Date.now(),
    })];
    return { checks, latency: [{ wallMs: stated.wallMs, ttftMs: null }, { wallMs: corrected.wallMs, ttftMs: null }], sessionId: session,
      metrics: { turns: 2, originalFactIds: originalFacts?.map(fact => fact.id) ?? null,
        activeCorrected: currentFacts?.filter(fact => fact.active && fact.content.includes(CORRECTED)).length ?? null,
        queuedPairs: Array.isArray(pendingConflicts) ? pendingConflicts.length : null } };
  },
};
