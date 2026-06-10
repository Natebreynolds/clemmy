/**
 * Capability Registry — Maps user intents to achievable outcomes across tool families.
 *
 * Purpose:
 * Instead of "tool not found" or "try this one tool", Clementine sees:
 *   "To send emails, you have: [Outlook (1.0), Gmail (0.9), CLI mail (0.6), manual draft (0.4)]"
 *
 * Design:
 * - Intent → list of alternatives, scored by applicability
 * - Scores: 1.0 (direct), 0.7-0.8 (indirect), 0.4-0.5 (workaround), 0.0 (impossible)
 * - Built from: tool taxonomy + observed tool availability + known limitations
 * - Injected early so agent picks best option, not first option
 *
 * Usage:
 * const capabilities = getCapabilitiesForIntent("send email")
 * // Returns: [
 * //   { tool: "composio_outlook_send", score: 1.0, reason: "Direct, built for email" },
 * //   { tool: "composio_gmail_send", score: 0.9, reason: "Direct, equally capable" },
 * //   { tool: "cli_mail", score: 0.6, reason: "Available but requires shell" },
 * //   { tool: "manual_guidance", score: 0.4, reason: "Guide user, they send manually" },
 * // ]
 */

// import type { RuntimeContextValue } from './types.js';

/**
 * A capability option — how to achieve a user intent.
 */
export interface CapabilityOption {
  /** Tool name or pseudo-tool identifier. */
  toolName: string;
  /** Direct tool: 1.0; indirect/workaround: 0.4-0.8; manual: 0.4; impossible: 0.0 */
  score: number;
  /** Why this option is available/preferred/fallback. */
  reason: string;
  /** Required context (e.g., "Outlook must be connected"). */
  requirement?: string;
  /** Alternative approach if this tool becomes unavailable. */
  fallback?: string;
}

/**
 * Registered capability pattern — maps an intent or intent family to options.
 */
export interface CapabilityPattern {
  /** Exact or partial intent match (used by fuzzy lookup). */
  intent: string;
  /** Detailed description for context injection. */
  description: string;
  /** Available options, ranked by score. */
  options: CapabilityOption[];
  /** Notes for edge cases (e.g., "tool returns partial results"). */
  notes?: string;
}

/**
 * Core capability patterns — intent → available tools.
 *
 * Design notes:
 * - Each pattern covers one intent family (send email, query database, etc.)
 * - Options ranked by score (1.0 first, 0.0 last)
 * - Scores reflect direct vs. indirect vs. workaround vs. manual
 * - Requirement/fallback fields guide agent when option unavailable
 */
