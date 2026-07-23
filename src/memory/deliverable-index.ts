/**
 * Deliverable index — durable "where did I put the user's work" memory.
 *
 * Born 2026-07-23: "find those emails we crafted yesterday" ground through
 * twenty mailbox/sheet calls while the 30 finished drafts sat in
 * ~/Desktop/ML-30-AI-Search-Drafts.md. Two structural causes: deliverable
 * capture only existed for the background lane (the drafting ran as chat
 * turns), and the evidence store that DID hold the trail (harness.db) had
 * been wiped — while memory.db survived. Conclusions, baked in here:
 *
 *   - CAPTURE AT THE EFFECT BOUNDARY, every lane: one tee where external
 *     writes are recorded (eventlog.appendEvent) + one at write_file success.
 *     No per-lane hooks to forget.
 *   - LIVE IN memory.db: "where the user's work lives" is long-term memory,
 *     not session telemetry. It must survive an evidence-store wipe.
 *   - THE INDEX POINTS, THE FILESYSTEM DECIDES: file entries are verified at
 *     recall time; a missing file is reported honestly, never asserted.
 *
 * Recall rides the unified spine (recallMemory 'deliverable' store), so the
 * first-turn primer and every memory tool surface it BEFORE tool grinding —
 * advisory context, never a gate.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from './db.js';

export interface DeliverableRecord {
  id: number;
  createdAt: string;
  kind: string;
  target: string;
  title: string;
  why: string;
  sessionId: string | null;
  lane: string | null;
}

export interface DeliverableHit extends DeliverableRecord {
  score: number;
  /** kind='file' only: false when the recorded path no longer exists. */
  stillExists?: boolean;
}

const MAX_ROWS = 1_000;

function ensureTable(): ReturnType<typeof openMemoryDb> {
  const db = openMemoryDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS deliverables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      why TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      lane TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deliverables_created ON deliverables(created_at);
    CREATE INDEX IF NOT EXISTS idx_deliverables_target ON deliverables(kind, target);
  `);
  return db;
}

/** Record (upsert) a deliverable. One row per (kind, target): a chunked
 *  write_file (append mode) or a re-run refreshes the row instead of
 *  spamming near-duplicates. Best-effort by contract — callers fire and
 *  forget; a memory-store hiccup must never affect the write it describes. */
export function recordDeliverable(input: {
  kind: string;
  target: string;
  title?: string;
  why?: string;
  sessionId?: string | null;
  lane?: string | null;
  at?: string;
}): DeliverableRecord | null {
  try {
    const target = input.target.trim();
    if (!target) return null;
    const db = ensureTable();
    const createdAt = input.at ?? new Date().toISOString();
    const title = (input.title ?? path.basename(target)).slice(0, 200);
    const why = (input.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
    db.prepare('DELETE FROM deliverables WHERE kind = ? AND target = ?').run(input.kind, target);
    const id = db.prepare(`
      INSERT INTO deliverables (created_at, kind, target, title, why, session_id, lane)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(createdAt, input.kind, target, title, why, input.sessionId ?? null, input.lane ?? null).lastInsertRowid as number;
    // Bounded store: prune the oldest rows past the cap.
    db.prepare(`
      DELETE FROM deliverables WHERE id IN (
        SELECT id FROM deliverables ORDER BY created_at DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_ROWS);
    return {
      id, createdAt, kind: input.kind, target, title, why,
      sessionId: input.sessionId ?? null, lane: input.lane ?? null,
    };
  } catch {
    return null;
  }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'we', 'i', 'my',
  'you', 'your', 'can', 'find', 'those', 'that', 'this', 'them', 'it',
  'please', 'hey', 'get', 'put', 'was', 'were', 'did', 'do', 'me', 'our',
]);

function tokensOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Lexical + recency search over the index. File entries are verified against
 *  the live filesystem so a stale pointer can never gaslight recall. */
export function searchDeliverables(query: string, limit = 6): DeliverableHit[] {
  try {
    const qTokens = new Set(tokensOf(query));
    if (qTokens.size === 0) return [];
    const db = ensureTable();
    const rows = db.prepare(`
      SELECT id, created_at AS createdAt, kind, target, title, why, session_id AS sessionId, lane
      FROM deliverables ORDER BY created_at DESC LIMIT 400
    `).all() as DeliverableRecord[];
    const nowMs = Date.now();
    const hits: DeliverableHit[] = [];
    for (const row of rows) {
      const hayTokens = tokensOf(`${row.kind} ${path.basename(row.target)} ${row.title} ${row.why}`);
      let overlap = 0;
      const seen = new Set<string>();
      for (const t of hayTokens) {
        if (qTokens.has(t) && !seen.has(t)) { overlap += 1; seen.add(t); }
      }
      if (overlap === 0) continue;
      const ageMs = Math.max(0, nowMs - Date.parse(row.createdAt));
      const recency = Math.max(0, 1 - ageMs / (30 * 24 * 60 * 60 * 1000)); // 30-day fade
      const score = Math.min(1, overlap / Math.max(2, qTokens.size)) * 0.75 + recency * 0.25;
      const hit: DeliverableHit = { ...row, score };
      if (row.kind === 'file') hit.stillExists = existsSync(row.target);
      hits.push(hit);
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  } catch {
    return [];
  }
}

/** One-line render used by the recall hit text. */
export function renderDeliverableHit(hit: DeliverableHit): string {
  const when = hit.createdAt.slice(0, 16).replace('T', ' ');
  const gone = hit.kind === 'file' && hit.stillExists === false
    ? ' [NOTE: the file no longer exists at this path]'
    : '';
  const why = hit.why ? ` — ${hit.why}` : '';
  return `${hit.kind} ${hit.target}${why} (${when}${hit.lane ? `, ${hit.lane}` : ''})${gone}`;
}

/** Map an external_write event's shapeKey to a deliverable kind. */
export function deliverableKindForShape(shapeKey: string | undefined): string {
  const key = (shapeKey ?? '').toUpperCase();
  if (/DRAFT/.test(key)) return 'draft';
  if (/SEND|EMAIL|MESSAGE|DM|REPLY|POST/.test(key)) return 'send';
  if (/SHEET|DOC|SLIDE|AIRTABLE|NOTION|RECORD|ROW|PAGE|UPLOAD/.test(key)) return 'external_doc';
  return 'external_write';
}
