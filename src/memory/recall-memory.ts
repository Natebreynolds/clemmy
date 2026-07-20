import { openMemoryDb, type MemoryEpisodeStatus } from './db.js';
import {
  findSimilarFactsScored,
  getFact,
  getFactAt,
  lexicalRelevance,
  searchFactsByText,
  searchFactsByTextAt,
  type ConsolidatedFact,
} from './facts.js';
import { recallHybrid, resolveRecallTimeZone, resolveTemporalMeetingDate } from './recall.js';
import {
  getFactIdsForEntity,
  getFactIdsForResource,
  getNeighborEntityIds,
  loadFactEntityEdges,
  loadFactResourceEdges,
  resolveEntityIdsForText,
} from './relations.js';
import { getResourcePointersByIds, listAllResourcePointers, type ResourcePointer } from './source-map.js';
import { matchToolChoicesForStep } from './tool-choice-store.js';
import { getFactEvidence, listMemoryPolicies } from './temporal-memory.js';
import {
  readRecallRefUtilitySignals,
  serializeRecallRef,
  type RecallRefUtilitySignal,
} from './recall-usage.js';

export type MemoryRef =
  | { type: 'fact'; id: string }
  | { type: 'entity'; id: number }
  | { type: 'resource'; id: number }
  | { type: 'episode'; id: string }
  | { type: 'note' | 'procedure' | 'policy'; id: string };

export interface MemoryEvidenceHit {
  ref: MemoryRef;
  text: string;
  title?: string;
  score: number;
  confidence: number;
  validFrom?: string;
  validTo?: string;
  evidence: Array<{ episodeId: string; excerpt: string; sourceUri?: string }>;
  whyRecalled: string[];
}

export interface MemoryRecallResult {
  hits: MemoryEvidenceHit[];
  answerability: 'supported' | 'partial' | 'insufficient';
  diagnostics: { candidates: number; stores: string[]; elapsedMs: number; utilityAdjusted?: number };
}

export interface MemoryRecallContext {
  limit?: number;
  perStore?: number;
  graphDepth?: 0 | 1 | 2;
  asOf?: string;
  stores?: Array<'fact' | 'note' | 'entity' | 'resource' | 'episode' | 'policy' | 'procedure'>;
  resourceMinOverlap?: number;
  /** Deterministic clock override for relative temporal queries. */
  now?: string;
  /** User timezone for "today"/"yesterday" resolution. */
  timeZone?: string;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'what', 'when', 'where', 'how', 'your']);
// NB: no bare "person" — it matches inside "in-person" (a common meeting
// phrase) and wrongly flips those queries into the complete-set path. "people"
// covers the roster case.
const COMPLETE_SET_QUERY_RE = /\b(?:all|every|everyone|everybody|complete|full|whole|entire|list|roster|team|teammates?|members?|people|folks|staff|group|crew|department|contacts?|recipients?|attendees?|invitees?|emails?|email addresses?)\b/i;
const TEMPORAL_TOPIC_STOP = new Set([
  ...STOP,
  'as', 'of', 'on', 'in', 'at', 'by', 'before', 'during', 'did', 'do', 'does',
  'happen', 'happened', 'activity', 'activities', 'today', 'tonight', 'tomorrow',
  'yesterday', 'recent', 'recently', 'current', 'currently', 'saved', 'show',
  'tell', 'identify', 'exact', 'full', 'list', 'local', 'memory',
]);
const IN_PERSON_RE = /\b(?:in\s*-?\s*person|inperson)(?=$|[^a-z0-9])/i;
const INSUFFICIENT_MEETING_CONTENT_RE = /\b(?:transcript too short|untranscribed|contained no discussion|no (?:usable )?(?:discussion|transcript)|recording (?:was )?empty)\b/i;
const MEETING_TOPIC_INTENT_RE = /\b(?:about|discuss(?:ed|ion)?|cover(?:ed|age)?|summar(?:y|ize|ise)|topics?|decisions?|action items?|takeaways?|what happened)\b/i;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9._@-]{2,}/g) ?? []).filter((token) => !STOP.has(token)));
}

/** Shared query-shape signal for exact/list recall. Exported so the projection
 * layer uses the same definition as ranking and cannot disagree about whether
 * a clipped roster is a complete answer. */
export function asksForCompleteRecallSet(text: string): boolean {
  return COMPLETE_SET_QUERY_RE.test(text);
}

function looksLikeListBearingText(text: string): boolean {
  const emails = (text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? []).length;
  return emails >= 2
    || /\b(?:roster|team members|members (?:are|include)|recipients? (?:are|include)|attendees? (?:are|include))\b/i.test(text);
}

function temporalTopicTokens(text: string): Set<string> {
  return new Set([...tokens(text)].filter((token) => !TEMPORAL_TOPIC_STOP.has(token)));
}

function hasFastDurableSetCandidate(facts: ConsolidatedFact[], objective: string): boolean {
  if (!asksForCompleteRecallSet(objective)) return false;
  // NB: deliberately NOT gated on lexical overlap with the query. A roster is
  // names + emails; a natural request ("invite everyone to Thursday's sync")
  // shares ~zero topic tokens with it, so a lexical floor would defeat the whole
  // purpose (the 2026-07-19 miss). List-bearing + evidence-backed + a
  // complete-set query shape are the right, sufficient signals.
  return facts.some((fact) =>
    (fact.kind === 'project' || fact.kind === 'reference' || fact.kind === 'user')
    && looksLikeListBearingText(fact.content)
    && getFactEvidence(fact.id).some((item) =>
      (item.status === 'available' || item.status === 'partial') && item.excerpt.trim().length > 0));
}

