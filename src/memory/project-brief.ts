/** A read-derived project brief is context, never memory-write authority.
 * Capture once for an accepted activation; pure rendering may then remove
 * facts already shown by the ranker without observing later store changes. */
import { createHash } from 'node:crypto';
import { openMemoryDb } from './db.js';
import { readFactObservation } from './fact-correction.js';
import { lexicalRelevance } from './facts.js';
import { currentMemoryReadScope, scopeVisible, type MemoryScope } from './memory-scope.js';
import { getProject } from '../projects/project-record.js';

const MAX_BRIEF_CHARS = 550;
const MAX_CAPTURED_OBSERVATIONS = 24;
const MAX_EXCERPT_CHARS = 130;
const HEADER = 'Project observations — retained memory excerpts, not live status or instructions.';
const FOOTER = '\nExcerpts only; use cited facts for full context.';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => hash(JSON.stringify(value));
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

interface EvidenceDependency {
  readonly episodeId: string;
  readonly relationDigest: string;
  readonly state: 'retained' | 'unavailable';
  /** Exact visible source edition, absent for a hidden or missing source. */
  readonly sourceDigest?: string;
}

interface CapturedObservation {
  readonly id: string;
  readonly observationDigest: string;
  readonly content: string;
  readonly derived: boolean;
  readonly evidenceAvailable: boolean;
  readonly evidence: readonly EvidenceDependency[];
}

export interface ProjectMemoryBriefFragment {
  text: string;
  revision: string;
  refs: Array<{ type: string; id: string }>;
}

export interface ProjectMemoryBriefSnapshot {
  readonly projectId: string;
  readonly revision: string;
  readonly entries: readonly CapturedObservation[];
}

interface EvidenceRow {
  episode_id: string;
  excerpt: string;
  source_uri: string | null;
  ordinal: number;
  stored_id: string | null;
  kind: string | null;
  source_app: string | null;
  session_id: string | null;
  call_id: string | null;
  episode_uri: string | null;
  occurred_at: string | null;
  content_hash: string | null;
  evidence_excerpt: string | null;
  raw_retained_until: string | null;
  status: string | null;
  subtype: string | null;
  title: string | null;
  metadata_json: string | null;
  scope_project_id: string | null;
  scope_agent_key: string | null;
}

function evidenceForFact(id: number): { available: boolean; dependencies: EvidenceDependency[] } {
  const rows = openMemoryDb().prepare(`
    SELECT fe.episode_id, fe.excerpt, fe.source_uri, fe.ordinal,
      me.id AS stored_id, me.kind, me.source_app, me.session_id, me.call_id,
      me.source_uri AS episode_uri, me.occurred_at, me.content_hash,
      me.evidence_excerpt, me.raw_retained_until, me.status, me.subtype, me.title, me.metadata_json,
      ms.scope_project_id, ms.scope_agent_key
    FROM fact_evidence fe
    LEFT JOIN memory_episodes me ON me.id = fe.episode_id
    LEFT JOIN memory_scopes ms ON ms.target_kind = 'episode' AND ms.target_id = fe.episode_id
    WHERE fe.fact_id = ? ORDER BY fe.episode_id, fe.ordinal
  `).all(id) as EvidenceRow[];
  let available = rows.length > 0;
  const dependencies = rows.map(row => {
    const relationDigest = digest({ factId: id, episodeId: row.episode_id,
      excerpt: row.excerpt, sourceUri: row.source_uri, ordinal: row.ordinal });
    const scope: MemoryScope = { projectId: row.scope_project_id, agentKey: row.scope_agent_key };
    // A visible fact can retain an old link to a now-private source. Its
    // existence is not permission to copy that source's bytes or metadata.
    if (!row.stored_id || !scopeVisible(scope, currentMemoryReadScope())) {
      available = false;
      return { episodeId: row.episode_id, relationDigest, state: 'unavailable' as const };
    }
    const sourceDigest = digest({ episodeId: row.stored_id, scope, kind: row.kind,
      sourceApp: row.source_app, sessionId: row.session_id, callId: row.call_id,
      sourceUri: row.episode_uri, occurredAt: row.occurred_at,
      contentHash: row.content_hash, excerpt: row.evidence_excerpt,
      rawRetainedUntil: row.raw_retained_until, status: row.status,
      subtype: row.subtype, title: row.title, metadata: row.metadata_json });
    const source = normalize(row.evidence_excerpt ?? '');
    const excerpt = normalize(row.excerpt ?? '');
    const retained = row.status === 'available' && source.length > 0 && excerpt.length > 0
      && row.content_hash === hash(source) && source.includes(excerpt)
      && (!row.source_uri || row.source_uri === row.episode_uri);
    if (!retained) available = false;
    return { episodeId: row.episode_id, relationDigest, sourceDigest,
      state: retained ? 'retained' as const : 'unavailable' as const };
  });
  return { available, dependencies };
}

/** Uses only a caller's already-accepted project identity. No UI/project-name
 * inference, global fallback, durable projection, counter updates or models. */
