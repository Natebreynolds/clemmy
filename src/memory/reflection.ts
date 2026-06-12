import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import pino from 'pino';
import { MODELS, getRuntimeEnv } from '../config.js';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';
import { openMemoryDb, type ConsolidatedFactKind, type ConsolidatedFactRow, type EntityType, type EntityRow, type EpisodicPointerRow } from './db.js';
import {
  rememberFact,
  updateFact,
  deleteFact,
  getFact,
  setFactPinned,
  findSimilarFacts,
  findSimilarFactsScored,
  type RememberInput,
  type ConsolidatedFact,
} from './facts.js';
import { recordToolEvent } from '../agents/tool-observability.js';
import { classifySource, isSourceTrustEnabled, AUTHORITATIVE_TRUST } from './authoritative-sources.js';
import { isSourceMapEnabled, upsertResourcePointer } from './source-map.js';
import { cosine, loadFactEmbeddings } from './embeddings.js';

/**
 * Reflection-on-tool-return — Phase 1 of the brain architecture.
 *
 * Implements Stanford Generative Agents' reflection loop (Park et al,
 * 2023, arxiv.org/abs/2304.03442) for tool returns specifically. After
 * any tool produces structured output above a content threshold, this
 * module runs an async pass via the fast-tier model that extracts:
 *
 *   - FACTS — durable semantic-memory entries (Tulving) about the user,
 *     their projects, references they'll want again later. Each fact
 *     carries `derivedFrom: { sessionId, callId, tool }` so the agent
 *     can recall the verbatim source via recall_tool_result.
 *
 *   - ENTITIES — first-class people / companies / projects / places /
 *     things mentioned in the output. Stored in the `entities` table
 *     with aliases for cross-source matching.
 *
 *   - POINTERS — short human-readable labels ("the pricing convo") that
 *     map to a specific (session_id, call_id) so the agent can refer to
 *     the source without re-fetching from the provider.
 *
 * Non-blocking. Fired from hooks.ts onToolEnd as a fire-and-forget
 * Promise that catches all errors. A reflection failure must never
 * affect the tool result returning to the SDK.
 *
 * The "pointer-first" novelty (see [[project_brain_architecture]]) is
 * what makes this useful at scale: the brain stores derived knowledge
 * + pointers, NOT raw tool outputs. The raw outputs live in the
 * tool_outputs table (v0.5.10) and are recallable via the
 * recall_tool_result tool when the agent actually needs them.
 */

const logger = pino({ name: 'clementine.memory.reflection' });

export const REFLECTION_MIN_CONTENT_CHARS = 500;
const REFLECTION_MAX_INPUT_CHARS = 8_000;

const FACT_KIND_VALUES = ['user', 'project', 'feedback', 'reference'] as const;
const ENTITY_TYPE_VALUES = ['person', 'company', 'project', 'place', 'thing'] as const;

const ExtractedFactSchema = z.object({
  kind: z.enum(FACT_KIND_VALUES),
  text: z.string().min(3).max(500),
  // Stanford §4.1: poignancy 1.0–10.0. 1=mundane, 10=life-changing.
  // The extractor MUST set this. Used as the reflection-trigger sum
  // gate (sum-importance ≥ 150 per Stanford) AND as the retrieval
  // weight in memory_search.
  importance: z.number().min(1).max(10),
});
const ExtractedEntitySchema = z.object({
  type: z.enum(ENTITY_TYPE_VALUES),
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(120)).optional(),
});
const ExtractedPointerSchema = z.object({
  label: z.string().min(3).max(120),
  source_uri: z.string().max(200).optional(),
});
// Source-map / landscape memory (pointer-first): a NAMED LOCATION the output
// reveals (a Drive folder, an Airtable base, a CRM object) — where data lives,
// not the data itself.
const ExtractedResourceSchema = z.object({
  kind: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
  ref: z.string().max(200).optional(),
  whats_here: z.string().max(200).optional(),
  when_to_use: z.string().max(160).optional(),
});
const ExtractionSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(8),
  entities: z.array(ExtractedEntitySchema).max(12),
  pointers: z.array(ExtractedPointerSchema).max(4),
});
// Variant used only when CLEMMY_SOURCE_MAP is on, so the flag-off extractor
// schema + prompt stay byte-identical to today.
const ExtractionSchemaWithResources = z.object({
  facts: z.array(ExtractedFactSchema).max(8),
  entities: z.array(ExtractedEntitySchema).max(12),
  pointers: z.array(ExtractedPointerSchema).max(4),
  resources: z.array(ExtractedResourceSchema).max(6),
});
export type Extraction = z.infer<typeof ExtractionSchema> & {
  resources?: z.infer<typeof ExtractedResourceSchema>[];
};

export interface ReflectionInput {
  sessionId: string;
  callId: string;
  tool: string | null;
  output: string;
}

export interface ReflectionResult {
  factsWritten: number;
  factsUpdated?: number;
  factsDeleted?: number;
  factsNoop?: number;
  entitiesUpserted: number;
  pointersStored: number;
  sumImportance?: number;
  skipped?: 'too_short' | 'already_reflected' | 'extractor_failed' | 'disabled' | 'low_importance' | 'self_tool';
}

const PROMPT_PREAMBLE = buildExtractorPreamble(false);
const PROMPT_PREAMBLE_WITH_RESOURCES = buildExtractorPreamble(true);

function buildExtractorPreamble(includeResources: boolean): string {
  const shape = [
    '  "facts": [{ "kind": "user|project|feedback|reference", "text": "<short fact>", "importance": <1-10> }],',
    '  "entities": [{ "type": "person|company|project|place|thing", "name": "<canonical>", "aliases": ["<alt>", ...] }],',
    includeResources
      ? '  "pointers": [{ "label": "<short human label>", "source_uri": "<optional uri like outlook:thread:abc>" }],'
      : '  "pointers": [{ "label": "<short human label>", "source_uri": "<optional uri like outlook:thread:abc>" }]',
  ];
  if (includeResources) {
    shape.push('  "resources": [{ "kind": "folder|file|doc|sheet|base|table|object|channel|label", "name": "<resource name>", "ref": "<optional stable id/uri>", "whats_here": "<one phrase: what this holds>", "when_to_use": "<optional: when to come back here>" }]');
  }
  const lines = [
    'You are the reflection layer of a long-running personal assistant.',
    'Read the tool output below and extract DURABLE knowledge the assistant should remember about the USER, their PROJECTS, or REFERENCES they may want to revisit. Be conservative — only extract facts that will plausibly matter weeks from now. If nothing durable is in this output, return empty arrays.',
    '',
    'Return strict JSON matching this shape:',
    '{',
    ...shape,
    '}',
    '',
    'IMPORTANCE SCALE (per Park et al, Generative Agents §4.1):',
    '  1 = purely mundane (e.g., user opened their inbox)',
    '  4 = routine but recurring (e.g., weekly meeting with X)',
    '  7 = notable / actionable for the user (e.g., new project kickoff)',
    '  10 = extremely poignant (e.g., job offer, contract signing, life event)',
    'Score conservatively. A typical derived fact is 3-5. Only push 7+ for things that change how the user works.',
    '',
    'Rules:',
    '- Facts must be ATOMIC (one statement per entry), present-tense, third-person if about the user (e.g. "User\'s preferred meeting time is Tuesday afternoons").',
    '- Pull entities (people, companies, projects) even if you have no fact about them yet — the registry uses them.',
    '- "pointers" are short labels the user might use later ("the pricing convo with Marlow"); only include when the output describes a notable thread/event/document.',
  ];
  if (includeResources) {
    lines.push('- "resources" are NAMED LOCATIONS this output reveals — a Drive folder, an Airtable base/table, a CRM object, a mail label, a channel. Capture WHERE data lives + what it holds (NOT the content). Only include real, re-visitable containers; skip one-off records and the data values themselves.');
  }
  lines.push(
    '- DO NOT extract ephemeral state (current weather, request-ids, timestamps).',
    `- DO NOT invent facts. If the output is noise/empty/error, return all ${includeResources ? 'four' : 'three'} arrays empty.`,
    '- Output ONLY the JSON object. No markdown fences. No commentary.',
  );
  return lines.join('\n');
}

