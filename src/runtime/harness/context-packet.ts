import { existsSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { getFocusSnapshot } from '../../memory/focus.js';
import { listSkills } from '../../memory/skill-store.js';
import { listWorkflows } from '../../memory/workflow-store.js';
import { listMcpServerHealth, type MCPServerHealthSnapshot } from '../mcp-namespace-shim.js';
import { resolveMcpToolScope, type McpToolScope } from '../mcp-tool-scope.js';

export interface MemoryPrimerSummary {
  enabled: boolean;
  hitCount: number;
  source?: string | null;
  injected: boolean;
  skippedReason?: string | null;
}

export interface RankedContextCandidate {
  name: string;
  description: string;
  score: number;
  reason: string;
}

/**
 * Result of the pure, turn-start multi-item detector. `isMultiItem` is true
 * only when the user's OWN words name N>=3 independent, same-shape items that
 * each warrant their own per-item tool work (so fanning out preserves context
 * and cuts the O(N^2) token leak). Conservative by construction: every
 * ambiguity resolves to NOT multi-item so we never wrongly push fan-out.
 */
export interface MultiItemIntent {
  isMultiItem: boolean;
  itemCount: number;
  itemKind: string | null;
  sameShapeWork: boolean;
}

export interface AgentContextPacket {
  inputPreview: string;
  complexity: 'simple' | 'moderate' | 'complex';
  memory: MemoryPrimerSummary;
  skills: RankedContextCandidate[];
  workflows: RankedContextCandidate[];
  toolScope: Pick<McpToolScope, 'reason' | 'allowAll' | 'allowedServerSlugs' | 'maxTools'>;
  mcp: Array<Pick<MCPServerHealthSnapshot, 'slug' | 'state' | 'toolCount' | 'failureCount' | 'lastError'>>;
  healthWarnings: string[];
  /**
   * Telemetry for the turn-start fan-out directive. `detected` = the pure
   * detector fired; `offered` = the directive was actually injected (detected
   * AND chat session AND flag on). Used to measure adherence lift.
   */
  multiItem: { detected: boolean; itemCount: number; offered: boolean };
  text: string;
}

const MAX_CANDIDATES = 3;
const LOW_DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
const CRITICAL_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'do', 'for', 'from',
  'go', 'have', 'help', 'i', 'in', 'into', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'our',
  'please', 'that', 'the', 'then', 'this', 'to', 'use', 'we', 'with', 'you',
]);

const DOMAIN_PATTERNS: RegExp[] = [
  /\bsalesforce|sf cli|soql|accounts?|leads?|contacts?|opportunit(?:y|ies)\b/i,
  /\bseo|ranking|rankings|serp|keyword|keywords|backlink|organic traffic|search visibility|dataforseo\b/i,
  /\boutlook|email|emails|drafts?|calendar|meeting invite\b/i,
  /\bgoogle sheets?|googlesheets?|spreadsheet|sheet row|worksheet\b/i,
  /\bwebsite|web page|webpage|scrape|crawl|browser|article|web search|look up online\b/i,
  /\blocal file|markdown|report|proposal|docx?|deck|pdf|workspace\b/i,
  /\bgithub|repo|repository|branch|commit|pull request|pr\b/i,
  /\bnetlify|vercel|railway|deploy|host\b/i,
];

const READ_RE = /\b(?:find|pull|query|search|scrape|crawl|research|audit|summarize|analyze|gather|inspect)\b/i;
const WRITE_RE =
  /\b(?:create|draft|send|write|update|append|post|publish|host|deploy|file|sheet|email|proposal|report|edit)\b/i;
const BATCH_RE = /\b(?:\d+|top\s+\d+|several|many|multiple|batch|bulk|list of|all of them|for each|each one)\b/i;
const SEQUENCE_RE = /\b(?:then|after that|afterward|before .* then|once .* then|first .* then)\b/i;

// ─── Turn-start multi-item detector (fan-out directive, P0) ─────────────────
//
// Pure helpers, reusing the existing READ_RE/WRITE_RE/SEQUENCE_RE family. The
// extra structural regexes below are NOT curated tool/domain lists — they are
// stopword-style filters (like STOPWORDS above) that keep the detector from
// firing on single-collection reads, internal cardinality, or chit-chat.