function preferDurableCompleteSetHits(hits: MemoryEvidenceHit[], objective: string): MemoryEvidenceHit[] {
  if (!asksForCompleteRecallSet(objective)) return hits;
  return hits.map((hit) => {
    // Not gated on query↔fact lexical overlap — see hasFastDurableSetCandidate:
    // a roster won't lexically resemble an invite verb. List-bearing +
    // evidence-backed + complete-set query shape are the signals that matter.
    if (
      (hit.ref.type !== 'fact' && hit.ref.type !== 'policy')
      || hit.evidence.length === 0
      || !looksLikeListBearingText(hit.text)
    ) return hit;
    return {
      ...hit,
      // A complete, source-backed durable set is the actual answer. Same-day
      // episodes are corroboration and must not displace it from the bounded
      // projection merely because their temporal score is 0.97.
      score: clamp(Math.max(hit.score + 0.30, 0.99), 0, 1),
      whyRecalled: Array.from(new Set([...hit.whyRecalled, 'complete-set durable fact preferred'])),
    };
  });
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const hay = tokens(text);
  let matched = 0;
  for (const token of queryTokens) if (hay.has(token)) matched += 1;
  return matched / queryTokens.size;
}

function meetingContentSupportsTopicAnswer(text: string): boolean {
  if (INSUFFICIENT_MEETING_CONTENT_RE.test(text)) return false;
  const summary = text.match(/\bSummary:\s*([\s\S]*?)(?=\n(?:Topics|Participants|Decisions|Action items|Notes|Transcript):|$)/i)?.[1]?.trim();
  if (summary && summary.length >= 40) return true;
  const transcript = text.match(/\bTranscript:\s*([\s\S]*)$/i)?.[1]?.trim();
  if (transcript && transcript.length >= 40) return true;
  // Vault meeting snippets omit the literal `Summary:` label after rendering.
  return text.length >= 100 && tokens(text).size >= 12;
}

function localDateKey(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
  } catch {
    return iso.slice(0, 10);
  }
}

