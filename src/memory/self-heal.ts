import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { Agent, run } from '@openai/agents';
import { BASE_DIR, MODELS, getRuntimeEnv } from '../config.js';
import {
  backupMemoryDb,
  openMemoryDb,
  type ConsolidatedFactKind,
  type ConsolidatedFactRow,
} from './db.js';
import { loadFactEmbeddings, cosine } from './embeddings.js';
import { canMergeEntitySafe, extractAnchors } from './memory-merge.js';
import { appendHygieneAudit, readHygieneAudit, type HygieneAuditEntry } from './hygiene-audit.js';
import { readFactRecallTrace, type FactRecallSurface } from './recall-trace.js';
import { isSelfReferentialTool } from './reflection.js';
import { looksLikeTransientRequest } from './memory-quality.js';

const logger = pino({ name: 'clementine-next.memory.self-heal' });

export type MemoryFixKind = 'merge_duplicate' | 'retire_internal_noise' | 'retire_transient_request' | 'lift_recall_gap' | 'demote_overexposed_fact' | 'supersede_stale_fact';
export type MemoryFixStatus = 'pending' | 'applied' | 'skipped' | 'reverted';
export type MemoryFixConfidence = 'high' | 'medium' | 'low';

export interface MergeDuplicatePayload {
  keepId: number;
  dropId: number;
  similarity: number;
}

export interface SingleFactPayload {
  id: number;
}

export interface LiftRecallGapPayload {
  id: number;
  priorImportance: number;
  newImportance: number;
}

export interface DemoteOverexposedFactPayload {
  id: number;
  priorImportance: number;
  newImportance: number;
  exposureCount: number;
  globalExposureCount: number;
  surfaces: FactRecallSurface[];
}

export interface SupersedeStaleFactPayload {
  staleId: number;
  replacementId: number;
  property: string;
  staleValue: string;
  replacementValue: string;
}

export type ProposedMemoryFixPayload =
  | MergeDuplicatePayload
  | SingleFactPayload
  | LiftRecallGapPayload
  | DemoteOverexposedFactPayload
  | SupersedeStaleFactPayload;

export interface ProposedMemoryFix {
  id: string;
  kind: MemoryFixKind;
  targetIds: number[];
  evidence: string;
  confidence: MemoryFixConfidence;
  autoApplicable: boolean;
  reversible: true;
  createdAt: string;
  signature: string;
  payload: ProposedMemoryFixPayload;
  status?: MemoryFixStatus;
  skipReason?: string;
  appliedAt?: string;
  auditId?: string;
}

export interface MemoryHealResult {
  ok: boolean;
  fixId: string;
  kind: MemoryFixKind;
  applied: number;
  ids: number[];
  auditId?: string;
  message: string;
  reason?: string;
}

export interface MemoryHealOutcome {
  ran: boolean;
  proposed: number;
  applied: number;
  skipped: Array<{ id: string; kind: MemoryFixKind; reason: string }>;
  results: MemoryHealResult[];
  dryRun: boolean;
  reason?: 'disabled' | 'real-disabled' | 'max-zero';
}

interface CandidateOptions {
  maxCandidates?: number;
  nowIso?: string;
  persistProposals?: boolean;
  /** Restrict detection to the requested fix families. Review surfaces use
   * this to prevent unrelated automatic hygiene candidates from consuming the
   * shared cap before human-review candidates are even considered. */
  kinds?: MemoryFixKind[];
}

interface ApplyOptions {
  dryRun?: boolean;
  nowIso?: string;
  judge?: MemoryFixJudge;
  /** Exact candidate pair was shown to the owner and explicitly approved.
   * Server-side probes still revalidate every invariant; this replaces only
   * the probabilistic model veto so an offline/local-first install can honor a
   * deliberate review decision. Never set this from unattended maintenance. */
  humanApproved?: boolean;
}

interface RunOptions extends CandidateOptions {
  dryRun?: boolean;
  maxApply?: number;
  judge?: MemoryFixJudge;
}

type MemoryFixJudge = (fix: ProposedMemoryFix) => Promise<{ verdict: 'approve' | 'veto' | 'unavailable'; reason?: string }>;

interface StoredProposalFile {
  proposals: ProposedMemoryFix[];
}

interface FactSnapshot {
  id: number;
  active: number;
  score: number;
  importance: number | null;
  trust_level: number | null;
  confidence: number | null;
  access_count: number;
  impression_count: number;
  utility_count: number;
  source_app: string | null;
  last_accessed_at: string | null;
  last_used_at: string | null;
  updated_at: string;
  valid_from: string | null;
  valid_to: string | null;
  superseded_by_fact_id: number | null;
}

interface FactEvidenceTransferRow {
  fact_id: number;
  episode_id: string;
  excerpt: string;
  source_uri: string | null;
  ordinal: number;
  created_at: string;
}

interface FactLinkTransferRow {
  fact_id: number;
  linked_id: number;
  created_at: string;
  link_type: 'stored' | 'extracted' | 'inferred_text';
  confidence: number;
  evidence_episode_id: string | null;
  evidence_excerpt: string | null;
}

interface FactLinkTransferDelta {
  linkedId: number;
  before: FactLinkTransferRow | null;
  applied: FactLinkTransferRow;
}

/** Exact relational delta produced by a reviewed duplicate merge. Keeping the
 * applied row beside the prior row lets revert use compare-and-swap semantics:
 * later evidence is never overwritten merely because an old merge is undone. */
interface DuplicateFactMergeTransfer {
  keepId: number;
  dropId: number;
  evidenceAdded: FactEvidenceTransferRow[];
  entityLinks: FactLinkTransferDelta[];
  resourceLinks: FactLinkTransferDelta[];
}

const STORE_DIR = path.join(BASE_DIR, 'state', 'memory-self-heal');
const STORE_FILE = path.join(STORE_DIR, 'proposals.json');
const DEFAULT_MAX_CANDIDATES = 50;
const DEFAULT_MAX_APPLY = 10;
const MERGE_SIMILARITY_THRESHOLD = 0.97;
const MAX_JUDGED_TEXT = 1000;
const TRACE_RECALL_LIMIT = 1000;
const OVEREXPOSED_MIN_EXPOSURES = 8;
const OVEREXPOSED_MIN_GLOBAL_EXPOSURES = 4;

export function memorySelfHealEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_MEMORY_SELF_HEAL', 'on') || 'on').toLowerCase() !== 'off';
}

export function memorySelfHealRealEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_MEMORY_SELF_HEAL_REAL', 'on') || 'on').toLowerCase() !== 'off';
}

export function memorySelfHealJudgeRequired(): boolean {
  return (getRuntimeEnv('CLEMMY_MEMORY_SELF_HEAL_JUDGE', 'on') || 'on').toLowerCase() !== 'off';
}

function configuredMaxApply(maxApply?: number): number {
  if (typeof maxApply === 'number' && Number.isFinite(maxApply)) return Math.max(0, Math.min(100, Math.floor(maxApply)));
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_MEMORY_SELF_HEAL_MAX', String(DEFAULT_MAX_APPLY)) || String(DEFAULT_MAX_APPLY), 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : DEFAULT_MAX_APPLY;
}

function stableId(kind: MemoryFixKind, signature: string): string {
  return createHash('sha1').update(`${kind}:${signature}`).digest('hex').slice(0, 12);
}

function auditId(fix: ProposedMemoryFix, nowIso: string): string {
  return `mh-${createHash('sha1').update(`${fix.id}:${nowIso}:${fix.signature}`).digest('hex').slice(0, 12)}`;
}

