/**
 * Clem's own tools folder. Nothing Clem installs for the owner depends on a
 * package manager being on the machine: npm packages install with Clem's
 * bundled runtime into this folder, and vendor binaries download straight
 * from their releases into it, verified against the vendor's checksums when
 * the vendor publishes them. The folder's bin goes first on every child's
 * PATH, so a tool Clem installed is the one Clem runs.
 *
 * Layout under <home>/tools: bin/ (links), downloads/<id>/, <id>/<version>/.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export function clementineHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next');
}
export function clemToolsDir(env: NodeJS.ProcessEnv = process.env): string { return path.join(clementineHomeDir(env), 'tools'); }
export function clemToolsBin(env: NodeJS.ProcessEnv = process.env): string { return path.join(clemToolsDir(env), 'bin'); }

/** Clem's own runtime, as a child: the packaged app's binary run as plain Node. */
export function ownNodeCommand(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** npm's command line, bundled with the daemon; null when this tree does not carry it. */
export function bundledNpmCli(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
  } catch { return null; }
}

/** The npm global install of one package into Clem's folder, on Clem's runtime. */
export function npmInstallPlan(input: { spec: string; npmCli: string | null; toolsDir: string; cacheDir: string; node?: { command: string; env: Record<string, string> } }): { command: string; args: string[]; env: Record<string, string> } {
  const node = input.node ?? ownNodeCommand();
  const args = ['install', '-g', '--prefix', input.toolsDir, '--no-fund', '--no-audit', '--loglevel', 'error', input.spec];
  if (input.npmCli) return { command: node.command, args: [input.npmCli, ...args], env: { ...node.env, npm_config_cache: input.cacheDir, npm_config_prefix: input.toolsDir } };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, env: { npm_config_cache: input.cacheDir, npm_config_prefix: input.toolsDir } };
}

export type ToolPlatformKey = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64' | 'win32-arm64';

export function toolPlatformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): ToolPlatformKey | null {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return null;
  if (arch !== 'arm64' && arch !== 'x64') return null;
  return `${platform}-${arch}`;
}

export interface ToolDownloadRecipe {
  /** owner/name: the latest release is read from GitHub; omitted for fixed URLs. */
  githubRepo?: string;
  /** Per platform: the release asset name (GitHub) or a full URL. {version} is the tag without a leading v; {tag} the tag itself. */
  assets: Partial<Record<ToolPlatformKey, string>>;
  /** Asset name of the vendor's checksum file ("<sha256>  <asset>" lines), when published; one name, or one per platform. */
  checksums?: string | Partial<Record<ToolPlatformKey, string>>;
  /** The executable inside the archive, matched by path suffix ('bin/gh', 'stripe'); 'binary' when the download is the executable itself. */
  bin: string;
  /** Archive kind; read from the asset name when omitted. */
  archive?: 'tar' | 'zip' | 'binary';
  /** Names linked into Clem's bin; the executable's own name when omitted. */
  links?: string[];
  /** The version a fixed-URL recipe pins, for the folder it unpacks into. */
  version?: string;
}

export interface ResolvedToolDownload { url: string; assetName: string; checksumsUrl: string | null; version: string; archive: 'tar' | 'zip' | 'binary' }

function fill(template: string, version: string, tag: string): string {
  return template.replaceAll('{version}', version).replaceAll('{tag}', tag);
}

/** The one download for this machine, pure over the recipe and the release tag. */
export function resolveToolDownload(recipe: ToolDownloadRecipe, input: { platform?: NodeJS.Platform; arch?: string; tag?: string }): ResolvedToolDownload | null {
  const key = toolPlatformKey(input.platform, input.arch);
  const asset = key ? recipe.assets[key] : undefined;
  if (!asset) return null;
  const tag = input.tag ?? '';
  const version = tag.replace(/^v/, '') || recipe.version || '';
  const name = fill(asset, version, tag);
  const base = recipe.githubRepo ? `https://github.com/${recipe.githubRepo}/releases/download/${tag}/` : '';
  const url = /^https?:\/\//.test(name) ? name : `${base}${name}`;
  const assetName = url.slice(url.lastIndexOf('/') + 1);
  const checksumsName = typeof recipe.checksums === 'string' ? recipe.checksums : recipe.checksums?.[key!];
  const checksumsUrl = checksumsName ? (/^https?:\/\//.test(checksumsName) ? fill(checksumsName, version, tag) : `${base}${fill(checksumsName, version, tag)}`) : null;
  const archive = recipe.archive ?? (/\.zip$/i.test(assetName) ? 'zip' : /\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tar)$/i.test(assetName) ? 'tar' : 'binary');
  return { url, assetName, checksumsUrl, version: version || 'latest', archive };
}

