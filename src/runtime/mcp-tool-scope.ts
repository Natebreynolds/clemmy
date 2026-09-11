import { listToolChoices, matchToolChoicesForStep, type StepToolChoiceMatch } from '../memory/tool-choice-store.js';
import { acceptedPhraseDigest } from '../memory/capability-alias-index.js';
import { requestedCapabilityEffectScope } from '../memory/capability-effect-scope.js';
import { resolveComposioMcpScopeCandidates } from '../integrations/composio/mcp-scope-adapter.js';

/**
 * What this turn is ALLOWED to run — deliberately not the same question as what
 * it can afford to show the model.
 *
 * `catalog`    — the user's connected, authorized capabilities are the boundary.
 *   Anything inside that catalog may execute, including a tool the turn never
 *   advertised: the model naming an exact authorized tool is a reason to fetch
 *   it, not a reason to refuse. This is the default for a CONVERSATION, because
 *   the catalog is what the user actually consented to and a chat turn cannot
 *   know in advance which of their systems the work will need.
 * `server_set` — only `allowedServerSlugs` may execute, at any tool. A lane
 *   handed one system (a worker, a workflow step, a delegated fan-out) was
 *   given that system and not the user's whole account. Widening here is not
 *   recovery, it is a bound lane escaping its binding.
 * `exact`      — only `allowedToolNames` may execute. Typed leases and approval
 *   resumes bind one precise capability and must not drift to a sibling.
 * `none`       — the user said no. A decline, an explicit "don't touch my
 *   connectors": zero external authority regardless of what is connected.
 *
 * `maxTools` is NOT on this axis. A cap is a context budget; spending it says
 * nothing about permission, and it must never be the reason a call is refused.
 */
export type McpToolAuthority = 'catalog' | 'server_set' | 'exact' | 'none';

export interface McpToolScope {
  /**
   * Human-readable reason for telemetry/debug logs.
   */
  reason: string;
  /**
   * Execution authority for this turn. Absent means "infer from shape" for
   * legacy callers (see `mcpToolScopeAuthority`); every producer in this module
   * states it outright, so an empty tool surface can no longer be mistaken for
   * a prohibition.
   */
  authority?: McpToolAuthority;
  /**
   * Escape hatch for legacy/internal callers that must preserve the full
   * external MCP surface.
   */
  allowAll?: boolean;
  /**
   * Allowed namespaced server slugs, e.g. "dataforseo".
   */
  allowedServerSlugs?: string[];
  /**
   * Servers the user explicitly excluded for this turn.
   *
   * A refusal is structure, not a hint. These are resolved against the
   * CONFIGURED catalog at scope time, so the runtime never carries a provider
   * name of its own — and they are honoured before construction, so an excluded
   * system is never connected, never listed, and never called.
   */
  deniedServerSlugs?: string[];
  /**
   * Canonical exact external tool identities (`server__tool`). When present,
   * this is an authority allowlist, not a ranking hint: descriptions and
   * substring-confusable sibling names cannot satisfy it.
   */
  allowedToolNames?: string[];
  /**
   * Regex sources matched against the namespaced tool name, original tool
   * name, and description.
   */
  toolPatterns?: string[];
  /**
   * Keyword hints used to rank matched tools before maxTools is applied.
   */
  priorityKeywords?: string[];
  /**
   * Hard cap on returned MCP tools after filtering. ADVERTISEMENT ONLY — this
   * bounds what the model is shown, never what it is permitted to run.
   */
  maxTools?: number;
  /**
   * Per-server cap after filtering. Prevents one broad server such as
   * DataForSEO from consuming the entire multi-system budget.
   */
  serverMaxTools?: Record<string, number>;
  /**
   * Fail-OPEN marker: set ONLY on the unrecognized-intent fallthrough (no
   * keyword family matched and it is NOT a deliberate no-tool turn). The
   * consumer (getOrCreateExternalMcpServers) interprets this as "expose the
   * user's OWN connected external servers, bounded by maxTools" — derived
   * dynamically, with NO allowlist and NO keyword branch. This is what makes a
   * connected app outside the 6 keyword families reachable on the first try
   * instead of silently invisible (maxTools:0). The filter treats it as
   * match-all-servers but STILL applies the cap.
   */
  failOpenCandidate?: boolean;
  /**
   * Set ONLY on the deliberate local-context-follow-up no-tool return. It marks
   * that the empty surface came from a wording heuristic, not from user intent
   * or authority — so the continuity resolver may still fill it from the prior
   * turn's concrete external-family scope when this turn continues that task.
   */
  localContextFollowup?: boolean;
  /**
   * The current user input, threaded through for T1 semantic tool retrieval.
   * When set (and embeddings are healthy), the fail-open surface ranks the
   * user's connected tools by semantic relevance to this text — turning the
   * arbitrary "first N tools" cap into the N MOST RELEVANT. Ignored on keyword
   * family scopes (their cached shim can't hold a per-query embedding). Set by
   * the orchestrator at run start; not part of the scope cache key.
   */
  queryText?: string;
}

/**
 * Names of the servers the user actually has configured.
 *
 * Supplied by the caller so this module stays pure and, more importantly, so
 * the runtime never learns a provider's name: an exclusion is only ever matched
 * against systems that exist in THIS user's catalog. Add a connector tomorrow
 * and "don't use it" works with no code change.
 */
export interface ResolveMcpToolScopeOptions {
  userInput?: string | null;
  configuredServerNames?: string[];
  /**
   * Adapter-compiled, provider-neutral advertisement hints from sealed
   * standing policies. These may widen the visible catalog; they never grant
   * execution authority.
   */
  standingCapabilityHints?: McpStandingCapabilityHint[];
}

export interface McpStandingCapabilityHint {
  adapterId: string;
  intentLabels: string[];
  requiresTemporalCue: boolean;
  allowedServerSlugs: string[];
  toolPatterns: string[];
  priorityKeywords: string[];
  maxTools: number;
}

/**
 * What the user said about their own systems, compiled against their catalog.
 *
 * `deny_all`   — no external system may run.
 * `allow_only` — exactly these may run; everything else is refused.
 * `deny_set`   — everything may run except these.
 * `none`       — the turn said nothing about access.
 */
export type McpConstraintMode = 'none' | 'deny_all' | 'allow_only' | 'deny_set';

export interface McpAccessConstraint {
  mode: McpConstraintMode;
  /** Configured server slugs the user permitted by name. */
  allow: string[];
  /** Configured server slugs the user refused by name. */
  deny: string[];
}