function rowById(id: number): ConsolidatedFactRow | null {
  const db = openMemoryDb();
  return (db.prepare('SELECT * FROM consolidated_facts WHERE id = ?').get(id) as ConsolidatedFactRow | undefined) ?? null;
}

function snapshotRows(ids: number[]): FactSnapshot[] {
  if (ids.length === 0) return [];
  const db = openMemoryDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, active, score, importance, trust_level, confidence,
            access_count, impression_count, utility_count,
            source_app, last_accessed_at, last_used_at, updated_at,
            valid_from, valid_to, superseded_by_fact_id
     FROM consolidated_facts WHERE id IN (${placeholders})`,
  ).all(...ids) as FactSnapshot[];
  return rows;
}

function truncate(s: string, n = 120): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n)}...` : clean;
}

function factQuality(row: ConsolidatedFactRow): number {
  return (row.score ?? 0)
    + (row.importance ?? 5) / 10
    // Canonical selection is a ranking decision too. `access_count` is legacy
    // exposure telemetry and includes automatic prompt impressions; using it
    // here would let passive display decide which duplicate survives. Only an
    // explicit material-use signal may reinforce the canonical candidate.
    + Math.log(1 + (row.utility_count ?? 0)) / 10
    + (row.trust_level ?? 0.6);
}

function proposal(p: Omit<ProposedMemoryFix, 'id' | 'createdAt' | 'reversible' | 'status'>, nowIso: string): ProposedMemoryFix {
  return {
    ...p,
    id: stableId(p.kind, p.signature),
    createdAt: nowIso,
    reversible: true,
    status: 'pending',
  };
}

function readProposalFile(): StoredProposalFile {
  try {
    if (!existsSync(STORE_FILE)) return { proposals: [] };
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as StoredProposalFile;
    return { proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [] };
  } catch {
    return { proposals: [] };
  }
}

function writeProposalFile(file: StoredProposalFile): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify({ proposals: file.proposals.slice(-1000) }, null, 2), 'utf-8');
}

function upsertProposals(proposals: ProposedMemoryFix[]): ProposedMemoryFix[] {
  if (proposals.length === 0) return [];
  const file = readProposalFile();
  const byId = new Map(file.proposals.map((p) => [p.id, p]));
  for (const p of proposals) {
    const existing = byId.get(p.id);
    byId.set(p.id, existing && existing.status !== 'pending' ? { ...p, status: existing.status, appliedAt: existing.appliedAt, auditId: existing.auditId, skipReason: existing.skipReason } : p);
  }
  writeProposalFile({ proposals: [...byId.values()] });
  return proposals.map((p) => byId.get(p.id) ?? p);
}

function updateStoredProposal(id: string, patch: Partial<ProposedMemoryFix>): void {
  const file = readProposalFile();
  let changed = false;
  const proposals = file.proposals.map((p) => {
    if (p.id !== id) return p;
    changed = true;
    return { ...p, ...patch };
  });
  if (changed) writeProposalFile({ proposals });
}

export function listProposedMemoryFixes(): ProposedMemoryFix[] {
  return readProposalFile().proposals;
}

/** Keep a review-only proposal from resurfacing without mutating its facts. */
export function dismissMemoryFix(id: string, reason = 'kept as a fact by user'): boolean {
  const proposal = loadProposedMemoryFix(id);
  if (!proposal) return false;
  updateStoredProposal(id, { status: 'skipped', skipReason: reason });
  return true;
}

function loadProposedMemoryFix(id: string): ProposedMemoryFix | null {
  return readProposalFile().proposals.find((p) => p.id === id) ?? null;
}

function detectMergeDuplicates(nowIso: string, cap: number): ProposedMemoryFix[] {
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT * FROM consolidated_facts
     WHERE active = 1 AND pinned = 0
     ORDER BY COALESCE(importance, 5) DESC, updated_at DESC`,
  ).all() as ConsolidatedFactRow[];
  const vectors = loadFactEmbeddings(rows.map((r) => r.id));
  const embedded = rows.filter((r) => vectors.has(r.id));
  const anchors = new Map<number, ReturnType<typeof extractAnchors>>();
  for (const row of embedded) anchors.set(row.id, extractAnchors(row));
  const byKind = new Map<ConsolidatedFactKind, ConsolidatedFactRow[]>();
  for (const row of embedded) {
    const arr = byKind.get(row.kind) ?? [];
    arr.push(row);
    byKind.set(row.kind, arr);
  }

  const out: ProposedMemoryFix[] = [];
  const alreadyDropping = new Set<number>();
  for (const kindRows of byKind.values()) {
    for (let i = 0; i < kindRows.length; i += 1) {
      const a = kindRows[i];
      if (alreadyDropping.has(a.id)) continue;
      const va = vectors.get(a.id);
      if (!va) continue;
      for (let j = i + 1; j < kindRows.length; j += 1) {
        const b = kindRows[j];
        if (alreadyDropping.has(b.id)) continue;
        const vb = vectors.get(b.id);
        if (!vb) continue;
        const sim = cosine(va, vb);
        if (sim < MERGE_SIMILARITY_THRESHOLD) continue;
        if (!canMergeEntitySafe(anchors.get(a.id)!, anchors.get(b.id)!)) continue;
        const keep = factQuality(a) >= factQuality(b) ? a : b;
        const drop = keep.id === a.id ? b : a;
        const similarity = Math.round(sim * 10000) / 10000;
        alreadyDropping.add(drop.id);
        out.push(proposal({
          kind: 'merge_duplicate',
          targetIds: [keep.id, drop.id],
          evidence: `cosine=${similarity}; same kind=${keep.kind}; entity anchors compatible; keep #${keep.id} "${truncate(keep.content)}"; drop #${drop.id} "${truncate(drop.content)}"`,
          confidence: 'high',
          autoApplicable: true,
          signature: `merge:${keep.id}:${drop.id}:${similarity}`,
          payload: { keepId: keep.id, dropId: drop.id, similarity },
        }, nowIso));
        if (out.length >= cap) return out;
        break;
      }
    }
  }
  return out;
}

function detectInternalNoise(nowIso: string, cap: number): ProposedMemoryFix[] {
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT * FROM consolidated_facts
     WHERE active = 1 AND pinned = 0 AND derived_from_tool IS NOT NULL
     ORDER BY id ASC`,
  ).all() as ConsolidatedFactRow[];
  return rows
    .filter((r) => isSelfReferentialTool(r.derived_from_tool))
    .slice(0, cap)
    .map((row) => proposal({
      kind: 'retire_internal_noise',
      targetIds: [row.id],
      evidence: `derived_from_tool=${row.derived_from_tool}; content="${truncate(row.content)}"`,
      confidence: 'high',
      autoApplicable: true,
      signature: `retire-internal:${row.id}:${row.derived_from_tool ?? 'unknown'}`,
      payload: { id: row.id },
    }, nowIso));
}

/**
 * Conservative detector for legacy chat turns that were promoted verbatim as
 * direct facts. It only feeds a human review queue; matching text is never
 * retired by the scheduled self-heal runner.
 */
export const looksLikeLegacyTransientRequest = looksLikeTransientRequest;

function detectTransientRequests(nowIso: string, cap: number): ProposedMemoryFix[] {
  if (cap <= 0) return [];
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT * FROM consolidated_facts
     WHERE active = 1 AND pinned = 0 AND kind != 'constraint'
       AND derived_from_call_id IS NULL
       AND derived_from_session_id IS NULL
       AND derived_from_tool IS NULL
     ORDER BY id ASC`,
  ).all() as ConsolidatedFactRow[];
  return rows
    .filter((row) => looksLikeLegacyTransientRequest(row.content))
    .slice(0, cap)
    .map((row) => proposal({
      kind: 'retire_transient_request',
      targetIds: [row.id],
      evidence: `direct fact resembles a conversational request; content="${truncate(row.content)}"`,
      confidence: 'medium',
      // Explicit review applies through applyMemoryFix. The scheduled runner
      // separately refuses this kind, so text shape is never deletion authority.
      autoApplicable: true,
      signature: `retire-transient-request:${row.id}:${row.content_hash}`,
      payload: { id: row.id },
    }, nowIso));
}

