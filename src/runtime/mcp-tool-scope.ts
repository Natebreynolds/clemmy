import { matchToolChoicesForStep, type StepToolChoiceMatch } from '../memory/tool-choice-store.js';

export interface McpToolScope {
  /**
   * Human-readable reason for telemetry/debug logs.
   */
  reason: string;
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
   * Regex sources matched against the namespaced tool name, original tool
   * name, and description.
   */
  toolPatterns?: string[];
  /**
   * Keyword hints used to rank matched tools before maxTools is applied.
   */
  priorityKeywords?: string[];
  /**
   * Hard cap on returned MCP tools after filtering.
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
   * The current user input, threaded through for T1 semantic tool retrieval.
   * When set (and embeddings are healthy), the fail-open surface ranks the
   * user's connected tools by semantic relevance to this text — turning the
   * arbitrary "first N tools" cap into the N MOST RELEVANT. Ignored on keyword
   * family scopes (their cached shim can't hold a per-query embedding). Set by
   * the orchestrator at run start; not part of the scope cache key.
   */
  queryText?: string;
}

export interface ResolveMcpToolScopeOptions {
  userInput?: string | null;
  /**
   * Distinguishing labels of the user's pinned-calendar rules (from
   * constraint-guard's pinnedCalendarRuleLabels). Lets a date shorthand that
   * names the org ("check <org> tomorrow") scope the Outlook tools.
   */
  pinnedCalendarLabels?: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
const SEO_RE =
  /\b(seo|audit|ranking|rankings|serp|keyword|keywords|backlink|backlinks|domain authority|organic traffic|search visibility|site health|technical audit|crawl|meta title|meta description|schema markup)\b/i;
const WEB_RE =
  /\b(scrape|crawl|website|web page|webpage|article|news|browser|search the web|look up|research online|recent article)\b/i;
const SALESFORCE_RE = /\b(salesforce|sf cli|soql|opportunit(?:y|ies)|account(?:s)?|lead(?:s)?|contact(?:s)?)\b/i;
const OUTLOOK_RE = /\b(outlook|email|emails|draft(?:s)?|inbox|calendar|meeting invite)\b/i;
const DATEISH_RE =
  /\b(today|tomorrow|tonight|this (?:morning|afternoon|evening|week)|next (?:week|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
// A shorthand ask that names a pinned calendar's org label ("check <org>
// tomorrow") is Outlook-calendar intent even without the word "calendar".
// Labels come from the caller (constraint-guard's pinnedCalendarRuleLabels —
// the user's own pinned-calendar constraint facts); nothing is hardcoded, and
// this module stays pure. No pinned calendars → this never fires.
function namesPinnedCalendarLabel(input: string, labels: string[] | undefined): boolean {
  try {
    return (labels ?? []).some((label) =>
      new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(input));
  } catch {
    return false;
  }
}
const GOOGLE_SHEETS_RE = /\b(google sheet|googlesheet|spreadsheet|sheet row|sheet tab|worksheet)\b/i;
const GITHUB_RE =
  /\b(github|pull request|pr\b|repo|repository|branch|commit|gh issue|github issue|issue #\d+)\b/i;
const LOCAL_CONTEXT_FOLLOWUP_RE =
  /\b(existing context|use the existing context|from context|remember|remembered|we just ran|previous|already found|append|local file update|local markdown|markdown report|the report|the audit we just ran)\b/i;
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
 * Resolve the external MCP tool surface for a fresh user turn.
 *
 * Important: callers without a concrete user prompt intentionally get
 * allowAll. Approval resumes and legacy internals may need the exact tool
 * that was pending before the scoped-tool experiment existed.
 */
export function resolveMcpToolScope(options: ResolveMcpToolScopeOptions = {}): McpToolScope {
  if (scopingDisabled()) {
    return { reason: 'scoped MCP disabled by CLEMMY_SCOPED_MCP_TOOLS', allowAll: true };
  }

  const input = options.userInput?.trim();
  if (!input) {
    return { reason: 'no prompt available; preserving legacy external MCP surface', allowAll: true };
  }

  const lower = input.toLowerCase();
  const scopes: McpToolScope[] = [];

  const isLocalContextFollowup = LOCAL_CONTEXT_FOLLOWUP_RE.test(input);
  const hasFreshExternalIntent = FRESH_EXTERNAL_RE.test(input) || FRESH_EXTERNAL_DATA_RE.test(input);
  const hasNegatedFreshExternalIntent = NEGATED_FRESH_EXTERNAL_RE.test(input) || NEGATED_EXTERNAL_WINDOW_RE.test(input);
  const wantsSeo = SEO_RE.test(input) || (URL_RE.test(input) && /\baudit\b/i.test(input));
  const wantsWeb = WEB_RE.test(input);
  const wantsSalesforce = SALESFORCE_RE.test(input);
  const wantsOutlook = OUTLOOK_RE.test(input)
    || (DATEISH_RE.test(input) && namesPinnedCalendarLabel(input, options.pinnedCalendarLabels));
  const wantsGoogleSheets = GOOGLE_SHEETS_RE.test(input);
  const wantsGithub = GITHUB_RE.test(input);
  const hasNamedExternalSystemIntent = wantsSalesforce || wantsOutlook || wantsGoogleSheets || wantsGithub;

  if (
    isLocalContextFollowup
    && !hasNamedExternalSystemIntent
    && (hasNegatedFreshExternalIntent || !hasFreshExternalIntent)
  ) {
    return {
      reason: `local context/file follow-up; no fresh external MCP needed: ${lower.slice(0, 120)}`,
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

  if (wantsSalesforce) {
    scopes.push({
      reason: 'salesforce intent',
      allowedServerSlugs: ['salesforce'],
      toolPatterns: ['salesforce', 'soql', 'account', 'lead', 'contact', 'opportunit'],
      priorityKeywords: ['query', 'search', 'list', 'get', 'create', 'update'],
      maxTools: 8,
      serverMaxTools: { salesforce: 8 },
    });
  }

  if (wantsOutlook) {
    scopes.push({
      reason: 'outlook/email intent',
      allowedServerSlugs: ['outlook', 'microsoft_outlook', 'microsoft'],
      toolPatterns: ['outlook', 'email', 'mail', 'draft', 'message', 'calendar', 'event'],
      priorityKeywords: ['draft', 'send', 'list', 'search', 'create', 'calendar'],
      maxTools: 8,
      serverMaxTools: { outlook: 8, microsoft_outlook: 8, microsoft: 8 },
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
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      };
    }
    return {
      reason: `no keyword-family intent matched — failing OPEN to the user's own connected servers (bounded): ${lower.slice(0, 120)}`,
      failOpenCandidate: true,
      toolPatterns: [],
      maxTools: failOpenMaxTools(),
    };
  }

  const allowedServerSlugs = Array.from(new Set(scopes.flatMap((scope) => scope.allowedServerSlugs ?? [])));
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
    reason: scopes.map((scope) => scope.reason).join(' + '),
    allowedServerSlugs,
    toolPatterns,
    priorityKeywords,
    maxTools: maxTools > 0 ? maxTools : undefined,
    serverMaxTools: Object.keys(serverMaxTools).length > 0 ? serverMaxTools : undefined,
  };
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
 */
export function resolveMcpToolScopeWithContinuity(
  options: { userInput?: string | null; priorUserInputs?: Array<string | null | undefined>; pinnedCalendarLabels?: string[] } = {},
): McpToolScope {
  const direct = resolveMcpToolScope({ userInput: options.userInput, pinnedCalendarLabels: options.pinnedCalendarLabels });
  if (scopeIsConcrete(direct)) return direct;
  if (!isToolScopeContinuation(options.userInput)) return direct;
  for (const prior of options.priorUserInputs ?? []) {
    const inherited = resolveMcpToolScope({ userInput: prior, pinnedCalendarLabels: options.pinnedCalendarLabels });
    // Only inherit a CONCRETE keyword scope (maxTools>0) — never a prior allowAll
    // (a no-prompt/internal turn) which would silently open the whole surface,
    // and never a prior FAIL-OPEN scope (that's a fallback, not a precise
    // intent to inherit — the direct fail-open below already covers it).
    if (!inherited.failOpenCandidate && (inherited.maxTools ?? 0) > 0) {
      return {
        ...inherited,
        reason: `continuity: inherited prior-turn scope for follow-up ("${(options.userInput ?? '').trim().slice(0, 40)}") → ${inherited.reason}`,
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
    if (m.kind !== 'mcp' || m.tier !== 'high') continue;
    const slug = (m.identifier.split('__')[0] ?? '').trim().toLowerCase();
    if (slug) slugs.push(slug);
  }
  return Array.from(new Set(slugs));
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
    pinnedCalendarLabels?: string[];
  } = {},
): McpToolScope {
  const base = resolveMcpToolScopeWithContinuity(options);
  if (!recallScopeEnabled()) return base;
  if (base.allowAll) return base; // already the full surface
  // A DELIBERATE no-tool turn (maxTools:0, not fail-open) explicitly wants no
  // tools — recall must not override it.
  if ((base.maxTools ?? 0) === 0 && !base.failOpenCandidate) return base;

  const input = (options.userInput ?? '').trim();
  let matches: StepToolChoiceMatch[];
  if (options.learnedMatches) {
    matches = options.learnedMatches;
  } else if (input) {
    try {
      matches = matchToolChoicesForStep(input);
    } catch {
      matches = [];
    }
  } else {
    matches = [];
  }

  const learned = learnedMcpServerSlugs(matches);
  if (learned.length === 0) return base;

  // Precise recall beats broad fail-open: drop failOpenCandidate and target the
  // learned servers (merged with any keyword-matched ones).
  const existing = base.failOpenCandidate ? [] : (base.allowedServerSlugs ?? []);
  const merged = Array.from(new Set([...existing, ...learned]));
  const baseCap = base.failOpenCandidate ? 0 : (base.maxTools ?? 0);
  return {
    ...base,
    failOpenCandidate: undefined,
    allowedServerSlugs: merged,
    maxTools: baseCap + learned.length * 8,
    reason: `${base.reason} + recall: proven server(s) ${learned.join(', ')}`,
  };
}