/** Generic words for "an external system", with no system named. */
const GENERIC_CONNECTOR_RE =
  /\b(?:external\s+)?(?:apps?|applications?|connectors?|integrations?|mcp(?:\s+servers?)?|external\s+(?:tools?|services?|systems?)|third[-\s]party\s+(?:tools?|services?))\b/gi;
/** Refusals. Order matters only for readability; all are scanned by position. */
const NEGATIVE_MARKER_RE =
  /\b(?:do\s+not|do\s?n[o']t|dont|never|without|avoid|excluding|no\s+longer|not|no)\b/gi;
/** Carve-outs from a surrounding statement. */
const EXCEPTION_MARKER_RE = /\b(?:except(?:\s+for)?|other\s+than|apart\s+from|besides|but\s+not)\b/gi;
/** Restriction to what is named. */
const ONLY_MARKER_RE = /\b(?:only|exclusively|solely|just)\b/gi;

function markerPositions(text: string, pattern: RegExp): number[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((m) => m.index ?? 0);
}

/** Where the clause containing `index` begins: after the last sentence end or
 *  line break before it. A constraint governs the clause it is written in —
 *  not the rest of the document. */
function clauseStart(text: string, index: number): number {
  let start = 0;
  for (let i = Math.min(index, text.length) - 1; i >= 0; i -= 1) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '.' || ch === '!' || ch === '?' || ch === ';') { start = i + 1; break; }
  }
  return start;
}

/** The nearest marker at or before `index` WITHIN the same clause, or -1.
 *
 * Scope used to be the whole preceding document, so a refusal written early
 * bound to any mention that appeared later — live 2026-08-26: a long workflow
 * prompt whose first line said never to post an update, and whose body
 * mentioned "Integrations" thousands of characters further on, compiled to
 * DENY ALL CONNECTORS and made every tool unavailable for the rest of the
 * turn. A refusal about one thing must never silently become a refusal about
 * everything: an instruction governs its own clause. */
function nearestBefore(positions: number[], index: number, text?: string): number {
  const floor = text === undefined ? 0 : clauseStart(text, index);
  let best = -1;
  for (const position of positions) {
    if (position <= index && position >= floor && position > best) best = position;
  }
  return best;
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Every way a user might name one configured server, longest first.
 *
 * Multiword names matter: "Google Sheets" and "Google Drive" share a word, so
 * the full phrase must win and the shared word must never decide. A single
 * token only counts when it identifies exactly one server in THIS catalog.
 */
function catalogAliases(configured: string[]): Array<{ slug: string; alias: string }> {
  const aliases: Array<{ slug: string; alias: string }> = [];
  const tokenOwners = new Map<string, Set<string>>();

  for (const name of configured) {
    const slug = slugOf(name);
    if (!slug) continue;
    const spaced = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    for (const alias of new Set([spaced, slug.replace(/_/g, ' '), canonicalMcpServerAliasLocal(name)])) {
      if (alias.length >= 2) aliases.push({ slug, alias });
    }
    for (const token of spaced.split(' ').filter((t) => t.length >= 3)) {
      const owners = tokenOwners.get(token) ?? new Set<string>();
      owners.add(slug);
      tokenOwners.set(token, owners);
    }
  }
  // A bare word is an alias only when it is unambiguous across the catalog.
  for (const [token, owners] of tokenOwners) {
    if (owners.size === 1) aliases.push({ slug: [...owners][0]!, alias: token });
  }
  return aliases.sort((a, b) => b.alias.length - a.alias.length);
}

/**
 * Compile a turn's access instruction against the user's own catalog.
 *
 * Polarity is decided by POSITION, not by which regex happened to match: the
 * nearest governing marker before a mention owns it, and an exception inside a
 * refusal flips back to permission — which is why "do not use any connector
 * except Alpha" grants Alpha instead of banning it. The previous parser read
 * every clause independently and got that backwards.
 */
export function compileMcpAccessConstraint(
  input: string,
  configuredServerNames: string[] | undefined,
): McpAccessConstraint {
  const configured = (configuredServerNames ?? []).filter(Boolean);
  const text = input.toLowerCase();
  if (!text.trim()) return { mode: 'none', allow: [], deny: [] };

  const negatives = markerPositions(text, NEGATIVE_MARKER_RE);
  const exceptions = markerPositions(text, EXCEPTION_MARKER_RE);
  const onlys = markerPositions(text, ONLY_MARKER_RE);

  const allow = new Set<string>();
  const deny = new Set<string>();
  let restrictedToNamed = false;

  // Which servers are mentioned, and where. Longest alias wins so a multiword
  // name is never shadowed by one of its words.
  const claimed: Array<{ start: number; end: number }> = [];
  for (const { slug, alias } of catalogAliases(configured)) {
    const pattern = new RegExp(`(?<![a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[^a-z0-9]+')}(?![a-z0-9])`, 'g');
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (claimed.some((span) => start < span.end && end > span.start)) continue;
      claimed.push({ start, end });

      const negative = nearestBefore(negatives, start, text);
      const exception = nearestBefore(exceptions, start, text);
      // An exception that sits inside a refusal grants; one that sits inside a
      // permission refuses ("use anything except Beta").
      if (exception >= 0 && exception > negative) {
        if (negative >= 0) {
          allow.add(slug);
          restrictedToNamed = true;
        } else {
          deny.add(slug);
        }
        continue;
      }
      if (negative >= 0 && negative > exception) {
        deny.add(slug);
        continue;
      }
      allow.add(slug);
      if (nearestBefore(onlys, start, text) >= 0) restrictedToNamed = true;
    }
  }

  // A blanket refusal of "connectors" with nothing carved out denies everything.
  const genericMentions = markerPositions(text, GENERIC_CONNECTOR_RE);
  const blanketRefusal = genericMentions.some((position) => {
    const negative = nearestBefore(negatives, position, text);
    const exception = nearestBefore(exceptions, position, text);
    return negative >= 0 && negative > exception;
  });

  if (restrictedToNamed && allow.size > 0) {
    return { mode: 'allow_only', allow: [...allow].sort(), deny: [...deny].sort() };
  }
  if (blanketRefusal) {
    if (allow.size > 0) {
      return { mode: 'allow_only', allow: [...allow].sort(), deny: [...deny].sort() };
    }
    // The user carved something out, but no catalog was supplied to resolve it
    // against. Compiling this as "deny everything" would refuse the one system
    // they just permitted, so decline to compile and let the caller's ordinary
    // routing decide — a constraint we cannot read is not a constraint we get
    // to invent.
    if (exceptions.length > 0) return { mode: 'none', allow: [], deny: [] };
    return { mode: 'deny_all', allow: [], deny: [] };
  }
  if (deny.size > 0) return { mode: 'deny_set', allow: [...allow].sort(), deny: [...deny].sort() };
  return { mode: 'none', allow: [...allow].sort(), deny: [] };
}