interface RecallExposureSummary {
  total: number;
  global: number;
  surfaces: Set<FactRecallSurface>;
}

const AUTOMATIC_RECALL_SURFACES = new Set<FactRecallSurface>([
  'facts_for_instructions',
  'harness_query_recall',
  'turn_memory_primer',
]);

function summarizeTraceExposures(limit = TRACE_RECALL_LIMIT): Map<number, RecallExposureSummary> {
  const out = new Map<number, RecallExposureSummary>();
  for (const entry of readFactRecallTrace(limit)) {
    if (!AUTOMATIC_RECALL_SURFACES.has(entry.surface)) continue;
    const seenInEntry = new Set<number>();
    for (const traced of entry.facts) {
      if (seenInEntry.has(traced.id)) continue;
      seenInEntry.add(traced.id);
      if (traced.pinned) continue;
      const summary = out.get(traced.id) ?? { total: 0, global: 0, surfaces: new Set<FactRecallSurface>() };
      summary.total += 1;
      if (entry.surface === 'facts_for_instructions' && traced.reason === 'scored-stanford-global') {
        summary.global += 1;
      }
      summary.surfaces.add(entry.surface);
      out.set(traced.id, summary);
    }
  }
  return out;
}

function isDerivedOrLowerTrust(row: ConsolidatedFactRow): boolean {
  return Boolean(row.derived_from_call_id || row.derived_from_session_id || row.derived_from_tool)
    || (typeof row.trust_level === 'number' && row.trust_level < 0.8);
}

function detectOverexposedRecallFacts(nowIso: string, cap: number): ProposedMemoryFix[] {
  const summaries = summarizeTraceExposures();
  if (summaries.size === 0) return [];
  return [...summaries.entries()]
    .filter(([, summary]) => summary.total >= OVEREXPOSED_MIN_EXPOSURES && summary.global >= OVEREXPOSED_MIN_GLOBAL_EXPOSURES)
    .sort((a, b) => b[1].global - a[1].global || b[1].total - a[1].total || a[0] - b[0])
    .flatMap(([id, summary]) => {
      const row = rowById(id);
      if (!row || row.active !== 1 || row.pinned === 1 || row.kind === 'constraint') return [];
      const prior = typeof row.importance === 'number' ? row.importance : 5;
      if (prior <= 3 || prior > 5) return [];
      if (!isDerivedOrLowerTrust(row)) return [];
      const newImportance = Math.max(3, prior - 1);
      return [proposal({
        kind: 'demote_overexposed_fact',
        targetIds: [row.id],
        evidence: `recalled ${summary.total} times across automatic context surfaces (${summary.global} global instruction exposures); derived/lower-trust fact #${row.id}; content="${truncate(row.content)}"`,
        confidence: 'high',
        autoApplicable: true,
        signature: `demote-overexposed:${row.id}:${prior}`,
        payload: {
          id: row.id,
          priorImportance: prior,
          newImportance,
          exposureCount: summary.total,
          globalExposureCount: summary.global,
          surfaces: [...summary.surfaces].sort(),
        },
      }, nowIso)];
    })
    .slice(0, cap);
}

function detectRecallGaps(nowIso: string, cap: number): ProposedMemoryFix[] {
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT * FROM consolidated_facts
     WHERE active = 1 AND pinned = 0
       AND COALESCE(importance, 5) >= 7 AND COALESCE(importance, 5) < 10
       AND (last_accessed_at IS NULL OR last_accessed_at <= datetime(created_at, '+2 seconds'))
       AND julianday(?) - julianday(created_at) > 7
     ORDER BY COALESCE(importance, 5) DESC, id ASC
     LIMIT ?`,
  ).all(nowIso, cap) as ConsolidatedFactRow[];
  return rows.map((row) => {
    const prior = row.importance ?? 5;
    return proposal({
      kind: 'lift_recall_gap',
      targetIds: [row.id],
      evidence: `importance=${prior}; never recalled; older than 7 days; content="${truncate(row.content)}"`,
      confidence: 'high',
      autoApplicable: true,
      signature: `lift:${row.id}:${prior}`,
      payload: { id: row.id, priorImportance: prior, newImportance: Math.min(10, prior + 1) },
    }, nowIso);
  });
}

interface PreferenceParse {
  subject: string;
  property: string;
  value: string;
}

function normalizeEntityText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an|user|client)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function parsePreferenceFact(content: string): PreferenceParse | null {
  const text = content.replace(/\s+/g, ' ').trim();
  const patterns = [
    /^(?:actually|correction[:,]?)\s*(?<subject>[A-Z][A-Za-z0-9 &.'-]{1,80}?)\s+(?:now\s+)?prefers\s+(?<value>[^.!?]{2,120})[.!?]?$/i,
    /^(?<subject>[A-Z][A-Za-z0-9 &.'-]{1,80}?)\s+(?:now\s+)?prefers\s+(?<value>[^.!?]{2,120})[.!?]?$/i,
    /^(?<subject>[A-Z][A-Za-z0-9 &.'-]{1,80}?)\s+preference\s+is\s+(?<value>[^.!?]{2,120})[.!?]?$/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    const groups = match?.groups as { subject?: string; value?: string } | undefined;
    if (!groups?.subject || !groups.value) continue;
    return {
      subject: normalizeEntityText(groups.subject),
      property: 'preference',
      value: normalizeEntityText(groups.value),
    };
  }
  return null;
}

function detectStaleSupersessions(nowIso: string, cap: number): ProposedMemoryFix[] {
  const db = openMemoryDb();
  const rows = db.prepare(
    `SELECT * FROM consolidated_facts
     WHERE active = 1 AND pinned = 0
     ORDER BY created_at ASC`,
  ).all() as ConsolidatedFactRow[];
  const parsed = rows
    .map((row) => ({ row, parsed: parsePreferenceFact(row.content) }))
    .filter((x): x is { row: ConsolidatedFactRow; parsed: PreferenceParse } => Boolean(x.parsed));
  const out: ProposedMemoryFix[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const stale = parsed[i];
    for (let j = parsed.length - 1; j >= 0; j -= 1) {
      const newer = parsed[j];
      if (stale.row.id === newer.row.id) continue;
      if (stale.parsed.subject !== newer.parsed.subject) continue;
      if (stale.parsed.property !== newer.parsed.property) continue;
      if (stale.parsed.value === newer.parsed.value) continue;
      if (Date.parse(newer.row.created_at) <= Date.parse(stale.row.created_at)) continue;
      const staleTrust = stale.row.trust_level ?? 0.6;
      const newerTrust = newer.row.trust_level ?? 1;
      const newerDirect = !newer.row.derived_from_call_id && !newer.row.derived_from_tool;
      const staleDerived = Boolean(stale.row.derived_from_call_id || stale.row.derived_from_tool);
      if (!staleDerived || !newerDirect || newerTrust < staleTrust) continue;
      out.push(proposal({
        kind: 'supersede_stale_fact',
        targetIds: [stale.row.id, newer.row.id],
        evidence: `newer direct fact #${newer.row.id} supersedes older derived ${stale.parsed.property} fact #${stale.row.id}; old="${truncate(stale.row.content)}"; new="${truncate(newer.row.content)}"`,
        confidence: 'high',
        autoApplicable: true,
        signature: `supersede:${stale.row.id}:${newer.row.id}:${stale.parsed.property}`,
        payload: {
          staleId: stale.row.id,
          replacementId: newer.row.id,
          property: stale.parsed.property,
          staleValue: stale.parsed.value,
          replacementValue: newer.parsed.value,
        },
      }, nowIso));
      if (out.length >= cap) return out;
      break;
    }
  }
  return out;
}

