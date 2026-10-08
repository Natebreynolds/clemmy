import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Options as ClaudeAgentOptions } from '@anthropic-ai/claude-agent-sdk';

const MAX_SHIM_BYTES = 16 * 1024;

function readSmallFile(file: string): string | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_SHIM_BYTES) return null;
    const content = readFileSync(file, 'utf8');
    return Buffer.byteLength(content, 'utf8') <= MAX_SHIM_BYTES ? content : null;
  } catch { return null; }
}

/** Recognize npm's local Claude Code target, without evaluating batch syntax.
 *  npm's cmd-shim ends the launcher with `"%_prog%" <args> "%dp0%\<target>" %*`
 *  for a script node runs (with no args that is TWO spaces after "%_prog%"),
 *  or `"%dp0%\<target>" <args> %*` for a native target. A tester's real npm
 *  install (2026-10-08) failed the old one-space pattern, fell through to the
 *  extensionless sh launcher and every Claude call crashed with spawn ENOENT.
 *  The target must be the package's own declared `claude` bin, inside it. */
function npmClaudeEntry(shim: string): string | null {
  const text = readSmallFile(shim);
  const launch = text ? /^\s*(?:endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & )?(?:"%_prog%"\s+)?"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\([^"%\r\n]+)"\s+%\*\s*$/im.exec(text) : null;
  if (!launch) return null;
  const packageRoot = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code');
  const metadata = readSmallFile(path.join(packageRoot, 'package.json'));
  if (!metadata) return null;
  try {
    const pkg = JSON.parse(metadata) as { name?: unknown; bin?: unknown };
    const declared = typeof pkg.bin === 'string' ? pkg.bin
      : pkg.bin && typeof pkg.bin === 'object' ? (pkg.bin as Record<string, unknown>).claude : undefined;
    if (pkg.name !== '@anthropic-ai/claude-code' || typeof declared !== 'string') return null;
    const target = path.posix.normalize(launch[1]!.split('\\').join('/'));
    if (path.posix.normalize(declared.split('\\').join('/')) !== target) return null;
    const entry = path.join(packageRoot, ...target.split('/'));
    const relative = path.relative(packageRoot, entry);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return statSync(entry).isFile() ? entry : null;
  } catch { return null; }
}

export function resolveClaudeCliOnPath(input: {
  directories: readonly string[];
  override?: string;
  platform?: NodeJS.Platform;
}): string | null {
  const platform = input.platform ?? process.platform;
  const resolveCandidate = (candidate: string): string | null => {
    if (!existsSync(candidate)) return null;
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(candidate)) return npmClaudeEntry(candidate);
    return candidate;
  };
  if (input.override && existsSync(input.override)) {
    const resolved = resolveCandidate(input.override);
    if (resolved) return resolved;
    throw new Error('CLAUDE_CLI_PATH is an unsupported Windows batch launcher. Use the native claude.exe or a standard npm Claude Code installation.');
  }
  // Windows cannot start an extensionless file: npm's bare `claude` beside
  // claude.cmd is a sh script for Git Bash, and spawning it is ENOENT.
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  let unsupportedLauncher = false;
  for (const directory of input.directories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const resolved = resolveCandidate(path.join(directory, `claude${extension}`));
      if (resolved) return resolved;
      if (platform === 'win32' && /\.(cmd|bat)$/.test(extension)
        && existsSync(path.join(directory, `claude${extension}`))) unsupportedLauncher = true;
    }
  }
  if (unsupportedLauncher) throw new Error('The Windows Claude batch launcher is not a supported npm Claude Code shim. Use the native claude.exe or repair the npm installation.');
  return null;
}

interface LaunchHost {
  platform?: NodeJS.Platform;
  execPath?: string;
  electron?: boolean;
}

export function claudeCliLaunch(cli: string, args: readonly string[], host: LaunchHost = {}): {
  command: string;
  args: string[];
  envPatch: NodeJS.ProcessEnv;
} {
  const script = (host.platform ?? process.platform) === 'win32' && /\.(js|mjs)$/.test(cli);
  if (!script) return { command: cli, args: [...args], envPatch: {} };
  return {
    command: host.execPath ?? process.execPath,
    args: [cli, ...args],
    envPatch: (host.electron ?? Boolean(process.versions.electron)) ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

/** SDK's documented script suffixes include .js/.mjs; .cmd is a native path to it. */
export function claudeSdkCliLaunchOptions(cli: string | undefined, host: LaunchHost = {}): Pick<ClaudeAgentOptions, 'executable' | 'spawnClaudeCodeProcess'> {
  if (!cli || (host.platform ?? process.platform) !== 'win32' || !/\.(js|mjs)$/.test(cli)) return {};
  return {
    executable: 'node',
    spawnClaudeCodeProcess: options => {
      // No command string or shell: SDK argv, auth ownership and abort signal
      // stay intact. Electron supplies its own Node without an external install.
      if (options.command !== 'node' || options.args[0] !== cli) throw new Error('Claude SDK script launch did not preserve the selected CLI entry.');
      return spawn(host.execPath ?? process.execPath, options.args, {
        cwd: options.cwd,
        env: { ...options.env, ...claudeCliLaunch(cli, [], host).envPatch },
        signal: options.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    },
  };
}
