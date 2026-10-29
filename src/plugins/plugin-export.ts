/**
 * Share what Clem built as one cartridge: the owner picks workflows, skills,
 * MCP servers and Spaces, and gets a .clemplug another Clementine installs
 * through the same preview-and-consent door. Selected definitions travel;
 * known Space data files and workflow runs are excluded. MCP environment
 * values are omitted, and launch fields pass the same credential-reference
 * checks as project tool setup. This is not a scrub of arbitrary file text.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { SKILLS_DIR, isSafeSkillName } from '../memory/skill-store.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { loadUserMcpServers } from '../runtime/mcp-config.js';
import { prepareMcpLaunchPrivacy } from '../runtime/mcp-server-setup.js';
import { spaceStore, isValidSpaceSlug, resolveSpaceDir } from '../spaces/store.js';
import { validateManifest, type PluginManifest } from './plugin-manifest.js';

export const PLUGIN_EXPORTS_DIR = path.join(BASE_DIR, 'exports', 'cartridges');

export interface PluginExportRequest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  publisher?: { name?: string; url?: string };
  workflows?: string[];
  skills?: string[];
  mcpServers?: string[];
  workspaces?: string[];
}

export interface PluginExportResult {
  file: string;
  fileName: string;
  bytes: number;
  manifest: PluginManifest;
  contents: { workflows: string[]; skills: string[]; mcpServers: string[]; workspaces: string[] };
  /** What was deliberately left out, in plain words, for the sharing screen. */
  leftOut: string[];
}

/** A Space's dataset, notes, audit and history never leave the owner's machine. */
const WORKSPACE_PRIVATE = new Set(['data.json', 'notes.jsonl', 'audit.jsonl', 'view-history', 'data', '.snapshot', 'workspace.lock']);
/** A workflow's runs are the owner's history, not the definition. */
const WORKFLOW_PRIVATE = new Set(['runs', 'runs-backup', '.runs']);

function copyDirExcept(from: string, to: string, except: ReadonlySet<string>): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (except.has(entry) || entry.startsWith('.')) continue;
    cpSync(path.join(from, entry), path.join(to, entry), { recursive: true });
  }
}

function uniqueStrings(values: unknown): string[] {
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))] : [];
}