export function detectMemoryHealCandidates(opts: CandidateOptions = {}): ProposedMemoryFix[] {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const cap = Math.max(1, Math.min(200, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const requestedKinds = opts.kinds?.length ? new Set(opts.kinds) : null;
  const wants = (kind: MemoryFixKind) => requestedKinds === null || requestedKinds.has(kind);
  const out: ProposedMemoryFix[] = [];
  const push = (items: ProposedMemoryFix[]) => {
    for (const item of items) {
      if (out.length >= cap) break;
      out.push(item);
    }
  };
  if (wants('retire_internal_noise')) push(detectInternalNoise(nowIso, cap - out.length));
  if (wants('retire_transient_request')) push(detectTransientRequests(nowIso, cap - out.length));
  if (wants('demote_overexposed_fact')) push(detectOverexposedRecallFacts(nowIso, cap - out.length));
  if (wants('lift_recall_gap')) push(detectRecallGaps(nowIso, cap - out.length));
  if (wants('merge_duplicate')) push(detectMergeDuplicates(nowIso, cap - out.length));
  if (wants('supersede_stale_fact')) push(detectStaleSupersessions(nowIso, cap - out.length));
  const seen = new Set<string>();
  const deduped = out.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  return opts.persistProposals === false ? deduped : upsertProposals(deduped);
}

/**
 * Cross-family VETO judge for an automated memory fix. Verdict is PLAIN TEXT,
 * parsed deterministically ("APPROVE: reason" / "VETO: reason") — the
 * boundary-judge sweep from 2e10714e/2538d916. No outputType, so a provider's
 * shape-validation can't reject a valid verdict and misreport the judge.
 *
 * FAILS CLOSED (unlike the workflow HealVeto): a no-marker / empty / errored
 * response returns 'unavailable', and the caller skips the fix while
 * memorySelfHealJudgeRequired() is on (a memory mutation is never applied
 * unverified). That skip semantics is UNCHANGED from the outputType era.
 */
export async function judgeMemoryFixCrossFamily(fix: ProposedMemoryFix): Promise<{ verdict: 'approve' | 'veto' | 'unavailable'; reason?: string }> {
  if (!memorySelfHealJudgeRequired()) return { verdict: 'unavailable', reason: 'memory fix judge disabled' };
  if (fix.kind !== 'merge_duplicate' && fix.kind !== 'supersede_stale_fact') return { verdict: 'approve', reason: 'deterministic fix kind' };
  try {
    const { resolveRoleModel } = await import('../runtime/harness/model-roles.js');
    const { resolveProvider } = await import('../runtime/harness/model-wire-registry.js');
    const { withJudgeTimeout } = await import('../runtime/harness/judge-family.js');
    const judge = resolveRoleModel('judge');
    const detectorProvider = resolveProvider(MODELS.fast);
    if (!judge?.modelId || String(judge.provider) === String(detectorProvider)) {
      return { verdict: 'unavailable', reason: 'no different-family judge bound' };
    }
    const agent = new Agent({
      name: 'MemoryHealVetoJudge',
      instructions: [
        'You are a strict reviewer of an AUTOMATED long-term-memory fix.',
        'Approve only if the evidence supports the exact proposed memory mutation and the fix cannot reasonably erase distinct user knowledge.',
        'For duplicate merges, approve only when the two facts express the same durable fact about the same entity. Reject if they may refer to different clients, people, accounts, dates, resources, or requirements.',
        'For supersession, approve only when a newer direct/high-trust fact clearly replaces an older lower-trust derived fact about the same property. Reject user-vs-user ambiguity.',
        'When uncertain, VETO — a vetoed memory fix is skipped, not lost.',
        'Reply with EXACTLY ONE LINE and nothing else: either "APPROVE: <one-sentence reason>" or "VETO: <one-sentence reason>".',
      ].join('\n'),
      model: judge.modelId,
      modelSettings: { reasoning: { effort: 'low' } },
      tools: [],
    });
    const rows = fix.targetIds.map((id) => rowById(id)).filter((r): r is ConsolidatedFactRow => Boolean(r));
    const prompt = [
      `Fix kind: ${fix.kind}`,
      `Evidence: ${fix.evidence}`,
      `Payload: ${JSON.stringify(fix.payload)}`,
      'Target facts:',
      ...rows.map((r) => `#${r.id} kind=${r.kind} trust=${r.trust_level ?? 'null'} pinned=${r.pinned} active=${r.active}: ${r.content.slice(0, MAX_JUDGED_TEXT)}`),
    ].join('\n');
    const result = await withJudgeTimeout(run(agent, prompt));
    return parseMemoryVetoVerdict(String((result as { finalOutput?: unknown } | undefined)?.finalOutput ?? ''));
  } catch (err) {
    return { verdict: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Parse the judge's ONE-LINE plain-text verdict deterministically:
 *   "APPROVE: <reason>" → approve · "VETO: <reason>" → veto
 * Case-insensitive, tolerates leading whitespace and a missing colon. Anything
 * else — empty output or a response with no APPROVE/VETO marker — is
 * 'unavailable', which the caller treats as a FAIL-CLOSED skip (a memory
 * mutation is never applied on an unreadable verdict). Nothing to fail on shape.
 */
export function parseMemoryVetoVerdict(raw: string): { verdict: 'approve' | 'veto' | 'unavailable'; reason?: string } {
  const text = (raw ?? '').trim();
  if (!text) return { verdict: 'unavailable', reason: 'judge timeout' };
  const match = /^\s*(APPROVE|VETO)\s*:?\s*(.*)$/im.exec(text);
  if (!match) return { verdict: 'unavailable', reason: `judge returned no APPROVE/VETO verdict (got: ${text.slice(0, 120)})` };
  const reason = (match[2] || '').trim().slice(0, 400);
  return match[1].toUpperCase() === 'APPROVE'
    ? { verdict: 'approve', reason }
    : { verdict: 'veto', reason };
}

function requireRow(id: number): ConsolidatedFactRow | null {
  const row = rowById(id);
  if (!row || row.active !== 1 || row.pinned === 1) return null;
  return row;
}

function validateFixProbe(fix: ProposedMemoryFix): { ok: true } | { ok: false; reason: string } {
  if (!fix.autoApplicable) return { ok: false, reason: 'fix is not auto-applicable' };
  if (fix.kind === 'retire_internal_noise') {
    const p = fix.payload as SingleFactPayload;
    const row = requireRow(p.id);
    if (!row) return { ok: false, reason: 'fact missing, inactive, or pinned' };
    if (!isSelfReferentialTool(row.derived_from_tool)) return { ok: false, reason: 'fact is no longer internal tool noise' };
    return { ok: true };
  }
  if (fix.kind === 'retire_transient_request') {
    const p = fix.payload as SingleFactPayload;
    const row = requireRow(p.id);
    if (!row) return { ok: false, reason: 'fact missing, inactive, or pinned' };
    if (row.kind === 'constraint') return { ok: false, reason: 'constraints are never transient cleanup candidates' };
    if (row.derived_from_call_id || row.derived_from_session_id || row.derived_from_tool) {
      return { ok: false, reason: 'fact provenance changed since detection' };
    }
    if (!looksLikeLegacyTransientRequest(row.content)) return { ok: false, reason: 'fact no longer resembles a transient request' };
    return { ok: true };
  }
  if (fix.kind === 'lift_recall_gap') {
    const p = fix.payload as LiftRecallGapPayload;
    const row = requireRow(p.id);
    if (!row) return { ok: false, reason: 'fact missing, inactive, or pinned' };
    const imp = row.importance ?? 5;
    if (imp < 7 || imp >= 10) return { ok: false, reason: 'fact is no longer an eligible recall gap' };
    if (row.last_accessed_at && Date.parse(row.last_accessed_at) > Date.parse(row.created_at) + 2000) {
      return { ok: false, reason: 'fact has been recalled since detection' };
    }
    return { ok: true };
  }
  if (fix.kind === 'demote_overexposed_fact') {
    const p = fix.payload as DemoteOverexposedFactPayload;
    const row = requireRow(p.id);
    if (!row) return { ok: false, reason: 'fact missing, inactive, or pinned' };
    if (row.kind === 'constraint') return { ok: false, reason: 'constraints are never demoted by recall trace' };
    const imp = row.importance ?? 5;
    if (imp !== p.priorImportance) return { ok: false, reason: 'fact importance changed since detection' };
    if (imp <= 3 || imp > 5) return { ok: false, reason: 'fact is no longer an eligible low-importance overexposure candidate' };
    if (!isDerivedOrLowerTrust(row)) return { ok: false, reason: 'fact is no longer derived or lower-trust' };
    const summary = summarizeTraceExposures().get(p.id);
    if (!summary || summary.total < OVEREXPOSED_MIN_EXPOSURES || summary.global < OVEREXPOSED_MIN_GLOBAL_EXPOSURES) {
      return { ok: false, reason: 'fact no longer has enough recall-trace exposure evidence' };
    }
    return { ok: true };
  }
  if (fix.kind === 'merge_duplicate') {
    const p = fix.payload as MergeDuplicatePayload;
    const keep = requireRow(p.keepId);
    const drop = requireRow(p.dropId);
    if (!keep || !drop) return { ok: false, reason: 'merge target missing, inactive, or pinned' };
    if (keep.id === drop.id) return { ok: false, reason: 'merge target is self' };
    if (keep.kind !== drop.kind) return { ok: false, reason: 'merge target kind changed' };
    if (!canMergeEntitySafe(extractAnchors(keep), extractAnchors(drop))) return { ok: false, reason: 'entity anchors are no longer compatible' };
    const vectors = loadFactEmbeddings([keep.id, drop.id]);
    const vk = vectors.get(keep.id);
    const vd = vectors.get(drop.id);
    if (!vk || !vd) return { ok: false, reason: 'merge target embedding missing' };
    const sim = cosine(vk, vd);
    if (sim < MERGE_SIMILARITY_THRESHOLD) return { ok: false, reason: `similarity fell below threshold (${sim.toFixed(3)})` };
    if (factQuality(drop) > factQuality(keep)) return { ok: false, reason: 'drop fact is now higher quality than keep fact' };
    return { ok: true };
  }
  const p = fix.payload as SupersedeStaleFactPayload;
  const stale = requireRow(p.staleId);
  const replacement = requireRow(p.replacementId);
  if (!stale || !replacement) return { ok: false, reason: 'supersession target missing, inactive, or pinned' };
  const staleParsed = parsePreferenceFact(stale.content);
  const replacementParsed = parsePreferenceFact(replacement.content);
  if (!staleParsed || !replacementParsed) return { ok: false, reason: 'supersession facts no longer parse as preferences' };
  if (staleParsed.subject !== replacementParsed.subject || staleParsed.property !== replacementParsed.property) return { ok: false, reason: 'supersession property changed' };
  if (staleParsed.value === replacementParsed.value) return { ok: false, reason: 'supersession facts no longer contradict' };
  const staleDerived = Boolean(stale.derived_from_call_id || stale.derived_from_tool);
  const replacementDirect = !replacement.derived_from_call_id && !replacement.derived_from_tool;
  if (!staleDerived || !replacementDirect) return { ok: false, reason: 'supersession is not lower-trust-derived to direct fact' };
  if ((replacement.trust_level ?? 1) < (stale.trust_level ?? 0.6)) return { ok: false, reason: 'replacement trust is lower than stale fact trust' };
  return { ok: true };
}

function appendHealAudit(fix: ProposedMemoryFix, nowIso: string, ids: number[], detail: Record<string, unknown>): string {
  const id = auditId(fix, nowIso);
  appendHygieneAudit({
    at: nowIso,
    kind: 'memory-heal',
    ids,
    detail: {
      healAuditId: id,
      fixId: fix.id,
      kind: fix.kind,
      evidence: fix.evidence,
      targetIds: fix.targetIds,
      ...detail,
    },
  });
  return id;
}

function laterIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

function linkTruthRank(value: FactLinkTransferRow['link_type']): number {
  if (value === 'stored') return 3;
  if (value === 'extracted') return 2;
  return 1;
}

function sameLinkRow(a: FactLinkTransferRow | null | undefined, b: FactLinkTransferRow | null | undefined): boolean {
  return Boolean(a && b)
    && a!.fact_id === b!.fact_id
    && a!.linked_id === b!.linked_id
    && a!.created_at === b!.created_at
    && a!.link_type === b!.link_type
    && a!.confidence === b!.confidence
    && a!.evidence_episode_id === b!.evidence_episode_id
    && a!.evidence_excerpt === b!.evidence_excerpt;
}

function mergedLinkRow(
  keepId: number,
  existing: FactLinkTransferRow | null,
  incoming: FactLinkTransferRow,
): FactLinkTransferRow {
  const existingRank = existing ? linkTruthRank(existing.link_type) : 0;
  const incomingRank = linkTruthRank(incoming.link_type);
  const preferred = !existing
    || incomingRank > existingRank
    || (incomingRank === existingRank && incoming.confidence > existing.confidence)
      ? incoming
      : existing;
  const fallback = preferred === incoming ? existing : incoming;
  return {
    fact_id: keepId,
    linked_id: incoming.linked_id,
    created_at: existing?.created_at ?? incoming.created_at,
    link_type: preferred.link_type,
    confidence: Math.max(existing?.confidence ?? 0, incoming.confidence),
    evidence_episode_id: preferred.evidence_episode_id ?? fallback?.evidence_episode_id ?? null,
    evidence_excerpt: preferred.evidence_excerpt ?? fallback?.evidence_excerpt ?? null,
  };
}

function transferFactLinkRows(
  db: ReturnType<typeof openMemoryDb>,
  table: 'fact_entities' | 'fact_resources',
  linkedColumn: 'entity_id' | 'resource_id',
  keepId: number,
  dropId: number,
): FactLinkTransferDelta[] {
  // `table` and `linkedColumn` are closed unions controlled by this module;
  // values never originate from user input.
  const select = db.prepare(`
    SELECT fact_id, ${linkedColumn} AS linked_id, created_at, link_type, confidence,
           evidence_episode_id, evidence_excerpt
    FROM ${table} WHERE fact_id = ?
  `);
  const existingById = new Map(
    (select.all(keepId) as FactLinkTransferRow[]).map((row) => [row.linked_id, row]),
  );
  const incoming = select.all(dropId) as FactLinkTransferRow[];
  const write = db.prepare(`
    INSERT INTO ${table}
      (fact_id, ${linkedColumn}, created_at, link_type, confidence, evidence_episode_id, evidence_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fact_id, ${linkedColumn}) DO UPDATE SET
      created_at = excluded.created_at,
      link_type = excluded.link_type,
      confidence = excluded.confidence,
      evidence_episode_id = excluded.evidence_episode_id,
      evidence_excerpt = excluded.evidence_excerpt
  `);
  const deltas: FactLinkTransferDelta[] = [];
  for (const row of incoming) {
    const before = existingById.get(row.linked_id) ?? null;
    const applied = mergedLinkRow(keepId, before, row);
    if (sameLinkRow(before, applied)) continue;
    write.run(
      applied.fact_id,
      applied.linked_id,
      applied.created_at,
      applied.link_type,
      applied.confidence,
      applied.evidence_episode_id,
      applied.evidence_excerpt,
    );
    deltas.push({ linkedId: row.linked_id, before, applied });
  }
  return deltas;
}

function transferFactEvidenceRows(
  db: ReturnType<typeof openMemoryDb>,
  keepId: number,
  dropId: number,
): FactEvidenceTransferRow[] {
  const incoming = db.prepare(`
    SELECT fact_id, episode_id, excerpt, source_uri, ordinal, created_at
    FROM fact_evidence WHERE fact_id = ?
    ORDER BY episode_id, ordinal
  `).all(dropId) as FactEvidenceTransferRow[];
  const exact = db.prepare(`
    SELECT 1 FROM fact_evidence
    WHERE fact_id = ? AND episode_id = ? AND excerpt = ?
      AND COALESCE(source_uri, '') = COALESCE(?, '')
    LIMIT 1
  `);
  const occupied = db.prepare(`
    SELECT 1 FROM fact_evidence WHERE fact_id = ? AND episode_id = ? AND ordinal = ?
  `);
  const nextOrdinal = db.prepare(`
    SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
    FROM fact_evidence WHERE fact_id = ? AND episode_id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO fact_evidence
      (fact_id, episode_id, excerpt, source_uri, ordinal, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const added: FactEvidenceTransferRow[] = [];
  for (const row of incoming) {
    if (exact.get(keepId, row.episode_id, row.excerpt, row.source_uri)) continue;
    const ordinal = occupied.get(keepId, row.episode_id, row.ordinal)
      ? Number((nextOrdinal.get(keepId, row.episode_id) as { ordinal: number }).ordinal)
      : row.ordinal;
    const applied = { ...row, fact_id: keepId, ordinal };
    insert.run(
      applied.fact_id,
      applied.episode_id,
      applied.excerpt,
      applied.source_uri,
      applied.ordinal,
      applied.created_at,
    );
    added.push(applied);
  }
  return added;
}

function transferDuplicateFactProvenance(
  db: ReturnType<typeof openMemoryDb>,
  keepId: number,
  dropId: number,
): DuplicateFactMergeTransfer {
  return {
    keepId,
    dropId,
    evidenceAdded: transferFactEvidenceRows(db, keepId, dropId),
    entityLinks: transferFactLinkRows(db, 'fact_entities', 'entity_id', keepId, dropId),
    resourceLinks: transferFactLinkRows(db, 'fact_resources', 'resource_id', keepId, dropId),
  };
}

function sameEvidenceRow(a: FactEvidenceTransferRow | undefined, b: FactEvidenceTransferRow): boolean {
  return Boolean(a)
    && a!.fact_id === b.fact_id
    && a!.episode_id === b.episode_id
    && a!.excerpt === b.excerpt
    && a!.source_uri === b.source_uri
    && a!.ordinal === b.ordinal
    && a!.created_at === b.created_at;
}

/** Revert only the relational rows that are still byte-identical to what the
 * merge wrote. If later learning strengthened a link or replaced an excerpt,
 * that newer state wins and is deliberately left intact. */
function revertDuplicateFactProvenance(transfer: DuplicateFactMergeTransfer): void {
  const db = openMemoryDb();
  const revertLinks = (
    table: 'fact_entities' | 'fact_resources',
    linkedColumn: 'entity_id' | 'resource_id',
    deltas: FactLinkTransferDelta[],
  ): void => {
    const read = db.prepare(`
      SELECT fact_id, ${linkedColumn} AS linked_id, created_at, link_type, confidence,
             evidence_episode_id, evidence_excerpt
      FROM ${table} WHERE fact_id = ? AND ${linkedColumn} = ?
    `);
    const remove = db.prepare(`DELETE FROM ${table} WHERE fact_id = ? AND ${linkedColumn} = ?`);
    const restore = db.prepare(`
      INSERT INTO ${table}
        (fact_id, ${linkedColumn}, created_at, link_type, confidence, evidence_episode_id, evidence_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(fact_id, ${linkedColumn}) DO UPDATE SET
        created_at = excluded.created_at,
        link_type = excluded.link_type,
        confidence = excluded.confidence,
        evidence_episode_id = excluded.evidence_episode_id,
        evidence_excerpt = excluded.evidence_excerpt
    `);
    for (const delta of deltas) {
      const current = read.get(transfer.keepId, delta.linkedId) as FactLinkTransferRow | undefined;
      if (!sameLinkRow(current, delta.applied)) continue;
      if (!delta.before) remove.run(transfer.keepId, delta.linkedId);
      else restore.run(
        delta.before.fact_id,
        delta.before.linked_id,
        delta.before.created_at,
        delta.before.link_type,
        delta.before.confidence,
        delta.before.evidence_episode_id,
        delta.before.evidence_excerpt,
      );
    }
  };

  db.transaction(() => {
    const readEvidence = db.prepare(`
      SELECT fact_id, episode_id, excerpt, source_uri, ordinal, created_at
      FROM fact_evidence WHERE fact_id = ? AND episode_id = ? AND ordinal = ?
    `);
    const removeEvidence = db.prepare(`
      DELETE FROM fact_evidence WHERE fact_id = ? AND episode_id = ? AND ordinal = ?
    `);
    for (const row of transfer.evidenceAdded) {
      const current = readEvidence.get(row.fact_id, row.episode_id, row.ordinal) as FactEvidenceTransferRow | undefined;
      if (sameEvidenceRow(current, row)) removeEvidence.run(row.fact_id, row.episode_id, row.ordinal);
    }
    revertLinks('fact_entities', 'entity_id', transfer.entityLinks);
    revertLinks('fact_resources', 'resource_id', transfer.resourceLinks);
  })();
}

function applyMergeDuplicate(fix: ProposedMemoryFix, nowIso: string, dryRun: boolean): MemoryHealResult {
  const p = fix.payload as MergeDuplicatePayload;
  const before = snapshotRows([p.keepId, p.dropId]);
  if (dryRun) return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.dropId], message: `Would merge duplicate fact #${p.dropId} into #${p.keepId}.` };
  const db = openMemoryDb();
  const keep = rowById(p.keepId)!;
  const drop = rowById(p.dropId)!;
  const foldedScore = Math.max(keep.score ?? 1, drop.score ?? 1);
  const foldedImportance = Math.min(10, Math.max(keep.importance ?? 5, drop.importance ?? 5));
  const foldedTrust = Math.min(1, Math.max(keep.trust_level ?? 0.6, drop.trust_level ?? 0.6));
  const foldedConfidence = Math.min(1, Math.max(keep.confidence ?? keep.trust_level ?? 0.6, drop.confidence ?? drop.trust_level ?? 0.6));
  const foldedAccess = (keep.access_count ?? 0) + (drop.access_count ?? 0);
  const foldedImpressions = (keep.impression_count ?? 0) + (drop.impression_count ?? 0);
  const foldedUtility = (keep.utility_count ?? 0) + (drop.utility_count ?? 0);
  const sourceApp = keep.source_app ?? drop.source_app;
  const transfer = db.transaction(() => {
    const provenance = transferDuplicateFactProvenance(db, p.keepId, p.dropId);
    db.prepare(
      `UPDATE consolidated_facts
       SET score = ?, importance = ?, trust_level = ?, confidence = ?,
           access_count = ?, impression_count = ?, utility_count = ?,
           source_app = ?, last_accessed_at = ?, last_used_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      foldedScore,
      foldedImportance,
      foldedTrust,
      foldedConfidence,
      foldedAccess,
      foldedImpressions,
      foldedUtility,
      sourceApp,
      laterIso(keep.last_accessed_at, drop.last_accessed_at),
      laterIso(keep.last_used_at, drop.last_used_at),
      laterIso(keep.updated_at, drop.updated_at) ?? keep.updated_at,
      p.keepId,
    );
    db.prepare(`
      UPDATE consolidated_facts
      SET active = 0, valid_to = ?, superseded_by_fact_id = ?, updated_at = ?
      WHERE id = ?
    `).run(nowIso, p.keepId, nowIso, p.dropId);
    return provenance;
  })();
  const id = appendHealAudit(fix, nowIso, [p.dropId], {
    action: 'merge_duplicate',
    keepId: p.keepId,
    dropId: p.dropId,
    similarity: p.similarity,
    before,
    mergeTransfer: transfer,
  });
  const evidence = transfer.evidenceAdded.length;
  const links = transfer.entityLinks.length + transfer.resourceLinks.length;
  return {
    ok: true,
    fixId: fix.id,
    kind: fix.kind,
    applied: 1,
    ids: [p.dropId],
    auditId: id,
    message: `Merged duplicate fact #${p.dropId} into #${p.keepId}; preserved ${evidence} evidence source${evidence === 1 ? '' : 's'} and ${links} graph link${links === 1 ? '' : 's'}.`,
  };
}

function applyRetireInternalNoise(fix: ProposedMemoryFix, nowIso: string, dryRun: boolean): MemoryHealResult {
  const p = fix.payload as SingleFactPayload;
  const before = snapshotRows([p.id]);
  if (dryRun) return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], message: `Would retire internal-noise fact #${p.id}.` };
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET active = 0, updated_at = ? WHERE id = ?').run(nowIso, p.id);
  const id = appendHealAudit(fix, nowIso, [p.id], { action: 'retire_internal_noise', before });
  return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], auditId: id, message: `Retired internal-noise fact #${p.id}.` };
}

function applyRetireTransientRequest(fix: ProposedMemoryFix, nowIso: string, dryRun: boolean): MemoryHealResult {
  const p = fix.payload as SingleFactPayload;
  const before = snapshotRows([p.id]);
  if (dryRun) return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], message: `Would forget legacy request fact #${p.id}.` };
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET active = 0, updated_at = ? WHERE id = ?').run(nowIso, p.id);
  const id = appendHealAudit(fix, nowIso, [p.id], { action: 'retire_transient_request', before });
  return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], auditId: id, message: `Forgot legacy request fact #${p.id}. It can be restored from memory history.` };
}

function applyLiftRecallGap(fix: ProposedMemoryFix, nowIso: string, dryRun: boolean): MemoryHealResult {
  const p = fix.payload as LiftRecallGapPayload;
  const before = snapshotRows([p.id]);
  if (dryRun) return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], message: `Would lift recall-gap fact #${p.id}.` };
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET importance = ?, updated_at = ? WHERE id = ?').run(p.newImportance, nowIso, p.id);
  const id = appendHealAudit(fix, nowIso, [p.id], { action: 'lift_recall_gap', priorImportance: p.priorImportance, newImportance: p.newImportance, before });
  return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], auditId: id, message: `Lifted recall-gap fact #${p.id} from importance ${p.priorImportance} to ${p.newImportance}.` };
}

