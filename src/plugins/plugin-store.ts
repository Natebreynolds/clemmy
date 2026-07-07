/**
 * Plugin store — the cartridge SLOT.
 *
 * install(source)   dir or .clemplug/.tgz → validate → consent summary →
 *                   materialize onto the EXISTING shelves (skill store,
 *                   workflow store, mcp servers.json) with provenance
 * ledger            ~/.clementine-next/plugins/installed.json — every artifact
 *                   a plugin owns, by kind+name, so uninstall removes exactly
 *                   what the cartridge brought and nothing else
 * disable/enable    Game-Boy eject without deleting the save: workflows flip
 *                   their enabled flag, MCP servers flip enabled, skills stash
 *                   to plugins/<id>/stash and restore on enable
 * uninstall         remove owned artifacts + the ledger entry
 *
 * Fail-safe bias: validation errors BLOCK install; a partial install rolls
 * back what it materialized. No new runtime paths — plugin workflows/skills
 * run through the same certification + gates as hand-built ones.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { installSkillFromDir, uninstallSkill, isSafeSkillName, SKILLS_DIR } from '../memory/skill-store.js';
import { readWorkflowDefinitionFile, readWorkflow, writeWorkflow, deleteWorkflow } from '../memory/workflow-store.js';
import { WORKFLOWS_DIR } from '../memory/vault.js';
import { loadUserMcpServers, saveUserMcpServers } from '../runtime/mcp-config.js';
import { validateManifest, renderConsentSummary, type PluginContents, type PluginManifest } from './plugin-manifest.js';

export interface PluginArtifact { kind: 'skill' | 'workflow' | 'mcp-server'; name: string }
export interface InstalledPlugin {
  manifest: PluginManifest;
  installedAt: string;
  enabled: boolean;
  artifacts: PluginArtifact[];
}
interface Ledger { plugins: Record<string, InstalledPlugin> }

// Cartridge state lives under plugins/.state — the legacy CODE-plugin loader
// (plugins/loader.ts, JS tool modules) scans plugins/* directories and skips
// dot-dirs, so content-cartridge bookkeeping never collides with it.
const PLUGINS_DIR = path.join(BASE_DIR, 'plugins');
const STATE_DIR = path.join(PLUGINS_DIR, '.state');
const LEDGER_FILE = path.join(STATE_DIR, 'installed.json');

function readLedger(): Ledger {
  try {
    if (existsSync(LEDGER_FILE)) return JSON.parse(readFileSync(LEDGER_FILE, 'utf-8')) as Ledger;
  } catch { /* corrupt ledger → treat as empty; installs re-create it */ }
  return { plugins: {} };
}
function writeLedger(ledger: Ledger): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2), 'utf-8');
}

/** Resolve a plugin source (directory, or .clemplug/.tgz/.tar.gz via system tar)
 *  to a readable directory. Tarballs extract to a temp dir the caller owns. */