function getReflectorModel(): string {
  return MODELS.fast || MODELS.primary || 'gpt-5.4-mini';
}

function readDisableFlag(): boolean {
  const raw = (process.env.CLEMMY_REFLECTION ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'false' || raw === '0';
}

// Self/introspective tools whose returns are Clementine's OWN internal state
// (memory, tasks, plans, execution status), NOT external/user data. Reflecting
// on them manufactures self-referential facts and a memory_read→fact recursion
// at derivation_depth 0 (so the nightly recursive-depth cap does NOT guard it).
// The 2026-06-08 memory audit found >50% of the fact store was self-referential
// this way (59 facts derived from memory_read alone). We skip reflection on
// these. KEEP read_file / run_shell_command / skill_read / workflow_run
// reflectable — they surface real user/external content.
const SELF_TOOL_DENY_EXACT = new Set<string>([
  'recall_tool_result', 'tool_output_query',
  'draft_plan', 'task_list', 'task_get', 'task_create', 'task_update',
  'workflow_get', 'workflow_list', 'workflow_schedule',
]);
const SELF_TOOL_DENY_PREFIXES = ['memory_', 'background_task', 'execution_'];

export function isSelfReferentialTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  const name = toolName.trim().toLowerCase();
  if (!name) return false;
  if (SELF_TOOL_DENY_EXACT.has(name)) return true;
  return SELF_TOOL_DENY_PREFIXES.some((p) => name.startsWith(p));
}

// Filter defaults ON (do NOT reflect on self/introspective tools). The
// kill-switch CLEMMY_REFLECT_SELF_TOOLS=on restores the old reflect-everything
// behavior. Read via getRuntimeEnv so a live ~/.clementine-next/.env override
// applies under launchd too.
function selfToolReflectionFilterEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_REFLECT_SELF_TOOLS', 'off') || 'off').toLowerCase() !== 'on';
}

// Stanford §4.2: reflection fires when sum(importance) of recent
// observations crosses a threshold. Their published agents use 150 on
// a 1-10 importance scale. Clementine's event stream is sparser (tool
// returns, not lived experience) so the default is half — calibrate
// from autoresearch telemetry after a week of real use. Setting
// CLEMMY_REFLECTION_THRESHOLD=0 disables importance gating entirely
// (revert to v0.5.11 commit-every-extraction behavior).
const DEFAULT_REFLECTION_THRESHOLD = 75;

export function getReflectionThreshold(): number {
  const raw = (process.env.CLEMMY_REFLECTION_THRESHOLD ?? '').trim();
  if (!raw) return DEFAULT_REFLECTION_THRESHOLD;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REFLECTION_THRESHOLD;
  return parsed;
}

interface SessionImportanceCounter {
  sum: number;
  lastUpdatedAt: number;
}
const SESSION_IMPORTANCE = new Map<string, SessionImportanceCounter>();
const SESSION_IMPORTANCE_IDLE_MS = 24 * 60 * 60 * 1000; // 24h reset

function accumulateImportance(sessionId: string, delta: number): SessionImportanceCounter {
  const now = Date.now();
  const existing = SESSION_IMPORTANCE.get(sessionId);
  if (!existing || now - existing.lastUpdatedAt > SESSION_IMPORTANCE_IDLE_MS) {
    const fresh: SessionImportanceCounter = { sum: delta, lastUpdatedAt: now };
    SESSION_IMPORTANCE.set(sessionId, fresh);
    return fresh;
  }
  existing.sum += delta;
  existing.lastUpdatedAt = now;
  return existing;
}

function resetSessionImportance(sessionId: string): void {
  SESSION_IMPORTANCE.delete(sessionId);
}

// Exported for tests only — lets the test suite peek/reset state
// without exposing the internal map shape.
export function _testOnly_peekSessionImportance(sessionId: string): number {
  return SESSION_IMPORTANCE.get(sessionId)?.sum ?? 0;
}
export function _testOnly_resetAllSessionImportance(): void {
  SESSION_IMPORTANCE.clear();
}
/**
 * Pure handle on the extractor for smoke testing. Bypasses the public
 * reflectOnToolReturn entry (which also touches the memory DB) so a
 * smoke test can hammer real Codex N times without polluting state.
 * Returns `null` when the extractor fails (thrown OR invalid-shape).
 */
export async function _testOnly_runExtractor(serialized: string): Promise<Extraction | null> {
  return runExtractor(serialized);
}

/**
 * Per-process de-dup so the same (session_id, call_id) doesn't get
 * reflected twice if the daemon's hook fires the path twice (e.g.
 * SDK retry on a tool that was marked successful then re-emitted).
 * Bounded to avoid unbounded growth on long-running daemons.
 */
const RECENT_REFLECTED = new Set<string>();
const RECENT_REFLECTED_MAX = 2000;
function markReflected(key: string): void {
  RECENT_REFLECTED.add(key);
  if (RECENT_REFLECTED.size > RECENT_REFLECTED_MAX) {
    // Drop the oldest ~25% in arrival order
    const iter = RECENT_REFLECTED.values();
    for (let i = 0; i < RECENT_REFLECTED_MAX / 4; i++) {
      const next = iter.next();
      if (next.done) break;
      RECENT_REFLECTED.delete(next.value);
    }
  }
}

