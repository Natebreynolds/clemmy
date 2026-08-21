/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/shipped-implementation-identity.test.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-shipped-id-'));
process.env.CLEMENTINE_HOME = HOME;

const {
  emitShippedImplementationArtifacts,
  implementationArtifactDigest,
  implementationArtifactPath,
  implementationManifestPath,
  installImplementationArtifactRoot,
  loadShippedImplementations,
  shippedImplementationDigest,
  verifyShippedImplementationIdentity,
  isShippedInvoke,
  isShippedReconcile,
  peekShippedProvenance,
} = await import('./shipped-implementation-identity.js');
const { registerProductionCapabilityPort, portImplementationDigest } = await import('./production-capability-ports.js');
const { attachSemanticContract } = await import('./capability-manifest.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('emitted artifacts are executable javascript with distinct identities', () => {
  const verified = verifyShippedImplementationIdentity();
  assert.equal(verified.ok, true, JSON.stringify(verified));
  if (!verified.ok) return;
  assert.notEqual(verified.digests.invoke, verified.digests.reconcile);
  assert.notEqual(verified.digests.invoke, verified.digests.observer);
  assert.notEqual(verified.digests.reconcile, verified.digests.observer);
  for (const kind of ['invoke', 'reconcile', 'observer'] as const) {
    const checked = spawnSync(process.execPath, ['--check', implementationArtifactPath(kind)], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
  const loaded = loadShippedImplementations();
  assert.equal(typeof loaded.invokeForSealedManifest, 'function');
  assert.equal(typeof loaded.reconcileForSealedManifest, 'function');
  assert.equal(typeof loaded.applyIndependentObserver, 'function');
});

test('changing a transitive helper changes the applicable digest', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-shipped-helper-'));
  const manifest = emitShippedImplementationArtifacts(root);
  const invokeInputs = Object.keys(manifest.artifacts.invoke.inputs ?? {});
  const observerInputs = Object.keys(manifest.artifacts.observer.inputs ?? {});
  assert.ok(invokeInputs.some((file) => file.includes('invoke-support')), JSON.stringify(invokeInputs));
  assert.equal(observerInputs.some((file) => file.includes('invoke-support')), false);
  const before = implementationArtifactDigest('invoke', root);
  writeFileSync(implementationArtifactPath('invoke', root), `${readFileSync(implementationArtifactPath('invoke', root))}\n// helper-closure-changed\n`);
  assert.notEqual(implementationArtifactDigest('invoke', root), before);
});

test('two materially different callbacks cannot receive the same production identity', () => {
  const one = async () => ({ a: 1 });
  const two = async () => ({ b: 2 });
  assert.equal(isShippedInvoke(one), false);
  assert.equal(isShippedInvoke(two), false);
  const identity = {
    manifestId: 'cap-x',
    manifestDigest: 'a'.repeat(64),
    operationId: 'host_create',
    definitionFingerprint: 'b'.repeat(64),
    providerKind: 'local_registry' as const,
    accountId: 'acct-1',
  };
  assert.equal(registerProductionCapabilityPort(identity, { invoke: one as never }).ok, false);
  assert.equal(registerProductionCapabilityPort({ ...identity, manifestId: 'cap-y' }, { invoke: two as never }).ok, false);
  const forged = async () => ({ forged: true });
  Object.defineProperty(forged, Symbol.for('clementine.shippedInvoke'), { value: true });
  assert.equal(registerProductionCapabilityPort({ ...identity, manifestId: 'cap-forged' }, { invoke: forged as never }).ok, false);
  assert.equal(registerProductionCapabilityPort({ ...identity, manifestId: 'cap-default' }, { invoke: one as never }).reason, 'not_shipped_implementation');
});

test('missing tampered or stale manifest or artifact refuses before I/O', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-shipped-tamper-'));
  emitShippedImplementationArtifacts(root);
  writeFileSync(implementationArtifactPath('invoke', root), `${readFileSync(implementationArtifactPath('invoke', root), 'utf8')}\n// tampered\n`);
  assert.equal(verifyShippedImplementationIdentity(root).ok, false);
  const clean = mkdtempSync(path.join(os.tmpdir(), 'clem-shipped-clean-'));
  emitShippedImplementationArtifacts(clean);
  const manifest = JSON.parse(readFileSync(implementationManifestPath(clean), 'utf8')) as { artifacts: { invoke: { sha256: string } } };
  manifest.artifacts.invoke.sha256 = 'a'.repeat(64);
  writeFileSync(implementationManifestPath(clean), `${JSON.stringify(manifest)}\n`);
  assert.equal(verifyShippedImplementationIdentity(clean).ok, false);
});

