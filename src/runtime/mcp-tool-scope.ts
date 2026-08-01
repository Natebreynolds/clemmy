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
const SALESFORCE_STRONG_RE = /\b(salesforce|sf cli|soql)\b/i;
const SALESFORCE_OBJECT_RE = /\b(opportunit(?:y|ies)|account(?:s)?|lead(?:s)?|contact(?:s)?)\b/i;
const SALESFORCE_CONTEXT_RE = /\b(crm|sales pipeline|salesforce pipeline|deal(?:s)?|prospect(?:s)?)\b/i;
const OUTLOOK_RE = /\b(outlook|email|emails|inbox|meeting invite)\b/i;
// "Calendar" and "draft" are overloaded artifact nouns (content calendar,
// release calendar, contract draft, post drafts). Calendar access becomes
// Outlook intent only when the user expresses an operational scheduling cue.
// Explicit Outlook/email/inbox language remains a strong signal above.
const CALENDAR_OPERATION_RE =
  /\b(?:check|show|list|read|open|view|add|put|create|update|edit|delete|remove|schedule|book|move|reschedule|block|clear)\b[^.!?\n]{0,80}\b(?:my|our|team|work|personal)\s+calendar\b|\b(?:add|put|schedule|book|move|reschedule|block)\b[^.!?\n]{0,50}\b(?:to|on)\s+(?:the\s+)?calendar\b|\b(?:my|our|team|work|personal)\s+calendar\b|\bcalendar\s+(?:event|events|invite|invites|meeting|meetings|availability)\b/i;
const EMAIL_DATA_FIELD_RE =
  /\b(?:column|columns|field|fields|header|headers|property|properties|key|keys)\b[^.!?\n]{0,80}?\be-?mails?\b|\be-?mail\b\s+(?:column|field|address|value|missing|blank|data)\b/i;
const EMAIL_DATA_LIST_RE =
  /([,;|]\s*)e-?mail\b|\be-?mail\b(?=\s*(?:[,;|/]|and\b)\s*(?:company|name|contact|account|domain|phone|title|status|value|field|column|header)\b)/gi;
const EMAIL_DATA_SHAPE_RE =
  /\be-?mail[-\s]shaped\s+(?:string|strings|value|values|field|fields|data)\b/gi;
