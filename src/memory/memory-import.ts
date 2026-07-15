/**
 * Memory Import — ingest OTHER agents' memory files into Clementine's store.
 *
 * The user points Clementine at a local folder or file (a Claude Code project
 * memory dir, an OpenClaw/Fermis store, a bare memory.md / agent.md — any
 * shape), and the pipeline normalizes it into ordinary consolidated facts:
 * provenance-tagged, deduped by rememberFact's content-hash idempotency,
 * picked up by the embedding backfill, and immediately reachable through
 * hybrid semantic recall. Source formats are unknowable in advance, so the
 * pipeline is shape-tolerant:
 *
 *   - STRUCTURED markdown (frontmatter with name/description, e.g. Claude
 *     Code memories) parses deterministically — no model call needed.
 *   - FREEFORM text is distilled by a small extraction agent (same
 *     grammar-constrained pattern as the reflection extractor); when the
 *     model is unavailable the fallback is deterministic bullet/paragraph
 *     harvesting, so import NEVER hard-depends on a live brain.
 *
 * Every run writes a batch record under state/memory-imports/ listing the
 * fact ids it ADDED (not ones that deduped onto pre-existing facts), so a
 * batch is undoable without touching native memory. Nothing here auto-runs:
 * discovery only PROPOSES sources; ingestion is user-initiated.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import pino from 'pino';
import { BASE_DIR, MODELS } from '../config.js';
import { embedMissingFacts, isEmbeddingsEnabled } from './embeddings.js';
import { deleteFact } from './facts.js';
import type { ConsolidatedFactKind } from './db.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { consolidateFact } from './reflection.js';
import { recordMemoryEpisode, selectSupportingExcerpt } from './temporal-memory.js';

const logger = pino({ name: 'clementine-next.memory.import' });

const IMPORTS_DIR = path.join(BASE_DIR, 'state', 'memory-imports');

// Bounded walk: memory stores are text; anything huge or binary is not a
// memory file. Caps keep a mispointed root (e.g. ~/) from exploding the scan.
const IMPORTABLE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MAX_WALK_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv', '.venv']);

export interface ImportCandidateFile {
  path: string;
  bytes: number;
  mtime: string;
  /** structured_md = frontmatter with name/description → deterministic parse. */
  shape: 'structured_md' | 'freeform';
  preview: string;
}

export interface ImportScanResult {
  root: string;
  files: ImportCandidateFile[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface MemoryImportBatch {
  id: string;
  root: string;
  sourceLabel: string;
  startedAt: string;
  finishedAt: string;
  fileCount: number;
  /** Fact ids CREATED by this batch (safe to undo). */
  newFactIds: number[];
  /** Facts that already existed (content-hash dedup) — never undone. */
  dedupedCount: number;
  distilledFiles: number;
  deterministicFiles: number;
  fallbackFiles: number;
  errors: Array<{ path: string; error: string }>;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function frontmatterOf(text: string): { meta: Record<string, string>; body: string } | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) meta[key] = value;
  }
  return { meta, body: text.slice(end + 4).trim() };
}

/** Map a foreign store's type/tag vocabulary onto Clementine's fact kinds. */
function kindFromForeignType(raw: string | undefined): ConsolidatedFactKind {
  const t = (raw ?? '').toLowerCase();
  if (/user|identity|person|preference/.test(t)) return 'user';
  if (/feedback|correction|rule|guideline|instruction/.test(t)) return 'feedback';
  if (/constraint|binding|policy/.test(t)) return 'constraint';
  if (/project|goal|task|work/.test(t)) return 'project';
  return 'reference';
}

// ─── Scan ────────────────────────────────────────────────────────────────────