/** "<sha256>  <file>" lines → file → digest; a bare "<sha256>" line is kept under ''. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^([0-9a-f]{64})\s+\*?(.*)$/i.exec(line);
    if (!match) continue;
    out.set(match[2].trim().replace(/^\.\//, '').split('/').pop() ?? '', match[1].toLowerCase());
  }
  return out;
}

export async function latestGitHubTag(repo: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'clementine-tools' } });
  if (!response.ok) throw new Error(`could not read the latest release of ${repo} (${response.status})`);
  const body = await response.json() as { tag_name?: string };
  if (!body.tag_name) throw new Error(`the latest release of ${repo} has no tag`);
  return body.tag_name;
}

function findBySuffix(root: string, suffix: string): string | null {
  const wanted = suffix.split('/').filter(Boolean);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      const parts = full.split(path.sep);
      if (wanted.every((part, i) => parts[parts.length - wanted.length + i] === part)) return full;
    }
  }
  return null;
}

/** Link <toolsBin>/<name> to the executable, replacing an older link. On
 *  Windows, where a link needs a privilege a user may not hold, the
 *  executable is copied under the name instead. */
export function linkTool(toolsBin: string, name: string, target: string, platform: NodeJS.Platform = process.platform): string {
  mkdirSync(toolsBin, { recursive: true });
  const link = path.join(toolsBin, platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name);
  try { if (lstatSync(link)) unlinkSync(link); } catch { /* absent */ }
  if (platform === 'win32') copyFileSync(target, link); else symlinkSync(target, link);
  return link;
}

/**
 * Download, verify, unpack and link one tool into Clem's folder. Every step
 * is narrated through `log`; the vendor's checksum is required whenever the
 * recipe names one.
 */
export async function installToolDownload(input: {
  id: string;
  recipe: ToolDownloadRecipe;
  log: (line: string) => void;
  toolsDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ executable: string; links: string[]; version: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const toolsDir = input.toolsDir ?? clemToolsDir();
  const tag = input.recipe.githubRepo ? await latestGitHubTag(input.recipe.githubRepo, fetchImpl) : '';
  const resolved = resolveToolDownload(input.recipe, { platform: input.platform, arch: input.arch, tag });
  if (!resolved) throw new Error('no download is published for this computer');
  input.log(`Downloading ${resolved.assetName}${resolved.version !== 'latest' ? ` (${resolved.version})` : ''}…`);
  const downloads = path.join(toolsDir, 'downloads', input.id);
  mkdirSync(downloads, { recursive: true });
  const file = path.join(downloads, resolved.assetName);
  const response = await fetchImpl(resolved.url, { headers: { 'user-agent': 'clementine-tools' }, redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(file));
  if (resolved.checksumsUrl) {
    const sums = await fetchImpl(resolved.checksumsUrl, { headers: { 'user-agent': 'clementine-tools' }, redirect: 'follow' });
    if (!sums.ok) throw new Error(`the vendor's checksum file could not be read (${sums.status})`);
    const expected = parseChecksums(await sums.text()).get(resolved.assetName);
    if (!expected) throw new Error(`the vendor's checksum file has no entry for ${resolved.assetName}`);
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== expected) { rmSync(file, { force: true }); throw new Error('the download did not match the vendor\'s checksum and was discarded'); }
    input.log('Verified against the vendor\'s checksum.');
  }
  const dest = path.join(toolsDir, input.id, resolved.version);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  if (resolved.archive === 'binary') {
    const target = path.join(dest, path.basename(input.recipe.bin));
    await pipeline(Readable.from(readFileSync(file)), createWriteStream(target));
  } else {
    input.log('Unpacking…');
    try {
      await execFileAsync('tar', ['-xf', file, '-C', dest], { maxBuffer: 4_000_000 });
    } catch (error) {
      if (resolved.archive !== 'zip') throw error;
      await execFileAsync('unzip', ['-q', '-o', file, '-d', dest], { maxBuffer: 4_000_000 });
    }
  }
  const executable = findBySuffix(dest, input.recipe.bin);
  if (!executable) throw new Error(`the download did not contain ${input.recipe.bin}`);
  chmodSync(executable, 0o755);
  const names = input.recipe.links?.length ? input.recipe.links : [path.basename(input.recipe.bin)];
  const links = names.map((name) => linkTool(path.join(toolsDir, 'bin'), name, executable));
  rmSync(file, { force: true });
  input.log(`Installed ${names.join(', ')} into Clem's tools.`);
  return { executable, links, version: resolved.version };
}

/** True when a tool Clem installed is at this link. */
export function toolInstalled(name: string, toolsBin: string = clemToolsBin()): boolean {
  try { return statSync(path.join(toolsBin, name)).isFile(); } catch { return false; }
}

export { existsSync as toolPathExists };
