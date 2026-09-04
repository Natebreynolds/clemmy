/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/successor-restart.test.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-successor-restart-'));
process.env.CLEMENTINE_HOME = HOME;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('two-process provision then normal bootstrap reconstructs the shipped successor port', () => {
  const script = `
    import { mkdtempSync } from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    const home = process.env.CLEMENTINE_HOME;
    process.env.CLEMENTINE_HOME = home;
    const { createCapabilityManifestStore, installCapabilityManifestStore } = await import(${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/capability-manifest-store.ts'))});
    const { productionCapabilityManifests, provisionAccountBoundCapabilitySuccessor, reconstructShippedPortsForDurableSuccessors, fakeAccountForTemplate } = await import(${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/production-capability-catalog.ts'))});
    const { peekProductionCapabilityPort, productionPortIdentityFromManifest } = await import(${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/production-capability-ports.ts'))});
    const { isShippedInvoke } = await import(${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/shipped-implementation-identity.ts'))});
    const { configureTypedExecutionRuntime, typedExecutionCatalogReady, refreshTypedExecutionReadiness } = await import(${JSON.stringify(path.join(repoRoot, 'src/runtime/semantic-boundary/configure-typed-execution-runtime.ts'))});
    const store = createCapabilityManifestStore([], { durable: true });
    installCapabilityManifestStore(store);
    const template = productionCapabilityManifests().find((row) => row.effect === 'read');
    if (!template) process.exit(2);
    const accountId = fakeAccountForTemplate(template);
    const provisioned = provisionAccountBoundCapabilitySuccessor({
      store,
      template,
      accountId,
      observation: {
        definitionFingerprint: template.definitionFingerprint,
        providerVersion: template.providerVersion,
        operationVersion: template.operationVersion,
        accountId,
      },
    });
    if (!provisioned.ok) process.exit(3);
    if (process.env.CLEMMY_SUCCESSOR_PHASE === 'provision') {
      process.stdout.write(provisioned.manifest.manifestId);
      process.exit(0);
    }
    configureTypedExecutionRuntime();
    reconstructShippedPortsForDurableSuccessors();
    refreshTypedExecutionReadiness();
    const port = peekProductionCapabilityPort(productionPortIdentityFromManifest(provisioned.manifest));
    if (!port || !isShippedInvoke(port.invoke)) process.exit(4);
    if (provisioned.manifest.providerKind === 'composio' && (
      typeof port.admitPreparation !== 'function'
      || typeof port.prepareInvocation !== 'function'
      || typeof port.invokeWithPreparation !== 'function'
    )) process.exit(5);
    process.stdout.write('reconstructed');
  `;
  const first = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, CLEMENTINE_HOME: HOME, CLEMMY_SUCCESSOR_PHASE: 'provision', CLEMMY_TEST_ISOLATED_HOME: '1' },
  });
  assert.equal(first.status, 0, first.stderr);
  const second = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, CLEMENTINE_HOME: HOME, CLEMMY_SUCCESSOR_PHASE: 'bootstrap', CLEMMY_TEST_ISOLATED_HOME: '1' },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, 'reconstructed');
});
