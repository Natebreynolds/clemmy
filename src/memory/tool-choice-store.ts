import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { recordToolEvent } from '../agents/tool-observability.js';

/**
 * Tool-choice memory store.
 *
 * Phase A of the intent-based tool dispatch plan. Stores, per-machine,
 * which concrete tool (CLI, Composio action, MCP tool) the agent
 * picked the last time it served a given intent — so future runs of
 * the same intent skip discovery and go straight to the proven path.
 *
 * Layout:
 *   ~/.clementine-next/memory/tool-choices/<machine-id>/<intent-slug>.md
 *
 * Each file is a YAML-frontmatter markdown doc (same format as the
 * rest of the vault). The frontmatter holds the choice and the
 * fallbacks (what didn't work); the body is free-form for any human
 * notes / context.
 *
 * Free-form intent slugs by design (decision 2026-05-19). To defend
 * against paraphrase fragmentation, `recallToolChoice` does a fuzzy
 * lookup when there's no exact slug match.
 *
 * Re-validation is event-driven only (decision 2026-05-19). A choice
 * stays valid until `invalidateToolChoice(intent, reason)` is called,
 * which moves the active choice into `fallbacks` and clears it.
 */

export type ToolChoiceKind = 'cli' | 'composio' | 'mcp';

export interface ToolChoiceRecordChoice {
  kind: ToolChoiceKind;
  /** CLI command name when kind=cli; Composio slug when kind=composio; MCP tool name when kind=mcp. */
  identifier: string;
  /** Free-form template the Executor renders. May contain `{{var}}` placeholders. */
  invocationTemplate?: string;
  /** ISO-8601 of when this choice was last validated. Informational. */
  testedAt: string;
  /** Short string describing how validation passed (e.g. "sf --version exit 0"). */
  testEvidence?: string;
  // ── Thread 2 — outcome-driven procedural memory ──
  // Track record of how this proven path has FARED since it was learned, so
  // retrieval can prefer procedures that actually work and retire ones that
  // don't. Reset when the identifier changes (a different tool earns its own
  // record). All optional → absent on legacy/never-measured choices.
  successCount?: number;
  failureCount?: number;
  approvalCount?: number;
  rejectionCount?: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface ToolChoiceRecordFallback {
  kind: ToolChoiceKind;
  identifier: string;
  failedAt: string;
  reason: string;
}

export interface ToolChoiceRecord {
  intent: string;
  description?: string;
  /** The currently active choice. Null when invalidated and not yet rediscovered. */
  choice: ToolChoiceRecordChoice | null;
  fallbacks: ToolChoiceRecordFallback[];
  /** Free-form markdown body after the frontmatter — optional human notes. */
  body: string;
  /** Absolute path of the underlying file. Useful for debugging. */
  filePath: string;
}

export interface RememberToolChoiceInput {
  intent: string;
  description?: string;
  choice: Omit<ToolChoiceRecordChoice, 'testedAt'> & { testedAt?: string };
  /** Optional fallbacks to record alongside the choice. Merged with any pre-existing fallbacks. */
  fallbacks?: ToolChoiceRecordFallback[];
  /** Optional body text. When omitted, preserves the existing body on update. */
  body?: string;
}

const TOOL_CHOICES_ROOT = path.join(BASE_DIR, 'memory', 'tool-choices');

function machineDir(): string {
  return path.join(TOOL_CHOICES_ROOT, getMachineId());
}

function ensureMachineDir(): string {
  const dir = machineDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Slugify a free-form intent string for use as a filename. Conservative — preserves dots. */
export function slugifyIntent(intent: string): string {
  return intent
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

function filePathFor(intent: string): string {
  const slug = slugifyIntent(intent);
  return path.join(machineDir(), `${slug}.md`);
}

function parseRecord(filePath: string): ToolChoiceRecord | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const intent = typeof fm.intent === 'string' ? fm.intent : path.basename(filePath, '.md');
  const description = typeof fm.description === 'string' ? fm.description : undefined;
  const choice = parseChoice(fm.choice);
  const fallbacks = Array.isArray(fm.fallbacks) ? fm.fallbacks.map(parseFallback).filter(isFallback) : [];
  return { intent, description, choice, fallbacks, body: parsed.content ?? '', filePath };
}

function parseChoice(raw: unknown): ToolChoiceRecordChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const identifier = r.identifier ?? r.command ?? r.slug ?? r.name;
  if (kind !== 'cli' && kind !== 'composio' && kind !== 'mcp') return null;
  if (typeof identifier !== 'string' || identifier.length === 0) return null;
  return {
    kind,
    identifier,
    // Strip any baked `connected_account_id` on READ too (not just on write):
    // 50+ legacy choices on disk still carry a hardcoded ca_… that, if the model
    // copied the template verbatim into composio_execute_tool, would override the
    // LIVE connection resolution and silently fail when that id rotates/revokes
    // (the 2026-06-01 Airtable INVALID_PERMISSIONS class). Stripping at the single
    // read source means every consumer — context injection, recall, the authoring
    // matcher — sees a connection-less template and always falls to live resolve.
    invocationTemplate: typeof r.invocationTemplate === 'string' ? stripBakedConnectionId(r.invocationTemplate) : undefined,
    testedAt: typeof r.testedAt === 'string' ? r.testedAt : new Date().toISOString(),
    testEvidence: typeof r.testEvidence === 'string' ? r.testEvidence : undefined,
    // Outcome counters — only present once measured, so legacy files round-trip
    // byte-identically until an outcome is recorded.
    successCount: numOrUndef(r.successCount),
    failureCount: numOrUndef(r.failureCount),
    approvalCount: numOrUndef(r.approvalCount),
    rejectionCount: numOrUndef(r.rejectionCount),
    lastSuccessAt: typeof r.lastSuccessAt === 'string' ? r.lastSuccessAt : undefined,
    lastFailureAt: typeof r.lastFailureAt === 'string' ? r.lastFailureAt : undefined,
  };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parseFallback(raw: unknown): ToolChoiceRecordFallback | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  const identifier = r.identifier ?? r.command ?? r.slug ?? r.name;
  const reason = r.reason;
  if (kind !== 'cli' && kind !== 'composio' && kind !== 'mcp') return null;
  if (typeof identifier !== 'string') return null;
  if (typeof reason !== 'string') return null;
  return {
    kind,
    identifier,
    failedAt: typeof r.failedAt === 'string' ? r.failedAt : new Date().toISOString(),
    reason,
  };
}

function isFallback(x: ToolChoiceRecordFallback | null): x is ToolChoiceRecordFallback {
  return x !== null;
}

function writeRecord(record: Omit<ToolChoiceRecord, 'filePath'> & { filePath?: string }): ToolChoiceRecord {
  ensureMachineDir();
  const filePath = record.filePath ?? filePathFor(record.intent);
  const fm: Record<string, unknown> = {
    intent: record.intent,
    ...(record.description ? { description: record.description } : {}),
    choice: record.choice ?? null,
    fallbacks: record.fallbacks,
  };
  const body = record.body ?? defaultBodyFor(record.intent, record.description);
  // gray-matter / js-yaml refuses to serialize `undefined`. Strip
  // undefined keys recursively before dumping so callers can pass
  // partial objects (e.g. choice without invocationTemplate) without
  // having to construct exact-shape literals.
  const stringified = matter.stringify(body, stripUndefined(fm) as object);
  writeFileSync(filePath, stringified, 'utf-8');
  return { ...record, body, filePath };
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

function defaultBodyFor(intent: string, description?: string): string {
  return [
    `# Tool choice — \`${intent}\``,
    '',
    description ?? '_(no description provided)_',
    '',
    'This file is maintained by Clementine\'s tool-choice memory. Edits are safe; the frontmatter is the source of truth.',
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

/**
 * Look up a recorded tool choice for an intent.
 *
 * Lookup strategy:
 *   1. Exact slug match → return that record.
 *   2. No exact match → fuzzy scan: rank existing slugs by token-overlap
 *      with the query slug; if the best candidate's score is ≥ 0.5 and
 *      strictly higher than the runner-up, return it.
 *   3. Otherwise return null.
 *
 * The fuzzy threshold is deliberately conservative: a borderline match
 * is more dangerous than a miss (false-positive picks a wrong tool).
 */
export function recallToolChoice(intent: string): ToolChoiceRecord | null {
  const slug = slugifyIntent(intent);
  if (!slug) return null;

  const exactPath = path.join(machineDir(), `${slug}.md`);
  const exact = parseRecord(exactPath);
  if (exact) {
    emitToolChoiceEvent('recall_hit', intent, exact.choice?.identifier);
    return exact;
  }

  // Fuzzy fallback
  const dir = machineDir();
  if (!existsSync(dir)) { emitToolChoiceEvent('recall_miss', intent); return null; }
  const slugs = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
  if (slugs.length === 0) { emitToolChoiceEvent('recall_miss', intent); return null; }

  const queryTokens = tokenize(slug);
  const scored = slugs.map((existing) => ({
    slug: existing,
    score: jaccardOverlap(queryTokens, tokenize(existing)),
  })).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < 0.5) { emitToolChoiceEvent('recall_miss', intent); return null; }
  if (runnerUp && runnerUp.score >= best.score) { emitToolChoiceEvent('recall_miss', intent); return null; }
  const fuzzy = parseRecord(path.join(dir, `${best.slug}.md`));
  emitToolChoiceEvent(fuzzy ? 'recall_hit_fuzzy' : 'recall_miss', intent, fuzzy?.choice?.identifier);
  return fuzzy;
}

function tokenize(slug: string): Set<string> {
  return new Set(
    slug
      .split(/[._\-/]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  );
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Upsert a tool choice. Merges with any existing record:
 *   - `choice` is replaced wholesale.
 *   - `fallbacks` from the input are appended to existing fallbacks
 *     (deduped by kind+identifier+reason).
 *   - `description` updates only if the input provides one.
 *   - `body` updates only if the input provides one.
 */
/**
 * Strip a hardcoded `connected_account_id` (Composio connection id, `ca_…`)
 * from a saved invocation template. Connection ids ROT — they get re-issued,
 * duplicated, or revoked — and a stale one baked into a tool-choice silently
 * breaks the WHOLE toolkit (observed 2026-06-01: Airtable returned
 * INVALID_PERMISSIONS for every records call because the cached template
 * pinned a dead `ca_…`). We never persist a specific connection; the composio
 * client resolves the LIVE connection for the toolkit at call time instead.
 */
export function stripBakedConnectionId(template: string | undefined): string | undefined {
  if (!template) return template;
  return template
    .replace(/connected_account_id\s*[=:]\s*["'][^"']*["']\s*,?\s*/g, '')
    .replace(/,\s*\)/g, ')')
    .replace(/\(\s*,\s*/g, '(')
    // Also clean the JSON-object/array case (e.g. stripping a mid-object
    // `connected_account_id` can leave a dangling `, }` or `{ ,`).
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{[])\s*,/g, '$1')
    .trim();
}

/**
 * Detect when a tool-choice's OWN evidence says the attempt FAILED or was
 * BLOCKED by a gate — so we never persist a failure as a PROVEN choice.
 *
 * The 2026-06-21 poisoning: a `netlify deploy` was hard-blocked by the
 * destination gate, after which the model called `tool_choice_remember` with
 * evidence "refused by harness UNVERIFIED_DESTINATION gate … must run manually"
 * — and the store saved it as the proven path, so the NEXT deploy would recall
 * "must run manually" instead of the real working memo (`netlify.deploy.local_site`).
 * A proven choice must represent something that WORKED. This is a code-level
 * guard (not a prompt rule), general across gates/CLIs/vendors. Conservative:
 * requires a STRONG failure/refusal marker, so a memo that merely *mentions*
 * handling failures ("retries on a 5xx") is not dropped.
 */
export function evidenceLooksFailedOrBlocked(text: string | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  return (
    // Harness gate refusals — the exact poisoning vector (any gate, not netlify).
    /\b(unverified_destination|implicit_destination|execution_wrap_required|confirm_first_required|grounding_check_failed|duplicate_external_write)\b/.test(t)
    || /refused by (?:the )?harness|tool call refused|blocked by (?:the )?(?:harness|gate|guardrail)/.test(t)
    // Punted to the human — the choice did NOT complete programmatically.
    || /run (?:it|this) manually|(?:must|need to|have to) (?:be )?run\b[^.]{0,20}\bmanual|deploy (?:it )?manually|do (?:it|this) manually/.test(t)
    // Unambiguous failure of the action this memo is supposed to encode.
    || /\b(?:could not|couldn't|cannot|can't|unable to|failed to)\s+(?:deploy|publish|run|send|create|upload|complete|execute|connect|authenticate)/.test(t)
    || /\b(?:was|were|got) (?:blocked|refused|rejected|denied)\b/.test(t)
  );
}

export function rememberToolChoice(input: RememberToolChoiceInput): ToolChoiceRecord {
  const existing = parseRecord(filePathFor(input.intent));
  const now = new Date().toISOString();
  // Write-back guard (2026-06-21 poisoned-memo class): if the model's OWN
  // evidence/description says this attempt was BLOCKED by a gate or FAILED, never
  // promote it to the active proven choice. Record it as a fallback (preserving
  // the "what was tried" history) and KEEP any existing proven choice — so recall
  // surfaces the real working memo (or triggers clean rediscovery), never "must
  // run manually". General + code-level; emits its own telemetry action.
  if (evidenceLooksFailedOrBlocked(input.choice.testEvidence) || evidenceLooksFailedOrBlocked(input.description)) {
    const reason = (input.choice.testEvidence || input.description || 'attempt blocked/failed').slice(0, 300);
    const failedFallback: ToolChoiceRecordFallback = {
      kind: input.choice.kind,
      identifier: input.choice.identifier,
      failedAt: now,
      reason,
    };
    const saved = writeRecord({
      intent: input.intent,
      description: input.description ?? existing?.description,
      // Keep an EXISTING proven choice; never overwrite it with a failure. If
      // none exists, leave choice null so recall won't serve a poisoned path.
      choice: existing?.choice ?? null,
      fallbacks: mergeFallbacks(existing?.fallbacks ?? [], [failedFallback]),
      body: input.body ?? existing?.body ?? defaultBodyFor(input.intent, input.description ?? existing?.description),
      filePath: existing?.filePath,
    });
    emitToolChoiceEvent('remember_rejected_failed', input.intent, input.choice.identifier);
    return saved;
  }
  const merged = mergeFallbacks(existing?.fallbacks ?? [], input.fallbacks ?? []);
  // Thread 2: carry the outcome track record forward when re-remembering the
  // SAME tool (a re-validation shouldn't wipe its history); reset when the
  // identifier changes (a different tool earns a fresh record).
  const prev = existing?.choice;
  const samePath = prev && prev.kind === input.choice.kind && prev.identifier === input.choice.identifier;
  const choice: ToolChoiceRecordChoice = {
    kind: input.choice.kind,
    identifier: input.choice.identifier,
    invocationTemplate: stripBakedConnectionId(input.choice.invocationTemplate),
    testedAt: input.choice.testedAt ?? now,
    testEvidence: input.choice.testEvidence,
    ...(samePath ? {
      successCount: prev.successCount,
      failureCount: prev.failureCount,
      approvalCount: prev.approvalCount,
      rejectionCount: prev.rejectionCount,
      lastSuccessAt: prev.lastSuccessAt,
      lastFailureAt: prev.lastFailureAt,
    } : {}),
  };
  const saved = writeRecord({
    intent: input.intent,
    description: input.description ?? existing?.description,
    choice,
    fallbacks: merged,
    body: input.body ?? existing?.body ?? defaultBodyFor(input.intent, input.description ?? existing?.description),
  });
  emitToolChoiceEvent('remember', input.intent, choice.identifier);
  return saved;
}

function mergeFallbacks(
  existing: ToolChoiceRecordFallback[],
  incoming: ToolChoiceRecordFallback[],
): ToolChoiceRecordFallback[] {
  const seen = new Set<string>();
  const out: ToolChoiceRecordFallback[] = [];
  const key = (f: ToolChoiceRecordFallback) => `${f.kind}:${f.identifier}:${f.reason}`;
  for (const arr of [existing, incoming]) {
    for (const f of arr) {
      const k = key(f);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
    }
  }
  return out;
}

/**
 * Invalidate the current choice for an intent.
 *
 * Moves the active choice into `fallbacks` with the supplied reason,
 * then clears `choice`. The next `recallToolChoice` for this intent
 * still finds the file (so the fallbacks history is preserved and the
 * caller knows what's been tried) but `choice` is null — the
 * Orchestrator's pre-flight will see that and trigger fresh discovery.
 *
 * Returns the updated record, or null if no record existed.
 */
export function invalidateToolChoice(
  intent: string,
  reason: string,
  opts: { automatic?: boolean } = {},
): ToolChoiceRecord | null {
  const existing = parseRecord(filePathFor(intent));
  if (!existing) return null;
  // Idempotent: already invalidated (choice null) → no-op success, no re-emit.
  // This makes a manual invalidate after the automatic one (or vice-versa) a
  // clean no-op instead of double-counting / re-writing.
  if (!existing.choice) return existing;
  const now = new Date().toISOString();
  const newFallbacks = [
    ...existing.fallbacks,
    {
      kind: existing.choice.kind,
      identifier: existing.choice.identifier,
      failedAt: now,
      reason,
    } as ToolChoiceRecordFallback,
  ];
  const invalidatedIdentifier = existing.choice.identifier;
  const updated = writeRecord({
    intent: existing.intent,
    description: existing.description,
    choice: null,
    fallbacks: newFallbacks,
    body: existing.body,
    filePath: existing.filePath,
  });
  // Split the telemetry action so background self-correction (automatic) is
  // visible to operators WITHOUT skewing the recall-hit-rate metric that the
  // agent-behavior `invalidate` feeds.
  emitToolChoiceEvent(opts.automatic ? 'auto_invalidate' : 'invalidate', intent, invalidatedIdentifier);
  return updated;
}

/**
 * Non-emitting read of a tool-choice record (no recall telemetry). For internal
 * callers (e.g. additive auto-commit) that must check whether an active choice
 * already exists WITHOUT firing a recall_hit/recall_miss event and skewing the
 * north-star recall-hit-rate metric.
 */
export function peekToolChoice(intent: string): ToolChoiceRecord | null {
  return parseRecord(filePathFor(intent));
}

/**
 * HARD-delete a tool-choice record (unlink the markdown file) — a TRUE clear.
 *
 * Unlike `invalidateToolChoice` (which keeps the file with choice=null, so it
 * is still fuzzy-matchable by recall and can be silently re-poisoned by
 * auto-remember filling the null slot), this removes the record entirely so the
 * next request re-discovers from scratch. Returns true if a file was removed.
 * (v0.5.64 — gives the agent/user a real "forget what you learned" affordance
 * so a poisoned choice no longer requires hand-deleting files.)
 */
export function deleteToolChoice(intent: string): boolean {
  try {
    const fp = filePathFor(intent);
    if (!existsSync(fp)) return false;
    unlinkSync(fp);
    emitToolChoiceEvent('forget', intent);
    return true;
  } catch {
    return false; // best-effort — a forget failure must never throw to a tool call
  }
}

/**
 * Forget every tool-choice whose intent matches `pattern` (case-insensitive
 * substring on the raw intent OR its slug). Returns the forgotten intents.
 * Used to clear a poisoned CLUSTER in one call (e.g. every `outlook send` /
 * `mark read` choice) instead of one intent at a time.
 */
export function forgetMatching(pattern: string): string[] {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return [];
  const needleSlug = slugifyIntent(needle);
  const forgotten: string[] = [];
  for (const rec of listToolChoices()) {
    const matches = rec.intent.toLowerCase().includes(needle)
      || (needleSlug.length > 0 && slugifyIntent(rec.intent).includes(needleSlug));
    if (matches && deleteToolChoice(rec.intent)) forgotten.push(rec.intent);
  }
  return forgotten;
}

/** List all recorded tool choices on this machine. Test/debug helper. */
export function listToolChoices(): ToolChoiceRecord[] {
  const dir = machineDir();
  if (!existsSync(dir)) return [];
  const out: ToolChoiceRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const rec = parseRecord(path.join(dir, f));
    if (rec) out.push(rec);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Author-time binding — match a workflow STEP PROMPT to the proven
// tool-choices the user has already taught Clem, so authoring bakes the
// concrete command into the step instead of leaving it generic (which lets
// the runtime agent re-decide and drift onto a stale/expired path).
//
// Scoring note: `jaccardOverlap` (used by recallToolChoice) compares two
// SLUGS of similar size. A step prompt is a long sentence and a choice's
// distinctive tokens are few — jaccard would score that near zero. So we use
// CONTAINMENT: of the choice's distinctive tokens, what fraction appear in the
// prompt. We also require at least one matched token to come from the choice's
// CORE identity (intent slug / identifier), not just its description, so an
// incidental description word can't trigger a bind.
// ─────────────────────────────────────────────────────────────────

/** Generic verbs/nouns that must never, on their own, anchor a step→choice
 *  match. Service/tool names (salesforce, airtable, firecrawl, sf, …) are NOT
 *  here — those are exactly the distinctive tokens we want to match on. */
// Two filter sets, applied differently:
//  - CORE (intent slug + identifier) keeps OPERATION tokens (query, list, soql,
//    update, …) because in a slug like `salesforce.cli.query` the operation IS
//    part of the tool's identity. It drops only true stopwords + tool-TYPE words
//    (cli/mcp/api) that never appear in a step prompt. A match then needs ≥2 of
//    these identity tokens (service + operation), so a lone service mention
//    ("the salesforce dashboard") never binds.
//  - CONTEXT (the free-text description) drops the broad generic set too, since
//    in prose those words are noise, not identity.
const STEP_MATCH_STOPWORDS = new Set<string>([
  'the', 'for', 'and', 'via', 'using', 'use', 'from', 'into', 'with', 'all', 'then',
  'this', 'that', 'each', 'about', 'your', 'their', 'a', 'an', 'of', 'to', 'in', 'on',
  'at', 'by', 'or', 'as', 'is', 'it', 'new', 'step', 'workflow',
  // tool-TYPE tokens describe HOW, not WHAT.
  'cli', 'mcp', 'composio', 'api', 'sdk', 'rest', 'graphql', 'tool', 'tools',
]);
const STEP_MATCH_GENERIC_TOKENS = new Set<string>([
  ...STEP_MATCH_STOPWORDS,
  // generic verbs/objects: noise inside a free-text DESCRIPTION (kept in CORE).
  'query', 'get', 'list', 'fetch', 'read', 'write', 'create', 'update', 'delete',
  'run', 'call', 'data', 'records', 'record', 'find', 'search', 'pull', 'fetching',
]);

/** Word-tokenize free text (a step prompt) into a lowercase set, dropping
 *  punctuation and very short tokens. (recall's `tokenize` only splits slugs
 *  on `._-/`, so it can't tokenize a sentence — this is the prose counterpart.) */
function wordTokens(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2),
  );
}

/** The IDENTITY portion of a CLI command — the program + subcommands BEFORE
 *  the first flag (`-x`/`--x`) or quoted/`=` argument. A tool's identity is
 *  `sf data query`, NOT its query string: ingesting argument VALUES let generic
 *  words leak into "core identity" (e.g. `LAST_N_DAYS:15` → "last"/"days"),
 *  which false-matched unrelated step prompts ("scrape posts from the last 14
 *  days" → the Salesforce SOQL choice). Non-CLI identifiers (composio/mcp) are
 *  bare identity slugs already, so they're used whole. */
function cliCommandHead(command: string): string {
  const flagIdx = command.search(/\s-{1,2}\w/); // first " -x" / " --x"
  const quoteIdx = command.search(/["'=]/);     // first quoted / `=` argument
  const cuts = [flagIdx, quoteIdx].filter((i) => i >= 0);
  const cut = cuts.length ? Math.min(...cuts) : command.length;
  return command.slice(0, cut);
}

/** CORE identity tokens of a choice: its intent slug + the command-HEAD of its
 *  identifier (program + subcommands only — NOT argument values), keeping
 *  operation tokens (query/list/soql/…) and dropping only stopwords + tool-type
 *  words. A match needs ≥2 of these (service + operation), so a lone service
 *  mention — or an incidental shared argument-value word — can't bind. */
function coreChoiceTokens(rec: ToolChoiceRecord): Set<string> {
  const identifier = rec.choice?.identifier ?? '';
  const identityText = rec.choice?.kind === 'cli' ? cliCommandHead(identifier) : identifier;
  const raw = new Set<string>([
    ...tokenize(slugifyIntent(rec.intent)),
    ...wordTokens(identityText),
  ]);
  const out = new Set<string>();
  for (const t of raw) if (t.length >= 3 && !STEP_MATCH_STOPWORDS.has(t)) out.add(t);
  return out;
}

/** CONTEXT tokens of a choice: its description words, minus generics. Used to
 *  raise confidence but never sufficient alone to anchor a match. */
function contextChoiceTokens(rec: ToolChoiceRecord): Set<string> {
  const raw = wordTokens(rec.description ?? '');
  const out = new Set<string>();
  for (const t of raw) if (t.length >= 3 && !STEP_MATCH_GENERIC_TOKENS.has(t)) out.add(t);
  return out;
}

export type StepToolChoiceTier = 'high' | 'medium';

export interface StepToolChoiceMatch {
  intent: string;
  kind: ToolChoiceKind;
  identifier: string;
  invocationTemplate?: string;
  /** Containment score in [0,1]: distinctive choice tokens present in the prompt. */
  score: number;
  tier: StepToolChoiceTier;
  /** Distinctive tokens of the choice that were found in the step prompt. */
  matched: string[];
  /** The step prompt already embeds this choice's identifier/command — never re-bind. */
  alreadyBound: boolean;
  /** Whether this choice may be AUTO-bound (deterministic) vs ADVISE-only.
   *  Only proven `cli`/`mcp` choices auto-bind; `composio` (identifier/connection
   *  rot-prone, see stripBakedConnectionId) is always advise-only. */
  autoBindable: boolean;
  /** The `allowedTools` family this step should be locked to when bound. */
  family: string[];
  /** The concrete command/tool to bake into the bound step prompt. */
  command: string;
}

export interface MatchToolChoicesOptions {
  limit?: number;
  /** Override the store read (tests). */
  choices?: ToolChoiceRecord[];
}

/** Rank: lower = preferred. On a near-tie prefer cli/mcp over composio — routes
 *  around a poisoned/mislabeled composio choice when a clean cli/mcp one exists. */
function choiceKindRank(kind: ToolChoiceKind): number {
  return kind === 'cli' ? 0 : kind === 'mcp' ? 1 : 2;
}

/** Does the prompt already embed this choice's concrete path? Uses whole-word
 *  matching for short identifiers so a 2-char command like `sf` is NOT counted
 *  as bound merely because it's a substring of "sale**sf**orce". */
function promptAlreadyBinds(promptText: string, choice: ToolChoiceRecordChoice): boolean {
  const lower = promptText.toLowerCase();
  const words = wordTokens(promptText);
  const id = (choice.identifier ?? '').toLowerCase();
  // A distinctive identifier (≥5 chars, e.g. an mcp tool name) can match as a
  // substring; a short one (sf, gh) must appear as a STANDALONE word.
  if (id.length >= 5 && lower.includes(id)) return true;
  if (id && words.has(id)) return true;
  const tmpl = choice.invocationTemplate?.trim();
  if (tmpl) {
    const head = tmpl.split(/\s+/)[0]?.toLowerCase();
    if (head && words.has(head)) return true; // command head as a standalone word
    const slice = tmpl.slice(0, 24).toLowerCase();
    if (slice.length >= 8 && lower.includes(slice)) return true; // embedded command
  }
  return false;
}

/**
 * Match a workflow step prompt against the user's active remembered tool-choices.
 * Returns the strongest matches (capped), each tagged with a confidence tier and
 * whether it may be auto-bound. Pure apart from reading the tool-choice store.
 */
export function matchToolChoicesForStep(
  promptText: string,
  opts: MatchToolChoicesOptions = {},
): StepToolChoiceMatch[] {
  const limit = opts.limit ?? 3;
  const prompt = wordTokens(promptText);
  if (prompt.size === 0) return [];

  let records: ToolChoiceRecord[];
  try {
    records = opts.choices ?? listToolChoices();
  } catch {
    return [];
  }

  const out: StepToolChoiceMatch[] = [];
  for (const rec of records) {
    if (!rec.choice) continue; // inactive (invalidated, not yet rediscovered)
    const core = coreChoiceTokens(rec);
    if (core.size === 0) continue;
    const matchedCore = [...core].filter((t) => prompt.has(t));
    const alreadyBound = promptAlreadyBinds(promptText, rec.choice);

    // Precision: an embedded command is the strongest possible signal → always a
    // match (the consumer skips it as already-bound). Otherwise require at least
    // TWO CORE identity tokens (typically service + operation, e.g. "salesforce"
    // AND "query") with a real anchor — so a lone service mention or an
    // incidental shared description word can never trigger a bind.
    if (!alreadyBound) {
      if (matchedCore.length < 2) continue;
      if (!matchedCore.some((t) => t.length >= 4)) continue;
    }
    // Containment score (for ranking only): how much of the choice's identity +
    // description the prompt names. Description tokens only raise/lower the
    // score; they never gate a match (that's the core-count rule above).
    const distinctive = new Set<string>([...core, ...contextChoiceTokens(rec)]);
    const matchedDistinctive = [...distinctive].filter((t) => prompt.has(t));
    const score = alreadyBound ? 1 : matchedDistinctive.length / distinctive.size;

    out.push({
      intent: rec.intent,
      kind: rec.choice.kind,
      identifier: rec.choice.identifier,
      invocationTemplate: rec.choice.invocationTemplate,
      score,
      // HIGH (auto-bind candidate) = ≥2 core identity tokens named (or an
      // already-embedded command). cli/mcp at HIGH auto-bind; composio advises.
      tier: alreadyBound || matchedCore.length >= 2 ? 'high' : 'medium',
      matched: matchedDistinctive,
      alreadyBound,
      autoBindable: rec.choice.kind === 'cli' || rec.choice.kind === 'mcp',
      family: toolFamilyForChoice(rec.choice),
      command: boundCommandForChoice(rec.choice),
    });
  }

  out.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.08) return b.score - a.score;
    return choiceKindRank(a.kind) - choiceKindRank(b.kind);
  });
  return out.slice(0, limit);
}

/** The `allowedTools` family a step should be locked to when bound to a choice.
 *  cli → run_shell_command; mcp → the mcp tool name; composio → the slug. */
export function toolFamilyForChoice(choice: ToolChoiceRecordChoice): string[] {
  switch (choice.kind) {
    case 'cli':
      return ['run_shell_command'];
    case 'mcp':
      return [choice.identifier];
    case 'composio':
      return ['composio_execute_tool'];
    default:
      return [];
  }
}

/** The concrete, human-readable command/tool to bake into a bound step prompt. */
export function boundCommandForChoice(choice: ToolChoiceRecordChoice): string {
  if (choice.invocationTemplate && choice.invocationTemplate.trim().length > 0) {
    return choice.invocationTemplate.trim();
  }
  return choice.identifier;
}

// ─────────────────────────────────────────────────────────────────
// P2 — measured learning loop
// ─────────────────────────────────────────────────────────────────

/**
 * Emit a synthetic `tool_choice` telemetry event so the observatory can
 * compute a recall hit-rate over time (proving the north-star claim that
 * Clem "gets measurably better at your work"). Mirrors the `reflection`
 * synthetic-event pattern (observatory computeBrainHealth): toolName is a
 * stable label, the action + intent live in argsSummary for the reader to
 * parse. Always-on + best-effort: it's the measurement, and it must never
 * perturb a recall/remember path. The CONTEXT INJECTION (behavior change)
 * is what's flag-gated, not this measurement.
 */
type ToolChoiceAction = 'recall_hit' | 'recall_hit_fuzzy' | 'recall_miss' | 'remember' | 'remember_rejected_failed' | 'invalidate' | 'auto_invalidate' | 'forget' | 'outcome_pos' | 'outcome_neg';
function emitToolChoiceEvent(action: ToolChoiceAction, intent: string, identifier?: string): void {
  try {
    recordToolEvent({
      at: new Date().toISOString(),
      toolName: 'tool_choice',
      kind: 'read',
      phase: 'end',
      outcome: action === 'recall_miss' ? 'cancelled' : 'success',
      argsSummary: `action=${action} intent=${slugifyIntent(intent)}${identifier ? ` id=${identifier}` : ''}`,
    });
  } catch {
    /* telemetry is best-effort — never break a tool-choice operation */
  }
}

// ─────────────────────────────────────────────────────────────────
// Thread 2 — outcome-driven procedural memory
// ─────────────────────────────────────────────────────────────────

/** Outcome-driven procedural memory: record how a remembered tool path FARES
 *  (success/failure/approve/reject) and prefer proven paths over merely-recent
 *  ones, auto-retiring repeat failures. DEFAULT-ON (validated behavior → default,
 *  per the no-rollout-flags rule); set CLEMMY_PROCEDURAL_OUTCOMES=off to disable
 *  (kill-switch retained → byte-identical pre-outcome recency ordering + no-op
 *  recording). This is the learning loop's teeth: "route by learned success."
 *  Composio + approval outcomes already feed it (composio-tools.ts,
 *  approval-registry.ts); turning it on lights up both recording and ranking. */
export function isProceduralOutcomesEnabled(): boolean {
  return (process.env.CLEMMY_PROCEDURAL_OUTCOMES ?? 'on').toLowerCase() !== 'off';
}

export type ProceduralOutcome = 'success' | 'failure' | 'approved' | 'rejected';

/** A choice whose injected confidence is at/below this is net-negative — it has
 *  failed at least as often as it has worked — so it's dropped from injection
 *  (still on disk + recallable; the model can retry, but we stop advertising a
 *  broken procedure as "previously worked"). */
export const TOOL_CHOICE_SCORE_FLOOR = 0.34;
/** Auto-invalidate (→ rediscovery) after this many failures with no later win. */
const AUTO_INVALIDATE_FAILURE_STREAK = 3;

/**
 * Laplace-smoothed success rate in (0,1). positives = success + approval;
 * negatives = failure + rejection. Prior 0.5 (one phantom win + one loss) so a
 * single observation can't peg the score to 0 or 1 — a freshly-learned choice
 * sits at the neutral prior until evidence accrues.
 */
export function computeChoiceScore(choice: ToolChoiceRecordChoice | null | undefined): number {
  if (!choice) return 0.5;
  const pos = (choice.successCount ?? 0) + (choice.approvalCount ?? 0);
  const neg = (choice.failureCount ?? 0) + (choice.rejectionCount ?? 0);
  return (pos + 1) / (pos + neg + 2);
}

function applyOutcome(choice: ToolChoiceRecordChoice, outcome: ProceduralOutcome, nowIso: string): ToolChoiceRecordChoice {
  const next = { ...choice };
  switch (outcome) {
    case 'success': next.successCount = (next.successCount ?? 0) + 1; next.lastSuccessAt = nowIso; break;
    case 'failure': next.failureCount = (next.failureCount ?? 0) + 1; next.lastFailureAt = nowIso; break;
    case 'approved': next.approvalCount = (next.approvalCount ?? 0) + 1; break;
    case 'rejected': next.rejectionCount = (next.rejectionCount ?? 0) + 1; break;
  }
  return next;
}

function recordOutcomeOn(rec: ToolChoiceRecord, outcome: ProceduralOutcome): ToolChoiceRecord | null {
  if (!rec.choice) return null;
  const now = new Date().toISOString();
  const nextChoice = applyOutcome(rec.choice, outcome, now);
  const saved = writeRecord({
    intent: rec.intent,
    description: rec.description,
    choice: nextChoice,
    fallbacks: rec.fallbacks,
    body: rec.body,
    filePath: rec.filePath,
  });
  emitToolChoiceEvent(outcome === 'failure' || outcome === 'rejected' ? 'outcome_neg' : 'outcome_pos', rec.intent, nextChoice.identifier);

  // Auto-invalidate a path that's failing repeatedly with no later win, so the
  // next run rediscovers instead of re-treading a broken procedure.
  if (outcome === 'failure') {
    const failures = nextChoice.failureCount ?? 0;
    const winAfterLoss = nextChoice.lastSuccessAt && nextChoice.lastFailureAt
      ? nextChoice.lastSuccessAt > nextChoice.lastFailureAt
      : Boolean(nextChoice.lastSuccessAt);
    if (failures >= AUTO_INVALIDATE_FAILURE_STREAK && !winAfterLoss) {
      return invalidateToolChoice(
        rec.intent,
        `auto-invalidated after ${failures} failures with no later success`,
        { automatic: true },
      ) ?? saved;
    }
  }
  return saved;
}

/**
 * Record an outcome for the active choice of an intent. No-op (returns null)
 * when the flag is off, the record is missing, or the choice is inactive.
 */
export function updateToolChoiceOutcome(intent: string, outcome: ProceduralOutcome): ToolChoiceRecord | null {
  if (!isProceduralOutcomesEnabled()) return null;
  const existing = parseRecord(filePathFor(intent));
  if (!existing || !existing.choice) return null;
  return recordOutcomeOn(existing, outcome);
}

/**
 * Record an outcome against every active choice whose identifier matches (e.g.
 * a Composio slug). The composio execute path knows the slug on every call —
 * regardless of whether a search preceded it — so this is the primary loop-
 * closing seam. Returns the number of choice records updated.
 */
export function updateToolChoiceOutcomeForIdentifier(identifier: string, outcome: ProceduralOutcome): number {
  if (!isProceduralOutcomesEnabled()) return 0;
  if (!identifier) return 0;
  let updated = 0;
  for (const rec of listToolChoices()) {
    if (rec.choice && rec.choice.identifier === identifier) {
      if (recordOutcomeOn(rec, outcome)) updated += 1;
    }
  }
  return updated;
}

/**
 * P2: inject remembered tool choices into the persistent context
 * block so the agent recalls a proven tool by READING, not only by
 * calling tool_choice_recall (which the prompt teaches but cannot
 * guarantee). Default ON with an escape hatch because this is now
 * budget-capped and per-machine.
 */
function contextInjectEnabled(): boolean {
  return (process.env.TOOL_CHOICE_CONTEXT_INJECT ?? 'on').toLowerCase() !== 'off';
}

/**
 * Render the most-relevant remembered tool choices as a compact context
 * block. Active choices only (an invalidated, not-yet-rediscovered choice
 * is noise here), most-recently-tested first, capped at `limit`. Returns
 * '' when the flag is off or nothing is remembered → no context change.
 *
 * Token-efficiency (north star): one tight line per choice, hard cap.
 */
// Per-line + whole-block caps so enabling context injection can't bloat the
// persistent prefix on every turn (the renderFactsForInstructions discipline:
// an explicit budget, not just a count). A long invocationTemplate is clipped,
// not dropped — the agent still sees the intent→tool mapping.
const TOOL_CHOICE_LINE_MAX = 160;
const TOOL_CHOICE_BLOCK_MAX = 1400;

export function renderToolChoicesForContext(limit = 12, maxChars = TOOL_CHOICE_BLOCK_MAX, objective?: string): string {
  if (!contextInjectEnabled()) return '';
  let records: ToolChoiceRecord[];
  try {
    records = listToolChoices();
  } catch {
    return '';
  }
  let activeRecords = records.filter((r) => r.choice);
  if (activeRecords.length === 0) return '';

  // Thread 2 / P3 — outcome weighting (flag-gated; off = byte-identical below).
  // Drop net-negative procedures from the ADVERTISED set (they remain on disk
  // and recallable — we just stop telling the model a broken path "worked").
  // If filtering would empty the pool, keep the unfiltered set rather than
  // advertise nothing.
  const outcomesOn = isProceduralOutcomesEnabled();
  if (outcomesOn) {
    const filtered = activeRecords.filter((r) => computeChoiceScore(r.choice) >= TOOL_CHOICE_SCORE_FLOOR);
    if (filtered.length > 0) activeRecords = filtered;
  }

  // Default ordering: most-recently-tested first (byte-identical to before).
  // With outcomes on, higher-confidence choices sort ahead of fresher-but-
  // unproven ones (recency breaks near-ties).
  const byRecency = [...activeRecords].sort((a, b) => {
    if (outcomesOn) {
      const sd = computeChoiceScore(b.choice) - computeChoiceScore(a.choice);
      if (Math.abs(sd) > 0.05) return sd;
    }
    return (b.choice!.testedAt ?? '').localeCompare(a.choice!.testedAt ?? '');
  });

  // P1-E — when the active objective is known, promote the choices RELEVANT to
  // it above pure recency so the model reuses the right remembered tool (e.g.
  // SALESFORCE_QUERY_RECORDS for a Salesforce-query task) instead of
  // re-discovering. Relevance uses the same matcher workflows use (≥2 core
  // identity tokens), so a lone service mention can't promote an unrelated
  // choice. The no-objective path is unchanged.
  let ordered = byRecency;
  const relevantIntents = new Set<string>();
  const trimmedObjective = objective?.trim();
  if (trimmedObjective) {
    try {
      const matches = matchToolChoicesForStep(trimmedObjective, {
        choices: byRecency,
        limit: byRecency.length,
      });
      for (const m of matches) relevantIntents.add(m.intent);
      if (relevantIntents.size > 0) {
        const relevant = byRecency.filter((r) => relevantIntents.has(r.intent));
        const rest = byRecency.filter((r) => !relevantIntents.has(r.intent));
        ordered = [...relevant, ...rest];
      }
    } catch {
      /* relevance ranking is best-effort; fall back to recency */
    }
  }

  const active = ordered.slice(0, limit);
  const header = relevantIntents.size > 0
    ? 'These tools previously worked for these intents on this machine (★ = relevant to your current task). Prefer them directly — skip rediscovery (composio_search_tools / local_cli_list). If one fails, call tool_choice_invalidate and rediscover.'
    : 'These tools previously worked for these intents on this machine. Prefer them directly — skip rediscovery (composio_search_tools / local_cli_list). If one fails, call tool_choice_invalidate and rediscover.';
  const clip = (s: string): string => (s.length <= TOOL_CHOICE_LINE_MAX ? s : `${s.slice(0, TOOL_CHOICE_LINE_MAX - 1)}…`);
  // Accumulate lines until the block budget is hit (header counts toward it),
  // so the highest-ranked choices win the space.
  const lines: string[] = [];
  let used = header.length;
  for (const r of active) {
    const c = r.choice!;
    const star = relevantIntents.has(r.intent) ? '★ ' : '';
    const how = c.invocationTemplate ? ` → \`${c.invocationTemplate}\`` : '';
    // With outcomes on, show the track record so the model can gauge confidence.
    const neg = (c.failureCount ?? 0) + (c.rejectionCount ?? 0);
    const pos = (c.successCount ?? 0) + (c.approvalCount ?? 0);
    const track = outcomesOn && pos + neg > 0 ? ` (✓${pos}${neg ? `/✗${neg}` : ''})` : '';
    const line = clip(`- ${star}${r.intent}: ${c.kind}:${c.identifier}${how}${track}`);
    if (used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }
  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
}
