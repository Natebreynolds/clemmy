/** Resolve an installed Browser Harness interpreter without running its CLI. */
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAbsoluteWindowsPath, windowsEnvValue } from './windows-browser-paths.js';

const MAX_LAUNCHER_BYTES = 1024 * 1024;

interface BrowserPythonFiles {
  isFile(file: string): boolean;
  read(file: string): Buffer;
}

const installedFiles: BrowserPythonFiles = {
  isFile(file) { try { return statSync(file).isFile(); } catch { return false; } },
  read(file) {
    if (statSync(file).size > MAX_LAUNCHER_BYTES) throw new Error('Launcher exceeds inspection limit');
    return readFileSync(file);
  },
};

/** Windows uv console launchers are copied .exe files, not POSIX symlinks.
 * Read their embedded absolute interpreter or an adjacent Scripts/python.exe
 * in an existing venv. Never evaluate a .cmd wrapper or fall back to a system
 * Python: neither proves which installed environment supplies cdp_use. */
export function findBrowserHarnessPython(options: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  files?: BrowserPythonFiles;
} = {}): string | null {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const files = options.files ?? installedFiles;
  const configuredToolBin = platform === 'win32' ? windowsEnvValue(env, 'UV_TOOL_BIN_DIR') : undefined;
  const configuredPath = platform === 'win32' ? windowsEnvValue(env, 'PATH') : env.PATH;
  const directories = [configuredToolBin && isAbsoluteWindowsPath(configuredToolBin) ? configuredToolBin : '',
    paths.join(home, '.local', 'bin'), ...(configuredPath ?? '').split(paths.delimiter)]
    .map(directory => platform === 'win32' ? directory.replace(/^"(.*)"$/, '$1') : directory)
    .filter(directory => Boolean(directory) && (platform !== 'win32' || isAbsoluteWindowsPath(directory)));

  const installedWindowsPython = (interpreter: string): string | null => {
    // A drive-qualified or UNC path is absolute; a rooted \path is not bound
    // to a drive, and a launcher argument is never part of an executable path.
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(interpreter)
      || paths.basename(interpreter).toLowerCase() !== 'python.exe'
      || paths.basename(paths.dirname(interpreter)).toLowerCase() !== 'scripts') return null;
    if (!files.isFile(interpreter)
      || !files.isFile(paths.join(paths.dirname(paths.dirname(interpreter)), 'pyvenv.cfg'))) return null;
    // Keep the venv path. Resolving a python.exe symlink to its base interpreter
    // would lose the virtual environment and therefore its installed packages.
    return interpreter;
  };

  for (const directory of directories) {
    const names = platform === 'win32'
      ? ['browser-harness.exe', 'browser-harness.cmd', 'browser-harness.bat', 'browser-harness']
      : ['browser-harness'];
    for (const name of names) {
      const command = paths.join(directory, name);
      if (!files.isFile(command)) continue;
      try {
        if (platform !== 'win32') {
          const firstLine = files.read(command).toString('utf8').split('\n')[0]!;
          const interpreter = firstLine.match(/^#!(\/[^\r\n]+\/python(?:[0-9.]+)?)$/)?.[1];
          if (interpreter && files.isFile(interpreter)) return interpreter;
          continue;
        }

        // A launcher directly in Scripts can bind its adjacent venv Python.
        // This also supports a .cmd shim there, without reading shell code.
        const adjacent = installedWindowsPython(paths.join(directory, 'python.exe'));
        if (adjacent) return adjacent;
        if (!name.endsWith('.exe') && name !== 'browser-harness') continue;
        const launcher = files.read(command);
        if (name.endsWith('.exe') && launcher.subarray(0, 2).toString('ascii') !== 'MZ') continue;
        const text = launcher.toString('utf8');
        for (const match of text.matchAll(/#!([^\r\n]{1,8192})\r?\n/g)) {
          const line = match[1]!;
          const interpreter = line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line;
          const installed = installedWindowsPython(interpreter);
          if (installed) return installed;
        }
      } catch { /* Broken launcher/venv: inspect the next installed command. */ }
    }
  }
  return null;
}
