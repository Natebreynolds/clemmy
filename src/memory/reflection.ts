import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import pino from 'pino';
import { MODELS } from '../config.js';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';
import { openMemoryDb, type ConsolidatedFactKind, type ConsolidatedFactRow, type EntityType, type EntityRow, type EpisodicPointerRow } from './db.js';
import {
  rememberFact,
  updateFact,
  deleteFact,
  findSimilarFacts,
  type RememberInput,
  type ConsolidatedFact,
} from './facts.js';
import { recordToolEvent } from '../agents/tool-observability.js';

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
const ExtractionSchema = z.object({
  facts: z.array(ExtractedFactSchema).max(8),
  entities: z.array(ExtractedEntitySchema).max(12),
  pointers: z.array(ExtractedPointerSchema).max(4),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

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
  skipped?: 'too_short' | 'already_reflected' | 'extractor_failed' | 'disabled' | 'low_importance';
}

const PROMPT_PREAMBLE = [
  'You are the reflection layer of a long-running personal assistant.',
  'Read the tool output below and extract DURABLE knowledge the assistant should remember about the USER, their PROJECTS, or REFERENCES they may want to revisit. Be conservative — only extract facts that will plausibly matter weeks from now. If nothing durable is in this output, return empty arrays.',
  '',
  'Return strict JSON matching this shape:',
  '{',
  '  "facts": [{ "kind": "user|project|feedback|reference", "text": "<short fact>", "importance": <1-10> }],',
  '  "entities": [{ "type": "person|company|project|place|thing", "name": "<canonical>", "aliases": ["<alt>", ...] }],',
  '  "pointers": [{ "label": "<short human label>", "source_uri": "<optional uri like outlook:thread:abc>" }]',
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
  '- DO NOT extract ephemeral state (current weather, request-ids, timestamps).',
  '- DO NOT invent facts. If the output is noise/empty/error, return all three arrays empty.',
  '- Output ONLY the JSON object. No markdown fences. No commentary.',
].join('\n');

function getReflectorModel(): string {
  return MODELS.fast || MODELS.primary || 'gpt-5.4-mini';
}

function readDisableFlag(): boolean {
  const raw = (process.env.CLEMMY_REFLECTION ?? '').trim().toLowerCase();
  return raw === 'off' || raw === 'false' || raw === '0';
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
  try {
    // v0.5.22.1 — outputType binds ExtractionSchema to the SDK's structured-
    // output path, so OpenAI's grammar-constrained sampling guarantees a
    // schema-conforming response (no more "reflection extractor returned
    // invalid shape" warnings). normalizeZodForCodexStrict rewrites
    // .optional() → .nullable() so Codex's strict-mode validator accepts.
    const agent = new Agent<unknown, typeof ExtractionSchema>({
      name: 'Reflection Extractor',
      model,
      instructions: PROMPT_PREAMBLE,
      outputType: normalizeZodForCodexStrict(ExtractionSchema) as typeof ExtractionSchema,
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

const ConflictDecisionSchema = z.object({
  decision: z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']),
  target_id: z.number().int().nullable().optional(),
  rewrite: z.string().min(3).max(500).optional(),
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
  'Output strict JSON: { "decision": "ADD|UPDATE|DELETE|NOOP", "target_id": <id or null>, "rewrite": "<optional>", "reason": "<one-line>" }',
  'No markdown fences. No commentary.',
].join('\n');

interface ConflictDecision {
  decision: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  target_id?: number | null;
  rewrite?: string;
  reason?: string;
}

async function resolveConflict(
  candidate: { kind: 'user' | 'project' | 'feedback' | 'reference'; text: string },
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
    const prompt = [
      `Candidate fact (kind=${candidate.kind}): "${candidate.text}"`,
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

  for (const fact of extraction.facts) {
    try {
      // Mem0-style conflict resolution (Chhikara et al §2.1): before
      // writing, find similar existing facts and let the LLM decide
      // ADD / UPDATE / DELETE / NOOP. Falls back to ADD if anything
      // fails — we never lose information silently.
      const similar = findSimilarFacts(fact.text, { kind: fact.kind, topK: 5 });
      const decision = await resolveConflict({ kind: fact.kind, text: fact.text }, similar);

      if (decision.decision === 'NOOP') {
        factsNoop += 1;
        continue;
      }

      if (decision.decision === 'DELETE' && typeof decision.target_id === 'number') {
        const ok = deleteFact(decision.target_id);
        if (ok) factsDeleted += 1;
        // After delete we still ADD the new fact, since the user's
        // current state may need to be stored (e.g. "user now prefers
        // tea"). The deleted fact represented the OLD state.
      }

      if (decision.decision === 'UPDATE' && typeof decision.target_id === 'number') {
        const updated = updateFact(decision.target_id, {
          content: decision.rewrite || fact.text,
          trustLevel: 0.6,
          importance: fact.importance,
          sessionId: input.sessionId,
        });
        if (updated) {
          factsUpdated += 1;
          sumImportance += fact.importance;
          continue; // UPDATE replaces ADD; no additional row
        }
        // If the target row is gone, fall through to ADD.
      }

      const rememberInput: RememberInput = {
        kind: fact.kind,
        content: fact.text,
        sessionId: input.sessionId,
        derivedFrom: {
          sessionId: input.sessionId,
          callId: input.callId,
          tool: input.tool ?? undefined,
        },
        importance: fact.importance,
      };
      rememberFact(rememberInput);
      factsWritten += 1;
      sumImportance += fact.importance;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), fact }, 'reflection: rememberFact failed');
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
export async function runRecursiveReflection(): Promise<RecursiveReflectionResult> {
  const startedAt = Date.now();
  const result: RecursiveReflectionResult = {
    patternsWritten: 0,
    patternsUpdated: 0,
    patternsNoop: 0,
    groupsProcessed: 0,
    groupsSkipped: 0,
    factsConsidered: 0,
  };

  const emit = (skipped?: 'disabled' | 'empty'): RecursiveReflectionResult => {
    recordToolEvent({
      at: new Date().toISOString(),
      sessionId: 'cron:recursive-reflection',
      toolName: 'recursive_reflection',
      kind: 'read',
      phase: 'end',
      durationMs: Date.now() - startedAt,
      // Same semantics as reflection.ts: extractor returning empty is
      // still success (groups <5 facts get groupsSkipped++; runs that
      // produced no patterns reflect a low-signal week, not a failure).
      outcome: skipped ? 'cancelled' : 'success',
      argsSummary: `groups=${result.groupsProcessed}/${result.groupsProcessed + result.groupsSkipped} facts=${result.factsConsidered} written=${result.patternsWritten} updated=${result.patternsUpdated} noop=${result.patternsNoop}${skipped ? ` skipped=${skipped}` : ''}`,
    });
    return result;
  };

  if (readDisableFlag()) return emit('disabled');

  const db = openMemoryDb();
  const sinceIso = new Date(Date.now() - RECURSIVE_REFLECTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const kinds: ConsolidatedFactKind[] = ['user', 'project', 'feedback', 'reference'];

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

    const extraction = await runRecursivePatternExtractor(kind, rows);
    if (!extraction || extraction.patterns.length === 0) {
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
        const similar = findSimilarFacts(pattern.text, { kind, topK: 5 });
        const decision = await resolveConflict({ kind, text: pattern.text }, similar);

        if (decision.decision === 'NOOP') {
          result.patternsNoop += 1;
          continue;
        }
        if (decision.decision === 'DELETE' && typeof decision.target_id === 'number') {
          deleteFact(decision.target_id);
        }
        if (decision.decision === 'UPDATE' && typeof decision.target_id === 'number') {
          const updated = updateFact(decision.target_id, {
            content: decision.rewrite || pattern.text,
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

  if (!producedAnything && result.groupsProcessed === 0) return emit('empty');
  return emit();
}