test('identical artifacts remain deterministic across two child processes', () => {
  const script = `
    import { shippedImplementationDigest } from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/shipped-implementation-identity.ts'))};
    process.stdout.write(shippedImplementationDigest('invoke'));
  `;
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-child-id-')) },
  });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /^[a-f0-9]{64}$/);
});

test('npm pack file list includes implementation artifacts and manifest', () => {
  const filesField = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { files: string[] };
  assert.ok(filesField.files.includes('dist'));
  const build = readFileSync(path.join(repoRoot, 'scripts/build-candidate.mjs'), 'utf8');
  assert.match(build, /emit-implementation-artifacts/);
  assert.match(build, /dist\/runtime\/harness\/implementation-artifacts\/emitted/);
  const distArtifacts = path.join(repoRoot, 'dist/runtime/harness/implementation-artifacts/emitted');
  emitShippedImplementationArtifacts(distArtifacts);
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const listing = packed.stdout + packed.stderr;
  assert.match(listing, /implementation-artifacts/);
  assert.match(listing, /manifest\.json/);
  assert.match(listing, /invoke-/);
  assert.match(listing, /reconcile-/);
  assert.match(listing, /observer-/);
  assert.match(listing, /transport-/);
});

test('packaged child process loads the same identity without source ts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-packed-id-'));
  emitShippedImplementationArtifacts(root);
  const loader = `
    import { createRequire } from 'node:module';
    import { readFileSync, readdirSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import path from 'node:path';
    const root = process.env.CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT;
    if (!root) process.exit(4);
    const names = readdirSync(root);
    if (names.some((name) => name.endsWith('.ts'))) process.exit(5);
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const require = createRequire(import.meta.url);
    const invokePath = path.join(root, manifest.artifacts.invoke.file);
    const transportPath = path.join(root, manifest.artifacts.transportIsolated.file);
    const invoke = require(invokePath);
    const transportMod = require(transportPath);
    if (typeof invoke.bindAttestedTransport !== 'function') process.exit(6);
    invoke.bindAttestedTransport(transportMod.createAttestedTransport(manifest.artifacts.transportIsolated.sha256));
    const digest = createHash('sha256').update(readFileSync(invokePath)).digest('hex');
    if (digest !== manifest.artifacts.invoke.sha256) process.exit(2);
    if (typeof invoke.invokeForSealedManifest !== 'function') process.exit(3);
    const fn = invoke.invokeForSealedManifest({ operationId: 'host_lookup', effect: 'read', accountId: 'acct', manifestId: 'm', invokePortId: 'p', argumentCompiler: { id: 'c', version: '1' }, acceptedInputKinds: [], producedOutputKinds: [] });
    if (typeof fn !== 'function') process.exit(7);
    process.stdout.write(digest);
  `;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', loader], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: {
      ...process.env,
      CLEMMY_IMPLEMENTATION_ARTIFACT_ROOT: root,
      CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-packed-home-')),
    },
  });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, `${first.status} ${first.stderr} ${first.stdout}`);
  assert.equal(second.status, 0, `${second.status} ${second.stderr} ${second.stdout}`);
  assert.equal(first.stdout, second.stdout);
});