export function scanMemorySource(rootInput: string): ImportScanResult {
  const root = path.resolve(expandHome(rootInput.trim()));
  const files: ImportCandidateFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const consider = (p: string): void => {
    if (files.length >= MAX_FILES) { skipped.push({ path: p, reason: 'file cap reached' }); return; }
    const ext = path.extname(p).toLowerCase();
    if (!IMPORTABLE_EXTENSIONS.has(ext)) { skipped.push({ path: p, reason: `unsupported extension ${ext || '(none)'}` }); return; }
    let st;
    try { st = statSync(p); } catch { skipped.push({ path: p, reason: 'unreadable' }); return; }
    if (st.size === 0) { skipped.push({ path: p, reason: 'empty' }); return; }
    if (st.size > MAX_FILE_BYTES) { skipped.push({ path: p, reason: `too large (${Math.round(st.size / 1024)}KB)` }); return; }
    let text = '';
    try { text = readFileSync(p, 'utf-8'); } catch { skipped.push({ path: p, reason: 'unreadable' }); return; }
    const fm = frontmatterOf(text);
    files.push({
      path: p,
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      shape: fm && (fm.meta.description || fm.meta.name) ? 'structured_md' : 'freeform',
      preview: (fm?.meta.description || text.replace(/^---[\s\S]*?\n---/, '').trim()).slice(0, 280),
    });
  };

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || files.length >= MAX_FILES) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { skipped.push({ path: dir, reason: 'unreadable directory' }); return; }
    for (const entry of entries.sort()) {
      if (entry.startsWith('.') && entry !== '.claude') continue;
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full, depth + 1);
      } else if (st.isFile()) {
        consider(full);
      }
    }
  };

  const st = existsSync(root) ? statSync(root) : null;
  if (!st) return { root, files: [], skipped: [{ path: root, reason: 'path does not exist' }] };
  if (st.isFile()) consider(root); else walk(root, 0);
  return { root, files, skipped };
}

// ─── Discovery (propose, never auto-import) ─────────────────────────────────

export interface DiscoveredMemorySource { path: string; label: string; fileCount: number }

/** Well-known local agent-memory locations. Existence-checked at call time —
 *  this proposes candidates for the user to review; it never ingests. */
export function discoverKnownMemorySources(): DiscoveredMemorySource[] {
  const home = os.homedir();
  const out: DiscoveredMemorySource[] = [];
  const propose = (p: string, label: string): void => {
    try {
      if (!existsSync(p)) return;
      const st = statSync(p);
      const count = st.isFile() ? 1 : scanMemorySource(p).files.length;
      if (count > 0) out.push({ path: p, label, fileCount: count });
    } catch { /* discovery is best-effort */ }
  };
  // Claude Code project memories (one dir per project).
  const claudeProjects = path.join(home, '.claude', 'projects');
  try {
    if (existsSync(claudeProjects)) {
      for (const entry of readdirSync(claudeProjects).sort()) {
        const memDir = path.join(claudeProjects, entry, 'memory');
        if (existsSync(memDir)) propose(memDir, `Claude Code memory · ${entry}`);
      }
    }
  } catch { /* best-effort */ }
  propose(path.join(home, '.claude', 'CLAUDE.md'), 'Claude Code global CLAUDE.md');
  propose(path.join(home, '.codex', 'AGENTS.md'), 'Codex global AGENTS.md');
  propose(path.join(home, '.config', 'opencode', 'memory'), 'OpenCode memory');
  return out;
}

// ─── Distillation ────────────────────────────────────────────────────────────

const DISTILL_MAX_FACTS_PER_FILE = 40;
const FACT_MAX_CHARS = 500;

const DistillSchema = z.object({
  facts: z.array(z.object({
    kind: z.enum(['user', 'project', 'feedback', 'reference', 'constraint']),
    content: z.string().min(8).max(FACT_MAX_CHARS),
    importance: z.number().min(1).max(10).nullable().optional(),
  })).max(DISTILL_MAX_FACTS_PER_FILE),
});

