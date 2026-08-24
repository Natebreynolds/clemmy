/**
 * Connect-time enumeration for LOCAL carriers: MCP servers and CLI programs.
 *
 * The Composio side of this lives at its own provider edge; this module is the
 * equivalent for the two carriers a user provisions on their own machine. Both
 * follow the same rule as everything else in the index: enumerate once when the
 * capability is provisioned, so the first turn afterwards can retrieve it
 * locally instead of rediscovering it live.
 *
 * Effect classification differs sharply by carrier, and the index records WHERE
 * each answer came from rather than flattening them:
 *
 *  - MCP: the server may annotate each tool (`readOnlyHint`/`destructiveHint`).
 *    That is a real declared signal and is recorded as `declared`. Absent an
 *    annotation, ordinary verb evidence from the OPERATION applies — never from
 *    the server name, which is whatever the user called it.
 *  - CLI: a binary has no per-operation effect signal at all until an argv
 *    exists, so a CLI row is honestly `unknown`. It is still worth indexing:
 *    knowing `gh` is installed and what its help says is exactly what a blank
 *    install cannot otherwise answer.
 */
import {
  recordCapabilityOperations,
  deactivateCapabilityCarrier,
  indexedCapabilityCarriers,
  markCapabilityInventory,
  capabilityInventoryState,
  searchCapabilityOperations,
  type CapabilityEffectClass,
  type CapabilityEffectProvenance,
  type CapabilityOperationRow,
} from '../memory/capability-index.js';
import type { CliSubcommand } from './cli-subcommands.js';
import { findSafeCliCommand } from './cli-discovery.js';
import { declaredMcpToolEffect } from './mcp-declared-effects.js';
import { composioSlugEffectEvidence } from '../integrations/composio/slug-effect.js';

const MAX_TOOLS_PER_SERVER = 200;
const MAX_CLIS = 400;

/** The operation segment of a namespaced MCP tool name. */
function operationSegment(namespaced: string): string {
  const withoutCarrier = namespaced.replace(/^mcp__/, '');
  return withoutCarrier.split('__').at(-1) ?? withoutCarrier;
}

function mcpEffect(namespaced: string): {
  effectClass: CapabilityEffectClass;
  effectProvenance: CapabilityEffectProvenance;
} {
  const declared = declaredMcpToolEffect(namespaced);
  if (declared?.destructive === true) return { effectClass: 'write', effectProvenance: 'declared' };
  if (declared?.readOnly === true) return { effectClass: 'read', effectProvenance: 'declared' };
  // Verb evidence from the OPERATION only. A read verb in an arbitrary server
  // name proves nothing (see execution-gate: the same rule guards dispatch).
  const evidence = composioSlugEffectEvidence(operationSegment(namespaced));
  if (evidence === 'read') return { effectClass: 'read', effectProvenance: 'inferred' };
  if (evidence === 'write') return { effectClass: 'write', effectProvenance: 'inferred' };
  return { effectClass: 'unknown', effectProvenance: 'none' };
}

export interface McpServerToolObservation {
  /** Namespaced executable identity, e.g. `mcp__linear__issues` or `linear__issues`. */
  name: string;
  description?: unknown;
  /**
   * The tool's declared input schema, exactly as the server published it. The
   * namespace shim re-emits each tool with `{...tool}`, so this arrives with
   * the name and costs nothing to keep — the same fact the Composio enumerator
   * used to discard (CAT-7).
   */
  inputSchema?: unknown;
}

/**
 * CAT-7 for MCP — the same discard, on a different carrier.
 *
 * An MCP server publishes each tool's input schema in the same `listTools`
 * response that names it, and the namespace shim re-emits the tool with a
 * spread, so the schema is already in hand here. Measured before this landed:
 * 4 MCP operations catalogued, 3 with a known effect, and ZERO with a
 * resolvable schema — a decorative carrier under CAT-8, where the user sees a
 * connected server and the executor sees nothing it can bind.
 *
 * TRAP this walks past deliberately: the shim's `{...tool}` spread means the
 * static type may not carry `inputSchema` even though the value does. Read it
 * off the observation defensively rather than trusting the type.
 */