function applyDemoteOverexposedFact(fix: ProposedMemoryFix, nowIso: string, dryRun: boolean): MemoryHealResult {
  const p = fix.payload as DemoteOverexposedFactPayload;
  const before = snapshotRows([p.id]);
  if (dryRun) return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], message: `Would demote overexposed fact #${p.id}.` };
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET importance = ?, updated_at = ? WHERE id = ?').run(p.newImportance, nowIso, p.id);
  const id = appendHealAudit(fix, nowIso, [p.id], {
    action: 'demote_overexposed_fact',
    priorImportance: p.priorImportance,
    newImportance: p.newImportance,
    exposureCount: p.exposureCount,
    globalExposureCount: p.globalExposureCount,
    surfaces: p.surfaces,
    before,
  });
  return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.id], auditId: id, message: `Demoted overexposed fact #${p.id} from importance ${p.priorImportance} to ${p.newImportance}.` };
}

function applySupersedeStaleFact(fix: ProposedMemoryFix, nowIso: string, dryRun: boolean): MemoryHealResult {
  const p = fix.payload as SupersedeStaleFactPayload;
  const before = snapshotRows([p.staleId, p.replacementId]);
  if (dryRun) return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.staleId], message: `Would supersede stale fact #${p.staleId} with #${p.replacementId}.` };
  const db = openMemoryDb();
  db.prepare('UPDATE consolidated_facts SET active = 0, updated_at = ? WHERE id = ?').run(nowIso, p.staleId);
  const id = appendHealAudit(fix, nowIso, [p.staleId], { action: 'supersede_stale_fact', before, replacementId: p.replacementId, property: p.property, staleValue: p.staleValue, replacementValue: p.replacementValue });
  return { ok: true, fixId: fix.id, kind: fix.kind, applied: 1, ids: [p.staleId], auditId: id, message: `Superseded stale fact #${p.staleId} with #${p.replacementId}.` };
}