const DISTILL_INSTRUCTIONS = [
  'You are a memory-import distiller. The input is ONE memory/config file from ANOTHER AI agent\'s memory system (unknown format).',
  'Extract the DURABLE facts worth remembering long-term: who the user is, standing preferences/rules, project state and goals, external references.',
  `Each fact: self-contained (readable with zero surrounding context), ≤${FACT_MAX_CHARS} chars, classified as user | project | feedback | constraint | reference.`,
  'DO NOT extract: ephemeral state, timestamps/ids, formatting/boilerplate, tool syntax, anything about the OTHER agent\'s own mechanics unless it encodes a user preference.',
  'DO NOT invent. Empty/noise input → empty facts array.',
  'Return ONLY JSON: {"facts":[{"kind":"user|project|feedback|reference|constraint","content":"...","importance":1-10|null}]}',
].join('\n');

type DistilledImportFact = z.infer<typeof DistillSchema>['facts'][number];

function parseDistillerJson(value: unknown): unknown | null {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const candidate = extractJsonCandidate(value);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function normalizeDistilledKind(value: unknown): ConsolidatedFactKind {
  const raw = String(value ?? '').trim().toLowerCase();
  if (/^users?$|identity|profile|preference|person/.test(raw)) return 'user';
  if (/^projects?$|task|goal|work|workspace/.test(raw)) return 'project';
  if (/feedback|correction|instruction|guideline|rule/.test(raw)) return 'feedback';
  if (/constraint|policy|limit|requirement|must|never/.test(raw)) return 'constraint';
  return 'reference';
}

function stringField(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  }
  return '';
}

function sanitizeDistillerOutput(value: unknown): DistilledImportFact[] | null {
  const parsed = parseDistillerJson(value);
  if (parsed == null) return null;
  const container = parsed as { facts?: unknown; memories?: unknown; items?: unknown; data?: unknown };
  const rawFacts =
    Array.isArray(parsed) ? parsed
      : Array.isArray(container.facts) ? container.facts
        : Array.isArray(container.memories) ? container.memories
          : Array.isArray(container.items) ? container.items
            : Array.isArray(container.data) ? container.data
              : container.facts === null ? []
                : null;
  if (!Array.isArray(rawFacts)) return null;

  const facts: DistilledImportFact[] = [];
  for (const raw of rawFacts) {
    if (facts.length >= DISTILL_MAX_FACTS_PER_FILE) break;
    let content = '';
    let kind: ConsolidatedFactKind = 'reference';
    let importance: number | null | undefined;

    if (typeof raw === 'string') {
      content = raw.replace(/\s+/g, ' ').trim();
    } else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      content = stringField(obj, ['content', 'fact', 'text', 'summary', 'memory', 'statement', 'value']);
      kind = normalizeDistilledKind(obj.kind ?? obj.type ?? obj.category);
      const n = typeof obj.importance === 'number'
        ? obj.importance
        : typeof obj.importance === 'string'
          ? Number.parseFloat(obj.importance)
          : typeof obj.score === 'number'
            ? obj.score
            : typeof obj.score === 'string'
              ? Number.parseFloat(obj.score)
              : NaN;
      importance = Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null;
    }

    if (content.length < 8) continue;
    facts.push({
      kind,
      content: content.slice(0, FACT_MAX_CHARS),
      importance,
    });
  }
  return facts;
}

export function _testOnly_sanitizeDistillerOutput(value: unknown): DistilledImportFact[] | null {
  return sanitizeDistillerOutput(value);
}

async function distillFile(text: string, filePath: string): Promise<DistilledImportFact[] | null> {
  try {
    const agent = new Agent({
      name: 'Memory Import Distiller',
      model: MODELS.fast || MODELS.primary || 'gpt-5.4-mini',
      instructions: DISTILL_INSTRUCTIONS,
    });
    const runner = new Runner({ workflowName: 'clementine-memory-import' });
    const input = `FILE: ${path.basename(filePath)}\n\n${text.slice(0, 24_000)}`;
    const result = await runner.run(agent, input);
    const final = (result as { finalOutput?: unknown }).finalOutput;
    return sanitizeDistillerOutput(final);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), file: filePath }, 'memory-import distiller failed — falling back to deterministic harvest');
    return null;
  }
}