function depositMcpSchemas(tools: readonly McpServerToolObservation[]): void {
  void (async () => {
    try {
      const { rememberToolSchema } = await import('../tools/composio-schema-cache.js');
      for (const tool of tools) {
        const identifier = String(tool?.name ?? '').trim();
        const schema = (tool as { inputSchema?: unknown })?.inputSchema;
        if (!identifier || schema === undefined) continue;
        try { rememberToolSchema(identifier, schema); } catch { /* per-tool */ }
      }
    } catch { /* a cold contract store leaves the install exactly as it was */ }
  })();
}

/**
 * Index the tools one MCP server exposes. `serverSlug` is the carrier the user
 * provisioned; the tool's namespaced name is its callable identity.
 */
export function indexMcpServerTools(
  serverSlug: string,
  tools: readonly McpServerToolObservation[],
): number {
  const carrier = serverSlug.trim().toLowerCase();
  if (!carrier) return 0;
  depositMcpSchemas(tools);
  const rows: CapabilityOperationRow[] = tools
    .slice(0, MAX_TOOLS_PER_SERVER)
    .map((tool) => String(tool.name ?? '').trim())
    .filter(Boolean)
    .map((name) => {
      const description = typeof (tools.find((tool) => String(tool.name ?? '').trim() === name)?.description) === 'string'
        ? String(tools.find((tool) => String(tool.name ?? '').trim() === name)?.description)
        : '';
      return {
        identifier: name,
        carrierKind: 'mcp' as const,
        carrier,
        displayName: operationSegment(name),
        // Server descriptions are prefixed `[slug] …` by the namespace shim;
        // the prefix is noise once the carrier is a column.
        description: description.replace(/^\[[^\]]+\]\s*/, ''),
        ...mcpEffect(name),
      };
    });
  return recordCapabilityOperations(rows);
}

export interface CliObservation {
  command: string;
  path: string;
  isLikelyCli?: boolean;
  version?: string;
  helpHead?: string;
}

/**
 * Index the CLI programs discovery found. One row per command: a binary's
 * subcommands are not knowable without running it, so the index records the
 * program itself and stays honest about its effect.
 */
export function indexDiscoveredClis(clis: readonly CliObservation[]): number {
  const rows: CapabilityOperationRow[] = clis
    .filter((cli) => cli.isLikelyCli !== false && cli.command.trim())
    .slice(0, MAX_CLIS)
    .map((cli) => ({
      identifier: cli.command.trim(),
      carrierKind: 'cli' as const,
      carrier: cli.command.trim().toLowerCase(),
      displayName: cli.command.trim(),
      description: [cli.version, cli.helpHead].filter(Boolean).join(' — '),
      // A binary carries no per-operation effect evidence until an argv exists.
      effectClass: 'unknown' as const,
      effectProvenance: 'none' as const,
    }));
  const recorded = recordCapabilityOperations(rows);
  // A program that left $PATH is no longer a capability. Reconcile against the
  // full scan so an uninstall is reflected without waiting for a restart.
  const live = new Set(rows.map((row) => row.carrier));
  for (const carrier of indexedCapabilityCarriers('cli')) {
    if (!live.has(carrier)) deactivateCapabilityCarrier('cli', carrier);
  }
  return recorded;
}

/** Bounded per program: a talkative help page cannot flood the index. */
const MAX_SUBCOMMANDS = 60;

/**
 * Record what a program can actually DO.
 *
 * A program is a carrier, not a capability. `indexDiscoveredClis` above records
 * the program itself — one row where `identifier === carrier`, effect unknown,
 * and (because the boot scan never executes anything) an empty description.
 * That row says a binary exists; it cannot say the binary can create a pull
 * request. The subcommands are the capabilities, and until they are rows there
 * is nothing for an ask to match against.
 *
 * Recorded honestly:
 *  - `identifier` is the INVOCATION (`<program> <subcommand>`), because that is
 *    what the local lane actually runs and therefore the only identity worth
 *    binding to.
 *  - `effect` stays `unknown`/`none`. A subcommand's effect is not knowable
 *    from its name or its blurb, and guessing an effect from a verb is exactly
 *    what once proved a delete read-only. The effect gate resolves it at
 *    dispatch, where an argv actually exists.
 *
 * Idempotent: re-running replaces descriptions and leaves `first_seen_at`.
 */