export async function applyMemoryFix(input: string | ProposedMemoryFix, opts: ApplyOptions = {}): Promise<MemoryHealResult> {
  const fix = typeof input === 'string' ? loadProposedMemoryFix(input) : input;
  if (!fix) return { ok: false, fixId: String(input), kind: 'retire_internal_noise', applied: 0, ids: [], message: `No memory fix found with id "${String(input)}".`, reason: 'not-found' };
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const probe = validateFixProbe(fix);
  if (!probe.ok) {
    if (!opts.dryRun) updateStoredProposal(fix.id, { status: 'skipped', skipReason: probe.reason });
    return { ok: false, fixId: fix.id, kind: fix.kind, applied: 0, ids: [], message: `Skipped memory fix ${fix.id}: ${probe.reason}`, reason: probe.reason };
  }
  if (fix.kind === 'merge_duplicate' || fix.kind === 'supersede_stale_fact') {
    const judge = opts.humanApproved
      ? { verdict: 'approve' as const, reason: 'owner reviewed exact candidate' }
      : await (opts.judge ?? judgeMemoryFixCrossFamily)(fix);
    if (judge.verdict === 'veto' || (judge.verdict === 'unavailable' && memorySelfHealJudgeRequired())) {
      const reason = judge.reason ?? judge.verdict;
      if (!opts.dryRun) updateStoredProposal(fix.id, { status: 'skipped', skipReason: reason });
      return { ok: false, fixId: fix.id, kind: fix.kind, applied: 0, ids: [], message: `Skipped memory fix ${fix.id}: ${reason}`, reason };
    }
  }
  if (!opts.dryRun) backupMemoryDb({ retain: 14 });
  let result: MemoryHealResult;
  if (fix.kind === 'merge_duplicate') result = applyMergeDuplicate(fix, nowIso, opts.dryRun === true);
  else if (fix.kind === 'retire_internal_noise') result = applyRetireInternalNoise(fix, nowIso, opts.dryRun === true);
  else if (fix.kind === 'retire_transient_request') result = applyRetireTransientRequest(fix, nowIso, opts.dryRun === true);
  else if (fix.kind === 'lift_recall_gap') result = applyLiftRecallGap(fix, nowIso, opts.dryRun === true);
  else if (fix.kind === 'demote_overexposed_fact') result = applyDemoteOverexposedFact(fix, nowIso, opts.dryRun === true);
  else result = applySupersedeStaleFact(fix, nowIso, opts.dryRun === true);
  if (result.ok && !opts.dryRun) updateStoredProposal(fix.id, { status: 'applied', appliedAt: nowIso, auditId: result.auditId });
  return result;
}

