/**
 * Run: npx tsx --test src/runtime/harness/brain-fallover-default.test.ts
 *
 * DRIFT GUARD (2026-07-20). The RUNTIME brain-fallover lanes (router, chat, workflow,
 * run_worker fan-out) all gate on CLEMMY_BRAIN_FALLOVER and MUST default ON — a
 * mid-request brain failure should switch to a connected brain, not dead-end. The
 * v1.21.0 release flipped three of them but left run_worker (orchestrator) reading
 * default 'off', so fan-out workers never fell over. This test fails the build if any
 * RUNTIME lane re-introduces a default of 'off'.
 *
 * EXCEPTION — codex-client.ts `automaticBrainFallbackEnabled` is a DIFFERENT mechanism:
 * BOOT-time brain SUBSTITUTION (the chosen brain can't auth at startup). It is
 * intentionally OPT-IN / default-'off' (fail-closed at boot + notify, let the user
 * decide — see codex-client.test.ts "fails closed by default even when Codex is
 * connected"). It shares the env var but keeps the opposite default ON PURPOSE, so it
 * is allowlisted here rather than flagged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

// The one intentional default-'off' site: boot-time brain substitution (opt-in).
const BOOT_SUBSTITUTION_OPT_IN = path.join('runtime', 'harness', 'codex-client.ts');

test('every RUNTIME CLEMMY_BRAIN_FALLOVER gate defaults to ON (no lane drifts back to off)', () => {
  // Matches getRuntimeEnv('CLEMMY_BRAIN_FALLOVER', '<default>') with either quote style.
  const gateRe = /CLEMMY_BRAIN_FALLOVER['"]\s*,\s*['"](on|off)['"]/g;
  const offenders: string[] = [];
  let bootOptInSeen = false;
  let gatesSeen = 0;

  for (const file of walk(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file);
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(gateRe)) {
      gatesSeen += 1;
      if (m[1] !== 'off') continue;
      if (rel === BOOT_SUBSTITUTION_OPT_IN) { bootOptInSeen = true; continue; } // intentional — see header
      offenders.push(`${rel}: default '${m[1]}'`);
    }
  }

  // Sanity: the pattern must actually be finding the gates (guards against a silent
  // rename making this test vacuously pass).
  assert.ok(gatesSeen >= 3, `expected to find the brain-fallover gates, saw ${gatesSeen}`);
  assert.equal(bootOptInSeen, true, `the boot-substitution opt-in (${BOOT_SUBSTITUTION_OPT_IN}) should still default 'off' by design — if this fails, reconcile the allowlist with the intended behavior`);
  assert.deepEqual(offenders, [], `RUNTIME brain-fallover gates must default ON; offenders:\n${offenders.join('\n')}`);
});