// Explicit count immediately governing a plural noun: "10 prospects",
// "44 law firms" (skips up to 3 modifier words, anchors on the plural noun).
const COUNT_PLURAL_RE = /\b(\d{1,3})\s+(?:[a-z][\w'-]+\s+){0,3}?([a-z][a-z'-]*s)\b/i;
// Enumerated list lines (numbered / bulleted), e.g. a pasted firm list.
const LIST_ITEM_RE = /^[ \t]*(?:\d+[.)]|[-*•–])\s+\S/gim;
// Aggregate / single-collection RETRIEVAL verbs — a paginated read of one
// collection, not N independent same-shape jobs ("show my last 5 emails").
const AGGREGATE_RETRIEVAL_RE = /\b(?:show|list|display|view|print|read out|pull up|give me|show me|tell me)\b/i;
// Genuine per-item WORK verbs (multi-step work, not mere retrieval/display).
// When one of these is present, an INCIDENTAL aggregate verb elsewhere in the
// prompt ("…then tell me which failed") must NOT suppress fan-out — the live
// 2026-06-02 batch ("research these 8 sites … tell me which") was wrongly
// suppressed by "tell me". The aggregate guard only bites when the request is
// retrieval-only (no deep work), e.g. "show my last 5 emails".
const DEEP_WORK_RE = /\b(?:research|audit|scrape|crawl|analy[sz]e|enrich|profile|investigate|draft|compose|create|build|generate|write|redesign|compile|produce|assemble|summari[sz]e|deploy|publish)\b/i;
// Internal cardinality — the N items belong to ONE parent, so there is only one
// job ("this firm's 10 competitors"): a possessive owner immediately governing
// the count. Tight by design: anchored to "<owner>'s <N>". The looser
// "N <noun> of the X" variant was REMOVED — it false-matched incidental phrases
// like "write a 2-3 sentence analysis of that firm" (live 2026-06-02), wrongly
// suppressing a legit per-firm fan-out. Its only unique target ("10 competitors
// of this firm") is itself fan-out-able, so dropping it favors reliable firing.
const INTERNAL_OWNER_RE = /\b(?:this|that|the|a|an|each|every|its|his|her|their|our|my|one|same)\s+[a-z][\w-]*['’]s\s+(?:top\s+|first\s+)?\d{1,3}\b/i;
// Distinct-items markers that override the sequence guard ("these 10 ...").
const DISTINCT_MARKER_RE = /\b(?:these|those|each|every|all (?:of )?(?:the|these|those|my|them)|the following|following|below|listed|respectively)\b/i;
// Nouns that are units/pagination/chit-chat, never independent fan-out items.
// Catches "30 days", paginated "200 rows", and "3 options" / "5 ideas".
const NON_ITEM_NOUNS = new Set([
  'days', 'weeks', 'months', 'years', 'hours', 'minutes', 'mins', 'seconds', 'secs', 'times',
  'results', 'rows', 'records', 'entries', 'items', 'fields', 'columns', 'cells', 'lines',
  'words', 'characters', 'chars', 'bytes', 'pages', 'dollars', 'cents', 'miles', 'points', 'percent',
  'options', 'ideas', 'examples', 'reasons', 'tips', 'ways', 'jokes', 'suggestions', 'names',
  'questions', 'thoughts', 'steps', 'versions', 'things', 'ones', 'others',
]);

const NO_MULTI_ITEM: MultiItemIntent = Object.freeze({
  isMultiItem: false,
  itemCount: 0,
  itemKind: null,
  sameShapeWork: false,
});

/**
 * Detect whether the user's input describes N>=3 independent, same-shape items
 * that each warrant their own per-item tool work. Pure + total: never throws,
 * always returns a result, and resolves every ambiguity to NOT multi-item so a
 * false positive can never wrongly push fan-out onto correct serial work.
 */
export function detectMultiItemIntent(input: string): MultiItemIntent {
  try {
    const text = (typeof input === 'string' ? input : '').trim();
    if (text.length < 4) return NO_MULTI_ITEM;

    // 1. Cardinality — an enumerated list, or an explicit count + plural noun.
    const listMatches = text.match(LIST_ITEM_RE);
    const enumerated = (listMatches?.length ?? 0) >= 3;
    let count = 0;
    let kind: string | null = null;
    if (enumerated) {
      count = listMatches!.length;
    } else {
      const m = COUNT_PLURAL_RE.exec(text);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        const noun = m[2].toLowerCase();
        if (Number.isFinite(n) && n >= 3 && n <= 500 && !NON_ITEM_NOUNS.has(noun)) {
          count = n;
          kind = noun;
        }
      }
    }
    if (count < 3) return NO_MULTI_ITEM;

    // 2. Per-item work verb — there must be real per-item tool work, not just
    //    a quantity ("3 options" already filtered above as a non-item noun).
    const sameShapeWork = READ_RE.test(text) || WRITE_RE.test(text);
    if (!sameShapeWork) return NO_MULTI_ITEM;

    // 3. Zero-regression guards — each resolves ambiguity to NOT multi-item.
    // Aggregate-retrieval ("show/list/tell me …") suppresses ONLY when the
    // request is retrieval-only; a genuine per-item work verb (research/
    // enrich/draft/…) means an incidental aggregate phrase shouldn't block.
    if (AGGREGATE_RETRIEVAL_RE.test(text) && !DEEP_WORK_RE.test(text)) return NO_MULTI_ITEM; // single-collection read
    if (INTERNAL_OWNER_RE.test(text)) return NO_MULTI_ITEM; // internal cardinality
    const hasDistinct = enumerated || DISTINCT_MARKER_RE.test(text);
    if (SEQUENCE_RE.test(text) && !hasDistinct) return NO_MULTI_ITEM; // A->B->C chain

    return { isMultiItem: true, itemCount: count, itemKind: kind, sameShapeWork: true };
  } catch {
    return NO_MULTI_ITEM; // fail-open: detection must never break a turn
  }
}