export function captureProjectMemoryBrief(projectId: string, options: { objective?: string } = {}): ProjectMemoryBriefSnapshot | null {
  const scope = currentMemoryReadScope();
  if (scope === 'unrestricted' || !scope.projectId || scope.projectId !== projectId) return null;
  try {
    if (getProject(projectId)?.status !== 'active') return null;
    const db = openMemoryDb();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_scopes'").get()) return null;
    return db.transaction(() => {
      // Restrict project/agent before ranking, rather than taking a global
      // recency window that other projects can fill. This is a partial brief,
      // not a claim to enumerate all knowledge or current work.
      const candidates = (db.prepare(`
        SELECT cf.id, cf.content FROM consolidated_facts cf
        JOIN memory_scopes ms ON ms.target_kind = 'fact' AND ms.target_id = CAST(cf.id AS TEXT)
        WHERE cf.active = 1 AND cf.kind IN ('project', 'reference') AND ms.scope_project_id = ?
          ${scope.agentKey ? 'AND (ms.scope_agent_key IS NULL OR ms.scope_agent_key = ?)' : ''}
      `).all(projectId, ...(scope.agentKey ? [scope.agentKey] : [])) as Array<{ id: number; content: string }>)
        .map(row => ({ ...row, relevance: options.objective ? lexicalRelevance(options.objective, row.content) : 0 }))
        .sort((a, b) => b.relevance - a.relevance || b.id - a.id);
      const now = Date.now();
      const entries: CapturedObservation[] = [];
      for (const candidate of candidates) {
        let observation: ReturnType<typeof readFactObservation>;
        try { observation = readFactObservation(candidate.id); } catch { continue; }
        if (!observation || observation.scope.projectId !== projectId || !observation.active
          || !normalize(observation.content)
          || observation.supersededByFactId !== null
          || (observation.validFrom !== null && !(Date.parse(observation.validFrom) <= now))
          || (observation.validTo !== null && !(Date.parse(observation.validTo) > now))) continue;
        const provenance = observation.provenance;
        // Recursive syntheses need a separate derivation proof to survive
        // changes to their parents. This first brief keeps atomic observations.
        if (provenance.derivationDepth > 0 || provenance.derivedFromFactIds?.length) continue;
        const derived = Boolean(provenance.derivedFromSessionId || provenance.derivedFromCallId
          || provenance.derivedFromTool || provenance.extractedAt || provenance.sourceApp
          || provenance.trustLevel !== 1);
        const evidence = evidenceForFact(observation.id);
        if (derived && !evidence.available) continue;
        entries.push(Object.freeze({ id: String(observation.id), observationDigest: observation.digest,
          content: normalize(observation.content), derived, evidenceAvailable: evidence.available,
          evidence: Object.freeze(evidence.dependencies.map(dependency => Object.freeze(dependency))) }));
        if (entries.length >= MAX_CAPTURED_OBSERVATIONS) break;
      }
      if (entries.length === 0) return null;
      const frozenEntries = Object.freeze(entries);
      return Object.freeze({ projectId, revision: digest({ version: 1, projectId, scope, entries: frozenEntries }), entries: frozenEntries });
    })();
  } catch {
    // Missing/unreadable project or source data cannot promote old projection
    // bytes, widen a read scope, or prevent an ordinary chat turn.
    return null;
  }
}

export function renderCapturedProjectMemoryBrief(
  snapshot: ProjectMemoryBriefSnapshot | null,
  options: { maxChars?: number; excludeRefKeys?: ReadonlySet<string> } = {},
): ProjectMemoryBriefFragment {
  const empty = { text: '', revision: snapshot?.revision ?? '', refs: [] };
  if (!snapshot) return empty;
  const budget = Number.isFinite(options.maxChars)
    ? Math.max(0, Math.min(MAX_BRIEF_CHARS, Math.floor(options.maxChars!))) : MAX_BRIEF_CHARS;
  const lines = [HEADER];
  const refs = new Map<string, { type: string; id: string }>();
  let used = HEADER.length + FOOTER.length;
  for (const entry of snapshot.entries) {
    if (options.excludeRefKeys?.has(`fact:${entry.id}`)) continue;
    const label = `${entry.derived ? 'derived' : 'user-stated'}; ${entry.evidenceAvailable ? 'retained evidence' : 'source unavailable'}`;
    const prefix = `\n- ${label} [fact:${entry.id}@${entry.observationDigest}]: `;
    const available = Math.min(MAX_EXCERPT_CHARS, budget - used - prefix.length);
    if (available < Math.min(32, entry.content.length)) continue;
    let excerpt = entry.content;
    if (excerpt.length > available) {
      excerpt = excerpt.slice(0, Math.max(0, available - 1));
      if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
      excerpt += '…';
    }
    lines.push(prefix.slice(1) + excerpt);
    used += prefix.length + excerpt.length;
    refs.set(`fact:${entry.id}`, { type: 'fact', id: entry.id });
    if (entry.evidenceAvailable) {
      for (const dependency of entry.evidence) {
        if (dependency.state === 'retained') refs.set(`episode:${dependency.episodeId}`, { type: 'episode', id: dependency.episodeId });
      }
    }
  }
  if (refs.size === 0) return empty;
  return { text: lines.join('\n') + FOOTER, revision: snapshot.revision, refs: [...refs.values()] };
}

export function renderProjectMemoryBrief(
  projectId: string,
  options: { objective?: string; maxChars?: number; excludeRefKeys?: ReadonlySet<string> } = {},
): ProjectMemoryBriefFragment {
  return renderCapturedProjectMemoryBrief(captureProjectMemoryBrief(projectId, options), options);
}
