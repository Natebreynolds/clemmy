/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/shipped-implementation-identity.test.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  readBuildStampsForTest,
  SRC_ARTIFACT_ROOT_FOR_TEST,
} = await import('./shipped-implementation-identity.js');

test('an ambient stamp beside the running module is consulted; one in a sibling build tree is not', () => {
  // A stamp that sits next to the running module describes the build that
  // produced it, and checking it is the point: packaged code and the artifacts
  // it loads must come from one build. A stamp reached by walking OUT of the
  // running tree describes a DIFFERENT artifact set.
  //
  // Running from source used to walk out to `<repo>/dist/runtime/build-stamp.json`.
  // Any developer tree whose dist was older than its emitted artifacts then
  // failed identity everywhere, and the typed-execution modules threw at import
  // so whole files died before a test ran — measured 2026-08-22 at ~125 of 163
  // suite failures from that one ignored, stale file.
  const tree = mkdtempSync(path.join(os.tmpdir(), 'clem-ambient-stamp-'));
  const moduleDir = path.join(tree, 'src', 'runtime', 'harness');
  const siblingBuild = path.join(tree, 'dist', 'runtime');
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(siblingBuild, { recursive: true });

  const foreign = { implementationManifestDigest: 'a'.repeat(64) };
  writeFileSync(path.join(siblingBuild, 'build-stamp.json'), JSON.stringify(foreign));

  assert.deepEqual(
    readBuildStampsForTest(SRC_ARTIFACT_ROOT_FOR_TEST, moduleDir)
      .filter((stamp) => stamp?.implementationManifestDigest === foreign.implementationManifestDigest),
    [],
    'a sibling build tree never judges the set being loaded',
  );

  // The packaged shape: the stamp lives one level above the running module,
  // which is exactly where an installed app puts it. That one still counts.
  const adjacent = { implementationManifestDigest: 'b'.repeat(64) };
  writeFileSync(path.join(tree, 'src', 'runtime', 'build-stamp.json'), JSON.stringify(adjacent));
  assert.ok(
    readBuildStampsForTest(SRC_ARTIFACT_ROOT_FOR_TEST, moduleDir)
      .some((stamp) => stamp?.implementationManifestDigest === adjacent.implementationManifestDigest),
    'a module-adjacent stamp is still enforced',
  );
});
const { registerProductionCapabilityPort, portImplementationDigest } = await import('./production-capability-ports.js');
const { attachSemanticContract } = await import('./capability-manifest.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const manifestFixtureScript = `
  import assert from 'node:assert/strict';
  import { createHash } from 'node:crypto';
  import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
  import os from 'node:os';
  import path from 'node:path';
  import { implementationArtifactPath, implementationManifestPath, verifyShippedImplementationIdentity,
    _fullIdentityVerificationsForTests } from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/shipped-implementation-identity.ts'))};
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-manifest-shape-'));
  const kinds = ['invoke', 'reconcile', 'observer', 'transport', 'transportIsolated'];
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const artifacts = Object.fromEntries(kinds.map((kind) => {
    const bytes = '// distinct fixture artifact: ' + kind;
    const sha256 = digest(bytes);
    const file = kind + '-' + sha256 + '.cjs';
    writeFileSync(path.join(root, file), bytes);
    return [kind, { file, sha256 }];
  }));
  const valid = { version: 3, artifacts, manifestDigest: digest(JSON.stringify({ version: 3, artifacts })) };
  const copy = () => JSON.parse(JSON.stringify(valid));
  const writeManifest = (manifest) => writeFileSync(implementationManifestPath(root), JSON.stringify(manifest));
`;

function runManifestFixture(script: string): void {
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', manifestFixtureScript + script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-manifest-shape-home-')) },
  });
  assert.equal(child.status, 0, `${child.status} ${child.stderr}`);
}

test('malformed manifest shapes refuse before cache enumeration or digesting', () => {
  runManifestFixture(`
    const cases = [
      ['null manifest', null], ['array manifest', []], ['number manifest', 3], ['string manifest', 'manifest'],
      ['unsupported version with malformed entry', { ...valid, version: 2, artifacts: { invoke: {} } }],
      ['null artifacts', { ...valid, artifacts: null }],
      ['array artifacts', { ...valid, artifacts: [] }],
      ['string artifacts', { ...valid, artifacts: 'artifacts' }],
      ['non-string manifest digest', { ...valid, manifestDigest: 12 }],
    ];
    for (const kind of kinds) {
      const missing = copy();
      delete missing.artifacts[kind];
      cases.push(['missing ' + kind, missing]);
      for (const entry of [null, [], false, 7, 'entry', {}, { file: artifacts[kind].file }]) {
        const malformed = copy();
        malformed.artifacts[kind] = entry;
        cases.push(['invalid ' + kind + ' entry ' + JSON.stringify(entry), malformed]);
      }
      for (const field of ['file', 'sha256']) {
        for (const value of [null, [], {}, 7, true, '']) {
          const malformed = copy();
          malformed.artifacts[kind][field] = value;
          cases.push(['invalid ' + kind + '.' + field + ' ' + JSON.stringify(value), malformed]);
        }
      }
    }
    for (const entry of [null, [], 7, {}, { file: 7, sha256: 'a'.repeat(64) }]) {
      const malformed = copy();
      malformed.artifacts.extra = entry;
      cases.push(['malformed additional entry ' + JSON.stringify(entry), malformed]);
    }
    for (const [label, manifest] of cases) {
      writeManifest(manifest);
      const result = verifyShippedImplementationIdentity(root);
      assert.equal(result.ok, false, label);
      assert.match(result.reason, /implementation manifest .*malformed/, label);
      assert.throws(() => implementationArtifactPath('invoke', root), /implementation manifest .*malformed/, label);
    }
  `);
});

test('manifest cache recovers from a malformed replacement without reusing prior success', () => {
  runManifestFixture(`
    writeManifest(valid);
    const first = verifyShippedImplementationIdentity(root);
    assert.equal(first.ok, true);
    const baseline = _fullIdentityVerificationsForTests();
    for (let index = 0; index < 1000; index += 1) {
      assert.deepEqual(verifyShippedImplementationIdentity(root), first);
    }
    assert.equal(_fullIdentityVerificationsForTests(), baseline, 'warm verification remains stat-only');

    for (const replacement of [null, { ...valid, artifacts: { ...artifacts, invoke: {} } }]) {
      writeManifest(replacement);
      assert.equal(verifyShippedImplementationIdentity(root).ok, false, 'changed malformed bytes invalidate success');
      writeManifest(valid);
      const before = _fullIdentityVerificationsForTests();
      assert.deepEqual(verifyShippedImplementationIdentity(root), first, 'restored exact generation verifies again');
      assert.equal(_fullIdentityVerificationsForTests(), before + 1, 'recovery performs a full verification');
      assert.deepEqual(verifyShippedImplementationIdentity(root), first);
      assert.equal(_fullIdentityVerificationsForTests(), before + 1, 'recovered success is cached');
    }

    const artifact = path.join(root, artifacts.invoke.file);
    writeFileSync(artifact, readFileSync(artifact, 'utf8') + '\\n// tampered');
    const tampered = verifyShippedImplementationIdentity(root);
    assert.equal(tampered.ok, false);
    assert.match(tampered.reason, /artifact does not match the implementation manifest/);
  `);
});

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

test('an unchanged artifact set is verified once, and a change after that is still refused', () => {
  // Live 2026-10-19: the first chat after start (or after a model switch) held
  // the service thread 18-62 s re-reading and re-hashing these same files once
  // per stored capability. The check must stay exact without that cost. Runs
  // in a child process because loading pins one generation.
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-shipped-cached-'));
  const script = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import path from 'node:path';
    import { emitShippedImplementationArtifacts, implementationArtifactPath, verifyShippedImplementationIdentity,
      installImplementationArtifactRoot, loadShippedImplementations,
      _fullIdentityVerificationsForTests } from ${JSON.stringify(path.join(repoRoot, 'src/runtime/harness/shipped-implementation-identity.ts'))};
    const root = process.env.CACHED_ROOT;
    emitShippedImplementationArtifacts(root);
    const before = _fullIdentityVerificationsForTests();
    const first = verifyShippedImplementationIdentity(root);
    if (!first.ok) { process.stderr.write(first.reason); process.exit(3); }
    for (let index = 0; index < 1000; index += 1) {
      if (JSON.stringify(verifyShippedImplementationIdentity(root)) !== JSON.stringify(first)) process.exit(4);
    }
    if (_fullIdentityVerificationsForTests() - before > 1) process.exit(5);
    const observer = implementationArtifactPath('observer', root);
    writeFileSync(observer, readFileSync(observer, 'utf8') + '\\n// tampered after verification\\n');
    if (verifyShippedImplementationIdentity(root).ok) process.exit(6);
    emitShippedImplementationArtifacts(root);
    if (!verifyShippedImplementationIdentity(root).ok) process.exit(7);
    writeFileSync(path.join(root, 'build-stamp.json'), JSON.stringify({ implementationManifestDigest: 'f'.repeat(64) }));
    if (verifyShippedImplementationIdentity(root).ok) process.exit(8);
    emitShippedImplementationArtifacts(root);
    const otherRoot = root + '-other';
    emitShippedImplementationArtifacts(otherRoot);
    if (!verifyShippedImplementationIdentity(otherRoot).ok) process.exit(9);
    installImplementationArtifactRoot(root);
    loadShippedImplementations();
    if (!verifyShippedImplementationIdentity(root).ok) process.exit(10);
    const otherGeneration = verifyShippedImplementationIdentity(otherRoot);
    if (otherGeneration.ok || !otherGeneration.reason.includes('generation changed')) process.exit(11);
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, CACHED_ROOT: root, CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-shipped-cached-home-')) },
  });
  // 4: a cached read differed; 5: more than one full read and hash; 6/8: a
  // change after verification was accepted; 7: a fresh set was refused;
  // 9/10: an unchanged set was refused; 11: a warm cache bypassed the process pin.
  assert.equal(child.status, 0, `${child.status} ${child.stderr}`);
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
  // This checks the file list after explicit emission. Actual prepack/build
  // and packaged smoke remain separate release gates, including vendored assets.
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--dry-run', '--json'], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
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