test('reconciliation after child-process restart rechecks the exact reserved artifact', () => {
  const reserved = shippedImplementationDigest('reconcile');
  const script = `
    import { shippedImplementationDigest, verifyShippedImplementationIdentity } from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/shipped-implementation-identity.ts'))};
    const verified = verifyShippedImplementationIdentity();
    if (!verified.ok) process.exit(2);
    if (verified.digests.reconcile !== process.env.RESERVED_RECONCILE_DIGEST) process.exit(3);
    if (shippedImplementationDigest('reconcile') !== process.env.RESERVED_RECONCILE_DIGEST) process.exit(4);
    process.stdout.write(verified.digests.reconcile);
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: {
      ...process.env,
      CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-restart-id-')),
      RESERVED_RECONCILE_DIGEST: reserved,
    },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, reserved);
});

test('a diagnostic read of callback provenance cannot relabel a reconcile as an invoke', () => {
  const loaded = loadShippedImplementations();
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: 'cap-provenance',
    providerKind: 'local_registry',
    operationId: 'host_create',
    providerIdentity: 'local_registry',
    providerVersion: 'tool-registry-v1',
    operationVersion: '1',
    definitionFingerprint: 'd'.repeat(64),
    effect: 'external_write',
    destination: { family: 'workbook', posture: 'create_new' },
    accountId: 'acct-provenance',
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'created_resource' },
    evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
    provenance: { issuer: 'host:test', issuedAt: '2026-08-16T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
  });
  const reconcileFn = loaded.reconcileForSealedManifest(manifest);
  assert.equal(isShippedReconcile(reconcileFn), true);
  assert.equal(isShippedInvoke(reconcileFn), false);

  const peeked = peekShippedProvenance(reconcileFn);
  assert.ok(peeked, 'shipped reconcile must carry provenance');
  const reconcileDigest = shippedImplementationDigest('reconcile');
  assert.equal(peeked.kind, 'reconcile');
  assert.equal(peeked.artifactDigest, reconcileDigest);

  // A caller holding the diagnostic view must not be able to reach production authority.
  assert.throws(() => { (peeked as { kind: string }).kind = 'invoke'; });
  assert.throws(() => { (peeked as { artifactDigest: string }).artifactDigest = 'e'.repeat(64); });

  // Whatever the caller did to its copy, the host's answer is unchanged.
  assert.equal(isShippedInvoke(reconcileFn), false);
  assert.equal(isShippedReconcile(reconcileFn), true);
  assert.equal(peekShippedProvenance(reconcileFn)?.kind, 'reconcile');
  assert.equal(peekShippedProvenance(reconcileFn)?.artifactDigest, reconcileDigest);
  assert.equal(
    portImplementationDigest({ invoke: reconcileFn as never, reconcile: reconcileFn }, 'reconcile'),
    reconcileDigest,
  );
});

test('an artifact set emitted to a disposable root verifies against its own stamp', () => {
  // Hermetic build root: emitting elsewhere must not be judged by the identity
  // of the workspace artifact set, or artifact and stamp can never move
  // together. Runs in a child process because loading pins one generation.
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-hermetic-root-'));
  const script = `
    import { readFileSync } from 'node:fs';
    import path from 'node:path';
    import { emitShippedImplementationArtifacts, verifyShippedImplementationIdentity }
      from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/shipped-implementation-identity.ts'))};
    const root = process.env.HERMETIC_ROOT;
    const manifest = emitShippedImplementationArtifacts(root);
    const stamp = JSON.parse(readFileSync(path.join(root, 'build-stamp.json'), 'utf8'));
    if (stamp.implementationManifestDigest !== manifest.manifestDigest) process.exit(3);
    const verified = verifyShippedImplementationIdentity(root);
    if (!verified.ok) { process.stderr.write(verified.reason); process.exit(4); }
    for (const kind of ['invoke','reconcile','observer','transport','transportIsolated']) {
      if (stamp.artifacts[kind] !== verified.digests[kind]) process.exit(5);
    }
    process.stdout.write(verified.manifestDigest);
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: {
      ...process.env,
      HERMETIC_ROOT: root,
      CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-hermetic-home-')),
    },
  });
  assert.equal(child.status, 0, `${child.status} ${child.stderr}`);
  assert.match(child.stdout, /^[a-f0-9]{64}$/);
  assert.ok(existsSync(path.join(root, 'build-stamp.json')), 'an emitted set must carry its own stamp');
});

test('a co-located stamp that disagrees with its artifact set is refused', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-hermetic-bad-'));
  const script = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { emitShippedImplementationArtifacts, verifyShippedImplementationIdentity }
      from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/shipped-implementation-identity.ts'))};
    const root = process.env.HERMETIC_ROOT;
    emitShippedImplementationArtifacts(root);
    const file = path.join(root, 'build-stamp.json');
    const stamp = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...stamp, implementationManifestDigest: 'f'.repeat(64) }));
    const verified = verifyShippedImplementationIdentity(root);
    if (verified.ok) process.exit(3);
    process.stdout.write(verified.reason);
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: {
      ...process.env,
      HERMETIC_ROOT: root,
      CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-hermetic-bad-home-')),
    },
  });
  assert.equal(child.status, 0, `${child.status} ${child.stderr}`);
  assert.match(child.stdout, /build stamp/);
});
