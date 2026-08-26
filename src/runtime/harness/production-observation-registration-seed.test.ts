/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/production-observation-registration-seed.test.ts
 *
 * Regression pin for the 2026-08-26 "observation_unavailable" gauntlet break:
 * a live chat turn's proof-provisioned Composio write (and the purely
 * host-local `host_transform` capability) both registered clean
 * (`registerIndependentCapabilityObservation` returned ok:true, nothing
 * threw, nothing was skipped) and then failed readiness's re-check with
 * `observation_unavailable` on every single attempt — 800+ occurrences in one
 * live daemon.log, `accepted_source_catalog_snapshots.snapshot_json` frozen
 * at '[]', every plan_task refused "primary model planning catalog no longer
 * matches the frozen host catalog".
 *
 * ROOT CAUSE: `independentlyObserveCapability` unconditionally seeds the
 * shipped observer's transport via `shipped.registerIsolatedObservation(...)`
 * before asking it to confirm the observation — every provider kind, every
 * call. `implementation-artifacts/transport-isolated-entry.ts` (the transport
 * this process loads whenever `isolatedTestContractActive()` is true — i.e.
 * every test in this suite) has always implemented that seed, so a
 * capability registered and then re-checked inside ANY node:test process
 * always found its own deposit and passed. `implementation-artifacts/
 * transport-entry.ts` — the ONLY transport a live daemon ever loads — had NO
 * such export; `loadShippedImplementations()` reaches it through an optional
 * `transportModule.registerIsolatedObservation?.()`, so the seed was a silent
 * no-op there and `observe()` could never find what registration had just
 * proven. No prior pin could see this: they all ran inside node:test, which
 * can never select the non-isolated transport kind. This pin runs the exact
 * production sequence (registerIndependentCapabilityObservation →
 * independentlyObserveCapability, unmodified production code, no fixtures) in
 * a plain child process with the isolated-test contract's own env markers
 * stripped, so `loadShippedImplementations()` makes the SAME choice a real
 * daemon makes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function runProductionSequence(): { status: number | null; stdout: string; stderr: string } {
  const script = `
    import { registerIndependentCapabilityObservation, independentlyObserveCapability }
      from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/independent-capability-observation.ts'))};

    // Exactly proof-provisioned-catalog.ts's composio registration shape
    // (registerProofProvisionedCapabilities): a fresh manifest's own fields,
    // re-derived on every observe() call, origin declared 'independent'.
    const composioManifest = {
      operationId: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
      accountId: 'conn-googlesheets',
      definitionFingerprint: 'f'.repeat(64),
      providerVersion: 'composio-v1',
      operationVersion: '1',
    };
    const composioRegistered = registerIndependentCapabilityObservation({
      ...composioManifest,
      observedAt: Date.now(),
      origin: 'independent',
      observe: () => ({ ...composioManifest, observedAt: Date.now() }),
    });

    // Exactly proof-provisioned-catalog.ts's host_transform registration
    // shape: no external provider at all, same generic contract.
    const hostManifest = {
      operationId: 'host_transform',
      accountId: 'host:runtime',
      definitionFingerprint: 'e'.repeat(64),
      providerVersion: 'tool-registry-v1',
      operationVersion: '1',
    };
    const hostRegistered = registerIndependentCapabilityObservation({
      ...hostManifest,
      observedAt: Date.now(),
      origin: 'independent',
      observe: () => ({ ...hostManifest, observedAt: Date.now() }),
    });

    const composioObserved = independentlyObserveCapability(composioManifest.operationId, composioManifest.accountId);
    const hostObserved = independentlyObserveCapability(hostManifest.operationId, hostManifest.accountId);

    process.stdout.write(JSON.stringify({
      composioRegistered,
      hostRegistered,
      composioObserved,
      hostObserved,
    }));
  `;
  const env = { ...process.env };
  // The isolated-test contract's own markers. Every node:test process in this
  // repo carries at least one of these; stripping both is what makes
  // isolatedTestContractActive() return false in the CHILD, exactly as it
  // does in a real daemon — that difference is the entire point of this pin.
  delete env.NODE_TEST_CONTEXT;
  delete env.CLEMMY_TEST_ISOLATED_HOME;
  env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-prod-observation-seed-'));
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

test('the production transport is actually selected once the isolated markers are gone', () => {
  const script = `
    import { isolatedTestContractActive } from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/isolated-test-contract.ts'))};
    process.stdout.write(JSON.stringify(isolatedTestContractActive()));
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.CLEMMY_TEST_ISOLATED_HOME;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'false',
    'the pin below is meaningless unless it actually reaches the non-isolated (production) transport kind');
});

test('a freshly registered independent observation is confirmable through the production transport', () => {
  const result = runProductionSequence();
  assert.equal(result.status, 0, `${result.status} ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    composioRegistered: { ok: boolean };
    hostRegistered: { ok: boolean };
    composioObserved: { origin?: string; operationId?: string; accountId?: string } | null;
    hostObserved: { origin?: string; operationId?: string; accountId?: string } | null;
  };

  // Registration itself was never the problem — it always reported ok:true.
  assert.equal(parsed.composioRegistered.ok, true, JSON.stringify(parsed.composioRegistered));
  assert.equal(parsed.hostRegistered.ok, true, JSON.stringify(parsed.hostRegistered));

  // The bug: readiness's re-check found nothing, for a provider capability...
  assert.ok(parsed.composioObserved, `composio: independentlyObserveCapability returned ${JSON.stringify(parsed.composioObserved)}`);
  assert.equal(parsed.composioObserved!.origin, 'independent');
  assert.equal(parsed.composioObserved!.operationId, 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1');
  assert.equal(parsed.composioObserved!.accountId, 'conn-googlesheets');

  // ...and for a capability with no external provider to contact at all,
  // proving this is a registration/observer wiring gap, not a live-network or
  // schema-cache-freshness problem specific to Composio.
  assert.ok(parsed.hostObserved, `host_transform: independentlyObserveCapability returned ${JSON.stringify(parsed.hostObserved)}`);
  assert.equal(parsed.hostObserved!.origin, 'independent');
  assert.equal(parsed.hostObserved!.operationId, 'host_transform');
  assert.equal(parsed.hostObserved!.accountId, 'host:runtime');
});
