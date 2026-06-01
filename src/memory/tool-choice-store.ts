import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
    invocationTemplate: typeof r.invocationTemplate === 'string' ? r.invocationTemplate : undefined,
    testedAt: typeof r.testedAt === 'string' ? r.testedAt : new Date().toISOString(),
    testEvidence: typeof r.testEvidence === 'string' ? r.testEvidence : undefined,
  };
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

export function rememberToolChoice(input: RememberToolChoiceInput): ToolChoiceRecord {
  const existing = parseRecord(filePathFor(input.intent));
  const now = new Date().toISOString();
  const merged = mergeFallbacks(existing?.fallbacks ?? [], input.fallbacks ?? []);
  const choice: ToolChoiceRecordChoice = {
    kind: input.choice.kind,
    identifier: input.choice.identifier,
    invocationTemplate: stripBakedConnectionId(input.choice.invocationTemplate),
    testedAt: input.choice.testedAt ?? now,
    testEvidence: input.choice.testEvidence,
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
type ToolChoiceAction = 'recall_hit' | 'recall_hit_fuzzy' | 'recall_miss' | 'remember' | 'invalidate' | 'auto_invalidate';
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

export function renderToolChoicesForContext(limit = 12, maxChars = TOOL_CHOICE_BLOCK_MAX): string {
  if (!contextInjectEnabled()) return '';
  let records: ToolChoiceRecord[];
  try {
    records = listToolChoices();
  } catch {
    return '';
  }
  const active = records
    .filter((r) => r.choice)
    .sort((a, b) => (b.choice!.testedAt ?? '').localeCompare(a.choice!.testedAt ?? ''))
    .slice(0, limit);
  if (active.length === 0) return '';
  const header = 'These tools previously worked for these intents on this machine. Prefer them directly — skip rediscovery (composio_search_tools / local_cli_list). If one fails, call tool_choice_invalidate and rediscover.';
  const clip = (s: string): string => (s.length <= TOOL_CHOICE_LINE_MAX ? s : `${s.slice(0, TOOL_CHOICE_LINE_MAX - 1)}…`);
  // Accumulate lines until the block budget is hit (header counts toward it),
  // so the most-recently-tested choices win the space.
  const lines: string[] = [];
  let used = header.length;
  for (const r of active) {
    const c = r.choice!;
    const how = c.invocationTemplate ? ` → \`${c.invocationTemplate}\`` : '';
    const line = clip(`- ${r.intent}: ${c.kind}:${c.identifier}${how}`);
    if (used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
  }
  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
}
