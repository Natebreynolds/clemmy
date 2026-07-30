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
/** Recent deliverables, newest first — the read surface for the Delivered
 *  shelf (console Work screen). Same durability contract as recall: the index
 *  survives wipes and daemon restarts, so finished work never goes dark. */
export function listRecentDeliverables(limit = 30): DeliverableHit[] {
  try {
    const db = ensureTable();
    const rows = db.prepare(`
      SELECT id, created_at AS createdAt, kind, target, title, why, session_id AS sessionId, lane
      FROM deliverables ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(limit, 100))) as DeliverableRecord[];
    return rows.map((row) => {
      const hit: DeliverableHit = { ...row, score: 1 };
      if (row.kind === 'file') hit.stillExists = existsSync(row.target);
      return hit;
    });
  } catch {
    return [];
  }
}

export interface DeliveredGroup {
  /** Stable key (representative row id). */
  id: number;
  createdAt: string;
  /** Humanized name of the WORK, never a tool slug or bare filename. */
  title: string;
  /** The ask that produced it (representative why). */
  why: string;
  lane: string | null;
  sessionId: string | null;
  /** Best openable link among members, when one exists. */
  url?: string;
  /** Representative local file (prefers documents over scripts/data). */
  filePath?: string;
  fileStillExists?: boolean;
  /** How many artifacts this piece of work produced. */
  artifactCount: number;
  /** True when the group is a re-runnable ask (guest/local produced work). */
  rerunnable: boolean;
}

const SCRIPT_OR_DATA_RE = /\.(mjs|cjs|js|ts|json|map|lock)$/i;
const DOCUMENT_RE = /\.(html?|pdf|docx?|md|csv|xlsx?|pptx?|png|jpe?g)$/i;

function humanizeExternalTitle(row: DeliverableRecord): string {
  const slug = row.title.trim();
  if (/^GOOGLESHEETS?_/i.test(slug)) return 'Google Sheet updated';
  if (/^(GMAIL|OUTLOOK)_/i.test(slug)) return slug.toLowerCase().includes('draft') ? 'Email drafted' : 'Email sent';
  const shell = slug.match(/^shell:(.+)$/i);
  if (shell) return `${shell[1].trim()} run`;
  if (/^[A-Z][A-Z0-9]+(_[A-Z0-9]+)+$/.test(slug)) {
    // Any other TOOL_SLUG: first token as the service name, verb-ish tail.
    const service = slug.split('_')[0].toLowerCase();
    return `${service.charAt(0).toUpperCase()}${service.slice(1)} updated`;
  }
  return slug || 'External update';
}

/** A `workflow-slug::step` machine ask reads as "workflow workflow-slug". */
function humanizeWhy(why: string): string {
  const m = why.trim().match(/^([a-z0-9][a-z0-9-]{2,})::[a-z0-9_-]+$/i);
  return m ? `workflow ${m[1]}` : why;
}

function groupTitle(rep: DeliverableRecord, members: DeliverableRecord[]): string {
  if (rep.kind === 'file') {
    const parts = rep.target.split('/').filter(Boolean);
    const base = parts.pop() ?? rep.target;
    // "myatt-bell-brief · index.html" reads as the work; a bare index.html
    // does not (three of them side by side on the live shelf). Skip generic
    // structural dirs (research/view/dist/…) so the name that survives is the
    // one a human would use for the project.
    let parent = parts.pop();
    while (parent && /^(users|home|tmp|desktop|documents|research|view|views|dist|build|out|public|src|output)$/i.test(parent)) {
      parent = parts.pop();
    }
    const name = parent ? `${parent} · ${base}` : base;
    return name.length > 64 ? `${name.slice(0, 61)}…` : name;
  }
  if (rep.kind === 'url') {
    try {
      const u = new URL(rep.target);
      if (u.hostname.includes('docs.google.com')) return 'Google Sheet';
      return u.hostname.replace(/^www\./, '');
    } catch { return rep.target.slice(0, 64); }
  }
  const human = humanizeExternalTitle(rep);
  // Several external writes in one piece of work stay ONE card.
  return members.length > 1 && rep.kind !== 'file' ? human : human;
}

/**
 * The Delivered shelf's real unit: a piece of FINISHED WORK, not an artifact.
 * Raw rows are per-file / per-external-call (the tee writes one row per sheet
 * call — the live shelf showed six GOOGLESHEETS_* slug cards from one edit).
 * Groups collapse rows by originating session (fallback: target), pick a
 * document-shaped representative over scripts/data, humanize tool slugs, and
 * mark which groups are re-runnable asks.
 */
export function listDeliveredGroups(limit = 12): DeliveredGroup[] {
  try {
    const rows = listRecentDeliverables(100);
    const byKey = new Map<string, DeliverableRecord[]>();
    for (const row of rows) {
      // One piece of work = one card. Guest-run files carry no sessionId but
      // share their producing ask verbatim — the ask is the work's identity
      // (live: one /build-brief run rendered as three sibling file cards).
      const key = row.sessionId?.trim() || (row.why.trim() ? `why:${row.why.trim()}` : `target:${row.target}`);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(row);
      else byKey.set(key, [row]);
    }
    const groups: DeliveredGroup[] = [];
    for (const members of byKey.values()) {
      // Representative: url > primary document (html/pdf beat notes/data —
      // the brief's face is index.html, not its research homepage.md) > any
      // document > any file > external write.
      const url = members.find((m) => m.kind === 'url' || m.target.startsWith('http'));
      const docs = members.filter((m) => m.kind === 'file' && DOCUMENT_RE.test(m.target) && !SCRIPT_OR_DATA_RE.test(m.target));
      const doc = docs.find((m) => /\.(html?|pdf)$/i.test(m.target)) ?? docs[0];
      const anyFile = members.find((m) => m.kind === 'file');
      const rep = doc ?? url ?? anyFile ?? members[0];
      const file = doc ?? (rep.kind === 'file' ? rep : undefined);
      const lane = rep.lane;
      groups.push({
        id: rep.id,
        createdAt: members[0].createdAt, // newest member leads
        title: groupTitle(rep, members),
        why: humanizeWhy(rep.why),
        lane,
        sessionId: rep.sessionId,
        ...(url ? { url: url.target } : {}),
        ...(file ? { filePath: file.target, fileStillExists: existsSync(file.target) } : {}),
        artifactCount: members.length,
        rerunnable: lane === 'guest' || lane === 'local',
      });
    }
    groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return groups.slice(0, Math.max(1, Math.min(limit, 50)));
  } catch {
    return [];
  }
}

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


/** Deterministic "known artifacts" block for planning surfaces (live
 *  2026-07-24: the planner asked "where is the banked research stored?" while
 *  this ledger held the research files, the target sheet URL, and the
 *  template — every question it asked). Bounded, best-effort, no model call.
 *  The consuming prompt's rubric forbids asking the user for anything
 *  answered here. */
export function deliverableContextBlock(objective: string): string {
  try {
    const hits = searchDeliverables(objective).slice(0, 5);
    if (hits.length === 0) return '';
    const lines = hits.map((h) => `- ${renderDeliverableHit(h)}`.slice(0, 260));
    return [
      'KNOWN ARTIFACTS (from the deliverable ledger — work already produced and where it lives).',
      'Check here FIRST: never ask the user where prior work, research, sheets, or templates are if this list answers it. Reference these directly in the plan.',
      ...lines,
    ].join('\n');
  } catch {
    return '';
  }
}