async function runExtractor(serialized: string): Promise<Extraction | null> {
  const model = getReflectorModel();
  // Source-map: when on, ask the extractor for `resources` too (named
  // locations). Flag-off keeps the schema + prompt byte-identical to today.
  const withResources = isSourceMapEnabled();
  const schema = withResources ? ExtractionSchemaWithResources : ExtractionSchema;
  const instructions = withResources ? PROMPT_PREAMBLE_WITH_RESOURCES : PROMPT_PREAMBLE;
  try {
    // v0.5.22.1 — outputType binds ExtractionSchema to the SDK's structured-
    // output path, so OpenAI's grammar-constrained sampling guarantees a
    // schema-conforming response (no more "reflection extractor returned
    // invalid shape" warnings). normalizeZodForCodexStrict rewrites
    // .optional() → .nullable() so Codex's strict-mode validator accepts.
    const agent = new Agent<unknown, typeof ExtractionSchema>({
      name: 'Reflection Extractor',
      model,
      instructions,
      outputType: normalizeZodForCodexStrict(schema) as typeof ExtractionSchema,
    });
    const runner = new Runner({ workflowName: 'clementine-reflection' });
    const result = await runner.run(agent, serialized);
    const final = (result as { finalOutput?: unknown }).finalOutput;
    if (!final || typeof final !== 'object') return null;
    return final as Extraction;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'reflection extractor failed');
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Mem0-style conflict resolution (Chhikara et al §2.1)
// ─────────────────────────────────────────────────────────────────

// Same ceiling as the extraction schema's fact text. The resolver's
// finalOutput is CAST, not zod-parsed, so the cap is re-enforced at the
// updateFact call site — an oversized rewrite falls back to candidate.text.
const CONFLICT_REWRITE_MAX_CHARS = 500;

const ConflictDecisionSchema = z.object({
  decision: z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']),
  target_id: z.number().int().nullable().optional(),
  rewrite: z.string().min(3).max(CONFLICT_REWRITE_MAX_CHARS).optional(),
  reason: z.string().max(300).optional(),
});

const CONFLICT_PROMPT = [
  'You are a memory-conflict resolver. A new candidate fact has been extracted from a tool return. Existing facts may or may not contradict it.',
  '',
  'Decide ONE of:',
  '  ADD    — no existing fact contradicts or duplicates this; store it.',
  '  UPDATE — an existing fact carries STALE / INCOMPLETE info that this new fact supersedes. Set target_id to its id, and optionally provide `rewrite` if the new fact should replace the existing content verbatim (otherwise the existing fact gets the new content).',
  '  DELETE — an existing fact is now FALSE according to the new fact (user changed their mind). Set target_id; the new fact is implicit (the absence). Soft-deletes the old fact.',
  '  NOOP   — the new fact is already represented (semantic duplicate). target_id = the existing id we matched against. No write happens.',
  '',
  'Be conservative — when in doubt, ADD. UPDATE/DELETE require clear contradiction, not vague semantic overlap.',
  '',
  'TRUST / AUTHORITY: each fact has a trust score (0–1). user-stated ≈ 1.0; a system of record (CRM, calendar, mailbox, database) ≈ 0.9 = CANONICAL ground truth; a generic inference ≈ 0.6; a public web/scrape ≈ 0.5. When the candidate is from an authoritative source (trust ≥ 0.85) and an existing LOWER-trust fact disagrees, prefer UPDATE (or DELETE) of the stale one — ground truth beats inference. Never let a low-trust inference overwrite a higher-trust fact; in that direction prefer NOOP.',
  '',
  'Output strict JSON: { "decision": "ADD|UPDATE|DELETE|NOOP", "target_id": <id or null>, "rewrite": "<optional>", "reason": "<one-line>" }',
  'No markdown fences. No commentary.',
].join('\n');

interface ConflictDecision {
  decision: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  target_id?: number | null;
  rewrite?: string;
  reason?: string;
}

export async function resolveConflict(
  candidate: { kind: 'user' | 'project' | 'feedback' | 'reference' | 'constraint'; text: string; trustLevel?: number },
  similar: ConsolidatedFact[],
): Promise<ConflictDecision> {
  if (similar.length === 0) return { decision: 'ADD' };
  const model = getReflectorModel();
  try {
    const agent = new Agent<unknown, typeof ConflictDecisionSchema>({
      name: 'Memory Conflict Resolver',
      model,
      instructions: CONFLICT_PROMPT,
      outputType: normalizeZodForCodexStrict(ConflictDecisionSchema) as typeof ConflictDecisionSchema,
    });
    const runner = new Runner({ workflowName: 'clementine-conflict-resolver' });
    const candTrust = typeof candidate.trustLevel === 'number' ? candidate.trustLevel.toFixed(2) : '?';
    const candAuthoritative = typeof candidate.trustLevel === 'number' && candidate.trustLevel >= AUTHORITATIVE_TRUST
      ? ' [AUTHORITATIVE system-of-record]' : '';
    const prompt = [
      `Candidate fact (kind=${candidate.kind}, trust=${candTrust})${candAuthoritative}: "${candidate.text}"`,
      '',
      'Existing similar facts:',
      ...similar.map((f) => `  [id=${f.id}, kind=${f.kind}, trust=${f.trustLevel ?? '?'}, importance=${f.importance ?? '?'}] "${f.content}"`),
    ].join('\n');
    const result = await runner.run(agent, prompt);
    const final = (result as { finalOutput?: unknown }).finalOutput;
    if (!final || typeof final !== 'object') return { decision: 'ADD' };
    return final as ConflictDecision;
  } catch {
    // Conservative: on any failure, ADD. Better to have a duplicate
    // than to lose a real fact.
    return { decision: 'ADD' };
  }
}

// ─────────────────────────────────────────────────────────────────
// Shared fact consolidation (Mem0 ADD/UPDATE/DELETE/NOOP application)
// ─────────────────────────────────────────────────────────────────

export interface ConsolidateCandidate {
  kind: ConsolidatedFactKind;
  text: string;
  /** Stanford §4.1 poignancy. Defaults handled by rememberFact (5.0). */
  importance?: number;
  /** 0.0–1.0. User-stated facts pass 1.0 so they win conflicts; tool-
   *  derived facts leave this undefined → rememberFact defaults to 0.6.
   *  Systems of record pass ~0.9 (connectors-as-authoritative-writers). */
  trustLevel?: number;
  /** v9 — friendly app name when the candidate came from a system of
   *  record (set by classifySource in the reflection loop). */
  sourceApp?: string;
  /** Pin the resulting fact (always-injected, decay-exempt). Set by the
   *  auto-capture prohibition path so a safety-critical "never …" rule can
   *  never be scoped out of context at action time. Pinned INSIDE
   *  consolidateFact where the resulting row id is known. */
  pin?: boolean;
}

export interface ConsolidateContext {
  sessionId?: string;
  derivedFrom?: { sessionId?: string; callId?: string; tool?: string };
}

export interface ConsolidateOutcome {
  written: number;
  updated: number;
  deleted: number;
  noop: number;
  importanceAdded: number;
}

export interface ConsolidateOptions {
  /** Tier A1 novelty fast-path: if the most-similar existing fact's cosine
   *  similarity is strictly below this value, skip the LLM conflict
   *  resolver and ADD directly (the candidate is clearly novel). Omit to
   *  always run the resolver when similar facts exist (legacy behavior). */
  noveltyFastPathSim?: number;
  /** Test seam: deterministic conflict resolver (defaults to the LLM
   *  resolveConflict). Mirrors runRecursiveReflection's extractor option. */
  resolver?: typeof resolveConflict;
}

/**
 * Consolidate a single candidate fact into memory via the Mem0 update
 * phase (Chhikara et al §2.1): retrieve similar existing facts, let the
 * LLM decide ADD / UPDATE / DELETE / NOOP, and apply it. The single
 * write path shared by both the tool-return reflection loop AND the
 * user-statement path (auto-capture) — so a user restating a preference
 * supersedes the stale fact instead of stacking a duplicate.
 *
 * Falls back to ADD on any resolver failure — we never lose a fact.
 */

// Cumulative resolver-decision tallies since process start. Surfaces whether
// refinement is actually happening (UPDATE/DELETE/NOOP supersede or merge) or
// the store is just growing by ADD — the deep-dive's open question. Read by the
// diagnostics panel; reset only on restart.
const resolverStats = { add: 0, update: 0, delete: 0, noop: 0 };
export function getResolverStats(): { add: number; update: number; delete: number; noop: number } {
  return { ...resolverStats };
}
export function _resetResolverStatsForTest(): void {
  resolverStats.add = 0; resolverStats.update = 0; resolverStats.delete = 0; resolverStats.noop = 0;
}

export async function consolidateFact(
  candidate: ConsolidateCandidate,
  ctx: ConsolidateContext = {},
  opts: ConsolidateOptions = {},
): Promise<ConsolidateOutcome> {
  const out = await consolidateFactInner(candidate, ctx, opts);
  // Tally the resolver decision (a fact is exactly one of these per call).
  if (out.updated) resolverStats.update += 1;
  else if (out.deleted) resolverStats.delete += 1;
  else if (out.noop) resolverStats.noop += 1;
  else if (out.written) resolverStats.add += 1;
  return out;
}

async function consolidateFactInner(
  candidate: ConsolidateCandidate,
  ctx: ConsolidateContext = {},
  opts: ConsolidateOptions = {},
): Promise<ConsolidateOutcome> {
  const out: ConsolidateOutcome = { written: 0, updated: 0, deleted: 0, noop: 0, importanceAdded: 0 };

  // Pin the resulting fact when the candidate asked for it (the safety-critical
  // prohibition path). Done HERE, where the ADD/UPDATE row id is known, so the
  // caller doesn't need an id back (consolidateFact returns counts only).
  // Best-effort: a pin failure must never break consolidation.
  const maybePin = (id: number | undefined | null): void => {
    if (!candidate.pin || !id) return;
    try { setFactPinned(id, true); } catch { /* best-effort */ }
  };

  const scored = await findSimilarFactsScored(candidate.text, { kind: candidate.kind, topK: 5 });
  const similar = scored.map((s) => s.fact);
  const topSim = scored.length > 0 ? scored[0].sim : null;

  // Ground-truth-wins fast-path (Thread 1 / C2): an AUTHORITATIVE candidate
  // (system of record, trust ≥ 0.85) that clearly conflicts (high cosine)
  // with a stale, lower-trust (≤ 0.6) existing fact supersedes it
  // deterministically — no LLM resolver call. This is the "ground truth
  // beats inference" rule: a fresh Salesforce/Outlook fact overrides an old
  // guess. Mirrors the novelty fast-path's shape.
  //
  // GATED on candidate.sourceApp — the system-of-record marker that ONLY the
  // flag-on (CLEMMY_SOURCE_TRUST) classifySource path sets. This is the real
  // enforcement of "only fires when source trust tagged the candidate": the
  // default-on auto-capture path passes user restatements at trust 1.0 (which
  // also clears 0.85) but NEVER sets sourceApp, so without this guard a
  // restatement merely ≥0.8 cosine-similar to a DERIVED fact (≤0.6) would
  // deterministically overwrite it (content replace, not append), bypassing
  // the LLM ADD/UPDATE resolver and silently dropping a distinct-but-related
  // derived fact. User restatements correctly fall through to resolveConflict
  // below — which UPDATEs a true restatement but ADDs a genuinely new one, so
  // no fact is lost. Default behavior (no sourceApp) is therefore unchanged.
  const GROUND_TRUTH_CONFLICT_SIM = 0.8;
  if (
    typeof candidate.sourceApp === 'string' &&
    candidate.sourceApp.length > 0 &&
    typeof candidate.trustLevel === 'number' &&
    candidate.trustLevel >= AUTHORITATIVE_TRUST &&
    scored.length > 0 &&
    topSim !== null &&
    topSim >= GROUND_TRUTH_CONFLICT_SIM &&
    (scored[0].fact.trustLevel ?? 1.0) <= 0.6
  ) {
    const updated = updateFact(scored[0].fact.id, {
      content: candidate.text,
      trustLevel: candidate.trustLevel,
      importance: candidate.importance,
      sessionId: ctx.sessionId,
      sourceApp: candidate.sourceApp,
    });
    if (updated) {
      out.updated = 1;
      maybePin(scored[0].fact.id);
      out.importanceAdded += candidate.importance ?? 0;
      return out;
    }
  }

  // Novelty fast-path (Tier A1): when the most-similar existing fact's
  // cosine is BELOW the bar, the candidate is clearly novel — there is no
  // plausible conflict to resolve, so ADD directly and skip the LLM
  // resolver call. Only applies on the semantic path (sim != null); the
  // lexical fallback reports sim=null and always runs the resolver.
  if (
    typeof opts.noveltyFastPathSim === 'number' &&
    topSim !== null &&
    topSim < opts.noveltyFastPathSim
  ) {
    const added = rememberFact({
      kind: candidate.kind,
      content: candidate.text,
      sessionId: ctx.sessionId,
      derivedFrom: ctx.derivedFrom,
      importance: candidate.importance,
      trustLevel: candidate.trustLevel,
      sourceApp: candidate.sourceApp,
    });
    maybePin(added.id);
    out.written = 1;
    out.importanceAdded += candidate.importance ?? 0;
    return out;
  }

  const decision = await (opts.resolver ?? resolveConflict)(
    { kind: candidate.kind, text: candidate.text, trustLevel: candidate.trustLevel },
    similar,
  );

  if (decision.decision === 'NOOP') {
    out.noop = 1;
    return out;
  }

  // Pinned facts are the always-rendered standing instructions — losing one
  // silently removes live protection. A resolver decision is LLM output and
  // must NEVER delete or rewrite a pinned fact; downgrade DELETE/UPDATE on a
  // pinned target to the conservative ADD below (the candidate still lands).
  const pinnedTargetId =
    (decision.decision === 'DELETE' || decision.decision === 'UPDATE') &&
    typeof decision.target_id === 'number' &&
    getFact(decision.target_id)?.pinned
      ? decision.target_id
      : null;
  if (pinnedTargetId !== null) {
    console.warn(`[reflection] conflict resolver ${decision.decision} blocked: fact ${pinnedTargetId} is pinned — adding candidate instead`);
  }

  if (pinnedTargetId === null && decision.decision === 'DELETE' && typeof decision.target_id === 'number') {
    if (deleteFact(decision.target_id)) out.deleted = 1;
    // After delete we still ADD the new fact below — the deleted row
    // was the OLD state; the candidate captures the current state.
  }

  if (pinnedTargetId === null && decision.decision === 'UPDATE' && typeof decision.target_id === 'number') {
    // Re-enforce the schema's rewrite cap (finalOutput is cast, not parsed).
    const rewrite =
      decision.rewrite && decision.rewrite.length <= CONFLICT_REWRITE_MAX_CHARS
        ? decision.rewrite
        : undefined;
    const updated = updateFact(decision.target_id, {
      content: rewrite || candidate.text,
      // Tool-derived candidates keep the historical 0.6; user candidates
      // pass 1.0. updateFact MAX-merges trust, so user always wins.
      trustLevel: candidate.trustLevel ?? 0.6,
      importance: candidate.importance,
      sessionId: ctx.sessionId,
      sourceApp: candidate.sourceApp,
    });
    if (updated) {
      out.updated = 1;
      maybePin(decision.target_id);
      out.importanceAdded += candidate.importance ?? 0;
      return out; // UPDATE replaces ADD; no additional row
    }
    // Target row gone — fall through to ADD.
  }

  const rememberInput: RememberInput = {
    kind: candidate.kind,
    content: candidate.text,
    sessionId: ctx.sessionId,
    derivedFrom: ctx.derivedFrom,
    importance: candidate.importance,
    // Leave undefined for tool-derived (rememberFact derives 0.6 from
    // derivedFrom); user path passes 1.0 explicitly.
    trustLevel: candidate.trustLevel,
    sourceApp: candidate.sourceApp,
  };
  const added = rememberFact(rememberInput);
  maybePin(added.id);
  out.written = 1;
  out.importanceAdded += candidate.importance ?? 0;
  return out;
}

/**
 * Upsert an entity row. canonical_name_lc is the dedupe key per
 * (entity_type, name). Aliases merge with existing aliases (set-union).
 * Returns the row id.
 */
export function upsertEntity(input: {
  type: EntityType;
  name: string;
  aliases?: string[];
}): number {
  const db = openMemoryDb();
  const name = input.name.trim();
  if (!name) throw new Error('upsertEntity: name required');
  const nameLc = name.toLowerCase();
  const now = new Date().toISOString();
  const newAliases = (input.aliases ?? []).map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== nameLc);

  const existing = db.prepare(
    'SELECT * FROM entities WHERE entity_type = ? AND canonical_name_lc = ?',
  ).get(input.type, nameLc) as EntityRow | undefined;

  if (existing) {
    // Merge aliases (set-union, case-insensitive)
    let merged: string[] = [];
    try {
      const current = JSON.parse(existing.aliases_json) as unknown;
      if (Array.isArray(current)) merged = current.filter((a) => typeof a === 'string');
    } catch { /* ignore */ }
    const seen = new Set(merged.map((a) => a.toLowerCase()));
    for (const alias of newAliases) {
      if (!seen.has(alias.toLowerCase())) {
        merged.push(alias);
        seen.add(alias.toLowerCase());
      }
    }
    db.prepare(`
      UPDATE entities
      SET aliases_json = ?, last_seen_at = ?, mention_count = mention_count + 1
      WHERE id = ?
    `).run(JSON.stringify(merged), now, existing.id);
    return existing.id;
  }

  const info = db.prepare(`
    INSERT INTO entities
      (entity_type, canonical_name, canonical_name_lc, aliases_json, first_seen_at, last_seen_at, mention_count)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(input.type, name, nameLc, JSON.stringify(newAliases), now, now);
  return Number(info.lastInsertRowid);
}

export function storeEpisodicPointer(input: {
  sessionId: string;
  callId: string;
  label: string;
  tool: string | null;
  sourceUri?: string | null;
}): number {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO episodic_pointers
      (session_id, call_id, label, tool, source_uri, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.callId,
    input.label.trim(),
    input.tool,
    input.sourceUri ?? null,
    now,
  );
  return Number(info.lastInsertRowid);
}

export function listRecentEpisodicPointers(sessionId: string, limit = 10): EpisodicPointerRow[] {
  const db = openMemoryDb();
  // id DESC as tiebreaker — when multiple pointers are stored in the
  // same millisecond, ORDER BY created_at alone is non-deterministic.
  return db.prepare(`
    SELECT * FROM episodic_pointers
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, limit) as EpisodicPointerRow[];
}

