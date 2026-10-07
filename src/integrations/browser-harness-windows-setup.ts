/** Windows-only setup. No shell recipe, symlink privilege, upstream repair, or browser attach. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findBrowserHarnessPython } from './browser-python.js';
import { isAbsoluteWindowsPath, windowsChromeCandidates, windowsEnvValue } from './windows-browser-paths.js';
import { stopWindowsProcessTree, type ProcessTreeStopResult } from '../runtime/windows-process-tree.js';

export const WINDOWS_BROWSER_HARNESS_SOURCE = Object.freeze({
  repository: 'https://github.com/browser-use/browser-harness',
  revision: 'c24e5072ee66f8499bacd663f4f4bcb089bc4492',
  tag: 'v0.1.13', version: '0.1.13', python: '3.12',
});
const OUTPUT_LIMIT = 24_000;
export interface WindowsSetupResult {
  ok: boolean; command: string; code: number | null; stdout: string; stderr: string; output: string;
}
export interface WindowsSetupCommand {
  executable: string; args: string[]; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv;
}
export type WindowsSetupRunner = (command: WindowsSetupCommand, onOutput?: (value: string) => void) => Promise<WindowsSetupResult>;
let setupCleanupUnconfirmed = false;

export function windowsBrowserHarnessEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const existing = windowsEnvValue(env, 'PATH') ?? '';
  const toolBin = windowsEnvValue(env, 'UV_TOOL_BIN_DIR');
  const additions = [toolBin && isAbsoluteWindowsPath(toolBin) ? toolBin : '',
    path.win32.join(home, '.local', 'bin'), path.win32.join(home, '.cargo', 'bin')];
  const result = { ...env };
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key];
  result.PATH = [...additions.filter(Boolean), existing].filter(Boolean).join(';');
  return result;
}

/** Metadata discovery cannot execute .cmd/.bat install wrappers or working-directory files. */
export function findWindowsSetupExecutable(name: 'git' | 'uv' | 'browser-harness' | 'python', env: NodeJS.ProcessEnv, home: string,
  isFile: (file: string) => boolean = file => { try { return statSync(file).isFile(); } catch { return false; } }): string | undefined {
  const directories = (windowsBrowserHarnessEnv(env, home).PATH ?? '').split(';').map(value => value.replace(/^"(.*)"$/, '$1'));
  if (name === 'git') for (const root of [windowsEnvValue(env, 'ProgramW6432'), windowsEnvValue(env, 'ProgramFiles'), 'C:\\Program Files']) {
    if (root && isAbsoluteWindowsPath(root)) directories.push(path.win32.join(root, 'Git', 'cmd'), path.win32.join(root, 'Git', 'bin'));
  }
  for (const directory of directories) {
    if (!isAbsoluteWindowsPath(directory)) continue;
    const file = path.win32.join(directory, `${name}.exe`);
    if (isFile(file)) return file;
  }
  return undefined;
}

