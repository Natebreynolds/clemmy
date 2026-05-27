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
}

export interface ResolveMcpToolScopeOptions {
  userInput?: string | null;
}

const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
const SEO_RE =
  /\b(seo|audit|ranking|rankings|serp|keyword|keywords|backlink|backlinks|domain authority|organic traffic|search visibility|site health|technical audit|crawl|meta title|meta description|schema markup)\b/i;
const WEB_RE =
  /\b(scrape|crawl|website|web page|webpage|article|news|browser|search the web|look up|research online|recent article)\b/i;
const SALESFORCE_RE = /\b(salesforce|sf cli|soql|opportunit(?:y|ies)|account(?:s)?|lead(?:s)?|contact(?:s)?)\b/i;
const OUTLOOK_RE = /\b(outlook|email|emails|draft(?:s)?|inbox|calendar|meeting invite)\b/i;
const GOOGLE_SHEETS_RE = /\b(google sheet|googlesheet|spreadsheet|sheet row|sheet tab|worksheet)\b/i;
const GITHUB_RE =
  /\b(github|pull request|pr\b|repo|repository|branch|commit|gh issue|github issue|issue #\d+)\b/i;
const LOCAL_CONTEXT_FOLLOWUP_RE =
  /\b(existing context|use the existing context|from context|remember|remembered|we just ran|previous|already found|append|local file update|local markdown|markdown report|the report|the audit we just ran)\b/i;
const FRESH_EXTERNAL_RE =
  /\b(fresh|new audit|rerun|re-run|run .*audit|use dataforseo|crawl|lighthouse|current rankings?|latest rankings?|check the site|fetch|scrape|search the web|look up online|new data)\b/i;
const NEGATED_FRESH_EXTERNAL_RE =
  /\b(?:do\s+not|don't|dont|without|no)\s+(?:run|running|rerun|re-running|re-run|perform|performing|do|doing|use|using|call|calling|invoke|invoking|start|starting|trigger|triggering)?\s*(?:any\s+)?(?:a\s+)?(?:fresh|new)?\s*(?:web\s+)?(?:seo\s+)?(?:audit|dataforseo|lookup|lookups|look\s+up|crawl|crawling|scrape|scraping|search|searching|external|external\s+mcp|web\s+search|site\s+check)\b/i;
const NEGATED_EXTERNAL_WINDOW_RE =
  /\b(?:do\s+not|don't|dont|without|no)\s+[^.!?\n]{0,160}\b(?:fresh|new|dataforseo|external\s+mcp|web\s+search|crawl|crawling|scrape|scraping|search|searching|lookup|lookups|look\s+up|audit)\b/i;

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
  const hasFreshExternalIntent = FRESH_EXTERNAL_RE.test(input);
  const hasNegatedFreshExternalIntent = NEGATED_FRESH_EXTERNAL_RE.test(input) || NEGATED_EXTERNAL_WINDOW_RE.test(input);
  const wantsSeo = SEO_RE.test(input) || (URL_RE.test(input) && /\baudit\b/i.test(input));
  const wantsWeb = WEB_RE.test(input);
  const wantsSalesforce = SALESFORCE_RE.test(input);
  const wantsOutlook = OUTLOOK_RE.test(input);
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
    return {
      reason: `no external MCP intent detected from prompt: ${lower.slice(0, 120)}`,
      allowedServerSlugs: [],
      toolPatterns: [],
      maxTools: 0,
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