/** Model-free fallback: harvest substantial bullets/paragraphs as reference facts. */
function harvestDeterministic(text: string): Array<{ kind: ConsolidatedFactKind; content: string }> {
  const body = text.replace(/^---[\s\S]*?\n---/, '').trim();
  const out: Array<{ kind: ConsolidatedFactKind; content: string }> = [];
  const push = (s: string): void => {
    const clean = s.replace(/\s+/g, ' ').trim();
    if (clean.length >= 24 && clean.length <= FACT_MAX_CHARS && out.length < 30) out.push({ kind: 'reference', content: clean });
  };
  for (const line of body.split('\n')) {
    const m = /^[ \t]*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (m) push(m[1]);
  }
  if (out.length === 0) {
    for (const para of body.split(/\n{2,}/).slice(0, 20)) push(para);
  }
  return out;
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

export async function ingestMemorySource(
  rootInput: string,
  options: { files?: string[]; sourceLabel?: string; distill?: boolean } = {},
): Promise<MemoryImportBatch> {
  const scan = scanMemorySource(rootInput);
  const selected = options.files?.length
    ? scan.files.filter((f) => options.files!.includes(f.path))
    : scan.files;
  const batchId = `mi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();
  const sourceLabel = options.sourceLabel?.trim() || path.basename(scan.root);
  const sourceApp = `import:${sourceLabel}`;
  const distillEnabled = options.distill !== false;

  const newFactIds: number[] = [];
  let dedupedCount = 0;
  let distilledFiles = 0;
  let deterministicFiles = 0;
  let fallbackFiles = 0;
  const errors: Array<{ path: string; error: string }> = [];

  const remember = async (
    kind: ConsolidatedFactKind,
    content: string,
    filePath: string,
    occurredAt: string,
    sourceText: string,
    importance?: number | null,
  ): Promise<void> => {
    // Imported claims are derived from a foreign file. Persist an excerpt
    // copied from that file before consolidation so the durable evidence is
    // the source passage—not the distiller's rewritten claim. One file can
    // yield several bounded excerpt episodes; recordMemoryEpisode dedupes
    // identical passages on re-import.
    const excerpt = selectSupportingExcerpt(sourceText, content);
    const episode = recordMemoryEpisode({
      kind: 'import',
      subtype: 'memory_import',
      title: path.basename(filePath),
      metadata: { batchId, sourceLabel },
      sourceApp,
      sourceUri: filePath,
      occurredAt,
      content: excerpt,
      status: excerpt ? 'available' : 'missing',
    });
    const outcome = await consolidateFact({
      kind,
      text: content.slice(0, FACT_MAX_CHARS),
      sourceUri: filePath,
      occurredAt,
      sourceApp,
      trustLevel: 0.75, // imported, not user-stated in THIS conversation
      authority: 'import',
      importance: typeof importance === 'number' ? Math.max(1, Math.min(10, importance)) : 4,
      evidence: excerpt ? { episodeId: episode.id, excerpt, sourceUri: filePath } : undefined,
    }, {}, {
      // Imports are additive unless they exactly reinforce a canonical claim;
      // speculative semantic replacement requires an explicit later review.
      resolver: async () => ({ decision: 'ADD' }),
    });
    if (outcome.action === 'add' && outcome.factId) newFactIds.push(outcome.factId);
    else if (outcome.action === 'reinforce') dedupedCount += 1;
  };

  for (const file of selected) {
    try {
      const text = readFileSync(file.path, 'utf-8');
      const fm = frontmatterOf(text);
      if (file.shape === 'structured_md' && fm) {
        // Deterministic: the file's own name/description is the headline fact.
        const name = fm.meta.name || path.basename(file.path, path.extname(file.path));
        const kind = kindFromForeignType(fm.meta.type ?? fm.meta.kind ?? fm.meta.category);
        if (fm.meta.description) await remember(kind, `[${name}] ${fm.meta.description}`, file.path, file.mtime, text);
        deterministicFiles += 1;
        // Body still carries detail worth distilling when it is substantial.
        if (distillEnabled && fm.body.length > 200) {
          const facts = await distillFile(fm.body, file.path);
          if (facts) { distilledFiles += 1; for (const f of facts) await remember(f.kind, f.content, file.path, file.mtime, text, f.importance); }
          else { fallbackFiles += 1; for (const f of harvestDeterministic(fm.body)) await remember(f.kind, f.content, file.path, file.mtime, text); }
        }
      } else {
        const facts = distillEnabled ? await distillFile(text, file.path) : null;
        if (facts) { distilledFiles += 1; for (const f of facts) await remember(f.kind, f.content, file.path, file.mtime, text, f.importance); }
        else { fallbackFiles += 1; for (const f of harvestDeterministic(text)) await remember(f.kind, f.content, file.path, file.mtime, text); }
      }
    } catch (err) {
      errors.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const batch: MemoryImportBatch = {
    id: batchId,
    root: scan.root,
    sourceLabel,
    startedAt,
    finishedAt: new Date().toISOString(),
    fileCount: selected.length,
    newFactIds,
    dedupedCount,
    distilledFiles,
    deterministicFiles,
    fallbackFiles,
    errors,
  };
  try {
    mkdirSync(IMPORTS_DIR, { recursive: true });
    writeFileSync(path.join(IMPORTS_DIR, `${batchId}.json`), JSON.stringify(batch, null, 2), 'utf-8');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'memory-import batch record write failed (facts are stored; undo unavailable for this batch)');
  }
  // Kick the embedding pass NOW (fire-and-forget) so imported facts become
  // semantically searchable immediately instead of waiting for the next
  // maintenance tick. The tick remains the safety net if this pass fails.
  if (newFactIds.length > 0 && isEmbeddingsEnabled()) {
    void embedMissingFacts({ newestFirst: true }).then(
      (stats) => logger.info({ batchId, embedded: stats.embedded, failed: stats.failed }, 'memory import: embedding pass done'),
      (err: unknown) => logger.warn({ batchId, err: err instanceof Error ? err.message : String(err) }, 'memory import: embedding pass failed (maintenance tick will retry)'),
    );
  }
  logger.info(
    { batchId, root: scan.root, files: selected.length, newFacts: newFactIds.length, deduped: dedupedCount, distilled: distilledFiles, fallback: fallbackFiles, errors: errors.length },
    'memory import completed — new facts enter hybrid recall as the embedding backfill picks them up',
  );
  return batch;
}

// ─── Batches + undo ──────────────────────────────────────────────────────────

export function listMemoryImportBatches(): MemoryImportBatch[] {
  try {
    if (!existsSync(IMPORTS_DIR)) return [];
    return readdirSync(IMPORTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(path.join(IMPORTS_DIR, f), 'utf-8')) as MemoryImportBatch)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

export function undoMemoryImportBatch(batchId: string): { deleted: number; batch: MemoryImportBatch | null } {
  const file = path.join(IMPORTS_DIR, `${path.basename(batchId)}.json`);
  if (!existsSync(file)) return { deleted: 0, batch: null };
  const batch = JSON.parse(readFileSync(file, 'utf-8')) as MemoryImportBatch;
  let deleted = 0;
  for (const id of batch.newFactIds) {
    try { if (deleteFact(id)) deleted += 1; } catch { /* keep going — undo is best-effort per fact */ }
  }
  try { rmSync(file, { force: true }); } catch { /* record removal is cosmetic */ }
  logger.info({ batchId: batch.id, deleted }, 'memory import batch undone');
  return { deleted, batch };
}