export function indexCliSubcommands(
  command: string,
  subcommands: readonly CliSubcommand[],
): number {
  const program = command.trim();
  if (!program) return 0;
  const carrier = program.toLowerCase();
  const rows: CapabilityOperationRow[] = subcommands
    .slice(0, MAX_SUBCOMMANDS)
    .filter((entry) => entry.name.trim() && entry.description.trim())
    .map((entry) => ({
      identifier: `${program} ${entry.name.trim()}`,
      carrierKind: 'cli' as const,
      carrier,
      displayName: `${program} ${entry.name.trim()}`,
      description: entry.description,
      effectClass: 'unknown' as const,
      effectProvenance: 'none' as const,
      parentIdentifier: program,
      selector: entry.name.trim(),
    }));
  const recorded = recordCapabilityOperations(rows);
  // Record the answer either way. "Asked, and it has none" is durable
  // knowledge — without it a flag-driven program is re-probed forever.
  markCapabilityInventory(program, rows.length > 0 ? 'expanded' : 'none');
  return recorded;
}

/** One program's help text must not hang a turn or fill memory. */
const HELP_TIMEOUT_MS = 4000;
const HELP_MAX_BYTES = 1_000_000;
/** Programs probed per trigger. Small: this is a background repair, not a scan. */
const EXPAND_PER_TRIGGER = 3;

/**
 * Ask ONE program what it can do, and remember the answer.
 *
 * Safety is not re-invented here: `findSafeCliCommand` already refuses the
 * binaries that must never be executed to be inspected — toolchain stubs whose
 * invocation triggers a system installer, GUI launchers, MDM tooling. A
 * refusal is recorded as `'none'` so the refusal itself is durable and the
 * program is not retried on every future miss.
 */
export async function expandCliInventory(command: string): Promise<number> {
  const program = command.trim();
  if (!program) return 0;
  // Never asked is the only state that justifies asking.
  if (capabilityInventoryState(program) !== null) return 0;

  const safe = findSafeCliCommand(program);
  if (!safe || safe.skipped) {
    markCapabilityInventory(program, 'none');
    return 0;
  }
  let help = '';
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const result = await promisify(execFile)(safe.path, ['--help'], {
      timeout: HELP_TIMEOUT_MS,
      maxBuffer: HELP_MAX_BYTES,
    });
    help = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    // Many programs print help to stderr and exit non-zero. That is still the
    // answer, so the output is used rather than the exit status.
    const failure = error as { stdout?: string; stderr?: string };
    help = `${failure?.stdout ?? ''}\n${failure?.stderr ?? ''}`;
  }
  const { parseCliSubcommands } = await import('./cli-subcommands.js');
  return indexCliSubcommands(program, parseCliSubcommands(help));
}

/**
 * Expand the programs an objective actually reaches, once per install.
 *
 * DETACHED ON PURPOSE. This fires where a bind has already failed, and the
 * turn that failed is not helped by waiting: probing costs seconds and the
 * answer arrives too late for it either way. What it buys is that the NEXT ask
 * finds the capability — permanently, because the result is durable. Making a
 * failing turn slower to fix a future one would be the wrong trade.
 *
 * Only programs already relevant to the objective are probed, so an install
 * with hundreds of binaries never pays for the ones nobody asks about.
 */
export function scheduleCliInventoryExpansion(objective: string): void {
  const text = objective.trim();
  if (!text) return;
  // Choose the work SYNCHRONOUSLY and return without scheduling anything when
  // there is none. Detaching first and discovering emptiness inside the task
  // spends a promise and an extra store open on every miss — and on an install
  // (or a test home) with no local programs indexed, every call is a miss.
  let programs: string[] = [];
  try {
    const seen = new Set<string>();
    for (const hit of searchCapabilityOperations(text, { limit: 12, carrierKind: 'cli' })) {
      // A row that already carries a selector IS an expansion — the program
      // behind it is the thing to ask about, not the subcommand.
      const program = hit.parentIdentifier ?? hit.identifier;
      if (seen.has(program)) continue;
      seen.add(program);
      if (capabilityInventoryState(program) !== null) continue;
      programs.push(program);
      if (programs.length >= EXPAND_PER_TRIGGER) break;
    }
  } catch {
    return;
  }
  if (programs.length === 0) return;
  void (async () => {
    try {
      for (const program of programs) await expandCliInventory(program);
    } catch { /* discovery repair is best-effort and never a turn's problem */ }
  })();
}

/** Fire-and-forget wrapper for provisioning hot paths. Never awaited. */
export function scheduleLocalCapabilityIndex(work: () => Promise<unknown>): void {
  void (async () => {
    try { await work(); } catch { /* connect-time indexing is best-effort */ }
  })();
}