/**
 * Build the size-aware fan-out line for the context packet. N>=8 gets an
 * imperative "do NOT serialize" + a one-line forEach-workflow suggestion (P2);
 * 3<=N<8 gets a soft offer that leaves the model's per-item judgment intact.
 */
function fanoutDirectiveLine(intent: MultiItemIntent): string {
  const kind = intent.itemKind ? ` ${intent.itemKind}` : ' items';
  const n = intent.itemCount;
  if (n >= 8) {
    return (
      `Fan-out directive: this turn names ${n} independent same-shape${kind} to process. `
      + 'Do NOT serialize them in this context — that balloons tokens and forces the harness to clip your freshly-fetched data mid-run. '
      + 'Resolve any shared tool/connection ONCE, then call run_worker once per item in parallel waves of up to 8 so each worker keeps its own lean context. '
      + 'This is a large/recurring shape: after you finish, offer in ONE line to save it as a forEach workflow — do not create or run a workflow unless the user says yes.'
    );
  }
  return (
    `Fan-out hint: this turn names ${n} independent same-shape${kind}. `
    + 'If each item needs its own multi-step work or large payloads, fan out with run_worker (one per item, in parallel) to keep this context lean. '
    + 'If they are quick lookups, just batch the calls in parallel here. Use your judgment.'
  );
}

const STATIC_PARALLELISM_LINE =
  'Parallelism reminder: for independent batches, resolve shared tools/context once, then call run_worker with one structured packet per item in parallel or use an existing workflow forEach.';