function result(command: string, code: number | null, stdout = '', stderr = ''): WindowsSetupResult {
  return { ok: code === 0, command, code, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n') };
}

/** Each process is bounded. A timed-out install is failure even when Windows confirms its tree stopped. */
export const runWindowsSetupCommand: WindowsSetupRunner = (input, onOutput) => new Promise(resolve => {
  const label = `${path.win32.basename(input.executable)} ${input.args.map(arg => JSON.stringify(arg)).join(' ')}`;
  if (setupCleanupUnconfirmed) {
    resolve(result(label, 1, '', 'A previous Windows setup process tree could not be confirmed stopped. Stop any remaining setup processes and restart Clementine before starting another setup command.'));
    return;
  }
  const child = spawn(input.executable, input.args, { cwd: input.cwd, env: input.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', finished = false, timedOut = false;
  let cleanup: Promise<ProcessTreeStopResult> | undefined;
  const append = (value: Buffer, error: boolean) => {
    const text = value.toString('utf8'); onOutput?.(text);
    if (error) stderr = (stderr + text).slice(-OUTPUT_LIMIT); else stdout = (stdout + text).slice(-OUTPUT_LIMIT);
  };
  const finish = async (code: number | null, message?: string) => {
    if (finished) return; clearTimeout(timer);
    const stopped = await cleanup;
    if (finished) return; finished = true;
    if (message) stderr = (stderr + '\n' + message).slice(-OUTPUT_LIMIT);
    if (timedOut) stderr += stopped === 'complete' ? '\nSetup timed out; its process tree was stopped. Inspect the partial install before retrying.'
      : '\nSetup timed out; Windows could not confirm its process tree stopped. Stop remaining setup processes before retrying.';
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
    resolve(result(label, timedOut ? null : code, stdout, stderr));
  };
  const timer = setTimeout(() => {
    timedOut = true;
    if (!child.pid) { void finish(null); return; }
    cleanup = stopWindowsProcessTree(child, { env: input.env }).then(status => {
      if (status === 'incomplete') setupCleanupUnconfirmed = true;
      return status;
    });
    // Resolve even when descendant pipes survive failed cleanup; never leave a job running forever.
    void cleanup.then(() => finish(null));
  }, input.timeoutMs);
  child.stdout.on('data', value => append(value, false)); child.stderr.on('data', value => append(value, true));
  child.once('error', error => { void finish(-1, error.message); }); child.once('close', code => { void finish(code); });
});

function ensurePlainDirectory(directory: string): void {
  const ancestors: string[] = []; let cursor = path.resolve(directory);
  for (;;) {
    ancestors.push(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  for (const item of ancestors.reverse()) {
    if (!existsSync(item)) mkdirSync(item);
    const entry = lstatSync(item);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Browser Harness skill paths must be ordinary directories, not links or junctions.');
  }
}

/** Copy only bounded Markdown guidance, preserving relative mechanic links without Windows symlinks. */
export function copyBrowserHarnessSkillResources(repository: string, destinations: string[]): void {
  const files: Array<{ relative: string; bytes: Buffer }> = []; let total = 0;
  const inspect = (relative: string, depth: number) => {
    const source = path.join(repository, relative); const entry = lstatSync(source);
    if (entry.isSymbolicLink()) throw new Error('Browser Harness skill resources cannot be symbolic links.');
    if (entry.isDirectory()) {
      if (depth > 3) throw new Error('Browser Harness skill resource nesting exceeds its limit.');
      for (const name of readdirSync(source)) inspect(path.join(relative, name), depth + 1);
    } else if (entry.isFile() && relative.endsWith('.md')) {
      if (entry.size > 512_000 || files.length >= 96 || (total += entry.size) > 2_000_000) throw new Error('Browser Harness skill resources exceed their limit.');
      files.push({ relative, bytes: readFileSync(source) });
    }
  };
  inspect('SKILL.md', 0); inspect('install.md', 0);
  if (existsSync(path.join(repository, 'interaction-skills'))) inspect('interaction-skills', 0);
  if (!files.find(file => file.relative === 'SKILL.md')?.bytes.length) throw new Error('Browser Harness SKILL.md is missing or empty.');
  for (const destination of [...new Set(destinations)]) {
    for (const file of files) {
      const target = path.join(destination, file.relative); ensurePlainDirectory(path.dirname(target));
      if (existsSync(target) && !lstatSync(target).isFile()) throw new Error('Existing Browser Harness skill resource is not an ordinary file.');
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, file.bytes, { flag: 'wx' }); renameSync(temporary, target); }
      finally { rmSync(temporary, { force: true }); }
    }
  }
}

const DEPENDENCY_PROBE = [
  'import json, sys, importlib.metadata as m',
  'from cdp_use.client import CDPClient',
  'from websockets.asyncio.client import connect',
  'expected={"browser-harness":"0.1.13","cdp-use":"1.4.5","fetch-use":"0.4.0","pillow":"12.3.0","websockets":"15.0.1"}',
  'actual={name:m.version(name) for name in expected}',
  'assert sys.version_info[:2] == (3,12), "Browser Harness requires the selected Python 3.12 environment"',
  'assert actual == expected, "Installed Browser Harness dependencies do not match the reviewed source"',
  'assert callable(CDPClient.send_raw) and callable(connect), "Required typed CDP API is missing"',
  'print(json.dumps({"python":"3.12","libraries":actual},sort_keys=True))',
].join('\n');

export interface WindowsInstallIO {
  exists(file: string): boolean;
  isDirectory(file: string): boolean;
  ensureDirectory(file: string): void;
  copySkills(repository: string, destinations: string[]): void;
  findPython(env: NodeJS.ProcessEnv, home: string): string | null;
  run: WindowsSetupRunner;
}
const installedIO: WindowsInstallIO = {
  exists: existsSync,
  isDirectory(file) { try { const entry = lstatSync(file); return entry.isDirectory() && !entry.isSymbolicLink(); } catch { return false; } },
  ensureDirectory: ensurePlainDirectory, copySkills: copyBrowserHarnessSkillResources,
  findPython: (env, home) => findBrowserHarnessPython({ platform: 'win32', env, home }), run: runWindowsSetupCommand,
};

export async function installBrowserHarnessOnWindows(options: {
  git: string; uv: string; home: string; env: NodeJS.ProcessEnv; io?: WindowsInstallIO; onOutput?: (text: string) => void;
}): Promise<WindowsSetupResult> {
  const { git, uv, home, onOutput } = options; const io = options.io ?? installedIO;
  const env = { ...windowsBrowserHarnessEnv(options.env, home), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }; const source = WINDOWS_BROWSER_HARNESS_SOURCE;
  const repo = path.win32.join(home, 'Developer', 'browser-harness');
  const codexHome = windowsEnvValue(env, 'CODEX_HOME') ?? path.win32.join(home, '.codex');
  const clemHome = windowsEnvValue(env, 'CLEMENTINE_HOME') ?? path.win32.join(home, '.clementine-next');
  const label = `Install Browser Harness ${source.version} at reviewed source ${source.revision}`;
  let output = '';
  const append = (value: string) => { output = (output + value).slice(-OUTPUT_LIMIT); onOutput?.(value); };
  const fail = (message: string) => result(label, 1, output, message);
  for (const value of [git, uv, home, codexHome, clemHome]) if (!isAbsoluteWindowsPath(value)) return fail('Windows Browser Harness setup requires absolute executable, home and skill paths.');
  const run = async (executable: string, args: string[], timeoutMs = 20_000) => {
    const receipt = await io.run({ executable, args, cwd: home, env, timeoutMs }, append);
    if (!receipt.ok) throw new Error(receipt.output || 'Browser Harness setup command failed.');
    return receipt.stdout.trim();
  };
  try {
    if (!io.exists(repo)) {
      io.ensureDirectory(path.win32.dirname(repo));
      await run(git, ['clone', '--no-checkout', '--single-branch', '--branch', source.tag, source.repository, repo], 120_000);
      const cloned = await run(git, ['-C', repo, 'rev-parse', `refs/tags/${source.tag}^{commit}`]);
      if (cloned !== source.revision) return fail('The upstream tag does not match the reviewed source. No Python package was installed.');
      await run(git, ['-C', repo, 'checkout', '--detach', source.revision]);
    } else if (!io.isDirectory(repo) || !io.isDirectory(path.win32.join(repo, '.git'))) {
      return fail('The Browser Harness directory already exists and is not an ordinary checkout. Preserve it and choose a fresh location before installing.');
    }
    const origin = await run(git, ['-C', repo, 'remote', 'get-url', 'origin']);
    const head = await run(git, ['-C', repo, 'rev-parse', 'HEAD']);
    const dirty = await run(git, ['-C', repo, 'status', '--porcelain']);
    if (![source.repository, `${source.repository}.git`].includes(origin) || head !== source.revision || dirty) {
      return fail('The existing Browser Harness checkout differs from the reviewed Windows source or contains local work. It was preserved. Resolve its changes or use a separately reviewed update; automatic pull/repair is disabled.');
    }
    await run(uv, ['tool', 'install', '--python', source.python, '--editable', repo], 300_000);
    const python = io.findPython(env, home);
    if (!python) return fail('uv finished, but the installed Browser Harness Python environment could not be identified. Check its tool executable directory before retrying.');
    const libraries = await run(python, ['-I', '-c', DEPENDENCY_PROBE]);
    io.copySkills(repo, [path.win32.join(codexHome, 'skills', 'browser-harness'), path.win32.join(clemHome, 'skills', 'browser-harness')]);
    append(`\nReviewed source ${source.revision}; installed library/API checks: ${libraries}\nLocal browser connection remains unverified. Open Chrome remote-debugging settings, enable the checkbox, and allow the pending attach if Chrome asks.\n`);
    return result(label, 0, output);
  } catch (error) { return fail(error instanceof Error ? error.message : 'Browser Harness Windows setup failed.'); }
}

/** Opening settings is distinct from enabling debugging or proving a browser connection. */
export function openWindowsChromeDebuggingSetup(options: {
  env?: NodeJS.ProcessEnv; isFile?: (file: string) => boolean; launch?: typeof spawn;
} = {}): Promise<WindowsSetupResult> {
  const url = 'chrome://inspect/#remote-debugging';
  const isFile = options.isFile ?? (file => { try { return statSync(file).isFile(); } catch { return false; } });
  const chrome = windowsChromeCandidates(options.env).find(isFile);
  const guidance = 'In Chrome, open chrome://inspect/#remote-debugging and enable remote debugging for this profile. If Chrome shows an Allow prompt for the pending attach, click Allow and resume that same operation.';
  if (!chrome) return Promise.resolve(result(`Open ${url}`, 1, '', `Google Chrome was not found in its known installed locations. ${guidance}`));
  return new Promise(resolve => {
    const child = (options.launch ?? spawn)(chrome, [url], { shell: false, detached: true, windowsHide: false, stdio: 'ignore' });
    child.once('error', error => resolve(result(`Open ${url}`, -1, '', `${error.message}. ${guidance}`)));
    child.once('spawn', () => { child.unref(); resolve(result(`Open ${url}`, 0, `Chrome setup was opened; the browser connection is not yet verified. ${guidance}`)); });
  });
}
