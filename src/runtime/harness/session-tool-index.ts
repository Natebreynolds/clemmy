/**
 * SESSION TOOL INDEX — the always-present, schema-free catalog.
 *
 * Live 2026-08-19 sess-synthetic-008: "update the platform 49 workflow to run
 * every 4 hours" burned 40 steps in denied tool_search retries while
 * `workflow_schedule` — her own tool, one call, exactly the ask — sat
 * unreachable: the hot-set didn't carry it, the search ranked third-party
 * schedulers above it, and the discovery budget allowed ONE search.
 *
 * The research consensus (Anthropic deferred-tools: 85% token cut AND +25pt
 * selection accuracy; Hermes PTC; DeepSeek index-not-schemas) is one design:
 * NAMES always in context, SCHEMAS on demand. This module renders that index:
 * every tool the brain lane may call, one line each, deterministic order,
 * no schemas — a few KB that replaces the discovery hunt entirely.
 */
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { peekConnectedToolkits } from '../../integrations/composio/client.js';
import { capabilityIndexStats, listCapabilityCarrierSummaries } from '../../memory/capability-index.js';

const MAX_DESCRIPTION_CHARS = 110;

function indexLine(name: string, description: string): string {
  const clean = description.replace(/\s+/g, ' ').trim();
  const clipped = clean.length > MAX_DESCRIPTION_CHARS
    ? `${clean.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
    : clean;
  return `- ${name} — ${clipped}`;
}

/**
 * Deterministic, session-stable index text. Sorted by name so consecutive
 * renders are byte-identical while the connected registry is unchanged
 * (KV-cache-first: the prefix must not churn).
 */
export function renderSessionToolIndex(): string {
  const local = TOOL_REGISTRY
    .filter((tool) => tool.lanes.includes('sdk-brain'))
    .map((tool) => indexLine(tool.name, tool.description ?? ''))
    .sort((a, b) => a.localeCompare(b));
  const toolkits = [...new Set(
    peekConnectedToolkits()
      .filter((toolkit) => (toolkit.status ?? '').toUpperCase() !== 'FAILED')
      .map((toolkit) => toolkit.slug.trim().toLowerCase())
      .filter(Boolean),
  )].sort();
  const sections = [
    'TOOL INDEX (names only — schemas load on demand when you call; nothing here needs pre-loading):',
    ...local,
    '',
    'A "No such tool available" error means the tool exists but is DEFERRED this turn — invoke it through `call_tool` (controls and reads) or `work_call` (business writes under an action contract) instead of retrying it directly.',
  ];
  const provisioned = renderProvisionedCapabilities();
  if (provisioned) {
    sections.push('', provisioned);
  } else if (toolkits.length > 0) {
    // Fallback for an install whose index has not been built yet (first boot
    // after upgrade, or a deleted index): the live connection cache still
    // names the apps, just not what they can do.
    sections.push(
      '',
      `Connected apps (call their operations by slug via call_tool; find exact operation names with tool_search): ${toolkits.join(', ')}`,
    );
  }
  return sections.join('\n');
}

/** How many carriers of one kind to name before collapsing into a count. */
const MAX_NAMED_CARRIERS = 10;

function carrierLine(
  label: string,
  entries: Array<{ carrier: string; operations: number }>,
  options: { withCounts?: boolean } = {},
): string | null {
  if (entries.length === 0) return null;
  const named = entries.slice(0, MAX_NAMED_CARRIERS);
  const rendered = named
    .map((entry) => (options.withCounts === false
      ? entry.carrier
      : `${entry.carrier} (${entry.operations})`))
    .join(', ');
  const remainder = entries.length - named.length;
  const tail = remainder > 0 ? `, +${remainder} more` : '';
  return `- ${label}: ${rendered}${tail}`;
}

/**
 * What this install can actually reach, from the connect-time capability index.
 *
 * This is the blank-install answer to "what tools do I have": the index is
 * built when a capability is PROVISIONED, so it is populated on turn one — no
 * prior use, no receipt, no live provider round-trip. Names and counts only:
 * operations are found by name through tool_search (which now reads the same
 * index) and schemas still load on demand. Deterministic ordering keeps the
 * prompt prefix byte-stable between turns; the text changes only when the user
 * genuinely gains or loses a capability.
 */
function renderProvisionedCapabilities(): string | null {
  // Totals come from the index itself; the naming cap below must never be
  // mistaken for the size of the world.
  const stats = capabilityIndexStats();
  if (stats.operations === 0) return null;
  const summaries = listCapabilityCarrierSummaries();
  const apps = summaries.filter((entry) => entry.carrierKind === 'composio');
  const servers = summaries.filter((entry) => entry.carrierKind === 'mcp');
  const cliCount = stats.byCarrierKind.cli ?? 0;
  const lines = [
    carrierLine('connected apps', apps),
    carrierLine('MCP servers', servers),
    // Deliberately NOT named: a PATH scan is mostly system binaries (`[`, `aa`,
    // `accton`), so naming the alphabetically-first ten spends prompt bytes on
    // noise and implies those are the interesting ones. The count plus search
    // is the honest signal; `gh`, `sf` and friends surface through tool_search
    // on the query that actually needs them.
    cliCount > 0
      ? `- local CLIs: ${cliCount} programs on PATH (find one by name with tool_search; run it with run_shell_command)`
      : null,
  ].filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return [
    `CONNECTED CAPABILITIES — ${stats.operations} operations across ${stats.carriers} carriers are reachable right now.`,
    ...lines,
    'Find the exact operation with tool_search (it reads this same index — no provider round-trip), then call it: apps and MCP operations through work_call/call_tool.',
  ].join('\n');
}
