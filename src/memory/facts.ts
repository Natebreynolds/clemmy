import { createHash } from 'node:crypto';
import { openMemoryDb, type ConsolidatedFactKind, type ConsolidatedFactRow } from './db.js';

/**
 * Read/write API for durable, agent-curated facts.
 *
 * Why this exists:
 * - Session briefs and working memory drift as conversations evolve.
 *   `consolidated_facts` is for the things that should NOT drift —
 *   user preferences, project context, persistent feedback, links to
 *   external references the agent should keep coming back to.
 * - The agent itself decides what to remember (via the `memory_remember`
 *   MCP tool). No automatic LLM extraction; the agent's own judgment is
 *   the consolidation step.
 * - On every turn, the top-N active facts are injected into the
 *   assistant's instructions so the model is fact-aware.
 *
 * Schema lives in src/memory/db.ts. Content is deduped by hash so the
 * same fact written twice is a no-op (we bump `score` and `updated_at`).
 */

export interface ConsolidatedFact {
  id: number;
  kind: ConsolidatedFactKind;
  content: string;
  source: { sessionId?: string; path?: string };
  score: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export const FACT_KINDS: ConsolidatedFactKind[] = ['user', 'project', 'feedback', 'reference'];

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function hashContent(kind: ConsolidatedFactKind, content: string): string {
  return createHash('sha1').update(`${kind}::${normalizeContent(content).toLowerCase()}`).digest('hex');
}

function rowToFact(row: ConsolidatedFactRow): ConsolidatedFact {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    source: {
      sessionId: row.source_session_id ?? undefined,
      path: row.source_path ?? undefined,
    },
    score: row.score,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RememberInput {
  kind: ConsolidatedFactKind;
  content: string;
  sessionId?: string;
  path?: string;
  score?: number;
}

/**
 * Record a durable fact. Idempotent on (kind, normalized content):
 * a repeat write bumps `score` by 0.1 and `updated_at` instead of
 * creating a duplicate row.
 */
export function rememberFact(input: RememberInput): ConsolidatedFact {
  const content = normalizeContent(input.content);
  if (!content) throw new Error('rememberFact: content is required');
  if (!FACT_KINDS.includes(input.kind)) {
    throw new Error(`rememberFact: invalid kind "${input.kind}"`);
  }

  const db = openMemoryDb();
  const hash = hashContent(input.kind, content);
  const now = new Date().toISOString();
  const initialScore = input.score ?? 1.0;

  const existing = db.prepare(
    'SELECT * FROM consolidated_facts WHERE content_hash = ?'
  ).get(hash) as ConsolidatedFactRow | undefined;

  if (existing) {
    db.prepare(`
      UPDATE consolidated_facts
      SET score = MIN(score + 0.1, 10),
          active = 1,
          updated_at = ?,
          source_session_id = COALESCE(?, source_session_id),
          source_path       = COALESCE(?, source_path)
      WHERE id = ?
    `).run(now, input.sessionId ?? null, input.path ?? null, existing.id);
    const refreshed = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?')
      .get(existing.id) as ConsolidatedFactRow;
    return rowToFact(refreshed);
  }

  const info = db.prepare(`
    INSERT INTO consolidated_facts
      (kind, content, content_hash, source_session_id, source_path, score, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(input.kind, content, hash, input.sessionId ?? null, input.path ?? null, initialScore, now, now);

  const inserted = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?')
    .get(info.lastInsertRowid) as ConsolidatedFactRow;
  return rowToFact(inserted);
}

export function listActiveFacts(options: { limit?: number; kind?: ConsolidatedFactKind } = {}): ConsolidatedFact[] {
  const db = openMemoryDb();
  const limit = Math.max(1, options.limit ?? 12);
  const rows = options.kind
    ? db.prepare(`
        SELECT * FROM consolidated_facts
        WHERE active = 1 AND kind = ?
        ORDER BY score DESC, updated_at DESC
        LIMIT ?
      `).all(options.kind, limit) as ConsolidatedFactRow[]
    : db.prepare(`
        SELECT * FROM consolidated_facts
        WHERE active = 1
        ORDER BY score DESC, updated_at DESC
        LIMIT ?
      `).all(limit) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

export function listAllFacts(limit = 50): ConsolidatedFact[] {
  const db = openMemoryDb();
  const rows = db.prepare(`
    SELECT * FROM consolidated_facts
    ORDER BY active DESC, score DESC, updated_at DESC
    LIMIT ?
  `).all(limit) as ConsolidatedFactRow[];
  return rows.map(rowToFact);
}

export function getFact(id: number): ConsolidatedFact | null {
  const db = openMemoryDb();
  const row = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?').get(id) as ConsolidatedFactRow | undefined;
  return row ? rowToFact(row) : null;
}

/**
 * Soft-delete a fact (sets active = 0). The row stays for audit/history.
 * Use {hard: true} to actually drop the row.
 */
export function forgetFact(id: number, options: { hard?: boolean } = {}): boolean {
  const db = openMemoryDb();
  if (options.hard) {
    const info = db.prepare('DELETE FROM consolidated_facts WHERE id = ?').run(id);
    return Number(info.changes ?? 0) > 0;
  }
  const info = db.prepare(`
    UPDATE consolidated_facts
    SET active = 0, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
  return Number(info.changes ?? 0) > 0;
}

/**
 * Render the top-N active facts as a compact block for the assistant's
 * instructions. Empty string when no facts exist — keeps the prompt clean.
 */
export function renderFactsForInstructions(limit = 10, maxChars = 1600): string {
  let facts: ConsolidatedFact[] = [];
  try {
    facts = listActiveFacts({ limit });
  } catch {
    // Don't ever break prompt assembly because the index is unhappy.
    return '';
  }
  if (facts.length === 0) return '';

  const byKind: Record<ConsolidatedFactKind, ConsolidatedFact[]> = {
    user: [], project: [], feedback: [], reference: [],
  };
  for (const fact of facts) byKind[fact.kind].push(fact);

  const sections: string[] = [];
  const titles: Record<ConsolidatedFactKind, string> = {
    user: 'About the user',
    project: 'Project context',
    feedback: 'Standing feedback',
    reference: 'References',
  };

  for (const kind of FACT_KINDS) {
    const group = byKind[kind];
    if (group.length === 0) continue;
    const lines = group.map((fact) => `- ${fact.content}`).join('\n');
    sections.push(`**${titles[kind]}**\n${lines}`);
  }

  return sections.join('\n\n').slice(0, maxChars);
}

export function countActiveFacts(): number {
  try {
    const db = openMemoryDb();
    const row = db.prepare('SELECT COUNT(*) AS c FROM consolidated_facts WHERE active = 1').get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}
