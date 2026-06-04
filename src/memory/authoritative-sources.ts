import { getRuntimeEnv } from '../config.js';

/**
 * Connectors as authoritative writers (Thread 1).
 *
 * Facts the reflection loop derives from a TOOL all collapse to trust 0.6
 * today — a Salesforce record and a guessed inference are indistinguishable.
 * This module assigns a SOURCE-CATEGORY trust prior so ground truth from a
 * system of record (CRM, calendar, mailbox, database) outranks an inference,
 * and public-web/scrape sources rank below a generic inference.
 *
 * This is a trust PRIOR, not a capability allowlist: an unrecognized tool
 * returns null → the fact keeps the default derived trust (0.6) and still
 * writes. So it only ever WEIGHTS, never gates — consistent with the
 * "global, no curated allowlists" north star. The categories are app-family
 * priors (CRM is authoritative; a scraper is not), not a per-tool list.
 *
 * Tool name matching is substring-based against the tool name the reflector
 * sees (`input.tool`), which spans composio first-class slugs
 * (SALESFORCE_*, OUTLOOK_*, GMAIL_*), MCP names
 * (mcp__claude_ai_Microsoft_365__*, dataforseo__*), and native CLIs (sf).
 * The generic `composio_execute_tool` wrapper carries the slug in its ARGS
 * rather than its name, so it won't classify here — that's handled later by
 * passing the resolved slug through (structured-ingest phase).
 */

export type SourceCategory = 'system_of_record' | 'web_source';

export interface SourceClass {
  app: string;
  trust: number;
  category: SourceCategory;
}

/** Ground-truth systems of record. trust 0.9 (below user-stated 1.0, above
 *  generic derived 0.6). token → friendly app name. Order matters: more
 *  specific tokens first. */
const SYSTEM_OF_RECORD: Array<{ token: string; app: string }> = [
  { token: 'salesforce', app: 'Salesforce' },
  { token: 'hubspot', app: 'HubSpot' },
  { token: 'microsoft_365', app: 'Outlook / Microsoft 365' },
  { token: 'microsoft365', app: 'Outlook / Microsoft 365' },
  { token: 'outlook', app: 'Outlook / Microsoft 365' },
  { token: 'sharepoint', app: 'SharePoint' },
  { token: 'gmail', app: 'Gmail' },
  { token: 'googlecalendar', app: 'Google Calendar' },
  { token: 'google_calendar', app: 'Google Calendar' },
  { token: 'googledrive', app: 'Google Drive' },
  { token: 'google_drive', app: 'Google Drive' },
  { token: 'googlesheets', app: 'Google Sheets' },
  { token: 'google_sheets', app: 'Google Sheets' },
  { token: 'googledocs', app: 'Google Docs' },
  { token: 'airtable', app: 'Airtable' },
  { token: 'notion', app: 'Notion' },
  { token: 'linear', app: 'Linear' },
  { token: 'jira', app: 'Jira' },
  { token: 'asana', app: 'Asana' },
  { token: 'trello', app: 'Trello' },
  { token: 'stripe', app: 'Stripe' },
  { token: 'supabase', app: 'Supabase' },
  { token: 'zoom', app: 'Zoom' },
  { token: 'onedrive', app: 'OneDrive' },
  { token: 'one_drive', app: 'OneDrive' },
];

/** Public web / scrape / search sources. trust 0.5 (below generic derived
 *  0.6) — useful but not canonical, and frequently stale or wrong. */
const WEB_SOURCE: Array<{ token: string; app: string }> = [
  { token: 'firecrawl', app: 'Firecrawl' },
  { token: 'dataforseo', app: 'DataForSEO' },
  { token: 'brightdata', app: 'Bright Data' },
  { token: 'serp', app: 'SERP' },
  { token: 'websearch', app: 'Web Search' },
  { token: 'web_search', app: 'Web Search' },
  { token: 'tavily', app: 'Tavily' },
  { token: 'perplexity', app: 'Perplexity' },
  { token: 'exa', app: 'Exa' },
];

/** Native-CLI binaries that ARE systems of record (the command-line path,
 *  reached via run_shell_command). Matched EXACTLY (not by substring) — a
 *  2-char binary like `sf` is a substring of ordinary words ("tran[sf]er"),
 *  so substring matching would false-positive. Conservative on purpose; more
 *  data-of-record CLIs (bq, etc.) can be added here. */
const CLI_BINARIES: Record<string, string> = {
  sf: 'Salesforce',
  sfdx: 'Salesforce',
  gh: 'GitHub',
};

export const SOURCE_OF_RECORD_TRUST = 0.9;
export const WEB_SOURCE_TRUST = 0.5;
/** A fact at/above this trust is treated as canonical ground truth by the
 *  conflict resolver and the deterministic ground-truth-wins fast-path. */
export const AUTHORITATIVE_TRUST = 0.85;

/** Whether tiered source trust is active (flag-gated, default off). */
export function isSourceTrustEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_SOURCE_TRUST', 'off') || 'off').toLowerCase() === 'on';
}

/**
 * Classify a tool name into a source category + trust prior, or null when
 * the tool is unrecognized (→ caller keeps the default derived trust).
 */
export function classifySource(tool: string | null | undefined): SourceClass | null {
  if (!tool) return null;
  const t = tool.toLowerCase().trim();
  // Exact whole-name match for native-CLI binaries FIRST — these are short
  // (sf/gh) and would false-positive under substring matching.
  const cliApp = CLI_BINARIES[t];
  if (cliApp) return { app: cliApp, trust: SOURCE_OF_RECORD_TRUST, category: 'system_of_record' };
  for (const { token, app } of SYSTEM_OF_RECORD) {
    if (t.includes(token)) return { app, trust: SOURCE_OF_RECORD_TRUST, category: 'system_of_record' };
  }
  for (const { token, app } of WEB_SOURCE) {
    if (t.includes(token)) return { app, trust: WEB_SOURCE_TRUST, category: 'web_source' };
  }
  return null;
}

/**
 * Extract a recognized connector-CLI binary from a shell command string, or
 * null. Returns ONLY known binaries (the CLI_BINARIES set), so arbitrary
 * shell (`ls`, `git status`, `npm run …`) never produces a spurious tool
 * attribution. Scans tokens so it finds the binary through common prefixes —
 * `cd ~/proj && sf data query`, `npx sf …`, `FOO=bar gh …` all yield the
 * binary. Tokenizing on non-identifier chars means `sf` is never matched
 * inside a word like "transfer" (that's a single token "transfer").
 */
export function cliBinaryFromCommand(command: string | null | undefined): string | null {
  if (!command) return null;
  const tokens = command.toLowerCase().split(/[^a-z0-9_.-]+/).filter(Boolean);
  for (const tok of tokens) {
    if (CLI_BINARIES[tok]) return tok;
  }
  return null;
}