/**
 * Main entry. Async — caller (hooks.ts) does NOT await. Returns the
 * count of rows written for observability via the dashboard, but the
 * caller will not see this value.
 */
export async function reflectOnToolReturn(input: ReflectionInput): Promise<ReflectionResult> {
  const startedAt = Date.now();
  const emitObservability = (result: ReflectionResult): ReflectionResult => {
    // Append a synthetic 'reflection' tool event to the per-day ndjson
    // so the autoresearch observatory (src/autoresearch/observatory.ts)
    // picks brain-learning health up alongside real-tool health in the
    // daily report. Foundation only — no mutation logic yet, just
    // observation. See [[project_brain_architecture]] + the
    // [[project_autoresearch_roadmap]] for the path from observation
    // to (future) tunable thresholds + prompt iteration.
    recordToolEvent({
      at: new Date().toISOString(),
      sessionId: input.sessionId,
      toolName: 'reflection',
      kind: 'read',
      phase: 'end',
      durationMs: Date.now() - startedAt,
      // Outcome: 'cancelled' when a gate fired before commit (too short,
      // low importance, etc); 'success' otherwise — empty-extraction is
      // still success (the extractor correctly judged nothing worth
      // remembering, e.g. for a JSON status tool return). Reserve 'error'
      // for the few paths that actually throw, which already short-
      // circuit before this emit.
      outcome: result.skipped ? 'cancelled' : 'success',
      argsSummary: `source_tool=${input.tool ?? 'unknown'} call=${input.callId} facts=${result.factsWritten} entities=${result.entitiesUpserted} pointers=${result.pointersStored}${result.skipped ? ` skipped=${result.skipped}` : ''}`,
    });
    return result;
  };

  if (readDisableFlag()) {
    return emitObservability({ factsWritten: 0, entitiesUpserted: 0, pointersStored: 0, skipped: 'disabled' });
  }
  if (selfToolReflectionFilterEnabled() && isSelfReferentialTool(input.tool)) {
    // Skip Clementine's own introspective tools — reflecting on them only
    // mints self-referential facts (memory_read→fact recursion).
    return emitObservability({ factsWritten: 0, entitiesUpserted: 0, pointersStored: 0, skipped: 'self_tool' });
  }
  if (!input.output || input.output.length < REFLECTION_MIN_CONTENT_CHARS) {
    return emitObservability({ factsWritten: 0, entitiesUpserted: 0, pointersStored: 0, skipped: 'too_short' });
  }
  const dedupKey = `${input.sessionId}::${input.callId}`;
  if (RECENT_REFLECTED.has(dedupKey)) {
    return emitObservability({ factsWritten: 0, entitiesUpserted: 0, pointersStored: 0, skipped: 'already_reflected' });
  }
  markReflected(dedupKey);

  // Cap input size to keep the extraction call cheap.
  const serialized = input.output.length > REFLECTION_MAX_INPUT_CHARS
    ? `${input.output.slice(0, REFLECTION_MAX_INPUT_CHARS)}…[+${input.output.length - REFLECTION_MAX_INPUT_CHARS} chars truncated]`
    : input.output;

  const extraction = await runExtractor(`Tool: ${input.tool ?? 'unknown'}\nCall: ${input.callId}\n\n${serialized}`);
  if (!extraction) {
    return emitObservability({ factsWritten: 0, entitiesUpserted: 0, pointersStored: 0, skipped: 'extractor_failed' });
  }

  // Source-map / landscape memory — mint resource pointers BEFORE the
  // importance gate below. The landscape is pointer-first + bounded (dedupe by
  // app+ref), so we map it LIBERALLY even in low-signal sessions, unlike facts
  // which the importance gate deliberately throttles. Only for systems of
  // record (the apps the user navigates), tagged with the source app + trust.
  // Flag-gated (CLEMMY_SOURCE_MAP) + best-effort — never perturbs reflection.
  if (isSourceMapEnabled() && extraction.resources && extraction.resources.length > 0) {
    const cls = classifySource(input.tool);
    if (cls && cls.category === 'system_of_record') {
      for (const r of extraction.resources) {
        try {
          upsertResourcePointer({
            app: cls.app,
            kind: r.kind,
            name: r.name,
            // Route the extractor's stable id/uri through providerId so a
            // reactively-learned resource lands on the SAME canonical ref as
            // the background-ingest crawler (app:kind:id) and they converge.
            providerId: r.ref,
            whatsHere: r.whats_here,
            whenToUse: r.when_to_use,
            trust: cls.trust,
            source: 'reactive',
          });
        } catch { /* best-effort — a map write must never break reflection */ }
      }
    }
  }

  // Stanford §4.2: importance-threshold gating on the COMMIT step. The
  // extractor already ran (cheap fast-tier call); we just decide
  // whether the extracted facts clear the rolling sum-importance bar.
  // Skipped extractions accumulate into the next call's budget so a
  // session of low-signal tool returns eventually crosses the gate
  // and writes.
  const extractionImportance = extraction.facts.reduce((acc, f) => acc + (f.importance || 0), 0);
  const threshold = getReflectionThreshold();
  if (threshold > 0 && extractionImportance > 0) {
    const counter = accumulateImportance(input.sessionId, extractionImportance);
    if (counter.sum < threshold) {
      return emitObservability({
        factsWritten: 0,
        entitiesUpserted: 0,
        pointersStored: 0,
        sumImportance: counter.sum,
        skipped: 'low_importance',
      });
    }
    // Crossed the threshold — reset so the next eligible window starts
    // fresh. We still proceed with the current commit below.
    resetSessionImportance(input.sessionId);
  }

  let factsWritten = 0;
  let factsUpdated = 0;
  let factsDeleted = 0;
  let factsNoop = 0;
  let entitiesUpserted = 0;
  let pointersStored = 0;
  let sumImportance = 0;

  // Connectors-as-authoritative-writers (Thread 1): classify the producing
  // tool's source category once for this batch. A system of record lifts the
  // derived-fact trust from 0.6 → 0.9 (ground truth) and records the source
  // app; a web/scrape source lowers it to 0.5. Flag-gated; unrecognized
  // tools → null → unchanged default trust.
  const source = isSourceTrustEnabled() ? classifySource(input.tool) : null;

  for (const fact of extraction.facts) {
    try {
      // Mem0-style conflict resolution (Chhikara et al §2.1) via the
      // shared consolidation path: find similar existing facts and let
      // the LLM decide ADD / UPDATE / DELETE / NOOP. Falls back to ADD
      // if anything fails — we never lose information silently.
      const outcome = await consolidateFact(
        {
          kind: fact.kind,
          text: fact.text,
          importance: fact.importance,
          trustLevel: source?.trust,
          sourceApp: source?.app,
        },
        {
          sessionId: input.sessionId,
          derivedFrom: {
            sessionId: input.sessionId,
            callId: input.callId,
            tool: input.tool ?? undefined,
          },
        },
      );
      factsWritten += outcome.written;
      factsUpdated += outcome.updated;
      factsDeleted += outcome.deleted;
      factsNoop += outcome.noop;
      sumImportance += outcome.importanceAdded;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), fact }, 'reflection: consolidateFact failed');
    }
  }

  for (const entity of extraction.entities) {
    try {
      upsertEntity({ type: entity.type, name: entity.name, aliases: entity.aliases });
      entitiesUpserted += 1;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), entity }, 'reflection: upsertEntity failed');
    }
  }

  for (const pointer of extraction.pointers) {
    try {
      storeEpisodicPointer({
        sessionId: input.sessionId,
        callId: input.callId,
        label: pointer.label,
        tool: input.tool ?? null,
        sourceUri: pointer.source_uri ?? null,
      });
      pointersStored += 1;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), pointer }, 'reflection: storeEpisodicPointer failed');
    }
  }

  return emitObservability({
    factsWritten,
    factsUpdated,
    factsDeleted,
    factsNoop,
    entitiesUpserted,
    pointersStored,
    sumImportance,
  });
}