export async function runMemorySelfHeal(opts: RunOptions = {}): Promise<MemoryHealOutcome> {
  const dryRun = opts.dryRun === true;
  if (!memorySelfHealEnabled()) return { ran: false, proposed: 0, applied: 0, skipped: [], results: [], dryRun, reason: 'disabled' };
  if (!memorySelfHealRealEnabled()) return { ran: false, proposed: 0, applied: 0, skipped: [], results: [], dryRun, reason: 'real-disabled' };
  const maxApply = configuredMaxApply(opts.maxApply);
  if (maxApply === 0) return { ran: false, proposed: 0, applied: 0, skipped: [], results: [], dryRun, reason: 'max-zero' };
  const candidates = detectMemoryHealCandidates({
    maxCandidates: opts.maxCandidates ?? maxApply,
    nowIso: opts.nowIso,
    persistProposals: !dryRun,
  });
  const results: MemoryHealResult[] = [];
  const skipped: Array<{ id: string; kind: MemoryFixKind; reason: string }> = [];
  for (const fix of candidates.slice(0, maxApply)) {
    // Embedding similarity is evidence for a review queue, never authority to
    // delete a durable claim. Keep the proposal pending so the desktop/API can
    // apply it explicitly through applyMemoryFix after human review.
    if (fix.kind === 'merge_duplicate' || fix.kind === 'retire_transient_request') {
      const reason = fix.kind === 'merge_duplicate'
        ? 'review required for semantic merge'
        : 'review required before forgetting a conversational request';
      skipped.push({ id: fix.id, kind: fix.kind, reason });
      continue;
    }
    if (fix.status && fix.status !== 'pending') {
      skipped.push({ id: fix.id, kind: fix.kind, reason: `stored status is ${fix.status}` });
      continue;
    }
    const res = await applyMemoryFix(fix, { dryRun, nowIso: opts.nowIso, judge: opts.judge });
    results.push(res);
    if (!res.ok) skipped.push({ id: fix.id, kind: fix.kind, reason: res.reason ?? res.message });
  }
  const applied = results.reduce((sum, r) => sum + (r.ok ? r.applied : 0), 0);
  return { ran: true, proposed: candidates.length, applied, skipped, results, dryRun };
}

