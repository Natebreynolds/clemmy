/**
 * Plugin manifest — the label on the cartridge.
 *
 * A Clementine plugin is a versioned BUNDLE of existing primitives (skills,
 * workflows, agents, MCP servers, standing rules) plus this manifest. There is
 * deliberately NO new runtime: installed contents materialize onto the same
 * shelves hand-built ones live on and run through the exact same certification
 * and safety gates. The manifest exists for three things:
 *   1. identity + versioning (id, publisher, semver)
 *   2. the CONSENT CONTRACT — what the plugin wants to touch, shown at install
 *   3. the future wall — `entitlement` is reserved now so licensed plugins are
 *      a registry/site concern later, never a format migration.
 *
 * Layout of a plugin source (a directory, or a .clemplug tarball of one):
 *   plugin.json          ← this manifest (required)
 *   skills/<name>/SKILL.md
 *   workflows/<name>/SKILL.md   (scripts/ + references/ ride along)
 *   mcp/servers.json     ← fragment merged into the user's servers.json
 *   memory/*.md          ← structured-frontmatter facts, imported on install
 */

export interface PluginPermissions {
  /** Tool patterns the plugin's content expects (informational for consent;
   *  runtime enforcement rides the existing gate chain). */
  tools?: string[];
  /** How the plugin's workflows may write externally. 'never' hard-disables
   *  send-class steps; 'approval' (default) keeps the normal approval gates. */
  externalWrites?: 'never' | 'approval';
  /** May the plugin register schedules/cron (workflow schedules)? */
  schedules?: boolean;
  /** Config keys it may read/write — MUST be under plugin.<id>.* (enforced). */
  config?: string[];
}

export interface PluginManifest {
  /** Reverse-dot id, e.g. "acme.salesforce-outbound". */
  id: string;
  name: string;
  version: string;
  description?: string;
  publisher?: { name?: string; url?: string; key?: string };
  requires?: { clementine?: string; connections?: string[] };
  permissions?: PluginPermissions;
  /** Reserved for the registry wall. v1 installers accept 'free' only. */
  entitlement?: string;
}

export interface PluginContents {
  skills: string[];      // skill dir names under skills/
  workflows: string[];   // workflow dir names under workflows/
  mcpServers: string[];  // server names in mcp/servers.json
  memoryFiles: string[]; // importable files under memory/, relative to the plugin root
}

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/i;

export interface ManifestIssue { level: 'error' | 'warn'; message: string }

/** Validate a parsed plugin.json. Errors block install; warns show in consent. */
export function validateManifest(raw: unknown): { manifest: PluginManifest | null; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { manifest: null, issues: [{ level: 'error', message: 'plugin.json is not an object' }] };
  }
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id.trim() : '';
  if (!ID_RE.test(id)) issues.push({ level: 'error', message: `invalid plugin id "${id}" (expected reverse-dot, e.g. "acme.sales-pack")` });
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name) issues.push({ level: 'error', message: 'missing plugin name' });
  const version = typeof m.version === 'string' ? m.version.trim() : '';
  if (!VERSION_RE.test(version)) issues.push({ level: 'error', message: `invalid version "${version}" (semver required)` });
  const entitlement = typeof m.entitlement === 'string' ? m.entitlement.trim() : 'free';
  if (entitlement !== 'free') issues.push({ level: 'error', message: `entitlement "${entitlement}" is not supported by this installer (free only for now)` });

  const permsRaw = (m.permissions ?? {}) as Record<string, unknown>;
  const externalWrites = permsRaw.externalWrites === 'never' ? 'never' : 'approval';
  const config = Array.isArray(permsRaw.config) ? permsRaw.config.filter((c): c is string => typeof c === 'string') : [];
  for (const key of config) {
    if (!key.startsWith(`plugin.${id}.`) && key !== `plugin.${id}`) {
      issues.push({ level: 'error', message: `config scope "${key}" is outside the plugin's sandbox (must be under plugin.${id}.*)` });
    }
  }
  const tools = Array.isArray(permsRaw.tools) ? permsRaw.tools.filter((t): t is string => typeof t === 'string').slice(0, 64) : [];
  if (issues.some((i) => i.level === 'error')) return { manifest: null, issues };

  return {
    manifest: {
      id,
      name,
      version,
      description: typeof m.description === 'string' ? m.description : undefined,
      publisher: (m.publisher && typeof m.publisher === 'object') ? m.publisher as PluginManifest['publisher'] : undefined,
      requires: (m.requires && typeof m.requires === 'object') ? m.requires as PluginManifest['requires'] : undefined,
      permissions: { tools, externalWrites, schedules: permsRaw.schedules === true, config },
      entitlement,
    },
    issues,
  };
}

/** The human consent contract shown before anything materializes. */
export function renderConsentSummary(manifest: PluginManifest, contents: PluginContents): string[] {
  const lines: string[] = [];
  const pub = manifest.publisher?.name ? ` by ${manifest.publisher.name}` : '';
  lines.push(`${manifest.name} v${manifest.version}${pub} (${manifest.id})`);
  if (manifest.description) lines.push(manifest.description);
  lines.push('Installs:');
  if (contents.skills.length) lines.push(`  • ${contents.skills.length} skill${contents.skills.length === 1 ? '' : 's'}: ${contents.skills.join(', ')}`);
  if (contents.workflows.length) lines.push(`  • ${contents.workflows.length} workflow${contents.workflows.length === 1 ? '' : 's'}: ${contents.workflows.join(', ')}`);
  if (contents.mcpServers.length) lines.push(`  • ${contents.mcpServers.length} MCP server${contents.mcpServers.length === 1 ? '' : 's'}: ${contents.mcpServers.join(', ')}`);
  if (contents.memoryFiles.length) lines.push(`  • ${contents.memoryFiles.length} memory file${contents.memoryFiles.length === 1 ? '' : 's'}: imported as facts (removed on uninstall; disable leaves them)`);
  if (!contents.skills.length && !contents.workflows.length && !contents.mcpServers.length && !contents.memoryFiles.length) lines.push('  • (nothing — empty plugin)');
  const p = manifest.permissions ?? {};
  lines.push('Asks for:');
  lines.push(`  • external writes: ${p.externalWrites === 'never' ? 'NEVER (send-class steps disabled)' : 'normal approval gates'}`);
  if (p.tools?.length) lines.push(`  • tools: ${p.tools.slice(0, 8).join(', ')}${p.tools.length > 8 ? ` (+${p.tools.length - 8} more)` : ''}`);
  if (p.schedules) lines.push('  • may register schedules (recurring runs)');
  if (p.config?.length) lines.push(`  • config sandbox: ${p.config.join(', ')}`);
  const conns = manifest.requires?.connections ?? [];
  if (conns.length) lines.push(`Needs connections: ${conns.join(', ')}`);
  return lines;
}