export function resolvePluginSource(source: string): { dir: string; cleanup: () => void } {
  const src = path.resolve(source);
  if (!existsSync(src)) throw new Error(`Plugin source not found: ${src}`);
  if (readdirSafe(src) !== null) return { dir: src, cleanup: () => { /* caller's dir — leave it */ } };
  if (!/\.(clemplug|tgz|tar\.gz)$/i.test(src)) throw new Error('Plugin source must be a directory or a .clemplug/.tgz archive');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'clemplug-'));
  execFileSync('tar', ['-xzf', src, '-C', tmp], { stdio: 'pipe' });
  // Accept both layouts: manifest at the archive root, or under a single top dir.
  const rootManifest = path.join(tmp, 'plugin.json');
  if (existsSync(rootManifest)) return { dir: tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  const entries = readdirSync(tmp).filter((e) => !e.startsWith('.'));
  if (entries.length === 1 && existsSync(path.join(tmp, entries[0], 'plugin.json'))) {
    return { dir: path.join(tmp, entries[0]), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
  }
  rmSync(tmp, { recursive: true, force: true });
  throw new Error('Archive does not contain a plugin.json at its root');
}

function readdirSafe(p: string): string[] | null {
  try { return readdirSync(p); } catch { return null; }
}

/** Discover what the cartridge contains (drives consent + materialization). */
export function discoverContents(dir: string): PluginContents {
  const skills = (readdirSafe(path.join(dir, 'skills')) ?? [])
    .filter((n) => !n.startsWith('.') && existsSync(path.join(dir, 'skills', n, 'SKILL.md')));
  // Workflows follow the store's Agent-Skills layout: workflows/<name>/SKILL.md
  // (scripts/ + references/ ride along and are preserved verbatim).
  const workflows = (readdirSafe(path.join(dir, 'workflows')) ?? [])
    .filter((n) => !n.startsWith('.') && existsSync(path.join(dir, 'workflows', n, 'SKILL.md')));
  let mcpServers: string[] = [];
  const mcpFile = path.join(dir, 'mcp', 'servers.json');
  if (existsSync(mcpFile)) {
    try { mcpServers = Object.keys(JSON.parse(readFileSync(mcpFile, 'utf-8')) as Record<string, unknown>); } catch { /* invalid fragment surfaces at install */ }
  }
  return { skills, workflows, mcpServers };
}

export interface PluginPreview {
  manifest: PluginManifest;
  contents: PluginContents;
  consent: string[];
  warnings: string[];
}

/** Validate a source and produce the consent contract WITHOUT installing. */
export function previewPlugin(dir: string): PluginPreview {
  const manifestPath = path.join(dir, 'plugin.json');
  if (!existsSync(manifestPath)) throw new Error(`No plugin.json in ${dir}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(manifestPath, 'utf-8')); } catch (err) {
    throw new Error(`plugin.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { manifest, issues } = validateManifest(raw);
  const errors = issues.filter((i) => i.level === 'error');
  if (!manifest || errors.length) throw new Error(`Invalid manifest: ${errors.map((e) => e.message).join('; ')}`);
  const contents = discoverContents(dir);
  const warnings = issues.filter((i) => i.level === 'warn').map((i) => i.message);
  // Content-level validation BEFORE consent: a workflow that doesn't parse, or
  // a skill with an unsafe name, blocks the cartridge at the slot.
  for (const w of contents.workflows) {
    const def = readWorkflowDefinitionFile(path.join(dir, 'workflows', w, 'SKILL.md'));
    if (!def || !Array.isArray(def.steps) || def.steps.length === 0) {
      throw new Error(`workflow "${w}" failed to parse (SKILL.md frontmatter + step body required)`);
    }
  }
  for (const s of contents.skills) {
    if (!isSafeSkillName(s)) throw new Error(`skill "${s}" has an unsafe name`);
  }
  return { manifest, contents, consent: renderConsentSummary(manifest, contents), warnings };
}

/** Materialize the cartridge. Call AFTER the user consented to previewPlugin().
 *  Partial failures roll back everything this install materialized. */
export function installPlugin(dir: string): InstalledPlugin {
  const { manifest, contents } = previewPlugin(dir);
  const ledger = readLedger();
  if (ledger.plugins[manifest.id]) throw new Error(`Plugin ${manifest.id} is already installed (uninstall it first, or bump the version and reinstall)`);

  const done: PluginArtifact[] = [];
  const rollback = (): void => {
    for (const a of done.reverse()) {
      try {
        if (a.kind === 'skill') uninstallSkill(a.name);
        else if (a.kind === 'workflow') deleteWorkflow(a.name);
        else if (a.kind === 'mcp-server') {
          const servers = loadUserMcpServers();
          delete servers[a.name];
          saveUserMcpServers(servers);
        }
      } catch { /* best-effort rollback */ }
    }
  };

  try {
    for (const s of contents.skills) {
      // Name collision with a NON-plugin skill blocks rather than clobbers.
      if (existsSync(path.join(SKILLS_DIR, s))) throw new Error(`skill "${s}" already exists — refusing to overwrite`);
      installSkillFromDir(path.join(dir, 'skills', s), s, { repo: `plugin:${manifest.id}`, installedAt: new Date().toISOString() });
      done.push({ kind: 'skill', name: s });
    }
    for (const w of contents.workflows) {
      const target = path.join(WORKFLOWS_DIR, w);
      if (readWorkflow(w) || existsSync(target)) throw new Error(`workflow "${w}" already exists — refusing to overwrite`);
      // Copy the WHOLE dir (SKILL.md + scripts/ + references/) — the store's own
      // layout, so the imported workflow is indistinguishable from a hand-built
      // one and runs through the same certification + gates.
      cpSync(path.join(dir, 'workflows', w), target, { recursive: true });
      if (!readWorkflow(w)) { rmSync(target, { recursive: true, force: true }); throw new Error(`workflow "${w}" did not load after copy`); }
      done.push({ kind: 'workflow', name: w });
    }
    if (contents.mcpServers.length) {
      const fragment = JSON.parse(readFileSync(path.join(dir, 'mcp', 'servers.json'), 'utf-8')) as Record<string, Record<string, unknown>>;
      const servers = loadUserMcpServers();
      for (const name of contents.mcpServers) {
        if (servers[name]) throw new Error(`MCP server "${name}" already exists — refusing to overwrite`);
        servers[name] = { ...fragment[name], pluginId: manifest.id } as never;
        done.push({ kind: 'mcp-server', name });
      }
      saveUserMcpServers(servers);
    }
  } catch (err) {
    rollback();
    throw err;
  }

  const installed: InstalledPlugin = {
    manifest,
    installedAt: new Date().toISOString(),
    enabled: true,
    artifacts: done,
  };
  ledger.plugins[manifest.id] = installed;
  writeLedger(ledger);
  return installed;
}

export function listPlugins(): InstalledPlugin[] {
  return Object.values(readLedger().plugins);
}

export function getPlugin(id: string): InstalledPlugin | null {
  return readLedger().plugins[id] ?? null;
}

/** Disable = eject without deleting: workflows+servers flip enabled, skills stash. */
export function setPluginEnabled(id: string, enabled: boolean): InstalledPlugin {
  const ledger = readLedger();
  const plugin = ledger.plugins[id];
  if (!plugin) throw new Error(`Plugin not installed: ${id}`);
  if (plugin.enabled === enabled) return plugin;
  const stash = path.join(STATE_DIR, id.replace(/[^a-z0-9.-]/gi, '_'), 'stash', 'skills');
  for (const a of plugin.artifacts) {
    try {
      if (a.kind === 'workflow') {
        const entry = readWorkflow(a.name);
        if (entry) writeWorkflow(a.name, { ...entry.data, enabled } as never);
      } else if (a.kind === 'mcp-server') {
        const servers = loadUserMcpServers();
        if (servers[a.name]) { servers[a.name] = { ...servers[a.name], enabled }; saveUserMcpServers(servers); }
      } else if (a.kind === 'skill') {
        const live = path.join(SKILLS_DIR, a.name);
        const parked = path.join(stash, a.name);
        if (!enabled && existsSync(live)) { mkdirSync(stash, { recursive: true }); renameSync(live, parked); }
        if (enabled && existsSync(parked)) { mkdirSync(SKILLS_DIR, { recursive: true }); renameSync(parked, live); }
      }
    } catch { /* one stuck artifact must not wedge the rest; state converges on retry */ }
  }
  plugin.enabled = enabled;
  writeLedger(ledger);
  return plugin;
}

/** Remove exactly what the cartridge brought (ledger-owned artifacts only). */
export function uninstallPlugin(id: string): { removed: PluginArtifact[] } {
  const ledger = readLedger();
  const plugin = ledger.plugins[id];
  if (!plugin) throw new Error(`Plugin not installed: ${id}`);
  if (!plugin.enabled) setPluginEnabled(id, true); // restore stashed skills so removal sees them
  const removed: PluginArtifact[] = [];
  for (const a of plugin.artifacts) {
    try {
      if (a.kind === 'skill' && uninstallSkill(a.name)) removed.push(a);
      else if (a.kind === 'workflow' && deleteWorkflow(a.name)) removed.push(a);
      else if (a.kind === 'mcp-server') {
        const servers = loadUserMcpServers();
        if (servers[a.name]) { delete servers[a.name]; saveUserMcpServers(servers); removed.push(a); }
      }
    } catch { /* keep going — report what actually came out */ }
  }
  const fresh = readLedger();
  delete fresh.plugins[id];
  writeLedger(fresh);
  try { rmSync(path.join(STATE_DIR, id.replace(/[^a-z0-9.-]/gi, '_')), { recursive: true, force: true }); } catch { /* stash dir cleanup is best-effort */ }
  return { removed };
}