function restoreSnapshot(rows: FactSnapshot[], nowIso: string): void {
  if (rows.length === 0) return;
  const db = openMemoryDb();
  const restore = db.prepare(
    `UPDATE consolidated_facts
     SET active = ?, score = ?, importance = ?, trust_level = ?, confidence = ?,
         access_count = ?, impression_count = ?, utility_count = ?,
         source_app = ?, last_accessed_at = ?, last_used_at = ?, updated_at = ?,
         valid_from = ?, valid_to = ?, superseded_by_fact_id = ?
     WHERE id = ?`,
  );
  const reactivate = db.prepare(
    `UPDATE consolidated_facts
     SET active = 1, score = ?, importance = ?, trust_level = ?, confidence = ?,
         access_count = ?, impression_count = ?, utility_count = ?,
         source_app = ?, last_accessed_at = ?, last_used_at = ?, updated_at = ?,
         valid_from = ?, valid_to = NULL, superseded_by_fact_id = NULL
     WHERE id = ?`,
  );
  const current = db.prepare('SELECT * FROM consolidated_facts WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      const live = current.get(row.id) as ConsolidatedFactRow | undefined;
      // Older audit snapshots predate measured impressions/utility and do not
      // carry these fields. Reverting one must preserve the live value instead
      // of binding undefined into a NOT NULL column.
      const score = row.score ?? live?.score ?? 1;
      const confidence = row.confidence ?? live?.confidence ?? live?.trust_level ?? null;
      const impressionCount = row.impression_count ?? live?.impression_count ?? 0;
      const utilityCount = row.utility_count ?? live?.utility_count ?? 0;
      const lastUsedAt = row.last_used_at ?? live?.last_used_at ?? null;
      if (row.active === 1 && live?.active === 0) {
        // Undoing a retirement asserts the claim again now. It must open a new
        // validity period rather than reopening/overwriting its closed history.
        reactivate.run(
          score,
          row.importance,
          row.trust_level,
          confidence,
          row.access_count,
          impressionCount,
          utilityCount,
          row.source_app,
          row.last_accessed_at,
          lastUsedAt,
          nowIso,
          nowIso,
          row.id,
        );
      } else {
        restore.run(
          row.active,
          score,
          row.importance,
          row.trust_level,
          confidence,
          row.access_count,
          impressionCount,
          utilityCount,
          row.source_app,
          row.last_accessed_at,
          lastUsedAt,
          row.updated_at,
          row.valid_from,
          row.valid_to,
          row.superseded_by_fact_id,
          row.id,
        );
      }
    }
  })();
}

export function revertMemoryHeal(healAuditId: string, nowIso: string = new Date().toISOString()): { ok: boolean; message: string; ids: number[] } {
  const entry = readHygieneAudit(2000).find((e) => e.kind === 'memory-heal' && (e.detail as { healAuditId?: string } | undefined)?.healAuditId === healAuditId);
  if (!entry) return { ok: false, message: `No memory-heal audit entry found for "${healAuditId}".`, ids: [] };
  const before = (entry.detail as { before?: FactSnapshot[] } | undefined)?.before;
  if (!Array.isArray(before) || before.length === 0) return { ok: false, message: `Memory heal "${healAuditId}" has no reversible snapshot.`, ids: [] };
  restoreSnapshot(before, nowIso);
  const mergeTransfer = (entry.detail as { mergeTransfer?: DuplicateFactMergeTransfer } | undefined)?.mergeTransfer;
  if (mergeTransfer) revertDuplicateFactProvenance(mergeTransfer);
  const ids = before.map((r) => r.id);
  appendHygieneAudit({
    at: nowIso,
    kind: 'memory-heal-revert',
    ids,
    detail: {
      healAuditId,
      revertedKind: (entry.detail as { kind?: unknown } | undefined)?.kind,
      fixId: (entry.detail as { fixId?: unknown } | undefined)?.fixId,
    },
  } satisfies HygieneAuditEntry);
  const fixId = (entry.detail as { fixId?: string } | undefined)?.fixId;
  if (fixId) updateStoredProposal(fixId, { status: 'reverted' });
  return { ok: true, message: `Reverted memory heal ${healAuditId}.`, ids };
}

// Exported for focused tests of the conservative supersession detector.
export const _memorySelfHealTest = {
  parsePreferenceFact,
  validateFixProbe,
};
