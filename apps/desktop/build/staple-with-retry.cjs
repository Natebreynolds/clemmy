/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Staple a notarized artifact, retrying while Apple's ticket service cannot be
 * reached or has not published the ticket yet.
 *
 * `xcrun stapler` fetches the notarization ticket over the network. A hosted
 * runner can lose that connection after the notarization itself succeeded
 * (stapler exits 68, EX_NOHOST), and a fresh ticket can take a moment to
 * appear (65). Both wait and try again; any other status stops at once, and
 * a stapled artifact is validated before it counts.
 */
const { spawnSync } = require('node:child_process');

const RETRYABLE = new Set([65, 68]);

/** @electron/notarize staples after a successful notarization; its staple
 *  failure is the only error that may continue to stapleWithRetry. */
function isStapleFailure(err) {
  return err instanceof Error && /Failed to staple/.test(err.message);
}

async function stapleWithRetry(target, {
  attempts = 6,
  waitMs = 30_000,
  spawn = spawnSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (line) => console.log(line),
} = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const staple = spawn('xcrun', ['stapler', 'staple', '-v', target], { stdio: 'inherit' });
    last = staple.status;
    if (staple.status === 0) {
      const validate = spawn('xcrun', ['stapler', 'validate', target], { stdio: 'inherit' });
      if (validate.status === 0) return attempt;
      last = validate.status;
    }
    if (!RETRYABLE.has(last)) break;
    if (attempt < attempts) {
      log(`  [staple] ${target}: stapler exited ${last}; retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${attempts})`);
      await sleep(waitMs);
    }
  }
  throw new Error(`stapling ${target} failed with status ${last}`);
}

module.exports = { stapleWithRetry, isStapleFailure };
