/**
 * Universal test preload. Evaluated before any user module so CLEMENTINE_HOME
 * cannot bind BASE_DIR to the live ~/.clementine-next unless an explicit
 * destructive-test override is present.
 *
 * It also owns PER-PROCESS home isolation. The test runner executes files
 * concurrently in separate processes, so a single shared home means every file
 * races the same SQLite databases: a failure then moves between runs and the
 * suite cannot gate anything. The runner therefore hands down a disposable
 * ROOT (CLEMMY_TEST_HOME_ROOT) rather than a finished home, and each process
 * mints its own beneath it. An explicit CLEMENTINE_HOME still wins — that is
 * the escape hatch a named destructive test uses.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function realUserHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

export const LIVE_CLEMENTINE_HOME = path.resolve(path.join(realUserHome(), '.clementine-next'));

const allowLive = process.env.CLEMMY_ALLOW_LIVE_HOME_TESTS === '1';
const requested = process.env.CLEMENTINE_HOME
  ? path.resolve(process.env.CLEMENTINE_HOME)
  : LIVE_CLEMENTINE_HOME;
const homeRoot = process.env.CLEMMY_TEST_HOME_ROOT
  ? path.resolve(process.env.CLEMMY_TEST_HOME_ROOT)
  : null;

if (!process.env.CLEMMY_REAL_USER_HOME) {
  process.env.CLEMMY_REAL_USER_HOME = realUserHome();
}

// A home is minted when this process has none of its own: either the runner
// gave us a root to mint under, or nothing was set at all and the default
// would otherwise be the live home.
const mintHome = !allowLive
  && (!process.env.CLEMENTINE_HOME || requested === LIVE_CLEMENTINE_HOME);

if (mintHome) {
  const parent = homeRoot ?? os.tmpdir();
  mkdirSync(parent, { recursive: true });
  const testHome = mkdtempSync(path.join(parent, 'clementine-test-home-'));
  const testTmp = path.join(testHome, 'tmp');
  mkdirSync(testTmp, { recursive: true });
  process.env.CLEMENTINE_HOME = testHome;
  process.env.CLEMMY_TEST_ISOLATED_HOME = process.env.CLEMMY_TEST_ISOLATED_HOME || '1';
  process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS || '1';
  if (!process.env.CLEMMY_LOCAL_EMBEDDINGS) process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
  // TMPDIR deliberately stays where the runner put it, one level up. macOS
  // caps a unix socket path at 104 bytes and tsx opens its IPC pipe under
  // TMPDIR; nesting temp inside each per-process home pushed that path to 133,
  // where the kernel truncates it and unrelated subprocesses collide with
  // EADDRINUSE. Contention was never a temp-file problem — it was the
  // databases in the home — so only the home moves.
  if (!process.env.TMPDIR) {
    process.env.TMPDIR = testTmp;
    process.env.TMP = testTmp;
    process.env.TEMP = testTmp;
  }
  // One home per FILE means a full suite mints a thousand of them. Releasing
  // each as its process ends keeps peak disk at roughly the concurrency width
  // rather than the whole suite; the runner's teardown still removes the root,
  // so a process killed outright is covered rather than leaked.
  if (homeRoot) {
    process.on('exit', () => {
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch { /* teardown of the root is the backstop */ }
    });
  }
}