function fanoutDirectiveEnabled(): boolean {
  return (process.env.CLEMMY_FANOUT_DIRECTIVE ?? 'on').toLowerCase() !== 'off';
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}...`;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function classifyComplexity(input: string): AgentContextPacket['complexity'] {
  const text = input.trim();
  const domains = DOMAIN_PATTERNS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
  const hasRead = READ_RE.test(text);
  const hasWrite = WRITE_RE.test(text);
  const hasBatch = BATCH_RE.test(text);
  const hasSequence = SEQUENCE_RE.test(text);
  if (domains >= 3 && (hasRead || hasWrite)) return 'complex';
  if (domains >= 2 && hasRead && hasWrite) return 'complex';
  if (domains >= 2 && hasBatch && hasSequence) return 'complex';
  if (text.length >= 300 && hasRead && hasWrite) return 'complex';
  if (domains >= 1 && (hasBatch || hasSequence || (hasRead && hasWrite))) return 'moderate';
  return 'simple';
}

function candidateScore(queryTokens: string[], fields: Array<{ text: string; weight: number }>): { score: number; matched: string[] } {
  const matched = new Set<string>();
  let score = 0;
  for (const token of queryTokens) {
    for (const field of fields) {
      const haystack = field.text.toLowerCase();
      if (!haystack.includes(token)) continue;
      matched.add(token);
      score += field.weight;
      if (haystack.split(/[^a-z0-9]+/).includes(token)) score += field.weight;
    }
  }
  return { score, matched: Array.from(matched).slice(0, 5) };
}

function rankSkills(input: string): RankedContextCandidate[] {
  const queryTokens = tokens(input);
  if (queryTokens.length === 0) return [];
  try {
    return listSkills()
      .map((skill) => {
        const description = skill.frontmatter.description || skill.bodyPreview || '';
        const { score, matched } = candidateScore(queryTokens, [
          { text: skill.name, weight: 5 },
          { text: skill.frontmatter.name, weight: 4 },
          { text: description, weight: 3 },
          { text: skill.bodyPreview, weight: 1 },
        ]);
        return {
          name: skill.name,
          description: clip(description || '(no description)', 180),
          score,
          reason: matched.length > 0 ? `matched ${matched.join(', ')}` : '',
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_CANDIDATES);
  } catch {
    return [];
  }
}

function rankWorkflows(input: string): RankedContextCandidate[] {
  const queryTokens = tokens(input);
  if (queryTokens.length === 0) return [];
  try {
    return listWorkflows()
      .map((entry) => {
        const data = entry.data;
        const description = data.whenToUse || data.description || data.description_body || '';
        const { score, matched } = candidateScore(queryTokens, [
          { text: entry.name, weight: 5 },
          { text: data.name, weight: 4 },
          { text: data.whenToUse ?? '', weight: 6 },
          { text: data.description, weight: 3 },
          { text: data.description_body ?? '', weight: 1 },
          { text: data.steps.map((step) => `${step.id} ${step.prompt}`).join('\n'), weight: 1 },
        ]);
        return {
          name: entry.name,
          description: `${data.enabled === false ? '[disabled] ' : ''}${clip(description || '(no description)', 200)}`,
          score: data.enabled === false ? Math.max(0, score - 2) : score,
          reason: matched.length > 0 ? `matched ${matched.join(', ')}` : '',
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_CANDIDATES);
  } catch {
    return [];
  }
}

function existingBaseDir(): string {
  let cursor = BASE_DIR;
  while (cursor && cursor !== path.dirname(cursor)) {
    if (existsSync(cursor)) return cursor;
    cursor = path.dirname(cursor);
  }
  return process.cwd();
}

function diskHealthWarnings(): string[] {
  try {
    const stats = statfsSync(existingBaseDir());
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < CRITICAL_DISK_WARNING_BYTES) {
      return [`Critical local disk space: ${Math.round(freeBytes / 1024 / 1024)} MB free. State writes may fail.`];
    }
    if (freeBytes < LOW_DISK_WARNING_BYTES) {
      return [`Low local disk space: ${(freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free. Long workflows may fail if tools create large files.`];
    }
  } catch {
    // Best-effort only.
  }
  return [];
}

function mcpHealth(): AgentContextPacket['mcp'] {
  try {
    return listMcpServerHealth()
      .filter((server) => server.state !== 'connected')
      .slice(0, 5)
      .map((server) => ({
        slug: server.slug,
        state: server.state,
        toolCount: server.toolCount,
        failureCount: server.failureCount,
        lastError: server.lastError ? clip(server.lastError, 160) : undefined,
      }));
  } catch {
    return [];
  }
}

function focusLine(): string | null {
  try {
    const focus = getFocusSnapshot();
    if (focus.active && !focus.needsConfirm) return `Active focus: ${focus.active.title} — ${clip(focus.active.summary, 180)}`;
    if (focus.active && focus.needsConfirm) return `Stale focus exists: ${focus.active.title}. Confirm before relying on it.`;
    if (focus.parked.length > 0) return `Parked resumable threads: ${focus.parked.slice(0, 3).map((p) => p.title).join('; ')}`;
  } catch {
    return null;
  }
  return null;
}

function renderCandidates(title: string, candidates: RankedContextCandidate[], instruction: string): string[] {
  if (candidates.length === 0) return [`${title}: none strongly matched.`];
  return [
    `${title}:`,
    ...candidates.map((candidate) =>
      `- ${candidate.name}: ${candidate.description}${candidate.reason ? ` (${candidate.reason})` : ''}`,
    ),
    instruction,
  ];
}

function summarizeToolScope(input: string): AgentContextPacket['toolScope'] {
  try {
    const scope = resolveMcpToolScope({ userInput: input });
    return {
      reason: scope.reason,
      allowAll: scope.allowAll,
      allowedServerSlugs: scope.allowedServerSlugs,
      maxTools: scope.maxTools,
    };
  } catch {
    return { reason: 'tool scope unavailable' };
  }
}

export function buildAgentContextPacket(
  input: string,
  memory: MemoryPrimerSummary,
  opts?: { sessionKind?: string; sessionId?: string },
): AgentContextPacket {
  const complexity = classifyComplexity(input);
  const skills = rankSkills(input);
  const workflows = rankWorkflows(input);
  const toolScope = summarizeToolScope(input);
  const mcp = mcpHealth();
  const healthWarnings = [
    ...diskHealthWarnings(),
    ...mcp.map((server) => `MCP ${server.slug} is ${server.state}${server.lastError ? `: ${server.lastError}` : ''}`),
  ];
  const focus = focusLine();
  const memoryLine = memory.enabled
    ? `Memory preflight: ${memory.hitCount} hit${memory.hitCount === 1 ? '' : 's'} via ${memory.source ?? 'local search'}${memory.injected ? ' and injected below' : ''}${memory.skippedReason ? ` (${memory.skippedReason})` : ''}.`
    : 'Memory preflight: disabled.';

  // Turn-start fan-out directive (P0). Fires only for CHAT sessions: workflow
  // steps can't restructure their own pipeline (forEach is an authoring-time
  // decision) and workers are already a fanned-out unit, so non-chat kinds keep
  // the static line byte-identical (zero-regression). Honors the kill-switch.
  const fanoutEnabled = fanoutDirectiveEnabled();
  const multiItem = fanoutEnabled ? detectMultiItemIntent(input) : NO_MULTI_ITEM;
  const offerFanout = fanoutEnabled && multiItem.isMultiItem && opts?.sessionKind === 'chat';
  const parallelismLine = offerFanout ? fanoutDirectiveLine(multiItem) : STATIC_PARALLELISM_LINE;

  const lines = [
    '[AGENT CONTEXT PACKET]',
    'This deterministic preflight ran before the model call. Use it to choose memory, skills, workflows, and tools instead of guessing.',
    `Complexity: ${complexity}.`,
    focus,
    memoryLine,
    `External MCP scope: ${toolScope.allowAll ? 'all external tools allowed' : `${(toolScope.allowedServerSlugs ?? []).join(', ') || 'none'}${toolScope.maxTools ? `, max ${toolScope.maxTools} tools` : ''}`} (${toolScope.reason}).`,
    ...renderCandidates('Likely skills', skills, 'If one is relevant, call skill_read before creating the deliverable.'),
    ...renderCandidates('Likely workflows', workflows, 'Use these as reusable-process candidates. Run one only if the user explicitly named or asked for that workflow; otherwise do the work directly and offer to save a workflow later.'),
    healthWarnings.length > 0 ? `Health warnings:\n${healthWarnings.map((w) => `- ${w}`).join('\n')}` : 'Health warnings: none.',
    parallelismLine,
    'Approval reminder: batch related writes/sends under one clear approval with a preview whenever possible.',
  ].filter((line): line is string => Boolean(line));

  return {
    inputPreview: clip(input, 200),
    complexity,
    memory,
    skills,
    workflows,
    toolScope,
    mcp,
    healthWarnings,
    multiItem: { detected: multiItem.isMultiItem, itemCount: multiItem.itemCount, offered: offerFanout },
    text: lines.join('\n'),
  };
}
