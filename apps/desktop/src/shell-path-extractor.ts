import { spawn } from 'node:child_process';

/**
 * Shell PATH extractor — runs a brief login shell to capture the
 * user's real PATH (with all version-manager init like nvm, asdf,
 * mise, volta, fnm, rbenv, pyenv, sdkman applied).
 *
 * v0.5.21 Phase 2.5 — addresses the chronic problem that GUI-launched
 * macOS apps inherit launchd's bare PATH (/usr/bin:/bin:/usr/sbin:/sbin
 * + whatever launchd has cached). The supervisor previously patched
 * this with a curated `COMMON_USER_BIN_DIRS` list, but that's a
 * hardcoded allowlist — it misses nvm, asdf, mise, volta, fnm, etc.
 * Verified 2026-05-25: Higgsfield installed at
 *   ~/.nvm/versions/node/v22.22.0/bin/higgsfield
 * was invisible to `local_cli_list` because nvm bin dirs weren't in
 * the curated list. Same gap exists for every npm-global-via-nvm CLI.
 *
 * The fix: spawn `zsh -lic 'echo $PATH'` (or `bash -lc` fallback) and
 * capture stdout. Matches the pattern used by VS Code, iTerm, Cursor,
 * GitHub Desktop — anything that needs to look like a real shell to
 * the user's tooling.
 *
 * Bounded to 2s so a pathological .zshrc (heavy nvm/conda init, slow
 * plugin manager) doesn't block the supervisor. On timeout or any
 * other failure we return null and the caller falls back to the
 * curated list — strictly additive, never worse than today.
 */

export interface ShellPathResult {
  /** Colon-delimited PATH string captured from the user's shell, OR null on any failure. */
  path: string | null;
  /** Which shell produced it ('zsh' | 'bash'), for debug logging. */
  shell: 'zsh' | 'bash' | null;
  /** Wall-clock ms the extraction took (or attempted). */
  durationMs: number;
  /** Diagnostic reason when path is null — 'timeout' | 'nonzero_exit' | 'no_shell' | 'spawn_error'. */
  failureReason?: 'timeout' | 'nonzero_exit' | 'no_shell' | 'spawn_error';
}

/**
 * 5s per shell. Heavy `.zshrc` setups (oh-my-zsh + nvm init + many
 * plugins) commonly need 2-4s; 2s caused timeouts on a real machine
 * (verified 2026-05-25). Total worst-case latency is 10s when both
 * zsh AND bash time out, but extraction runs async so it never
 * blocks daemon startup.
 */
const EXTRACTION_TIMEOUT_MS = 5_000;

/** Try one shell. Returns the PATH string on success, or throws. */
function spawnShellForPath(shell: 'zsh' | 'bash'): Promise<string> {
  return new Promise((resolve, reject) => {
    // `-l` makes it a login shell (runs `.zprofile` / `.bash_profile`).
    // For zsh, `-i` also pulls in `.zshrc` (nvm init typically lives
    // there). bash doesn't read .bashrc in `-lc` non-interactive mode
    // for some setups; `-l` alone is what's portable for bash.
    const flags = shell === 'zsh' ? ['-lic'] : ['-lc'];
    const child = spawn(shell, [...flags, 'printf %s "$PATH"'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Critical: do NOT inherit our cwd into the shell — a project's
      // direnv / mise local config could shadow the global PATH.
      cwd: process.env.HOME,
      // Strip env so we get a clean login shell run. The user's
      // .zprofile / .zshrc is the source of truth, not whatever
      // env we were spawned with.
      env: { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      reject(new Error(`shell-path-extractor: ${shell} timed out after ${EXTRACTION_TIMEOUT_MS}ms`));
    }, EXTRACTION_TIMEOUT_MS);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`shell-path-extractor: ${shell} exited ${code}; stderr=${stderr.slice(0, 200)}`));
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed.includes(':') && !trimmed.includes('/')) {
        reject(new Error(`shell-path-extractor: ${shell} returned no PATH-shaped output: ${trimmed.slice(0, 100)}`));
        return;
      }
      resolve(trimmed);
    });
  });
}

/**
 * Extract the user's shell PATH. Tries zsh first (macOS default since
 * Catalina), then bash on ANY failure (timeout, nonzero exit, missing
 * shell). Returns a result envelope so callers can log diagnostics
 * regardless of success.
 *
 * Critical: on timeout we MUST fall through to bash, not return
 * early. Verified 2026-05-25 on a real machine — the user's zsh hit
 * the timeout (heavy .zshrc), and an early-return left the daemon
 * with no shell PATH at all. Bash is virtually guaranteed to be
 * installed on macOS and usually has a lighter rc.
 */
export async function extractShellPath(): Promise<ShellPathResult> {
  const started = Date.now();
  let lastFailureReason: ShellPathResult['failureReason'] = 'no_shell';
  let lastShell: ShellPathResult['shell'] = null;
  for (const shell of ['zsh', 'bash'] as const) {
    lastShell = shell;
    try {
      const path = await spawnShellForPath(shell);
      return { path, shell, durationMs: Date.now() - started };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        // shell not installed — try the next one
        lastFailureReason = 'no_shell';
        continue;
      }
      if (msg.includes('timed out')) {
        lastFailureReason = 'timeout';
        // Fall through to the next shell — bash usually has a
        // lighter rc than zsh and can succeed where zsh timed out.
        continue;
      }
      lastFailureReason = 'nonzero_exit';
      continue;
    }
  }
  return { path: null, shell: lastShell, durationMs: Date.now() - started, failureReason: lastFailureReason };
}