const CORE_PATTERNS: CapabilityPattern[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // COMMUNICATION
  // ─────────────────────────────────────────────────────────────────────────

  {
    intent: 'send email',
    description:
      'Send email to recipient(s) via connected email service, with optional attachments and formatting.',
    options: [
      {
        toolName: 'composio_outlook_send_message',
        score: 1.0,
        reason: 'Direct Outlook action; best if Outlook is connected',
        requirement: 'Outlook account connected',
        fallback: 'composio_gmail_send_message',
      },
      {
        toolName: 'composio_gmail_send_message',
        score: 0.95,
        reason: 'Direct Gmail action; equally capable, often more reliable',
        requirement: 'Gmail account connected',
        fallback: 'composio_outlook_send_message',
      },
      {
        toolName: 'cli_mail_send',
        score: 0.5,
        reason: 'System mail command; works but no rich formatting',
        requirement: 'Mail CLI installed on system',
        fallback: 'manual_guidance',
      },
      {
        toolName: 'manual_draft_guidance',
        score: 0.3,
        reason: 'No automation possible; I will draft, you send manually',
      },
    ],
    notes: 'If both Outlook and Gmail are available, prefer the one with better reliability history',
  },

  {
    intent: 'send message to slack',
    description: 'Post message to Slack channel or DM.',
    options: [
      {
        toolName: 'composio_slack_send_message',
        score: 1.0,
        reason: 'Direct Slack API action',
        requirement: 'Slack workspace connected',
      },
      {
        toolName: 'discord_dm_guidance',
        score: 0.3,
        reason: 'Alternative: send via Discord instead of Slack',
      },
    ],
  },

  {
    intent: 'send calendar invite',
    description: 'Schedule meeting and send invites to attendees.',
    options: [
      {
        toolName: 'composio_outlook_create_event',
        score: 1.0,
        reason: 'Direct Outlook calendar action',
        requirement: 'Outlook account connected',
      },
      {
        toolName: 'composio_google_calendar_create_event',
        score: 0.95,
        reason: 'Direct Google Calendar action',
        requirement: 'Google Calendar connected',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // DATA QUERY & RETRIEVAL
  // ─────────────────────────────────────────────────────────────────────────

  {
    intent: 'query salesforce records',
    description: 'Search or query Salesforce for accounts, leads, opportunities, etc.',
    options: [
      {
        toolName: 'composio_salesforce_query',
        score: 1.0,
        reason: 'Direct Salesforce API; full SOQL support',
        requirement: 'Salesforce connected with query permission',
      },
      {
        toolName: 'cli_sf_query',
        score: 0.7,
        reason: 'SF CLI direct access; slower but works offline',
        requirement: 'SF CLI installed, logged in',
      },
      {
        toolName: 'csv_export_manual',
        score: 0.4,
        reason: 'Export CSV manually, provide query guidance',
      },
    ],
    notes: 'If both API and CLI available, API is faster',
  },

  {
    intent: 'search airtable records',
    description: 'Find records in Airtable base, optionally filter or sort.',
    options: [
      {
        toolName: 'composio_airtable_list_records',
        score: 1.0,
        reason: 'Direct Airtable API action',
        requirement: 'Airtable base connected',
      },
      {
        toolName: 'airtable_web_ui_guidance',
        score: 0.4,
        reason: 'Guide user to open web UI and filter manually',
      },
    ],
  },

  {
    intent: 'query google sheets',
    description: 'Read data from Google Sheets, optionally filter or aggregate.',
    options: [
      {
        toolName: 'composio_google_sheets_read',
        score: 1.0,
        reason: 'Direct Sheets API action',
        requirement: 'Google Sheets connected',
      },
      {
        toolName: 'cli_gcloud_sheets',
        score: 0.6,
        reason: 'Google Cloud CLI; works but slower',
        requirement: 'gcloud CLI configured',
      },
    ],
  },

  {
    intent: 'get seo data for website',
    description: 'Research SEO metrics: rankings, backlinks, traffic, etc.',
    options: [
      {
        toolName: 'composio_dataforseo_labs_rank',
        score: 1.0,
        reason: 'Direct DataForSEO API; comprehensive SEO data',
        requirement: 'DataForSEO connected (composio)',
      },
      {
        toolName: 'native_dataforseo_api',
        score: 0.95,
        reason: 'Native DataForSEO SDK access (fallback)',
        requirement: 'DataForSEO API key configured',
      },
      {
        toolName: 'web_scrape_manual',
        score: 0.3,
        reason: 'Scrape competitor sites manually for basic data',
      },
    ],
    notes: 'Rate limits on DataForSEO are strict; batch requests carefully',
  },

  {
    intent: 'scrape or fetch website content',
    description: 'Get HTML/markdown from a URL, including JavaScript-rendered content.',
    options: [
      {
        toolName: 'firecrawl_scrape',
        score: 1.0,
        reason: 'Direct Firecrawl API; handles JS-heavy pages',
        requirement: 'Firecrawl configured',
      },
      {
        toolName: 'web_fetch_simple',
        score: 0.7,
        reason: 'Simple HTTP fetch; fails on JS-heavy pages',
      },
      {
        toolName: 'browser_automation',
        score: 0.6,
        reason: 'Use computer vision to load and read page',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // DATA UPDATE/WRITE
  // ─────────────────────────────────────────────────────────────────────────

  {
    intent: 'create or update salesforce record',
    description: 'Add or modify account, lead, opportunity, etc. in Salesforce.',
    options: [
      {
        toolName: 'composio_salesforce_create_update',
        score: 1.0,
        reason: 'Direct Salesforce API; atomic operations',
        requirement: 'Salesforce connected with write permission',
      },
      {
        toolName: 'cli_sf_upsert',
        score: 0.7,
        reason: 'SF CLI direct; slower but works offline',
        requirement: 'SF CLI installed, logged in',
      },
      {
        toolName: 'csv_import_guidance',
        score: 0.4,
        reason: 'Prepare CSV, guide user to import in Salesforce web UI',
      },
    ],
  },

  {
    intent: 'update airtable records',
    description: 'Modify fields in Airtable, batch or single record.',
    options: [
      {
        toolName: 'composio_airtable_update_records',
        score: 1.0,
        reason: 'Direct Airtable API; batch operations',
        requirement: 'Airtable base connected with write permission',
      },
      {
        toolName: 'airtable_web_ui_guidance',
        score: 0.3,
        reason: 'Guide user to edit in web UI',
      },
    ],
  },

  {
    intent: 'write to google sheets',
    description: 'Add or update rows in Google Sheets.',
    options: [
      {
        toolName: 'composio_google_sheets_append',
        score: 1.0,
        reason: 'Direct Sheets API; append or update',
        requirement: 'Google Sheets connected with write permission',
      },
      {
        toolName: 'sheets_web_ui_guidance',
        score: 0.4,
        reason: 'Guide user to paste data manually',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // FILE OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────

  {
    intent: 'read or create file',
    description: 'Read, write, or append to files in workspace.',
    options: [
      {
        toolName: 'read_file',
        score: 1.0,
        reason: 'Direct local file read',
      },
      {
        toolName: 'write_file',
        score: 1.0,
        reason: 'Direct local file write (to workspace)',
      },
    ],
  },

  {
    intent: 'upload file to cloud storage',
    description: 'Upload file to Google Drive, Dropbox, or similar.',
    options: [
      {
        toolName: 'composio_google_drive_upload',
        score: 1.0,
        reason: 'Direct Google Drive API',
        requirement: 'Google Drive connected',
      },
      {
        toolName: 'dropbox_upload_guidance',
        score: 0.5,
        reason: 'Guide user to upload manually to Dropbox',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // ANALYSIS & SYNTHESIS
  // ─────────────────────────────────────────────────────────────────────────

  {
    intent: 'analyze or research topic',
    description: 'Deep research with web search, content synthesis, competitor analysis.',
    options: [
      {
        toolName: 'composio_search_tools',
        score: 1.0,
        reason: 'Search for tools, then compose multi-step research',
      },
      {
        toolName: 'web_search_native',
        score: 0.9,
        reason: 'Native web search + firecrawl for content',
      },
      {
        toolName: 'manual_research_guidance',
        score: 0.3,
        reason: 'Provide research outline, user gathers data',
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────────
  // EXECUTION & AUTOMATION
  // ─────────────────────────────────────────────────────────────────────────

  {
    intent: 'run shell command or script',
    description: 'Execute CLI commands, scripts, or local tools.',
    options: [
      {
        toolName: 'run_shell_command',
        score: 1.0,
        reason: 'Direct shell execution in workspace',
      },
      {
        toolName: 'cli_tool_guidance',
        score: 0.5,
        reason: 'Provide exact command, user runs in terminal',
      },
    ],
  },

  {
    intent: 'deploy or publish',
    description: 'Deploy to hosting platform (Netlify, Vercel, GitHub Pages, etc.)',
    options: [
      {
        toolName: 'composio_netlify_deploy',
        score: 1.0,
        reason: 'Direct Netlify API',
        requirement: 'Netlify connected',
      },
      {
        toolName: 'composio_vercel_deploy',
        score: 1.0,
        reason: 'Direct Vercel API',
        requirement: 'Vercel connected',
      },
      {
        toolName: 'git_push_guidance',
        score: 0.5,
        reason: 'User pushes to repo, CI/CD handles deploy',
      },
    ],
  },
];

/**
 * Get all capabilities for a given intent. Includes direct matches and fuzzy matches.
 */
export function getCapabilitiesForIntent(intent: string): CapabilityOption[] {
  const normalized = intent.toLowerCase().trim();

  // Exact match first
  const exact = CORE_PATTERNS.find((p) => p.intent.toLowerCase() === normalized);
  if (exact) {
    return exact.options;
  }

  // Fuzzy match — check for keyword overlap (require at least 2 keywords or 50% overlap)
  const intentKeywords = normalized.split(/\s+/).filter((k) => k.length > 2); // Skip short words
  const matches = CORE_PATTERNS.filter((p) => {
    const patternTerms = p.intent.toLowerCase().split(/\s+/).filter((k) => k.length > 2);
    const overlap = intentKeywords.filter((i) => patternTerms.includes(i)).length;

    // Require at least 2 keywords match OR >= 50% of the intent's keywords match
    const minMatch = Math.max(2, Math.ceil(intentKeywords.length * 0.5));
    return overlap >= minMatch;
  });

  if (matches.length === 0) {
    // No capabilities found — return a "unknown" option
    return [
      {
        toolName: 'unknown_capability',
        score: 0.0,
        reason: `No known tools for "${intent}"`,
        requirement: 'May require manual approach or new tool discovery',
      },
    ];
  }

  // Return options from all fuzzy matches, deduplicated
  const seen = new Set<string>();
  const results: CapabilityOption[] = [];
  for (const match of matches) {
    for (const option of match.options) {
      if (!seen.has(option.toolName)) {
        seen.add(option.toolName);
        results.push(option);
      }
    }
  }

  return results.sort((a, b) => b.score - a.score); // Sort by score descending
}

/**
 * Format capabilities for context injection — readable summary for the agent.
 */
export function formatCapabilitiesForContext(intent: string, options: CapabilityOption[]): string {
  if (options.length === 0) return '';

  const lines = [`For "${intent}", you have these options:`];
  for (const opt of options) {
    const scoreLabel =
      opt.score >= 0.95 ? '✅' : opt.score >= 0.7 ? '⚠️' : opt.score >= 0.4 ? '⭕' : '❌';
    const requirement = opt.requirement ? ` (requires: ${opt.requirement})` : '';
    lines.push(`${scoreLabel} [${opt.score.toFixed(2)}] ${opt.toolName}: ${opt.reason}${requirement}`);
  }
  return lines.join('\n');
}

/**
 * Check whether a given tool is available in the current runtime context.
 */
export function isToolAvailable(toolName: string, context?: unknown): boolean {
  // This would check against actual tool availability from the harness
  // For now, placeholder implementation
  if (!context) return false;

  // Check native tools
  const nativeTools = ['read_file', 'write_file', 'run_shell_command'];
  if (nativeTools.includes(toolName)) return true;

  // TODO: Check composio tools
  // TODO: Check MCP tools
  // TODO: Check skill tools

  return false;
}

/**
 * Suggest a fallback when a tool fails.
 */
export function suggestFallback(failedTool: string, intent: string): CapabilityOption[] {
  const allOptions = getCapabilitiesForIntent(intent);

  // If we don't have real capabilities (unknown intent), suggest escalation
  if (allOptions.length === 1 && allOptions[0].score === 0.0) {
    return [
      {
        toolName: 'escalate_to_user',
        score: 0.2,
        reason: `No known tools for "${intent}". I'll guide you step-by-step.`,
      },
    ];
  }

  // Filter out the failed tool
  const available = allOptions.filter((opt) => opt.toolName !== failedTool);

  if (available.length === 0) {
    return [
      {
        toolName: 'escalate_to_user',
        score: 0.2,
        reason: `No other options available. I'll guide you step-by-step.`,
      },
    ];
  }

  return available;
}
