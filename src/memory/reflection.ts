import { Agent, Runner } from '@openai/agents';
import { z } from 'zod';
import pino from 'pino';
import { MODELS } from '../config.js';
import { openMemoryDb, type EntityType, type EntityRow, type EpisodicPointerRow } from './db.js';
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
  skipped?: 'too_short' | 'already_reflected' | 'extractor_failed' | 'disabled';
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
    const agent = new Agent({
      name: 'Reflection Extractor',
      model,
      instructions: PROMPT_PREAMBLE,
    });
    const runner = new Runner({ workflowName: 'clementine-reflection' });
    const result = await runner.run(agent, serialized);
    const text = typeof (result as { finalOutput?: unknown }).finalOutput === 'string'
      ? (result as { finalOutput: string }).finalOutput
      : String((result as { finalOutput?: unknown }).finalOutput ?? '');
    if (!text || !text.trim()) return null;
    // Strip optional fenced output defensively.
    const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    const validated = ExtractionSchema.safeParse(parsed);
    if (!validated.success) {
      logger.warn({ issues: validated.error.issues.slice(0, 3) }, 'reflection extractor returned invalid shape');
      return null;
    }
    return validated.data;
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
    const agent = new Agent({
      name: 'Memory Conflict Resolver',
      model,
      instructions: CONFLICT_PROMPT,
    });
    const runner = new Runner({ workflowName: 'clementine-conflict-resolver' });
    const prompt = [
      `Candidate fact (kind=${candidate.kind}): "${candidate.text}"`,
      '',
      'Existing similar facts:',
      ...similar.map((f) => `  [id=${f.id}, kind=${f.kind}, trust=${f.trustLevel ?? '?'}, importance=${f.importance ?? '?'}] "${f.content}"`),
    ].join('\n');
    const result = await runner.run(agent, prompt);
    const text = typeof (result as { finalOutput?: unknown }).finalOutput === 'string'
      ? (result as { finalOutput: string }).finalOutput
      : String((result as { finalOutput?: unknown }).finalOutput ?? '');
    if (!text || !text.trim()) return { decision: 'ADD' };
    const cleaned = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
    const parsed = ConflictDecisionSchema.safeParse(JSON.parse(cleaned));
    if (!parsed.success) return { decision: 'ADD' };
    return parsed.data;
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
      outcome: result.skipped
        ? 'cancelled'
        : (result.factsWritten + result.entitiesUpserted + result.pointersStored > 0
            ? 'success'
            : 'error'),
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
