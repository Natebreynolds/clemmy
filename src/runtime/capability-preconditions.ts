import { discoverMcpServers } from './mcp-config.js';
import { slugifyServerName } from './mcp-namespace-shim.js';
import { findSafeCliCommand } from './cli-discovery.js';

/**
 * Generic, FAIL-OPEN check of a capability's declared preconditions against live
 * config — keyed on counts + existing readers, never on hardcoded app names. A
 * skill (or any caller) can declare what it needs via a `requires` list of
 * "kind:value" strings:
 *
 *   mcp:<slug>              — a connected/configured MCP server
 *   cli:<command>          — an executable on PATH (PATH-augmented; see spawn-env)
 *   secret:<KEY> / env:<KEY> — an env-resolved secret/variable
 *
 * Unknown kinds are ignored. Any individual check that throws is treated as MET,
 * so we NEVER fabricate a NOT-READY warning on uncertainty. An empty/absent
 * `requires` returns ready:true — so capabilities that don't declare anything
 * behave exactly as before.
 */
export interface PreconditionCheck {
  ready: boolean;
  /** Human-readable descriptions of the unmet preconditions. */
  unmet: string[];
}

export function checkSkillPreconditions(requires: unknown): PreconditionCheck {
  const items = Array.isArray(requires)
    ? requires.filter((r): r is string => typeof r === 'string' && r.includes(':'))
    : [];
  if (items.length === 0) return { ready: true, unmet: [] };

  const unmet: string[] = [];
  let configuredMcpSlugs: Set<string> | null = null;

  for (const raw of items) {
    const idx = raw.indexOf(':');
    const kind = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (!value) continue;
    try {
      if (kind === 'mcp') {
        if (!configuredMcpSlugs) {
          configuredMcpSlugs = new Set(discoverMcpServers().map((s) => slugifyServerName(s.name)));
        }
        if (!configuredMcpSlugs.has(slugifyServerName(value))) {
          unmet.push(`an MCP server "${value}" (none connected)`);
        }
      } else if (kind === 'cli') {
        if (!findSafeCliCommand(value)) {
          unmet.push(`the CLI "${value}" (not found on PATH)`);
        }
      } else if (kind === 'secret' || kind === 'env') {
        const present = typeof process.env[value] === 'string' && process.env[value]!.trim().length > 0;
        if (!present) unmet.push(`the secret/env var ${value} (not set)`);
      }
      // Unknown kinds are intentionally ignored — forward-compatible.
    } catch {
      // Fail-open: a reader hiccup must never fabricate a NOT-READY warning.
    }
  }

  return { ready: unmet.length === 0, unmet };
}