const QUOTED_EMAIL_FIELD_RE =
  /(["'])e-?mail\1(?=\s*[,:\]}])/gi;
const STRUCTURED_TABULAR_CONTEXT_RE =
  /\b(?:google\s+sheets?|googlesheets?|spreadsheet|worksheet|sheet\s+(?:range|row|rows|tab|cells?)|cell\s+data|matrix|tabular|headers?|columns?|value\s+range)\b/i;
const CALENDAR_ARTIFACT_RE =
  /\b(?:social(?:\s+media)?\s+)?(?:content|editorial|marketing|campaign|publishing|post|production|release|launch|roadmap)\s+calendar\b/gi;
const NEGATED_OUTLOOK_ACTION_RE =
  /\b(?:do\s+not|don't|dont|never|without)\s+(?:(?:send|sending|draft|drafting|read|reading|search|searching|check|checking|use|using|open|opening|call|calling|contact|contacting|access|accessing|query|querying|invoke|invoking|create|creating|schedule|scheduling)\s+)?(?:any\s+)?(?:outlook|e-?mail(?:s|ing|ed)?|inbox|calendar|meeting\s+invites?)(?:\s+(?:or|and)\s+(?:(?:send|sending|draft|drafting|read|reading|search|searching|check|checking|use|using|open|opening|call|calling|contact|contacting|access|accessing|query|querying|invoke|invoking|create|creating|schedule|scheduling)\s+)?(?:any\s+)?(?:outlook|e-?mail(?:s|ing|ed)?|inbox|calendar|meeting\s+invites?))?/gi;
const NO_OUTLOOK_ACTION_RE =
  /\bno\s+(?:outlook|e-?mail|mail|calendar)\s+(?:action|actions|tool|tools|call|calls|send|sends|draft|drafts|access)\b/gi;

/**
 * Remove only email-as-data mentions before selecting Outlook tools. This is
 * intentionally a text projection rather than another broad negative regex:
 * a mixed request keeps its second operational mention ("columns company and
 * email, then email Bob"), while compact Sheet matrices such as
 * "company,email; Acme,acme@example.com" no longer preload an unrelated inbox.
 */
function withoutStructuredEmailMentions(input: string): string {
  const projected = STRUCTURED_TABULAR_CONTEXT_RE.test(input)
    ? input.replace(QUOTED_EMAIL_FIELD_RE, '"structured_field"')
    : input;
  return projected
    .replace(new RegExp(EMAIL_DATA_FIELD_RE.source, 'gi'), ' structured_field ')
    .replace(EMAIL_DATA_LIST_RE, '$1structured_field')
    .replace(EMAIL_DATA_SHAPE_RE, ' structured_data ');
}

/**
 * Project away explicit prohibitions before detecting Outlook intent. A
 * prohibition names a connector precisely so it will *not* be used; treating
 * that noun as positive intent both wastes schema budget and widens authority.
 * Mixed requests remain monotonic: only the negated action is removed, so
 * "do not send yet; draft an Outlook email" still exposes Outlook for the
 * positive draft clause.
 */
function withoutNegatedOutlookMentions(input: string): string {
  return withoutStructuredEmailMentions(input)
    // "Content calendar" is an artifact/domain model, not a request to read or
    // mutate the user's personal calendar. Project only that phrase away so a
    // mixed ask ("build a content calendar, then add a meeting to Outlook")
    // retains its separate operational Outlook clause.
    .replace(CALENDAR_ARTIFACT_RE, ' planning_artifact ')
    .replace(NEGATED_OUTLOOK_ACTION_RE, ' prohibited_outlook_action ')
    .replace(NO_OUTLOOK_ACTION_RE, ' prohibited_outlook_action ');
}
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
const GOOGLE_SHEETS_RE = /\b(google sheets?|googlesheets?|spreadsheet|sheet row|sheet tab|worksheet)\b/i;
const GITHUB_RE =
  /\b(github|pull request|pr\b|gh issue|github issue|issue #\d+)\b/i;
const LOCAL_DEPLOY_CLI_RE =
  /\b(netlify|vercel|railway|fly\.io|wrangler|cloudflare pages|firebase|render\.com|heroku)\b/i;
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
// A user who explicitly constrains a turn to local memory/context has already
// made the tool-scope decision. Detect this before keyword families: negative
// phrases such as "names only, no emails" must never open Outlook merely
// because OUTLOOK_RE sees the noun "emails". An explicit "except <app>" keeps
// the escape hatch for intentionally mixed requests.
const EXPLICIT_LOCAL_ONLY_RE =
  /\b(?:(?:use|using|consult|read|search|check)\s+only\s+(?:clementine(?:'s)?\s+)?local\s+(?:memory|context|files?)|(?:clementine(?:'s)?\s+)?local\s+(?:memory|context|files?)\s+only)\b/i;
const EXPLICIT_NO_EXTERNAL_TOOLS_RE =
  /\b(?:(?:do\s+not|don't|dont|never)\s+(?:call|use|invoke|open|query|contact)\s+(?:any\s+)?external\s+(?:connector|connectors|tool|tools|mcp|service|services)|no\s+external\s+(?:connector|connectors|tool|tools|mcp|service|services))\b/i;
const EXTERNAL_SCOPE_EXCEPTION_RE =
  /\b(?:except|other\s+than)\s+(?:for\s+)?(?:salesforce|outlook|gmail|google|github|slack|notion|airtable|an?\s+external)\b/i;

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
  if (
    (EXPLICIT_LOCAL_ONLY_RE.test(input) || EXPLICIT_NO_EXTERNAL_TOOLS_RE.test(input))
    && !EXTERNAL_SCOPE_EXCEPTION_RE.test(input)
  ) {
    return {
      reason: `explicit local-only/no-external-tools instruction: ${lower.slice(0, 120)}`,
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
  const wantsSalesforce = SALESFORCE_STRONG_RE.test(input)
    || (SALESFORCE_OBJECT_RE.test(input) && SALESFORCE_CONTEXT_RE.test(input));
  const outlookIntentInput = withoutNegatedOutlookMentions(input);
  const mentionsOutlookFamily = OUTLOOK_RE.test(outlookIntentInput)
    || CALENDAR_OPERATION_RE.test(outlookIntentInput);
  const wantsOutlook = mentionsOutlookFamily
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
    // These providers are driven by Clementine's local CLI + shell surface,
    // not an external MCP server. A deploy prompt often contains generic words
    // such as "account", "site", "commit", and "branch"; failing open here
    // used to preload unrelated Salesforce/GitHub tools before a Netlify call.
    // Mixed requests have already populated `scopes` above (for example,
    // "deploy to Netlify, then email Bob"), so their real connector remains.
    if (LOCAL_DEPLOY_CLI_RE.test(input)) {
      return {
        reason: `local deploy CLI intent; no external MCP needed: ${lower.slice(0, 120)}`,
        allowedServerSlugs: [],
        toolPatterns: [],
        maxTools: 0,
      };
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
    pinnedCalendarLabels?: string[];
    /** The previous turn ended by asking this user a question. */
    awaitingAnswer?: boolean;
  } = {},
): McpToolScope {
  const direct = resolveMcpToolScope({ userInput: options.userInput, pinnedCalendarLabels: options.pinnedCalendarLabels });
  if (scopeIsConcrete(direct)) return direct;
  if (!options.awaitingAnswer && !isToolScopeContinuation(options.userInput)) return direct;
  for (const prior of options.priorUserInputs ?? []) {
    const inherited = resolveMcpToolScope({ userInput: prior, pinnedCalendarLabels: options.pinnedCalendarLabels });
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
    if (m.kind !== 'mcp' || m.tier !== 'high') continue;
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
    pinnedCalendarLabels?: string[];
    /** The previous turn ended by asking this user a question. Threaded to
     *  continuity so a contentless go-ahead keeps the scope its request earned. */
    awaitingAnswer?: boolean;
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