/** Build the cartridge as a directory the caller owns (tests read it; export tars it). */
export function stageCartridge(request: PluginExportRequest): { dir: string; manifest: PluginManifest; contents: PluginExportResult['contents']; leftOut: string[] } {
  const { manifest, issues } = validateManifest({
    id: request.id, name: request.name, version: request.version?.trim() || '1.0.0',
    ...(request.description ? { description: request.description } : {}),
    ...(request.publisher ? { publisher: request.publisher } : {}),
  });
  const errors = issues.filter((issue) => issue.level === 'error').map((issue) => issue.message);
  if (!manifest || errors.length > 0) throw new Error(errors.join('; ') || 'invalid manifest');
  // Prepare every MCP definition before allocating or copying the cartridge.
  // A refusal leaves no partially staged copy and never rewrites the owner's
  // saved endpoint, arguments or credential values.
  const servers = loadUserMcpServers();
  const serverNames = uniqueStrings(request.mcpServers);
  const fragment: Record<string, Record<string, unknown>> = {};
  for (const name of serverNames) {
    const server = servers[name];
    if (!server) throw new Error(`MCP server "${name}" is not one of yours`);
    const prepared = prepareMcpLaunchPrivacy(server);
    if (!prepared.ok) throw new Error(`This MCP definition cannot be shared: ${prepared.error}`);
    fragment[name] = {
      ...(server.type ? { type: server.type } : {}),
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(prepared.headers ? { headers: prepared.headers } : {}),
      ...(server.description ? { description: server.description } : {}),
      // Names only: the installer asks the next owner for each value.
      ...(prepared.requiredEnvKeys.length ? { env: Object.fromEntries(prepared.requiredEnvKeys.map((key) => [key, ''])) } : {}),
      enabled: true,
    };
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-cartridge-'));
  const leftOut: string[] = [];
  const contents: PluginExportResult['contents'] = { workflows: [], skills: [], mcpServers: [], workspaces: [] };

  const byName = new Map(listWorkflows().map((entry) => [entry.name, entry]));
  for (const name of uniqueStrings(request.workflows)) {
    const entry = byName.get(name);
    if (!entry) throw new Error(`workflow "${name}" is not one of yours`);
    const target = path.join(dir, 'workflows', name);
    if (entry.layout === 'directory') copyDirExcept(entry.dir, target, WORKFLOW_PRIVATE);
    else { mkdirSync(target, { recursive: true }); cpSync(entry.filePath, path.join(target, 'SKILL.md')); }
    contents.workflows.push(name);
  }
  leftOut.push('workflow run history');

  for (const name of uniqueStrings(request.skills)) {
    if (!isSafeSkillName(name)) throw new Error(`skill "${name}" has an unsafe name`);
    const from = path.join(SKILLS_DIR, name);
    if (!existsSync(path.join(from, 'SKILL.md'))) throw new Error(`skill "${name}" is not installed`);
    copyDirExcept(from, path.join(dir, 'skills', name), new Set());
    contents.skills.push(name);
  }

  contents.mcpServers.push(...serverNames);
  if (contents.mcpServers.length) {
    mkdirSync(path.join(dir, 'mcp'), { recursive: true });
    writeFileSync(path.join(dir, 'mcp', 'servers.json'), JSON.stringify(fragment, null, 2));
    leftOut.push('MCP environment secrets (names kept, values left blank; credential-bearing launch fields refused)');
  }

  for (const slug of uniqueStrings(request.workspaces)) {
    if (!isValidSpaceSlug(slug)) throw new Error(`Space "${slug}" has an unsafe slug`);
    const record = spaceStore.get(slug);
    if (!record) throw new Error(`Space "${slug}" is not one of yours`);
    const from = resolveSpaceDir(slug);
    const target = path.join(dir, 'workspaces', slug);
    copyDirExcept(from, target, WORKSPACE_PRIVATE);
    rmSync(path.join(target, 'space.json'), { force: true });
    writeFileSync(path.join(target, 'workspace.json'), JSON.stringify({
      title: record.title,
      view: record.viewEntry ?? 'view/index.html',
      dataSources: (record.dataSources ?? []).map((source) => ({
        id: source.id,
        ...(source.composioSlug ? { composioSlug: source.composioSlug } : {}),
        ...(source.runner ? { runner: source.runner } : {}),
        ...(source.cliArgv ? { cliArgv: source.cliArgv } : {}),
        ...(source.schedule ? { schedule: source.schedule } : {}),
        ...(source.timezone ? { timezone: source.timezone } : {}),
      })),
    }, null, 2));
    contents.workspaces.push(slug);
  }
  if (contents.workspaces.length) leftOut.push('Space data, notes, audit and view history');

  if (!contents.workflows.length && !contents.skills.length && !contents.mcpServers.length && !contents.workspaces.length) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('pick at least one workflow, skill, MCP server or Space to share');
  }
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifest, contents, leftOut };
}

/** The cartridge file, under the owner's exports folder. */
export function exportPlugin(request: PluginExportRequest): PluginExportResult {
  const staged = stageCartridge(request);
  try {
    mkdirSync(PLUGIN_EXPORTS_DIR, { recursive: true });
    const fileName = `${staged.manifest.id}-${staged.manifest.version}.clemplug`;
    const file = path.join(PLUGIN_EXPORTS_DIR, fileName);
    execFileSync('tar', ['-czf', file, '-C', staged.dir, '.'], { stdio: 'pipe' });
    return { file, fileName, bytes: statSync(file).size, manifest: staged.manifest, contents: staged.contents, leftOut: staged.leftOut };
  } finally {
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

/** A file the export route may hand back: one of ours, by its bare name. */
export function exportedCartridgePath(fileName: string): string | null {
  if (!/^[a-z0-9][a-z0-9.-]*\.clemplug$/.test(fileName)) return null;
  const file = path.join(PLUGIN_EXPORTS_DIR, fileName);
  return existsSync(file) ? file : null;
}

/** For the sharing screen: what the owner can put in a cartridge. */
export function shareableInventory(): { workflows: Array<{ name: string; description: string }>; skills: string[]; mcpServers: string[]; workspaces: Array<{ slug: string; title: string }> } {
  const skills = existsSync(SKILLS_DIR)
    ? readdirSync(SKILLS_DIR).filter((name) => isSafeSkillName(name) && existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))).sort()
    : [];
  return {
    workflows: listWorkflows().filter((entry) => !entry.data.watch && entry.data.origin !== 'dev').map((entry) => ({ name: entry.name, description: typeof entry.data.description === 'string' ? entry.data.description : '' })),
    skills,
    mcpServers: Object.keys(loadUserMcpServers()).sort(),
    workspaces: spaceStore.listForView().map((space) => ({ slug: space.id, title: space.title })),
  };
}

export function readCartridgeFile(fileName: string): Buffer | null {
  const file = exportedCartridgePath(fileName);
  return file ? readFileSync(file) : null;
}