/**
 * Fire-and-forget convenience used by hooks.ts. Runs in the background;
 * any error is swallowed (logged at warn level). NEVER awaited by the
 * caller — the SDK's tool return must not be blocked by reflection.
 */
export function scheduleReflection(input: ReflectionInput): void {
  // Schedule on next tick so we never share the same microtask as the
  // calling hook (defensive against unhandled-rejection edge cases).
  queueMicrotask(() => {
    reflectOnToolReturn(input).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'reflection: scheduled run errored');
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// Recursive reflection — Stanford trees (Park et al §4.2)
// ─────────────────────────────────────────────────────────────────
//
// Nightly job that reads the last 7 days of atomic facts (depth=0) and
// already-synthesized patterns (depth=1) and emits higher-order
// reflections grouped by kind. Stanford's published agents only went
// 2 levels deep; we cap at the same.

const RECURSIVE_REFLECTION_LOOKBACK_DAYS = 7;
const RECURSIVE_REFLECTION_MIN_GROUP_SIZE = 5;
const RECURSIVE_REFLECTION_MAX_GROUP_SIZE = 100;
const RECURSIVE_REFLECTION_MAX_DEPTH = 2;

const RecursivePatternSchema = z.object({
  text: z.string().min(3).max(500),
  importance: z.number().min(1).max(10),
});
const RecursiveExtractionSchema = z.object({
  patterns: z.array(RecursivePatternSchema).max(3),
});

const RECURSIVE_PROMPT = [
  'You are the recursive-reflection layer of a long-running personal assistant.',
  'You will be shown a batch of recent atomic facts the assistant has learned about a single kind (user / project / feedback / reference). Identify 0-3 higher-order PATTERNS that emerge across these facts — themes, trends, shifts, recurring concerns — that would NOT be visible from any single fact alone.',
  '',
  'Return strict JSON:',
  '{ "patterns": [{ "text": "<one-sentence pattern>", "importance": <1-10 per Park et al §4.1> }] }',
  '',
  'Rules:',
  '- A pattern must reference EVIDENCE that spans ≥ 2 of the input facts. Single-fact restatements are NOT patterns.',
  '- "text" is present-tense, third-person, atomic — same shape as the atomic facts.',
  '- Score importance per Park et al: 1 mundane / 4 routine-recurring / 7 notable-actionable / 10 life-changing. Patterns typically score 5-8.',
  '- If no patterns are warranted (facts are unrelated or already-summarized), return { "patterns": [] }. Empty is the correct answer most of the time.',
  '- Output ONLY the JSON object. No markdown fences.',
].join('\n');

interface RecursiveReflectionResult {
  patternsWritten: number;
  patternsUpdated: number;
  patternsNoop: number;
  groupsProcessed: number;
  groupsSkipped: number;
  factsConsidered: number;
  /** Groups whose extractor LLM call FAILED (returned null) — distinct from a
   *  low-signal night (groups processed, 0 patterns). >0 means the synthesizer
   *  is broken (auth/quota/model), not that the week was quiet. */
  groupsFailed: number;
}

async function runRecursivePatternExtractor(
  kind: ConsolidatedFactKind,
  facts: ConsolidatedFactRow[],
): Promise<{ patterns: { text: string; importance: number }[] } | null> {
  const model = getReflectorModel();
  try {
    const agent = new Agent<unknown, typeof RecursiveExtractionSchema>({
      name: 'Recursive Reflection Extractor',
      model,
      instructions: RECURSIVE_PROMPT,
      outputType: normalizeZodForCodexStrict(RecursiveExtractionSchema) as typeof RecursiveExtractionSchema,
    });
    const runner = new Runner({ workflowName: 'clementine-recursive-reflection' });
    const lines = facts.map((f) => `[id=${f.id}, depth=${f.derivation_depth}, importance=${f.importance ?? '?'}] ${f.content}`);
    const prompt = `Kind: ${kind}\nFact count: ${facts.length}\n\nFacts:\n${lines.join('\n')}`;
    const result = await runner.run(agent, prompt);
    const final = (result as { finalOutput?: unknown }).finalOutput;
    if (!final || typeof final !== 'object') return null;
    return final as { patterns: { text: string; importance: number }[] };
  } catch (err) {
    logger.warn({ kind, err: err instanceof Error ? err.message : String(err) }, 'recursive-reflection extractor failed');
    return null;
  }
}

/**
 * Nightly synthesis pass. Reads the last week of facts grouped by kind,
 * asks the fast-tier model to surface higher-order patterns, and writes
 * each pattern as a new fact at derivation_depth = max(source depths) + 1.
 * Patterns flow through the same Mem0 conflict resolver so a recurring
 * theme gets UPDATEd next week instead of duplicated.
 *
 * Returns counts for observability. Safe to call from a cron tick or
 * manually for testing. Honors CLEMMY_REFLECTION=off.
 */
export async function runRecursiveReflection(
  opts: { extractor?: typeof runRecursivePatternExtractor } = {},
): Promise<RecursiveReflectionResult> {
  const extractFn = opts.extractor ?? runRecursivePatternExtractor;
  const startedAt = Date.now();
  const result: RecursiveReflectionResult = {
    patternsWritten: 0,
    patternsUpdated: 0,
    patternsNoop: 0,
    groupsProcessed: 0,
    groupsSkipped: 0,
    factsConsidered: 0,
    groupsFailed: 0,
  };

  const emit = (skipped?: 'disabled' | 'empty'): RecursiveReflectionResult => {
    recordToolEvent({
      at: new Date().toISOString(),
      sessionId: 'cron:recursive-reflection',
      toolName: 'recursive_reflection',
      kind: 'read',
      phase: 'end',
      durationMs: Date.now() - startedAt,
      // A group that ran but produced no patterns is a low-signal week (success).
      // A group whose extractor FAILED (groupsFailed>0) means the synthesizer is
      // broken (auth/quota/model) — surface that as 'error' so a dark compounding
      // layer can't hide behind written=0 like it did before.
      outcome: skipped ? 'cancelled' : (result.groupsFailed > 0 && result.patternsWritten === 0 && result.patternsUpdated === 0 ? 'error' : 'success'),
      argsSummary: `groups=${result.groupsProcessed}/${result.groupsProcessed + result.groupsSkipped + result.groupsFailed} failed=${result.groupsFailed} facts=${result.factsConsidered} written=${result.patternsWritten} updated=${result.patternsUpdated} noop=${result.patternsNoop}${skipped ? ` skipped=${skipped}` : ''}`,
    });
    return result;
  };

  if (readDisableFlag()) return emit('disabled');

  const db = openMemoryDb();
  const sinceIso = new Date(Date.now() - RECURSIVE_REFLECTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Constraints are standing rules, not derived patterns — exclude from recursive reflection
  const kinds: Array<'user' | 'project' | 'feedback' | 'reference'> = ['user', 'project', 'feedback', 'reference'];

  let producedAnything = false;
  for (const kind of kinds) {
    const rows = db.prepare(`
      SELECT * FROM consolidated_facts
      WHERE active = 1
        AND kind = ?
        AND derivation_depth < ?
        AND updated_at >= ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(kind, RECURSIVE_REFLECTION_MAX_DEPTH, sinceIso, RECURSIVE_REFLECTION_MAX_GROUP_SIZE) as ConsolidatedFactRow[];

    if (rows.length < RECURSIVE_REFLECTION_MIN_GROUP_SIZE) {
      result.groupsSkipped += 1;
      continue;
    }
    result.factsConsidered += rows.length;

    const extraction = await extractFn(kind, rows);
    if (!extraction) {
      // The extractor LLM call FAILED (auth/quota/model) — not a quiet week.
      // Counted separately so the emit can flag a broken synthesizer instead of
      // masquerading as success/written=0.
      result.groupsFailed += 1;
      continue;
    }
    if (extraction.patterns.length === 0) {
      // Ran fine; genuinely nothing higher-order to synthesize this week.
      result.groupsProcessed += 1;
      continue;
    }
    producedAnything = true;
    result.groupsProcessed += 1;

    const sourceIds = rows.map((r) => r.id);
    const maxSourceDepth = rows.reduce((m, r) => Math.max(m, r.derivation_depth ?? 0), 0);
    const targetDepth = Math.min(RECURSIVE_REFLECTION_MAX_DEPTH, maxSourceDepth + 1);

    for (const pattern of extraction.patterns) {
      try {
        const similar = await findSimilarFacts(pattern.text, { kind, topK: 5 });
        const decision = await resolveConflict({ kind, text: pattern.text }, similar);

        if (decision.decision === 'NOOP') {
          result.patternsNoop += 1;
          continue;
        }
        // Same pinned guard as consolidateFact: this path runs NIGHTLY and
        // unattended, on depth-2 inferences (trust 0.5) — the LAST place an
        // LLM decision may delete/rewrite a pinned standing instruction.
        const pinnedTarget =
          (decision.decision === 'DELETE' || decision.decision === 'UPDATE') &&
          typeof decision.target_id === 'number' &&
          getFact(decision.target_id)?.pinned
            ? decision.target_id
            : null;
        if (pinnedTarget !== null) {
          console.warn(`[reflection] recursive resolver ${decision.decision} blocked: fact ${pinnedTarget} is pinned — adding pattern instead`);
        }
        if (pinnedTarget === null && decision.decision === 'DELETE' && typeof decision.target_id === 'number') {
          deleteFact(decision.target_id);
        }
        if (pinnedTarget === null && decision.decision === 'UPDATE' && typeof decision.target_id === 'number') {
          const rewrite =
            decision.rewrite && decision.rewrite.length <= CONFLICT_REWRITE_MAX_CHARS
              ? decision.rewrite
              : pattern.text;
          const updated = updateFact(decision.target_id, {
            content: rewrite,
            // Recursive patterns are inferences over inferences — keep
            // trust strictly below direct-derived (0.6) so user-stated
            // facts always win on conflict.
            trustLevel: 0.5,
            importance: pattern.importance,
          });
          if (updated) {
            result.patternsUpdated += 1;
            continue;
          }
        }
        const remembered = rememberFact({
          kind,
          content: pattern.text,
          importance: pattern.importance,
          trustLevel: 0.5,
          derivationDepth: targetDepth,
          derivedFromFactIds: sourceIds,
        });
        if (remembered) result.patternsWritten += 1;
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), kind, pattern }, 'recursive-reflection: write failed');
      }
    }
  }

  // 'empty' (a quiet, low-signal week) ONLY when nothing was produced AND no
  // group failed. If groups failed, fall through to emit() so the outcome is
  // flagged 'error' rather than masquerading as a cancelled/empty run.
  if (!producedAnything && result.groupsProcessed === 0 && result.groupsFailed === 0) return emit('empty');
  return emit();
}

export interface DedupResult {
  examined: number;
  merged: number;
  ids: number[];
}

/**
 * Retroactive semantic dedup (Tier A3). Folds NEAR-IDENTICAL active facts
 * (cosine >= `simThreshold`, default 0.95) that accumulated before the
 * resolver was on the `memory_remember` path. Deliberately MECHANICAL and
 * high-confidence — no LLM call: at ~0.95 cosine on text-embedding-3-small
 * the two statements are paraphrases of the same fact, so we keep the
 * higher-scored (tie → newer) and soft-delete the other. This avoids
 * misusing the conflict resolver (which is built for NEW candidate vs
 * existing, not existing vs existing) and bounds blast radius.
 *
 * Semantic-only: without embeddings, `findSimilarFactsScored` reports
 * sim=null and nothing is folded (no-op). Capped by `maxMerges` per run.
 * Soft delete only (active=0) — fully reversible, embedding + audit kept.
 */
function dedupStoredEmbeddingsEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DEDUP_STORED_EMBEDDINGS', 'on') || 'on').toLowerCase() !== 'off';
}

export async function consolidateActiveFacts(
  opts: { perKind?: number; maxMerges?: number; simThreshold?: number; useStoredEmbeddings?: boolean } = {},
): Promise<DedupResult> {
  const maxMerges = Math.max(0, opts.maxMerges ?? 100);
  const simThreshold = opts.simThreshold ?? 0.95;
  const useStored = opts.useStoredEmbeddings ?? dedupStoredEmbeddingsEnabled();
  // The stored-embedding path scans the FULL active set per kind (in-memory
  // pairwise cosine over vectors we ALREADY computed — ZERO new API calls), so
  // the old 200-row window that left ~59% of project facts un-deduped is gone.
  // The legacy re-embedding path keeps the conservative window to bound cost.
  const perKind = Math.max(1, opts.perKind ?? (useStored ? 5000 : 200));
  const result: DedupResult = { examined: 0, merged: 0, ids: [] };
  if (maxMerges === 0) return result;

  const db = openMemoryDb();
  const kinds: ConsolidatedFactKind[] = ['user', 'project', 'feedback', 'reference'];
  const folded = new Set<number>();

  if (useStored) {
    for (const kind of kinds) {
      if (result.merged >= maxMerges) break;
      const rows = db.prepare(`
        SELECT id, content, score FROM consolidated_facts
        WHERE active = 1 AND kind = ? AND pinned = 0
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(kind, perKind) as { id: number; content: string; score: number }[];
      const vecs = loadFactEmbeddings(rows.map((r) => r.id));
      // Only facts with a stored embedding participate; the handful not yet
      // embedded are folded on a later run once the backfill catches them.
      const embedded = rows.filter((r) => vecs.has(r.id));
      for (let i = 0; i < embedded.length; i += 1) {
        if (result.merged >= maxMerges) break;
        const a = embedded[i];
        if (folded.has(a.id)) continue;
        result.examined += 1;
        const va = vecs.get(a.id);
        if (!va) continue;
        for (let j = i + 1; j < embedded.length; j += 1) {
          if (result.merged >= maxMerges) break;
          const b = embedded[j];
          if (folded.has(b.id)) continue;
          const vb = vecs.get(b.id);
          if (!vb || cosine(va, vb) < simThreshold) continue;
          // Keep the higher-scored fact (tie → larger id = newer); drop the other.
          const keepId = a.score > b.score || (a.score === b.score && a.id > b.id) ? a.id : b.id;
          const dropId = keepId === a.id ? b.id : a.id;
          if (deleteFact(dropId)) {
            folded.add(dropId);
            result.merged += 1;
            result.ids.push(dropId);
          }
          if (dropId === a.id) break; // a was folded away — advance to next i
        }
      }
    }
    return result;
  }

  // Legacy per-row re-embedding path (kill-switch: CLEMMY_DEDUP_STORED_EMBEDDINGS=off).
  for (const kind of kinds) {
    const rows = db.prepare(`
      SELECT id, content, score FROM consolidated_facts
      WHERE active = 1 AND kind = ? AND pinned = 0
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(kind, perKind) as { id: number; content: string; score: number }[];

    for (const row of rows) {
      if (result.merged >= maxMerges) break;
      if (folded.has(row.id)) continue; // already merged away
      result.examined += 1;

      const scored = await findSimilarFactsScored(row.content, { kind, topK: 6 });
      for (const s of scored) {
        if (result.merged >= maxMerges) break;
        if (s.fact.id === row.id || folded.has(s.fact.id)) continue;
        // scored is cosine-desc; once below the bar, no later one qualifies.
        if (s.sim === null || s.sim < simThreshold) break;

        // Keep the higher-scored fact (tie → larger id = newer); drop the other.
        const keepId = s.fact.score > row.score
          || (s.fact.score === row.score && s.fact.id > row.id)
          ? s.fact.id
          : row.id;
        const dropId = keepId === row.id ? s.fact.id : row.id;

        if (deleteFact(dropId)) {
          folded.add(dropId);
          result.merged += 1;
          result.ids.push(dropId);
        }
        if (dropId === row.id) break; // the outer fact itself was folded away
      }
    }
  }
  return result;
}