/** Back-compatible view: which configured servers this turn refuses outright. */
export function deniedServerSlugsFromInput(
  input: string,
  configuredServerNames: string[] | undefined,
): string[] {
  return compileMcpAccessConstraint(input, configuredServerNames).deny;
}

/** Local copy of the dispatcher's canonical alias rule, kept here so this
 *  module stays dependency-free and pure. */
function canonicalMcpServerAliasLocal(value: string): string {
  let canonical = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (;;) {
    const next = canonical.replace(/(?:mcpserver|servermcp|mcp|server)$/, '');
    if (next === canonical) return canonical;
    canonical = next;
  }
}

const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
const SEO_RE =
  /\b(seo|audit|ranking|rankings|serp|keyword|keywords|backlink|backlinks|domain authority|organic traffic|search visibility|site health|technical audit|crawl|meta title|meta description|schema markup)\b/i;
const WEB_RE =
  /\b(scrape|crawl|website|web page|webpage|article|news|browser|search the web|look up|research online|recent article)\b/i;
const DATEISH_RE =
  /\b(today|tomorrow|tonight|this (?:morning|afternoon|evening|week)|next (?:week|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
// Match only adapter-compiled hint data. The shared scope kernel never maps a
// remembered label to a provider name or tool family itself.
function matchingStandingCapabilityHints(
  input: string,
  hints: McpStandingCapabilityHint[] | undefined,
): McpStandingCapabilityHint[] {
  try {
    return (hints ?? []).filter((hint) => {
      if (hint.requiresTemporalCue && !DATEISH_RE.test(input)) return false;
      return hint.intentLabels.some((label) =>
        new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(input));
    });
  } catch {
    return [];
  }
}
// Bare-noun forms ("the sheet", "spreadsheets", "gauntlet sheet") are family
// intent too: an unmatched family phrasing must never scope OUT a connected
// toolkit (2026-08-26 gauntlet: "add a row to the … sheet" fell to fail-open
// and the write capability was never advertised). Scoping is ADVERTISEMENT
// only — a false positive costs a few ranked tools, a false negative starved
// the whole act lane.
const GOOGLE_SHEETS_RE = /\b(google sheets?|googlesheets?|spreadsheets?|sheets?|sheet (?:row|tab)|worksheet)\b/i;
const GITHUB_RE =
  /\b(github|pull request|pr\b|gh issue|github issue|issue #\d+)\b/i;
const LOCAL_DEPLOY_CLI_RE =
  /\b(netlify|vercel|railway|fly\.io|wrangler|cloudflare pages|firebase|render\.com|heroku)\b/i;
// Bare "append" deliberately absent: it is an external-write verb as much as
// a local one, and classifying "append after the last row" as a local-context
// turn zeroed the external surface of a live sheet-write continuation
// (2026-08-26 gauntlet seq 82133). "append" counts as local only when the same
// clause names a local artifact (report/markdown/file path/memory/context).
const LOCAL_CONTEXT_FOLLOWUP_RE =
  /\b(existing context|use the existing context|from context|remember|remembered|we just ran|previous|already found|append[^.!?\n]{0,120}\b(?:local(?:ly)?|report|markdown|\.md\b|memory|context)|local file update|local markdown|markdown report|the report|the audit we just ran)\b/i;
const FRESH_EXTERNAL_RE =
  /\b(fresh|new audit|rerun|re-run|run .*audit|use dataforseo|crawl|lighthouse|current rankings?|latest rankings?|check the site|fetch|scrape|search the web|look up online|new data)\b/i;
// A local-context follow-up that nonetheless asks for FRESH data from an
// external system ("update the report with the latest Airtable records", "the
// report needs the newest backlinks", "pull the current deals") still needs
// external tools. Without this, those phrases fall through to maxTools:0 (the
// app sits outside the 6 named keyword families) and read as "not connected".
// Monotonic: matching here only ever turns a no-tools turn into the bounded
// fail-open surface — it can never strip tools from a turn that had them.
const FRESH_EXTERNAL_DATA_RE =
  /\b(?:latest|newest|current|up[-\s]?to[-\s]?date|updated|recent|most recent)\s+(?:\w+\s+){0,3}(?:record|records|data|results?|rows?|entries|metric|metrics|lead|leads|backlinks?|listings?|deal|deals|contact|contacts|ranking|rankings|numbers|figures|stats|statistics)\b|\b(?:pull|grab|import|sync|retrieve|refresh|re-?pull|re-?fetch)\s+(?:the\s+|in\s+|down\s+)?(?:\w+\s+){0,3}(?:record|records|data|results?|rows?|entries|leads?|deals?|contacts?|backlinks?|rankings?|from\b)|\bairtable\b/i;
const NEGATED_FRESH_EXTERNAL_RE =
  /\b(?:do\s+not|don't|dont|without|no)\s+(?:run|running|rerun|re-running|re-run|perform|performing|do|doing|use|using|call|calling|invoke|invoking|start|starting|trigger|triggering)?\s*(?:any\s+)?(?:a\s+)?(?:fresh|new)?\s*(?:web\s+)?(?:seo\s+)?(?:audit|dataforseo|lookup|lookups|look\s+up|crawl|crawling|scrape|scraping|search|searching|external|external\s+mcp|web\s+search|site\s+check)\b/i;
const NEGATED_EXTERNAL_WINDOW_RE =
  /\b(?:do\s+not|don't|dont|without|no)\s+[^.!?\n]{0,160}\b(?:fresh|new|dataforseo|external\s+mcp|web\s+search|crawl|crawling|scrape|scraping|search|searching|lookup|lookups|look\s+up|audit)\b/i;
// A user who explicitly constrains a turn to local memory/context has already
// made the tool-scope decision. Detect this before keyword families: negative
// Negative data phrases must never open an unrelated external family. Explicit
// catalog exceptions were already compiled above by compileMcpAccessConstraint.
const EXPLICIT_LOCAL_ONLY_RE =
  /\b(?:(?:use|using|consult|read|search|check)\s+only\s+(?:clementine(?:'s)?\s+)?local\s+(?:memory|context|files?)|(?:clementine(?:'s)?\s+)?local\s+(?:memory|context|files?)\s+only)\b/i;
const EXPLICIT_NO_EXTERNAL_TOOLS_RE =
  /\b(?:(?:do\s+not|don't|dont|never)\s+(?:call|use|invoke|open|query|contact)\s+(?:any\s+)?external\s+(?:connector|connectors|tool|tools|mcp|service|services)|no\s+external\s+(?:connector|connectors|tool|tools|mcp|service|services))\b/i;
const EXPLICIT_EXTERNAL_EXCEPTION_RE =
  /\b(?:except(?:\s+for)?|other\s+than|apart\s+from)\s+([a-z][a-z0-9_.-]*)\b/i;
const EXTERNAL_EXCEPTION_FILLER_RE =
  /^(?:be|being|to|for|if|when|while|as|the|a|an|this|that|it|we|i|you|thorough|careful|sure)$/i;

function hasExplicitExternalException(input: string): boolean {
  const match = EXPLICIT_EXTERNAL_EXCEPTION_RE.exec(input);
  if (!match) return false;
  const token = match[1] ?? '';
  if (/^an?$/i.test(token) && /\bexternal\b/i.test(input.slice(match.index))) return true;
  if (EXTERNAL_EXCEPTION_FILLER_RE.test(token)) return false;
  return token.length >= 3;
}

// A turn that CONTINUES the active thread rather than opening a new topic — a
// bare confirmation / go-ahead / anaphoric follow-up ("let's get them ready",
// "go ahead", "do it", "make that happen", "yes that's perfect", "show me").
// These carry no tool keyword, so the keyword scoper would strip every external
// tool mid-task — the "chatbot" failure. When one matches AND no fresh intent is
// detected, we inherit the most recent concrete scope from a prior turn instead.
const TOOL_SCOPE_CONTINUATION_RE =
  /\b(?:go ahead|go for it|let'?s (?:go|do|get|build|run|send|make|try|kick|finish|wrap)|do it|go off|now go|ok(?:ay)? (?:go|do|proceed)|get (?:them|it|those|these|that|started)|make (?:it|that|this|them|those)?[^.!?]{0,30}happen|make (?:it|them|those)\b|run (?:it|them|those|that)|send (?:it|them|those|that)|build (?:it|them|those|that)|create (?:it|them|those|that)|generate (?:it|them|those|that)|prep (?:it|them|those)|finish (?:it|them|those|up)|wrap (?:it|them|those) up|proceed|continue|carry on|keep going|next step|yes(?:\s+please)?|yep|yeah|sure|sounds good|looks good|that'?s perfect|perfect|show me|kick it off)\b/i;

const DATAFORSEO_SEO_PATTERNS = [
  'serp',
  'organic',
  'ranked[_-]?keywords?',
  'keywords?[_-]?for[_-]?site',
  'keywords?[_-]?for[_-]?keywords?',
  'domain[_-]?rank',
  'domain[_-]?intersection',
  'page[_-]?intersection',
  'competitors?',
  'backlinks?',
  'referring[_-]?domains?',
  'on[_-]?page',
  'pages?',
  'technologies',
  'traffic',
  'summary',
];

const DATAFORSEO_SEO_PRIORITIES = [
  'on_page',
  'on-page',
  'lighthouse',
  'technologies',
  'domain_rank',
  'domain rank',
  'ranked_keywords',
  'ranked keywords',
  'keywords_for_site',
  'keywords for site',
  'backlinks_summary',
  'backlinks summary',
  'referring_domains',
  'referring domains',
  'competitors',
  'serp_organic',
  'organic live',
  'traffic',
];

function scopingDisabled(): boolean {
  const raw = process.env.CLEMMY_SCOPED_MCP_TOOLS;
  return typeof raw === 'string' && /^(0|false|off|no)$/i.test(raw.trim());
}

// Bounded global cap for the unrecognized-intent fail-open surface. Small enough
// to stay token-cheap on keyword-less turns, large enough to surface a connected
// server's core tools. Tunable via CLEMMY_MCP_SCOPE_FAILOPEN_MAX.
const DEFAULT_FAILOPEN_MAX_TOOLS = 12;

// Kill-switch (default ON). CLEMMY_MCP_SCOPE_FAILOPEN=off restores the prior
// behavior (an unrecognized-intent turn exposes NO external tools).
function failOpenScopeEnabled(): boolean {
  return (process.env.CLEMMY_MCP_SCOPE_FAILOPEN ?? 'on').toLowerCase() !== 'off';
}

function failOpenMaxTools(): number {
  const raw = Number.parseInt(process.env.CLEMMY_MCP_SCOPE_FAILOPEN_MAX ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FAILOPEN_MAX_TOOLS;
}

/**
 * Turn a compiled constraint into the turn's scope, when the user actually
 * expressed one. Returns null when they said nothing about access, leaving the
 * ordinary relevance routing below to decide what to show.
 */
function constraintScope(
  constraint: McpAccessConstraint,
  input: string,
): McpToolScope | null {
  const excerpt = input.toLowerCase().slice(0, 120);
  if (constraint.mode === 'deny_all') {
    return {
      reason: `user refused external connectors: ${excerpt}`,
      authority: 'none',
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    };
  }
  if (constraint.mode === 'allow_only') {
    return {
      reason: `user restricted this turn to ${constraint.allow.join(', ')}: ${excerpt}`,
      authority: 'server_set',
      allowedServerSlugs: constraint.allow,
      ...(constraint.deny.length > 0 ? { deniedServerSlugs: constraint.deny } : {}),
      maxTools: Math.max(8, constraint.allow.length * 8),
    };
  }
  if (constraint.mode === 'deny_set') {
    // Everything else stays reachable; the named systems do not.
    return {
      reason: `user excluded ${constraint.deny.join(', ')}: ${excerpt}`,
      authority: 'catalog',
      deniedServerSlugs: constraint.deny,
      failOpenCandidate: true,
      toolPatterns: [],
      maxTools: failOpenMaxTools(),
    };
  }
  return null;
}

function provenLocalCliIdentifiers(input: string): string[] {
  const ids = new Set<string>();
  try {
    for (const match of matchToolChoicesForStep(input)) {
      if (match.kind === 'cli' && match.identifier && (match.autoBindable || match.alreadyBound || match.tier === 'high')) {
        ids.add(match.identifier);
      }
    }
  } catch { /* bind-tier unreadability is not MCP authority */ }
  try {
    const digest = acceptedPhraseDigest(input);
    if (digest) {
      for (const rec of listToolChoices()) {
        if (rec.choice?.kind !== 'cli' || !rec.choice.identifier) continue;
        for (const alias of rec.aliases ?? []) {
          if (alias.status && alias.status !== 'active') continue;
          if (acceptedPhraseDigest(alias.intent) === digest) ids.add(rec.choice.identifier);
        }
      }
    }
  } catch { /* exact-alias unreadability is not MCP authority */ }
  return [...ids];
}

/**
 * Resolve the external MCP tool surface for a fresh user turn.
 *
 * Important: callers without a concrete user prompt intentionally get
 * allowAll. Approval resumes and legacy internals may need the exact tool
 * that was pending before the scoped-tool experiment existed.
 */
export function resolveMcpToolScope(options: ResolveMcpToolScopeOptions = {}): McpToolScope {
  const rawInput = options.userInput?.trim();

  // Consent is compiled BEFORE any kill-switch. `CLEMMY_SCOPED_MCP_TOOLS=off`
  // disables scoped advertisement and ranking — a token-budget experiment. It
  // was never meant to mean "ignore the user when they say don't touch my
  // connectors", and letting a display flag revoke a refusal is not a tuning
  // decision, it is a consent bug.
  const constraint = rawInput
    ? compileMcpAccessConstraint(rawInput, options.configuredServerNames)
    : { mode: 'none' as const, allow: [], deny: [] };
  const constrained = constraintScope(constraint, rawInput ?? '');
  if (constrained) return constrained;

  if (scopingDisabled()) {
    return { reason: 'scoped MCP disabled by CLEMMY_SCOPED_MCP_TOOLS', allowAll: true };
  }

  const input = rawInput;
  if (!input) {
    return { reason: 'no prompt available; preserving legacy external MCP surface', allowAll: true };
  }

  const lower = input.toLowerCase();
  const requestedEffectScope = requestedCapabilityEffectScope(input);
  // Resolved once and attached to every branch below: a refusal must survive
  // whichever route the turn takes through this resolver.
  const deniedRaw = deniedServerSlugsFromInput(input, options.configuredServerNames);
  const denied = deniedRaw.length > 0 ? { deniedServerSlugs: deniedRaw } : {};
  if ((EXPLICIT_LOCAL_ONLY_RE.test(input) || EXPLICIT_NO_EXTERNAL_TOOLS_RE.test(input))
    && !hasExplicitExternalException(input)) {
    // The user prohibited external connectors. This is the real thing an empty
    // surface used to be confused with: a decision, not a budget.
    return {
      reason: `explicit local-only/no-external-tools instruction: ${lower.slice(0, 120)}`,
      authority: 'none',
      ...denied,
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    };
  }
  const scopes: McpToolScope[] = [];

  const isLocalContextFollowup = LOCAL_CONTEXT_FOLLOWUP_RE.test(input);
  const hasFreshExternalIntent = FRESH_EXTERNAL_RE.test(input) || FRESH_EXTERNAL_DATA_RE.test(input);
  const hasNegatedFreshExternalIntent = NEGATED_FRESH_EXTERNAL_RE.test(input) || NEGATED_EXTERNAL_WINDOW_RE.test(input);
  const wantsSeo = SEO_RE.test(input) || (URL_RE.test(input) && /\baudit\b/i.test(input));
  const wantsWeb = WEB_RE.test(input);
  const adapterScopeCandidates = resolveComposioMcpScopeCandidates(input);
  const wantsGoogleSheets = GOOGLE_SHEETS_RE.test(input);
  const wantsGithub = GITHUB_RE.test(input);
  const standingHints = matchingStandingCapabilityHints(input, options.standingCapabilityHints);
  const hasNamedExternalSystemIntent = adapterScopeCandidates.length > 0 || wantsGoogleSheets || wantsGithub
    || standingHints.length > 0;

  if (
    isLocalContextFollowup
    && !hasNamedExternalSystemIntent
    && (hasNegatedFreshExternalIntent || !hasFreshExternalIntent)
  ) {
    // Nothing here needs a connector, so advertise none — but the user never
    // withdrew access. If the work turns out to need an authorized tool, the
    // model may still name it and get it.
    return {
      reason: `local context/file follow-up; no fresh external MCP needed: ${lower.slice(0, 120)}`,
      authority: 'catalog',
      ...denied,
      localContextFollowup: true,
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
    };
  }

  if (wantsSeo) {
    scopes.push({
      reason: 'seo/web-audit intent',
      allowedServerSlugs: ['dataforseo'],
      toolPatterns: DATAFORSEO_SEO_PATTERNS,
      priorityKeywords: DATAFORSEO_SEO_PRIORITIES,
      maxTools: 8,
      serverMaxTools: { dataforseo: 8 },
    });
  }

  if (wantsWeb && !wantsSeo) {
    // Browser-ish MCP servers are intentionally broad here because users
    // name these differently in their configs. The cap keeps payload bounded.
    scopes.push({
      reason: 'web/browser intent',
      allowedServerSlugs: ['browser', 'browsermcp', 'playwright', 'firecrawl'],
      toolPatterns: ['search', 'scrape', 'crawl', 'fetch', 'browser', 'page', 'navigate', 'click'],
      priorityKeywords: ['search', 'scrape', 'crawl', 'fetch', 'navigate'],
      maxTools: 8,
      serverMaxTools: { browser: 8, browsermcp: 8, playwright: 8, firecrawl: 8 },
    });
  }

  scopes.push(...adapterScopeCandidates);

  for (const hint of standingHints) {
    scopes.push({
      reason: `sealed standing-policy capability hint (${hint.adapterId})`,
      allowedServerSlugs: hint.allowedServerSlugs,
      toolPatterns: hint.toolPatterns,
      priorityKeywords: hint.priorityKeywords,
      maxTools: hint.maxTools,
      serverMaxTools: Object.fromEntries(
        hint.allowedServerSlugs.map((server) => [server, hint.maxTools]),
      ),
    });
  }

  if (wantsGoogleSheets) {
    scopes.push({
      reason: 'google-sheets intent',
      allowedServerSlugs: ['googlesheets', 'google_sheets', 'google'],
      toolPatterns: ['sheet', 'spreadsheet', 'row', 'range', 'values'],
      priorityKeywords: ['values', 'append', 'update', 'create', 'get'],
      maxTools: 8,
      serverMaxTools: { googlesheets: 8, google_sheets: 8, google: 8 },
    });
    // A collect→construct ask ("find the top 5 … add them to a Google sheet")
    // needs the COLLECTION provider too: sheets-only scoping dropped the
    // search provider and the model had nothing to collect with (live
    // 2026-08-19 seq 59105). The destination never narrows away the source.
    if (!wantsWeb && !wantsSeo && /\b(find|top\s+\d+|best|search|look\s*up|latest|research)\b/i.test(input)) {
      scopes.push({
        reason: 'collect-into-sheets: keep the search provider',
        allowedServerSlugs: ['browser', 'browsermcp', 'playwright', 'firecrawl'],
        toolPatterns: ['search', 'scrape', 'crawl', 'fetch'],
        priorityKeywords: ['search', 'scrape', 'crawl', 'fetch'],
        maxTools: 8,
        serverMaxTools: { browser: 8, browsermcp: 8, playwright: 8, firecrawl: 8 },
      });
    }
  }

  if (wantsGithub) {
    scopes.push({
      reason: 'github intent',
      allowedServerSlugs: ['github'],
      toolPatterns: ['repo', 'repository', 'pull', 'pr', 'issue', 'branch', 'commit', 'file'],
      priorityKeywords: ['search', 'get', 'list', 'create', 'update'],
      maxTools: 8,
      serverMaxTools: { github: 8 },
    });
  }

  if (scopes.length === 0) {
    // These providers are driven by Clementine's local CLI + shell surface,
    // not an external MCP server. A deploy prompt often contains generic words
    // such as "account", "site", "commit", and "branch"; failing open here
    // used to preload unrelated Salesforce/GitHub tools before a Netlify call.
    // Mixed requests have already populated `scopes` above (for example,
    // "deploy to Netlify, then email Bob"), so their real connector remains.
    if (LOCAL_DEPLOY_CLI_RE.test(input)) {
      return {
        reason: `local deploy CLI intent; no external MCP needed: ${lower.slice(0, 120)}`,
        authority: 'catalog',
        ...denied,
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      };
    }
    // A proven local CLI for THIS ask is the capability. Only a bind-tier
    // match (the user named the program/service) or an exact learned phrase
    // may suppress fail-open. Token-overlap advertise hits must not hide
    // every connector on an unrelated turn.
    // One remembered CLI operation is evidence for one operation, not proof
    // that a write-shaped task's complete capability set is local. In
    // particular, mixed compatibility deliberately retrieves both read and
    // write memories; letting the first CLI read take this return would hide an
    // unresolved external write before the model could discover it.
    if (requestedEffectScope !== 'write' && requestedEffectScope !== 'mixed') {
      try {
        const localCli = provenLocalCliIdentifiers(input);
        if (localCli.length > 0) {
          return {
            reason: `proven local CLI capability (${[...new Set(localCli)].join(', ')}); no external MCP needed: ${lower.slice(0, 120)}`,
            authority: 'catalog',
            ...denied,
            allowedServerSlugs: [],
            toolPatterns: [],
            maxTools: 0,
          };
        }
      } catch { /* store unreadability must not invent MCP authority */ }
    }
    // No keyword family matched. The old behavior returned maxTools:0 — which
    // made ANY connected app outside the 6 hardcoded families (Airtable, Slack,
    // Notion, Stripe, …) silently invisible, so Clem falsely reported "not
    // connected" on the first relevant turn. FAIL OPEN per class instead:
    // expose the user's OWN connected servers, bounded. No allowlist, no new
    // keyword branch — the consumer enumerates the configured servers
    // dynamically. (The DELIBERATE local-context no-tool turn above keeps
    // maxTools:0, so token discipline is preserved where it was intended.)
    if (!failOpenScopeEnabled()) {
      return {
        reason: `no external MCP intent detected; fail-open disabled: ${lower.slice(0, 120)}`,
        authority: 'catalog',
        ...denied,
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      };
    }
    return {
      reason: `no keyword-family intent matched — failing OPEN to the user's own connected servers (bounded): ${lower.slice(0, 120)}`,
      authority: 'catalog',
      ...denied,
      failOpenCandidate: true,
      toolPatterns: [],
      maxTools: failOpenMaxTools(),
    };
  }

  // A SERVER THE OWNER NAMED IS NEVER HIDDEN BY A RELEVANCE GUESS.
  //
  // `constraint.allow` already holds every configured server the request named
  // affirmatively — matched against THIS install's connected server names, not
  // any list in the harness. It was honoured only in `allow_only` mode ("use
  // only X"); in the ordinary case, where someone simply names the systems they
  // want, it was computed and dropped. A keyword family then narrowed the
  // surface to whatever it recognised.
  //
  // Live 2026-09-11: a Plan turn was asked to use "all of our research tools:
  // Apify and Data for SEO". One family matched, the scope resolved to that
  // family's single server, and the other system the owner had named by name
  // was invisible before the first model step. The turn could not have found it
  // however well it searched.
  //
  // The comment below this has always said keyword families "choose what to
  // SHOW first … never a narrowing of consent". This makes that true: families
  // still rank and still cap payload; naming a connected system keeps it
  // reachable. A denial still wins — refusals ride separately in `denied`.
  const namedServerSlugs = constraint.allow.filter(
    (slug) => !(denied.deniedServerSlugs ?? []).includes(slug),
  );
  const allowedServerSlugs = Array.from(new Set([
    ...scopes.flatMap((scope) => scope.allowedServerSlugs ?? []),
    ...namedServerSlugs,
  ]));
  const toolPatterns = Array.from(new Set(scopes.flatMap((scope) => scope.toolPatterns ?? [])));
  const priorityKeywords = Array.from(new Set(scopes.flatMap((scope) => scope.priorityKeywords ?? [])));
  const maxTools = scopes.reduce((sum, scope) => sum + (scope.maxTools ?? 0), 0);
  const serverMaxTools: Record<string, number> = {};
  for (const scope of scopes) {
    for (const [slug, cap] of Object.entries(scope.serverMaxTools ?? {})) {
      const normalizedCap = Math.max(1, Math.floor(cap));
      serverMaxTools[slug] = Math.max(serverMaxTools[slug] ?? 0, normalizedCap);
    }
  }

  return {
    reason: [
      ...scopes.map((scope) => scope.reason),
      ...(namedServerSlugs.length > 0
        ? [`plus servers the request named: ${namedServerSlugs.join(', ')}`]
        : []),
    ].join(' + '),
    // Keyword families choose what to SHOW first. They are a relevance guess
    // about the user's own connected systems, never a narrowing of consent.
    authority: 'catalog',
    ...denied,
    allowedServerSlugs,
    toolPatterns,
    priorityKeywords,
    maxTools: maxTools > 0 ? maxTools : undefined,
    serverMaxTools: Object.keys(serverMaxTools).length > 0 ? serverMaxTools : undefined,
  };
}

/**
 * The turn's execution authority. Explicit when the producer stated it;
 * otherwise inferred from shape so callers that predate the field keep their
 * exact behavior — an exact allowlist stays exact, `allowAll` stays open, and
 * everything else falls to the catalog boundary rather than to a cap.
 */
export function mcpToolScopeAuthority(scope: McpToolScope): McpToolAuthority {
  if (scope.authority) return scope.authority;
  if (scope.allowAll) return 'catalog';
  if (scope.allowedToolNames !== undefined) return 'exact';
  return 'catalog';
}

/** Tightest first. Composition may only ever move DOWN this list. */
const AUTHORITY_STRICTNESS: Record<McpToolAuthority, number> = {
  none: 0,
  exact: 1,
  server_set: 2,
  catalog: 3,
};

/**
 * The stricter of two authorities. Composition is a narrowing operation — a
 * parent and a child each get to say no, and neither gets to say yes on the
 * other's behalf. Leaving this to inference is how a bounded lane ended up
 * holding the whole catalog.
 */
export function strictestMcpToolAuthority(
  ...authorities: Array<McpToolAuthority | undefined>
): McpToolAuthority {
  let strictest: McpToolAuthority = 'catalog';
  for (const authority of authorities) {
    if (!authority) continue;
    if (AUTHORITY_STRICTNESS[authority] < AUTHORITY_STRICTNESS[strictest]) strictest = authority;
  }
  return strictest;
}

/** Union of two exclusion lists — a denial from either side stands. */
export function mergeDeniedServerSlugs(
  ...lists: Array<string[] | undefined>
): string[] | undefined {
  const merged = [...new Set(lists.flatMap((list) => list ?? []))].sort();
  return merged.length > 0 ? merged : undefined;
}

/** A scope that actually exposes tools FROM A RECOGNIZED INTENT: the legacy
 *  allowAll surface, or a concrete keyword scope with a non-zero cap. A
 *  fail-open scope is deliberately NOT concrete — it's the last-resort fallback,
 *  so continuity must still get a chance to inherit a PRECISE prior-turn scope
 *  before we settle for the broad bounded fail-open surface. (maxTools:0 =
 *  nothing exposed.) */
function scopeIsConcrete(scope: McpToolScope): boolean {
  if (scope.failOpenCandidate) return false;
  return Boolean(scope.allowAll) || (scope.maxTools ?? 0) > 0;
}

/**
 * True when the input CONTINUES the active conversation (a bare confirmation /
 * go-ahead / anaphoric follow-up) rather than opening a fresh topic. Pure.
 */
export function isToolScopeContinuation(input?: string | null): boolean {
  const text = (input ?? '').trim();
  if (!text) return false;
  return TOOL_SCOPE_CONTINUATION_RE.test(text);
}

/**
 * Continuity-aware scope resolution. Resolves the current turn normally; if that
 * turn has NO fresh external intent (maxTools:0) but the user is CONTINUING the
 * thread, inherit the most recent CONCRETE scope from a prior turn's input so the
 * tools needed to finish the just-agreed task aren't yanked away mid-conversation
 * (the verified "chatbot feel": every keyword-less turn — "let's get them ready",
 * "yes that's perfect" — silently dropped the Outlook tools). `priorUserInputs`
 * are prior turn texts, NEWEST FIRST (this session + continuation lineage). Pure;
 * the caller supplies the history. Fail-safe: no continuation match or no prior
 * concrete scope → returns the direct (today's) result unchanged.
 *
 * `awaitingAnswer` is the STRUCTURAL half of the same question, and it is the
 * one that matters. Recognizing a go-ahead by its wording means maintaining a
 * list of ways to say yes, and that list will always be incomplete. Verified
 * against the live event log (2026-07-31): "lets kick it off" and "yes please"
 * were recognized, a bare "go" was not — and the "go" turn was a real one, whose
 * request had named Salesforce, Outlook and Google Sheets. Its scope collapsed
 * from 24 tools across seven servers to the bounded no-server fail-open surface,
 * on the exact turn that had to do the work.
 *
 * The system already knew. That same turn was prompted "CONVERGE — your previous
 * turn asked the user a clarifying question": the harness held the fact and the
 * scope resolver never asked for it. A message is an answer when the previous
 * turn asked something, whatever words the answer happens to use. The vocabulary
 * stays as a fallback for callers that cannot supply the structure.
 */
export function resolveMcpToolScopeWithContinuity(
  options: {
    userInput?: string | null;
    priorUserInputs?: Array<string | null | undefined>;
    standingCapabilityHints?: McpStandingCapabilityHint[];
    configuredServerNames?: string[];
    /** The previous turn ended by asking this user a question. */
    awaitingAnswer?: boolean;
    /** Exact runtime-derived meaning of the answer. A decline is an explicit
     * zero-authority boundary and may never inherit the parent tool scope. */
    answerDisposition?: 'affirmed' | 'declined' | 'selected' | 'provided';
  } = {},
): McpToolScope {
  if (options.answerDisposition === 'declined') {
    return {
      reason: 'continuity: user declined the prior task; external MCP authority denied for this turn',
      authority: 'none',
      allowedServerSlugs: [],
      allowedToolNames: [],
      toolPatterns: [],
      maxTools: 0,
    };
  }
  const direct = resolveMcpToolScope({
    userInput: options.userInput,
    standingCapabilityHints: options.standingCapabilityHints,
    configuredServerNames: options.configuredServerNames,
  });
  // A turn that withdrew external access resolves to an empty surface, and an
  // empty surface is exactly what continuity is built to fill in. Those two
  // facts together turned "don't use my connectors" into "reuse the last
  // connector". Authority is checked before the gap is noticed.
  if (mcpToolScopeAuthority(direct) === 'none') return direct;
  if (scopeIsConcrete(direct)) return direct;
  // A local-context follow-up is by definition a continuation of the active
  // task. When that task's prior turns carried a concrete external-family
  // scope, the wording heuristic must not strip it mid-task (2026-08-26
  // gauntlet: the sheet-append follow-up resolved to maxTools:0 and the write
  // toolkit vanished). Genuinely local threads have no prior concrete family
  // scope, so their no-tool discipline is preserved by the loop below.
  if (
    !options.awaitingAnswer
    && !isToolScopeContinuation(options.userInput)
    && !direct.localContextFollowup
  ) return direct;
  for (const prior of options.priorUserInputs ?? []) {
    const inherited = resolveMcpToolScope({
      userInput: prior,
      standingCapabilityHints: options.standingCapabilityHints,
      configuredServerNames: options.configuredServerNames,
    });
    // Only inherit a CONCRETE keyword scope (maxTools>0) — never a prior allowAll
    // (a no-prompt/internal turn) which would silently open the whole surface,
    // and never a prior FAIL-OPEN scope (that's a fallback, not a precise
    // intent to inherit — the direct fail-open below already covers it).
    if (!inherited.failOpenCandidate && (inherited.maxTools ?? 0) > 0) {
      return {
        ...inherited,
        reason: `continuity: inherited prior-turn scope for ${options.awaitingAnswer ? 'answer-to-question' : 'follow-up'} ("${(options.userInput ?? '').trim().slice(0, 40)}") → ${inherited.reason}`,
      };
    }
  }
  return direct;
}

// Kill-switch (default ON). CLEMMY_SCOPE_FROM_RECALL=off disables both the
// recall-aware widening here AND the remember-native-MCP-on-success half
// (auto-remember.ts) — they are one feature and must move together.
function recallScopeEnabled(): boolean {
  return (process.env.CLEMMY_SCOPE_FROM_RECALL ?? 'on').toLowerCase() !== 'off';
}

/** Server slugs from HIGH-tier remembered MCP choices whose identity the current
 *  prompt strongly names — derived from each mcp tool name's `<slug>__<tool>`
 *  prefix. This is the user's OWN proven evidence, so it can only WIDEN reach. */
function learnedMcpServerSlugs(matches: StepToolChoiceMatch[]): string[] {
  const slugs: string[] = [];
  for (const m of matches) {
    // Any advertise-tier match may PROPOSE its server: a conversational ask
    // names the service without the operation token 'high' demands, and the
    // caller's own guards decide admission (fail-open turns take proposals;
    // an already-precise scope still requires the input to name the server).
    if (m.kind !== 'mcp') continue;
    const slug = (m.identifier.split('__')[0] ?? '').trim().toLowerCase();
    if (slug) slugs.push(slug);
  }
  return Array.from(new Set(slugs));
}

/**
 * Only positive action text may authorize recall to add a second MCP server to
 * an already-precise keyword scope. Structured payload can contain arbitrary
 * provider-like words ("Clem Smoke Beta"), and prohibitions often name tools
 * specifically so they will not be used. Neither is connector intent.
 */
function recallWideningSignalText(input: string): string {
  return input
    .replace(/\[\s*\[[\s\S]{0,12000}?\]\s*\]/g, ' structured_payload ')
    .replace(/\b(?:do\s+not|don'?t|dont|never|without)\b[^.!?;\n]*/gi, ' prohibited_action ')
    .replace(/\bno\s+(?:calls?|writes?|access|actions?|tools?|connectors?)\b[^.!?;\n]*/gi, ' prohibited_action ');
}

function explicitlyNamesLearnedServer(input: string, serverSlug: string): boolean {
  const phrase = serverSlug
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!phrase) return false;
  const escaped = phrase
    .split(' ')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(recallWideningSignalText(input));
}

/**
 * Recall-aware scope: resolve continuity-aware normally, then WIDEN with the
 * user's own proven MCP servers when the current prompt strongly names a
 * remembered tool. This closes the native-MCP compounding loop — a server proven
 * once for an intent becomes reachable for it again WITHOUT needing a keyword
 * branch (pairs with the remember-on-success half in auto-remember.ts).
 *
 * Strictly additive: it only ever adds the user's own learned servers, never
 * removes; a deliberate no-tool turn is left untouched; precise recall replaces
 * the broad fail-open surface (drops failOpenCandidate so the consumer targets
 * the proven servers). No-op when nothing is learned or the flag is off. Reading
 * the tool-choice store is the only impurity; `learnedMatches` overrides it for
 * tests / callers that already have the matches.
 */
export function resolveMcpToolScopeWithRecall(
  options: {
    userInput?: string | null;
    priorUserInputs?: Array<string | null | undefined>;
    learnedMatches?: StepToolChoiceMatch[];
    standingCapabilityHints?: McpStandingCapabilityHint[];
    configuredServerNames?: string[];
    /** The previous turn ended by asking this user a question. Threaded to
     *  continuity so a contentless go-ahead keeps the scope its request earned. */
    awaitingAnswer?: boolean;
    answerDisposition?: 'affirmed' | 'declined' | 'selected' | 'provided';
  } = {},
): McpToolScope {
  const base = resolveMcpToolScopeWithContinuity(options);
  if (!recallScopeEnabled()) return base;
  if (base.allowAll) return base; // already the full surface
  // A user prohibition outranks the user's own history. Everywhere else recall
  // only reorders what was already permitted.
  if (mcpToolScopeAuthority(base) === 'none') return base;
  // A DELIBERATE no-tool turn (maxTools:0, not fail-open) explicitly wants no
  // tools — recall must not override it.
  if ((base.maxTools ?? 0) === 0 && !base.failOpenCandidate) return base;

  const input = (options.userInput ?? '').trim();
  const requestedEffectScope = requestedCapabilityEffectScope(input);
  // A remembered server may rank one operation, but cannot prove completeness
  // for a write or mixed accepted request. Preserve the bounded configured
  // catalog so an unresolved write remains discoverable instead of replacing
  // it with whichever remembered read happened to match first.
  if (
    base.failOpenCandidate
    && (requestedEffectScope === 'write' || requestedEffectScope === 'mixed')
  ) return base;
  let matches: StepToolChoiceMatch[];
  if (options.learnedMatches) {
    matches = options.learnedMatches;
  } else if (input) {
    try {
      // 'advertise': exposing a learned SERVER is scoping, not binding — the
      // same distinction the Claude lane's JIT pin uses. The bind-tier
      // matcher demanded an operation token a conversational ask never
      // carries and consulted a fingerprint cache that is empty at turn
      // start, so the Codex/BYO lane re-discovered servers its own memory
      // had proven (lane-parity fix, 2026-08-05). The widening guards below
      // (explicitlyNamesLearnedServer on precise scopes) are unchanged.
      matches = matchToolChoicesForStep(input, { purpose: 'advertise' });
    } catch {
      matches = [];
    }
  } else {
    matches = [];
  }

  const learned = learnedMcpServerSlugs(matches);
  if (learned.length === 0) return base;

  // Precise recall beats broad fail-open: drop failOpenCandidate and target the
  // learned servers. Once keyword routing already produced a precise scope,
  // recall may add another server only when the positive action text explicitly
  // names it. A semantic hit caused only by payload or a prohibited tool is not
  // authority to widen the live connector surface.
  const existing = base.failOpenCandidate ? [] : (base.allowedServerSlugs ?? []);
  const eligibleLearned = base.failOpenCandidate
    ? learned
    : learned.filter((slug) => existing.includes(slug) || explicitlyNamesLearnedServer(input, slug));
  const additions = eligibleLearned.filter((slug) => !existing.includes(slug));
  if (additions.length === 0) return base;
  const merged = Array.from(new Set([...existing, ...additions]));
  const baseCap = base.failOpenCandidate ? 0 : (base.maxTools ?? 0);
  return {
    ...base,
    failOpenCandidate: undefined,
    allowedServerSlugs: merged,
    maxTools: baseCap + additions.length * 8,
    serverMaxTools: {
      ...(base.serverMaxTools ?? {}),
      ...Object.fromEntries(additions.map((slug) => [slug, 8])),
    },
    reason: `${base.reason} + recall: explicitly requested proven server(s) ${additions.join(', ')}`,
  };
}