export interface TemporalQueryWindow {
  startMs: number;
  endMs: number;
  startDate: string;
  endDate: string;
  label: string;
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function monthDateRange(dateKey: string, monthOffset: number): { start: string; end: string } {
  const [year, month] = dateKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 + monthOffset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function yearDateRange(dateKey: string, yearOffset: number): { start: string; end: string } {
  const year = Number(dateKey.slice(0, 4)) + yearOffset;
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** Convert a wall-clock instant in an IANA zone to UTC. Iterating the observed
 * offset avoids hard-coded DST assumptions and keeps relative dates stable at
 * midnight boundaries. */
function zonedWallClockMs(dateKey: string, timeZone: string): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let guess = desired;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
    const observed = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
    const delta = desired - observed;
    guess += delta;
    if (delta === 0) break;
  }
  return guess;
}

/** Resolve common event-time expressions to an exact user-local window. This
 * is intentionally deterministic and bounded; unsupported prose leaves the
 * query unfiltered instead of guessing. */
export function resolveTemporalQueryWindow(
  query: string,
  options: { nowMs?: number; timeZone?: string } = {},
): TemporalQueryWindow | null {
  const timeZone = resolveRecallTimeZone(options.timeZone);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const today = localDateKey(new Date(nowMs).toISOString(), timeZone);
  let range: { start: string; end: string; label: string } | null = null;
  const explicitDate = query.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (explicitDate) range = { start: explicitDate, end: explicitDate, label: explicitDate };
  else if (/\byesterday\b/i.test(query)) {
    const date = shiftDateKey(today, -1);
    range = { start: date, end: date, label: 'yesterday' };
  } else if (/\b(?:today|tonight|this\s+(?:morning|afternoon|evening))\b/i.test(query)) {
    range = { start: today, end: today, label: 'today' };
  } else if (/\blast\s+week\b/i.test(query) || /\bthis\s+week\b/i.test(query)) {
    const [year, month, day] = today.split('-').map(Number);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    const thisMonday = shiftDateKey(today, mondayOffset);
    const last = /\blast\s+week\b/i.test(query);
    const start = shiftDateKey(thisMonday, last ? -7 : 0);
    range = { start, end: last ? shiftDateKey(start, 6) : today, label: last ? 'last week' : 'this week' };
  } else if (/\blast\s+month\b/i.test(query) || /\bthis\s+month\b/i.test(query)) {
    const last = /\blast\s+month\b/i.test(query);
    const dates = monthDateRange(today, last ? -1 : 0);
    range = { ...dates, end: last ? dates.end : today, label: last ? 'last month' : 'this month' };
  } else if (/\blast\s+year\b/i.test(query) || /\bthis\s+year\b/i.test(query)) {
    const last = /\blast\s+year\b/i.test(query);
    const dates = yearDateRange(today, last ? -1 : 0);
    range = { ...dates, end: last ? dates.end : today, label: last ? 'last year' : 'this year' };
  } else {
    const year = query.match(/\b(?:in|during)\s+(20\d{2})\b/i)?.[1];
    if (year) range = { start: `${year}-01-01`, end: `${year}-12-31`, label: year };
  }
  if (!range) return null;
  const startMs = zonedWallClockMs(range.start, timeZone);
  const endMs = zonedWallClockMs(shiftDateKey(range.end, 1), timeZone) - 1;
  return { startMs, endMs, startDate: range.start, endDate: range.end, label: range.label };
}

function factHit(fact: ConsolidatedFact, score: number, why: string[]): MemoryEvidenceHit {
  return {
    ref: { type: 'fact', id: String(fact.id) },
    title: `${fact.kind} fact`,
    text: fact.content,
    score: clamp(score, 0, 1),
    confidence: clamp(fact.confidence ?? fact.trustLevel ?? 0.7, 0, 1),
    validFrom: fact.validFrom ?? fact.createdAt,
    validTo: fact.validTo ?? undefined,
    evidence: getFactEvidence(fact.id)
      .filter((item) => (item.status === 'available' || item.status === 'partial') && item.excerpt.trim().length > 0)
      .map((item) => ({
        episodeId: item.episodeId,
        excerpt: item.excerpt,
        sourceUri: item.sourceUri,
      })),
    whyRecalled: why,
  };
}

function mergeHit(target: Map<string, MemoryEvidenceHit>, hit: MemoryEvidenceHit): void {
  const key = `${hit.ref.type}:${hit.ref.id}`;
  const existing = target.get(key);
  if (!existing) { target.set(key, hit); return; }
  existing.score = Math.max(existing.score, hit.score);
  existing.confidence = Math.max(existing.confidence, hit.confidence);
  existing.whyRecalled = Array.from(new Set([...existing.whyRecalled, ...hit.whyRecalled]));
  const evidence = new Map(existing.evidence.map((item) => [`${item.episodeId}:${item.excerpt}`, item]));
  for (const item of hit.evidence) evidence.set(`${item.episodeId}:${item.excerpt}`, item);
  existing.evidence = Array.from(evidence.values());
}

function memoryRefKey(ref: MemoryRef): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * A small, bounded rerank signal from explicit material-use attribution.
 * Relevance, temporal validity, and evidence remain dominant: even a ref used
 * hundreds of times can gain at most +0.08.
 *
 * The signal is signed. When explicit `not_useful` outcomes (user corrections,
 * recall-usage.ts) OUTWEIGH proven uses, the ref earns a bounded PENALTY down to
 * -0.12 — enough to demote a repeatedly-corrected fact below fresh, well-evidenced
 * ones, never enough to override strong current evidence. The penalty is
 * accumulation-gated: a single stray correction against a well-used fact stays in
 * the positive branch (reliability just dampens the bonus); only when corrections
 * outnumber uses does the score go negative, and it deepens with repeated
 * corrections. This is the teeth behind the correction loop — see
 * correction-detector.ts. Symmetric to the positive cap so neither side can
 * dominate evidence.
 */
export function recallUtilityBonus(
  signal: RecallRefUtilitySignal | undefined,
  nowMs = Date.now(),
): number {
  const used = signal?.used ?? 0;
  const notUseful = Math.max(0, signal?.notUseful ?? 0);
  if (!signal || (used <= 0 && notUseful <= 0)) return 0;

  // Negative branch: corrections outweigh proven uses -> bounded demotion.
  if (notUseful > used) {
    const total = used + notUseful;
    const disutility = clamp(notUseful / total, 0, 1);
    // log1p accumulation gate: 1 correction ~0.29, 3 ~0.58, saturating.
    const magnitude = clamp(Math.log1p(notUseful) / Math.log1p(10), 0, 1);
    return -clamp(disutility * (0.10 * magnitude), 0, 0.12);
  }

  if (used <= 0) return 0;
  const total = Math.max(used, used + notUseful);
  const reliability = clamp(used / total, 0, 1);
  const frequency = clamp(Math.log1p(used) / Math.log1p(20), 0, 1);
  let recency = 0;
  const lastUsedMs = signal.lastUsedAt ? Date.parse(signal.lastUsedAt) : Number.NaN;
  if (Number.isFinite(lastUsedMs)) {
    const ageDays = Math.max(0, (nowMs - lastUsedMs) / (24 * 60 * 60 * 1_000));
    recency = 0.02 * Math.exp(-ageDays / 90);
  }
  return clamp(reliability * (0.06 * frequency + recency), 0, 0.08);
}

function applyUtilityRerank(
  hits: MemoryEvidenceHit[],
  nowMs: number,
): { hits: MemoryEvidenceHit[]; adjusted: number } {
  const signals = readRecallRefUtilitySignals(hits.map((hit) => ({
    type: hit.ref.type,
    id: String(hit.ref.id),
  })));
  let adjusted = 0;
  const reranked = hits.map((hit) => {
    const signal = signals.get(serializeRecallRef({ type: hit.ref.type, id: String(hit.ref.id) }));
    const bonus = recallUtilityBonus(signal, nowMs);
    if (bonus === 0 || !signal) return hit;
    adjusted += 1;
    const outcomes = signal.used + signal.notUseful;
    const why = bonus < 0
      // Negative: corrections outweigh uses — demoted so a wrong memory stops resurfacing.
      ? [`flagged not-useful ${signal.notUseful}× (recall demoted)`]
      : [
          `proven useful in ${signal.used} attributed recall${signal.used === 1 ? '' : 's'}`,
          ...(signal.notUseful > 0 ? [`material-use evidence ${signal.used}/${outcomes}`] : []),
        ];
    return {
      ...hit,
      score: clamp(hit.score + bonus, 0, 1),
      whyRecalled: Array.from(new Set([...hit.whyRecalled, ...why])),
    };
  });
  return { hits: reranked, adjusted };
}

function normalizedMeetingSourceUri(sourceUri?: string | null): string | null {
  const trimmed = sourceUri?.trim();
  if (!trimmed || !/^meeting:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    const provider = parsed.hostname.toLowerCase();
    const meetingId = decodeURIComponent(parsed.pathname.replace(/^\/+|\/+$/g, ''));
    if (!provider || !meetingId) return null;
    return `meeting://${provider}/${encodeURIComponent(meetingId)}`;
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

interface MeetingNoteIdentity {
  logicalKey: string;
  sourceUri: string;
}

/** Resolve the stable recording identity embedded in a meeting artifact. This
 * is exact metadata matching, not title/date similarity: if the artifact does
 * not carry a meeting id, it remains an independent note. */
function meetingNoteIdentity(filePath: string): MeetingNoteIdentity | null {
  if (!filePath.replace(/\\/g, '/').includes('/04-Meetings/')) return null;
  const db = openMemoryDb();
  const row = db.prepare(`
    SELECT content FROM vault_chunks
    WHERE path = ? AND content LIKE '%type: meeting-transcript%'
    ORDER BY chunk_index ASC LIMIT 1
  `).get(filePath) as { content: string } | undefined;
  if (!row) return null;
  const value = (key: string) => row.content.match(new RegExp(`^${key}:\\s*(.+)$`, 'im'))?.[1]?.trim();
  const meetingId = value('meeting_id');
  if (!meetingId) return null;
  const provider = value('provider')?.toLowerCase()
    || (IN_PERSON_RE.test(`${value('source') ?? ''} ${filePath}`) ? 'local' : 'recall');
  const derivedSourceUri = normalizedMeetingSourceUri(`meeting://${provider}/${encodeURIComponent(meetingId)}`);
  if (!derivedSourceUri) return null;
  const episode = db.prepare(`
    SELECT source_uri FROM memory_episodes
    WHERE subtype = 'meeting'
      AND (source_uri = ? OR (call_id = ? AND (session_id = ? OR session_id IS NULL)))
    ORDER BY CASE WHEN source_uri = ? THEN 0 ELSE 1 END, occurred_at DESC
    LIMIT 1
  `).get(derivedSourceUri, meetingId, `meeting:${provider}`, derivedSourceUri) as { source_uri: string | null } | undefined;
  const sourceUri = normalizedMeetingSourceUri(episode?.source_uri) ?? derivedSourceUri;
  return { logicalKey: `meeting:${sourceUri}`, sourceUri };
}

function collapseMeetingRepresentations(
  hits: MemoryEvidenceHit[],
  logicalKeys: Map<string, string>,
): MemoryEvidenceHit[] {
  const groups = new Map<string, MemoryEvidenceHit[]>();
  const standalone: MemoryEvidenceHit[] = [];
  for (const hit of hits) {
    const key = logicalKeys.get(memoryRefKey(hit.ref));
    if (!key) { standalone.push(hit); continue; }
    const group = groups.get(key) ?? [];
    group.push(hit);
    groups.set(key, group);
  }

  const collapsed = Array.from(groups.values()).map((group) => {
    if (group.length === 1) return group[0];
    const canonical = group.find((hit) => hit.ref.type === 'episode')
      ?? group.reduce((best, hit) => hit.score > best.score ? hit : best);
    const richest = [...group].sort((a, b) =>
      Number(meetingContentSupportsTopicAnswer(b.text)) - Number(meetingContentSupportsTopicAnswer(a.text))
      || b.text.length - a.text.length
      || Number(b.ref.type === 'episode') - Number(a.ref.type === 'episode'))[0];
    const evidence = new Map<string, MemoryEvidenceHit['evidence'][number]>();
    for (const hit of group) for (const item of hit.evidence) {
      evidence.set(`${item.episodeId}:${item.sourceUri ?? ''}:${item.excerpt}`, item);
    }
    return {
      ...canonical,
      title: canonical.title ?? richest.title,
      text: richest.text,
      score: Math.max(...group.map((hit) => hit.score)),
      confidence: Math.max(...group.map((hit) => hit.confidence)),
      validFrom: canonical.validFrom ?? richest.validFrom,
      validTo: canonical.validTo ?? richest.validTo,
      evidence: Array.from(evidence.values()),
      whyRecalled: Array.from(new Set([
        ...group.flatMap((hit) => hit.whyRecalled),
        'cross-store meeting representations collapsed',
      ])),
    } satisfies MemoryEvidenceHit;
  });
  return [...standalone, ...collapsed];
}

function isValidAt(fact: ConsolidatedFact, asOfMs: number): boolean {
  const from = Date.parse(fact.validFrom ?? fact.createdAt);
  const to = fact.validTo ? Date.parse(fact.validTo) : Number.POSITIVE_INFINITY;
  return (!Number.isFinite(from) || from <= asOfMs) && (!Number.isFinite(to) || asOfMs < to);
}

function diversify(hits: MemoryEvidenceHit[], limit: number): MemoryEvidenceHit[] {
  const selected: MemoryEvidenceHit[] = [];
  for (const hit of hits.sort((a, b) => b.score - a.score)) {
    // Entity hit bodies intentionally share a compact type/count string; their
    // identity lives in `title`. Comparing text alone collapsed an eight-person
    // roster to one visible person. Diversify what the model actually sees.
    const hitTokens = tokens(`${hit.title ?? ''} ${hit.text}`);
    const duplicate = selected.some((existing) => {
      // Cross-store corroboration is useful evidence, not duplication. Keep a
      // fact, its episode, and its policy projection independently visible.
      if (existing.ref.type !== hit.ref.type) return false;
      const other = tokens(`${existing.title ?? ''} ${existing.text}`);
      if (hitTokens.size === 0 || other.size === 0) return false;
      let intersection = 0;
      for (const token of hitTokens) if (other.has(token)) intersection += 1;
      const union = new Set([...hitTokens, ...other]).size;
      return union > 0 && intersection / union >= 0.85;
    });
    if (!duplicate) selected.push(hit);
    if (selected.length >= limit) break;
  }
  return selected;
}

function resolveAsOf(query: string, explicit?: string, nowMs = Date.now(), timeZone?: string): { iso?: string; ms: number } {
  const raw = explicit?.trim()
    || query.match(/\b(?:as of|on)\s+(\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?)/i)?.[1]
    || query.match(/\b(?:as of|in)\s+(\d{4})\b/i)?.[1];
  if (!raw) {
    const relative = /\b(?:as\s+of|by|before)\s+(?:today|yesterday|this\s+(?:week|month|year)|last\s+(?:week|month|year))\b/i.test(query)
      ? resolveTemporalQueryWindow(query, { nowMs, timeZone })
      : null;
    if (!relative) return { ms: nowMs };
    return { iso: new Date(relative.endMs).toISOString(), ms: relative.endMs };
  }
  const normalized = /^\d{4}$/.test(raw) ? `${raw}-12-31T23:59:59.999Z`
    : /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z`
      : raw.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : { ms: nowMs };
}

/** Evidence-backed hybrid recall over the complete local memory set. Stored
 * graph links expand candidates, but inferred graph edges never affect recall. */
export async function recallMemory(query: string, context: MemoryRecallContext = {}): Promise<MemoryRecallResult> {
  const started = Date.now();
  const objective = query.replace(/\s+/g, ' ').trim();
  const limit = clamp(context.limit ?? 12, 1, 50);
  const perStore = clamp(context.perStore ?? Math.max(8, limit), 1, 30);
  const depth = context.graphDepth ?? 1;
  const wanted = new Set(context.stores ?? ['fact', 'note', 'entity', 'resource', 'episode', 'policy', 'procedure']);
  const usedStores = new Set<string>();
  const merged = new Map<string, MemoryEvidenceHit>();
  const logicalMeetingKeys = new Map<string, string>();
  if (!objective) return { hits: [], answerability: 'insufficient', diagnostics: { candidates: 0, stores: [], elapsedMs: 0 } };
  const queryTokens = tokens(objective);
  const contextNowMs = context.now ? Date.parse(context.now) : Date.now();
  const nowMs = Number.isFinite(contextNowMs) ? contextNowMs : Date.now();
  const timeZone = resolveRecallTimeZone(context.timeZone);
  const recallTime = resolveAsOf(objective, context.asOf, nowMs, timeZone);
  const asOfMs = recallTime.ms;
  const historicalAsOf = recallTime.iso;
  const temporalMeetingDate = resolveTemporalMeetingDate(objective, { nowMs, timeZone });
  const temporalMeetingTopicQuery = Boolean(temporalMeetingDate && MEETING_TOPIC_INTENT_RE.test(objective));
  const temporalWindow = resolveTemporalQueryWindow(objective, { nowMs, timeZone });
  const searchFactsAsGraphBridge = wanted.has('fact') || depth > 0;

  // Exact/list requests frequently have a complete, source-backed durable fact
  // already available synchronously. In that case, do not spend the primer's
  // latency budget embedding the same query or searching the vault before
  // ranking the fact. The remaining graph/episode passes still corroborate it.
  const lexicalFacts = searchFactsAsGraphBridge
    ? (historicalAsOf
        ? searchFactsByTextAt(objective, historicalAsOf, perStore)
        : searchFactsByText(objective, perStore))
    : [];
  const fastDurableSetCandidate = hasFastDurableSetCandidate(lexicalFacts, objective);

  const [semanticFacts, notes] = await Promise.all([
    searchFactsAsGraphBridge && !fastDurableSetCandidate
      ? findSimilarFactsScored(objective, { topK: perStore, asOf: historicalAsOf }).catch(() => [])
      : Promise.resolve([]),
    wanted.has('note') && !fastDurableSetCandidate
      ? recallHybrid(objective, { limit: perStore, nowMs, timeZone }).catch(() => [])
      : Promise.resolve([]),
  ]);

  const factIds = new Set<number>();
  if (searchFactsAsGraphBridge) {
    if (wanted.has('fact')) usedStores.add('fact');
    const lexical = lexicalFacts;
    const semanticById = new Map(semanticFacts.map((item, rank) => [item.fact.id, { ...item, rank }]));
    for (const fact of [...semanticFacts.map((item) => item.fact), ...lexical]) {
      if (!isValidAt(fact, asOfMs)) continue;
      factIds.add(fact.id);
      const semantic = semanticById.get(fact.id);
      const semanticScore = semantic?.sim == null ? 0 : clamp((semantic.sim + 1) / 2, 0, 1);
      const lexicalScore = lexicalRelevance(objective, fact.content);
      const confidence = fact.confidence ?? fact.trustLevel ?? 0.7;
      const importance = (fact.importance ?? 5) / 10;
      const score = 0.45 * semanticScore + 0.30 * lexicalScore + 0.15 * confidence + 0.10 * importance;
      const hit = factHit(fact, Math.max(score, semantic ? 0.35 - semantic.rank * 0.005 : 0.25), []);
      hit.whyRecalled = [
        semanticScore > 0 ? `semantic similarity ${semanticScore.toFixed(2)}` : '',
        lexicalScore > 0 ? `lexical relevance ${lexicalScore.toFixed(2)}` : '',
        hit.evidence.length > 0 ? 'source-backed' : '',
      ].filter(Boolean);
      if (wanted.has('fact')) mergeHit(merged, hit);
    }
  }

  if (wanted.has('note')) {
    usedStores.add('note');
    notes.forEach((note, rank) => {
      const normalizedPath = note.filePath.replace(/\\/g, '/');
      const inPersonMatch = IN_PERSON_RE.test(objective)
        && IN_PERSON_RE.test(`${normalizedPath} ${note.title} ${note.snippet}`);
      const exactTemporalMeeting = Boolean(
        temporalMeetingDate
        && normalizedPath.includes('/04-Meetings/')
        && (normalizedPath.includes(temporalMeetingDate) || note.snippet.includes(temporalMeetingDate)),
      );
      const identity = meetingNoteIdentity(note.filePath);
      const hit: MemoryEvidenceHit = {
        ref: { type: 'note', id: note.filePath },
        title: note.title,
        text: note.snippet,
        score: exactTemporalMeeting
          ? clamp(0.98 - rank * 0.01, 0.85, 0.98)
          : clamp(0.68 - rank * 0.025, 0.2, 0.68),
        confidence: exactTemporalMeeting ? 0.95 : 0.8,
        validFrom: note.occurredAt,
        evidence: [{ episodeId: `note:${note.filePath}`, excerpt: note.snippet, sourceUri: note.filePath }],
        whyRecalled: exactTemporalMeeting
          ? ['exact temporal match', inPersonMatch ? 'in-person capture match' : '', 'recorded meeting source', 'vault type meeting-transcript'].filter(Boolean)
          : ['vault lexical/vector retrieval'],
      };
      mergeHit(merged, hit);
      if (identity) logicalMeetingKeys.set(memoryRefKey(hit.ref), identity.logicalKey);
    });
  }

  const directEntityIdSet = new Set<number>();
  const factLinkedEntityIdSet = new Set<number>();
  const neighborEntityIdSet = new Set<number>();
  const entityIds = new Set<number>();
  if (wanted.has('entity') || depth > 0) {
    const directEntityIds = resolveEntityIdsForText(objective, perStore);
    for (const id of directEntityIds) {
      directEntityIdSet.add(id);
      entityIds.add(id);
      if (depth > 0) for (const factId of getFactIdsForEntity(id, perStore, historicalAsOf)) factIds.add(factId);
    }
  }

  const directResources = (wanted.has('resource') || depth > 0 ? listAllResourcePointers() : [])
    .map((resource) => ({ resource, overlap: overlapScore(queryTokens, `${resource.name} ${resource.whatsHere ?? ''} ${resource.whenToUse ?? ''}`) }))
    .filter((item) => item.overlap * Math.max(1, queryTokens.size) >= (context.resourceMinOverlap ?? 1))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, perStore);
  const directResourceOverlap = new Map<number, number>();
  const resourceById = new Map<number, ResourcePointer>();
  const resourceIds = new Set<number>();
  const factLinkedResourceIdSet = new Set<number>();
  for (const { resource, overlap } of directResources) {
    directResourceOverlap.set(resource.id, overlap);
    resourceById.set(resource.id, resource);
    resourceIds.add(resource.id);
    if (depth > 0) for (const id of getFactIdsForResource(resource.id, perStore, historicalAsOf)) factIds.add(id);
  }

  // Bidirectional stored-graph expansion. Previous recall could travel from a
  // directly named entity/resource into facts, but a semantic fact hit was a
  // dead end. Traverse the exact persisted joins in the opposite direction so
  // a recalled claim can surface its people, resources, and source episodes.
  // Explicitly inferred text matches remain excluded from recall.
  const graphFactIds = Array.from(factIds).slice(0, perStore * 4);
  const factEntityEdges = depth > 0
    ? loadFactEntityEdges(graphFactIds).filter((edge) => edge.truth === 'stored')
    : [];
  const factResourceEdges = depth > 0
    ? loadFactResourceEdges(graphFactIds).filter((edge) => edge.truth === 'stored')
    : [];
  for (const edge of factEntityEdges) {
    entityIds.add(edge.entityId);
    factLinkedEntityIdSet.add(edge.entityId);
  }
  for (const edge of factResourceEdges) {
    resourceIds.add(edge.resourceId);
    factLinkedResourceIdSet.add(edge.resourceId);
  }

  if (depth === 2 && entityIds.size > 0) {
    const neighbors = getNeighborEntityIds(
      Array.from(entityIds),
      perStore,
      historicalAsOf ?? new Date(asOfMs).toISOString(),
    );
    for (const id of neighbors) {
      entityIds.add(id);
      neighborEntityIdSet.add(id);
    }
    // Second hop: every stored entity/resource reached from a fact can lead to
    // other temporally valid claims. Keep the fan-out bounded per store.
    for (const id of Array.from(entityIds).slice(0, perStore * 2)) {
      for (const factId of getFactIdsForEntity(id, perStore, historicalAsOf)) factIds.add(factId);
    }
    for (const id of Array.from(resourceIds).slice(0, perStore * 2)) {
      for (const factId of getFactIdsForResource(id, perStore, historicalAsOf)) factIds.add(factId);
    }
  }

  if (entityIds.size > 0 && wanted.has('entity')) {
    const ids = Array.from(entityIds).slice(0, perStore * 3);
    const ph = ids.map(() => '?').join(',');
    const rows = openMemoryDb().prepare(`
      SELECT id, entity_type, canonical_name, mention_count FROM entities WHERE id IN (${ph})
    `).all(...ids) as Array<{ id: number; entity_type: string; canonical_name: string; mention_count: number }>;
    for (const row of rows) {
      const supportingEdges = factEntityEdges.filter((edge) => edge.entityId === row.id);
      const evidence = supportingEdges
        .filter((edge) => edge.evidenceEpisodeId && edge.evidenceExcerpt?.trim())
        .map((edge) => ({
          episodeId: edge.evidenceEpisodeId!,
          excerpt: edge.evidenceExcerpt!,
        }));
      const direct = directEntityIdSet.has(row.id);
      const factLinked = factLinkedEntityIdSet.has(row.id);
      mergeHit(merged, {
        ref: { type: 'entity', id: row.id },
        title: row.canonical_name,
        text: `${row.entity_type} · mentioned ${row.mention_count}×`,
        score: direct ? 0.72 : factLinked ? 0.58 : 0.48,
        confidence: supportingEdges.length > 0
          ? Math.max(...supportingEdges.map((edge) => edge.confidence))
          : 0.75,
        evidence,
        whyRecalled: [
          direct ? 'entity name or alias matched' : '',
          factLinked ? 'stored fact-to-entity relationship' : '',
          neighborEntityIdSet.has(row.id) ? 'stored entity relationship' : '',
        ].filter(Boolean),
      });
    }
    usedStores.add('entity');
  }

  for (const resource of getResourcePointersByIds(Array.from(resourceIds))) resourceById.set(resource.id, resource);
  if (wanted.has('resource')) {
    for (const resource of Array.from(resourceById.values()).slice(0, perStore * 3)) {
      const supportingEdges = factResourceEdges.filter((edge) => edge.resourceId === resource.id);
      const evidence = supportingEdges
        .filter((edge) => edge.evidenceEpisodeId && edge.evidenceExcerpt?.trim())
        .map((edge) => ({ episodeId: edge.evidenceEpisodeId!, excerpt: edge.evidenceExcerpt! }));
      const overlap = directResourceOverlap.get(resource.id);
      const factLinked = factLinkedResourceIdSet.has(resource.id);
      mergeHit(merged, {
        ref: { type: 'resource', id: resource.id },
        title: resource.name,
        text: `${resource.app}${resource.whatsHere ? ` · ${resource.whatsHere}` : ''}`,
        score: overlap !== undefined ? 0.38 + 0.42 * overlap : factLinked ? 0.56 : 0.42,
        confidence: supportingEdges.length > 0
          ? Math.max(resource.trust ?? 0.7, ...supportingEdges.map((edge) => edge.confidence))
          : resource.trust ?? 0.7,
        evidence,
        whyRecalled: [
          overlap !== undefined ? `resource overlap ${overlap.toFixed(2)}` : '',
          factLinked ? 'stored fact-to-resource relationship' : '',
        ].filter(Boolean),
      });
    }
    if (resourceById.size > 0) usedStores.add('resource');
  }

  // Graph-expanded facts are evidence-bearing context, not merely breadcrumbs.
  if (wanted.has('fact')) for (const id of factIds) {
    const fact = historicalAsOf ? getFactAt(id, historicalAsOf) : getFact(id);
    if (!fact || (!historicalAsOf && !fact.active) || !isValidAt(fact, asOfMs)) continue;
    mergeHit(merged, factHit(fact, 0.58 + 0.2 * lexicalRelevance(objective, fact.content), ['stored graph traversal']));
  }

  if (wanted.has('episode') && depth > 0) {
    let linkedEpisodes = 0;
    for (const factId of Array.from(factIds).slice(0, perStore * 4)) {
      for (const evidence of getFactEvidence(factId)) {
        if (linkedEpisodes >= perStore * 3) break;
        if ((evidence.status !== 'available' && evidence.status !== 'partial') || !evidence.excerpt.trim()) continue;
        const occurredAtMs = Date.parse(evidence.occurredAt);
        if (Number.isFinite(occurredAtMs) && occurredAtMs > asOfMs) continue;
        mergeHit(merged, {
          ref: { type: 'episode', id: evidence.episodeId },
          title: 'supporting memory episode',
          text: evidence.excerpt,
          score: 0.56,
          confidence: evidence.status === 'available' ? 0.85 : 0.65,
          validFrom: evidence.occurredAt,
          evidence: [{ episodeId: evidence.episodeId, excerpt: evidence.excerpt, sourceUri: evidence.sourceUri }],
          whyRecalled: ['stored fact-to-evidence relationship', `supports fact:${factId}`],
        });
        linkedEpisodes += 1;
      }
    }
    if (linkedEpisodes > 0) usedStores.add('episode');
  }

  if (wanted.has('episode')) {
    const db = openMemoryDb();
    const tokenList = Array.from(queryTokens).slice(0, 8);
    const topicalTokens = temporalWindow ? temporalTopicTokens(objective) : queryTokens;
    const broadTemporalQuery = Boolean(temporalWindow && topicalTokens.size === 0);
    const lexicalClauses = tokenList.map(() => `LOWER(COALESCE(title, '') || ' ' || COALESCE(source_app, '') || ' ' || evidence_excerpt) LIKE ?`);
    // A temporal meeting query is type-constrained. The previous `1 = 1`
    // temporal widening admitted every episode from that day, allowing an
    // unrelated manual memory to answer "what was my meeting about?" with
    // false confidence when no meeting existed.
    const candidateClauses = temporalMeetingDate
      ? ["subtype = 'meeting'"]
      : [
          ...(lexicalClauses.length > 0 ? [`(${lexicalClauses.join(' OR ')})`] : []),
          ...(temporalWindow ? ['1 = 1'] : []),
        ];
    const baseEpisodeSql = `
      SELECT id, kind, subtype, title, source_app, source_uri, occurred_at, evidence_excerpt, status
      FROM memory_episodes
      WHERE evidence_excerpt IS NOT NULL
        AND status IN ('available','partial')
        AND (${candidateClauses.join(' OR ')})
      ORDER BY occurred_at DESC
    `;
    const episodeQueryTokens = temporalMeetingDate ? [] : tokenList;
    const rows = candidateClauses.length === 0 ? [] : (temporalWindow
      ? db.prepare(baseEpisodeSql).all(...episodeQueryTokens.map((token) => `%${token}%`))
      : db.prepare(`${baseEpisodeSql} LIMIT ?`).all(...episodeQueryTokens.map((token) => `%${token}%`), temporalMeetingDate ? 200 : perStore)) as Array<{
      id: string; kind: string; subtype: string | null; title: string | null; source_app: string | null; source_uri: string | null;
      occurred_at: string; evidence_excerpt: string; status: MemoryEpisodeStatus;
    }>;
    const rankedEpisodes = rows.map((row) => {
      const lexical = overlapScore(
        temporalWindow && !broadTemporalQuery ? topicalTokens : queryTokens,
        `${row.title ?? ''} ${row.source_app ?? ''} ${row.evidence_excerpt}`,
      );
      const occurredAtMs = Date.parse(row.occurred_at);
      const temporalMatch = Boolean(temporalWindow && Number.isFinite(occurredAtMs)
        && occurredAtMs >= temporalWindow.startMs && occurredAtMs <= temporalWindow.endMs);
      const exactTemporalMeeting = Boolean(temporalMeetingDate
        && row.subtype === 'meeting'
        && localDateKey(row.occurred_at, timeZone) === temporalMeetingDate);
      return { row, lexical, temporalMatch, exactTemporalMeeting };
    }).filter((item) => temporalMeetingDate
      ? item.exactTemporalMeeting
      : temporalWindow
        ? item.temporalMatch && (broadTemporalQuery || item.lexical > 0)
        : item.lexical > 0)
      .sort((a, b) => Number(b.exactTemporalMeeting) - Number(a.exactTemporalMeeting)
        || Number(b.temporalMatch) - Number(a.temporalMatch) || b.lexical - a.lexical)
      .slice(0, perStore);
    if (rankedEpisodes.length > 0) usedStores.add('episode');
    for (const { row, lexical, temporalMatch, exactTemporalMeeting } of rankedEpisodes) {
      const hit: MemoryEvidenceHit = {
      ref: { type: 'episode', id: row.id },
      title: row.title ?? row.source_app ?? row.kind,
      text: row.evidence_excerpt,
      score: exactTemporalMeeting
        ? 0.97
        : temporalMatch
          ? broadTemporalQuery ? 0.72 : 0.48 + 0.40 * lexical
          : 0.35 + 0.45 * lexical,
      confidence: row.status === 'available' ? 0.9 : row.status === 'partial' ? 0.65 : 0.4,
      validFrom: row.occurred_at,
      evidence: [{ episodeId: row.id, excerpt: row.evidence_excerpt, sourceUri: row.source_uri ?? undefined }],
      whyRecalled: exactTemporalMeeting
        ? ['exact temporal match', 'first-class recorded meeting episode', row.source_app?.includes('In-person') ? 'in-person capture match' : '']
          .filter(Boolean)
        : [
            temporalMatch && temporalWindow ? `temporal window match: ${temporalWindow.label}` : '',
            'durable episode evidence',
            row.subtype ? `${row.subtype} episode` : '',
          ].filter(Boolean),
      };
      mergeHit(merged, hit);
      const sourceIdentity = normalizedMeetingSourceUri(row.source_uri);
      if (row.subtype === 'meeting' && sourceIdentity) {
        logicalMeetingKeys.set(memoryRefKey(hit.ref), `meeting:${sourceIdentity}`);
      }
    }
  }

  if (wanted.has('policy')) {
    for (const policy of listMemoryPolicies()) {
      const fact = getFact(policy.fact_id);
      if (!fact) continue;
      const relevance = lexicalRelevance(objective, fact.content);
      if (relevance <= 0 && policy.policy_type !== 'hard_constraint') continue;
      if (relevance <= 0) continue;
      usedStores.add('policy');
      mergeHit(merged, {
        ...factHit(fact, 0.55 + 0.35 * relevance, [`${policy.policy_type}`, `${policy.enforcement}-enforced`]),
        ref: { type: 'policy', id: String(policy.fact_id) },
        title: policy.policy_type.replace(/_/g, ' '),
      });
    }
  }

  if (wanted.has('procedure')) {
    const procedures = matchToolChoicesForStep(objective, { limit: perStore });
    if (procedures.length > 0) usedStores.add('procedure');
    procedures.forEach((procedure, rank) => mergeHit(merged, {
      ref: { type: 'procedure', id: procedure.procedureId ?? procedure.intent },
      title: procedure.intent,
      text: `proven tool → ${procedure.kind}:${procedure.identifier}`,
      score: clamp(0.62 - rank * 0.025, 0.25, 0.62),
      confidence: 0.75,
      evidence: [],
      whyRecalled: ['procedural intent match'],
    }));
  }

  const utilityRerank = applyUtilityRerank(Array.from(merged.values()), nowMs);
  const completeSetRerank = preferDurableCompleteSetHits(utilityRerank.hits, objective);
  const logicalCandidates = collapseMeetingRepresentations(completeSetRerank, logicalMeetingKeys)
    .map((hit) => temporalMeetingTopicQuery && hit.whyRecalled.includes('exact temporal match')
      && !meetingContentSupportsTopicAnswer(hit.text)
      ? {
          ...hit,
          score: Math.min(hit.score, 0.62),
          whyRecalled: Array.from(new Set([...hit.whyRecalled, 'recording exists; topic unavailable'])),
        }
      : hit);
  const intentCandidates = temporalMeetingDate
    ? logicalCandidates.filter((hit) => hit.whyRecalled.includes('exact temporal match'))
    : logicalCandidates;
  const hits = diversify(intentCandidates, limit);
  const supported = temporalMeetingDate
    ? hits.some((hit) => hit.evidence.length > 0
      && hit.score >= 0.45
      && (!temporalMeetingTopicQuery || meetingContentSupportsTopicAnswer(hit.text)))
    : hits.some((hit) => hit.evidence.length > 0 && hit.score >= 0.45);
  return {
    hits,
    answerability: supported ? 'supported' : hits.length > 0 ? 'partial' : 'insufficient',
    diagnostics: {
      candidates: merged.size,
      stores: Array.from(usedStores),
      elapsedMs: Date.now() - started,
      utilityAdjusted: utilityRerank.adjusted,
    },
  };
}
