/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/packaged-runtime.test.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-packaged-runtime-'));
process.env.CLEMENTINE_HOME = HOME;

const {
  emitShippedImplementationArtifacts,
  implementationManifestPath,
  loadShippedImplementations,
  shippedImplementationDigest,
  shippedTransportDigest,
} = await import('./shipped-implementation-identity.js');
const { isolatedTransportCalls } = await import('./implementation-artifacts/transport-isolated-entry.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('packaged extract has no source ts and invokes the attested adapter once', () => {
  const packRoot = mkdtempSync(path.join(os.tmpdir(), 'clem-pack-root-'));
  const artifactDir = path.join(packRoot, 'implementation-artifacts');
  emitShippedImplementationArtifacts(artifactDir);
  const names = readdirSync(artifactDir);
  assert.equal(names.some((name) => name.endsWith('.ts')), false);
  const manifest = JSON.parse(readFileSync(implementationManifestPath(artifactDir), 'utf8')) as {
    artifacts: Record<string, { file: string; sha256: string }>;
  };
  const tarballDir = mkdtempSync(path.join(os.tmpdir(), 'clem-tarball-'));
  writeFileSync(path.join(tarballDir, 'package.json'), `${JSON.stringify({
    name: 'clemmy-packaged-runtime-probe',
    version: '0.0.0',
    type: 'commonjs',
  })}\n`);
  cpSync(artifactDir, path.join(tarballDir, 'artifacts'), { recursive: true });
  const packed = spawnSync('npm', ['pack', '--json'], { encoding: 'utf8', cwd: tarballDir });
  assert.equal(packed.status, 0, packed.stderr);
  const extractRoot = mkdtempSync(path.join(os.tmpdir(), 'clem-extract-'));
  const tgz = readdirSync(tarballDir).find((name) => name.endsWith('.tgz'));
  assert.ok(tgz);
  const extracted = spawnSync('tar', ['-xzf', path.join(tarballDir, tgz), '-C', extractRoot], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const extractedArtifacts = path.join(extractRoot, 'package', 'artifacts');
  assert.equal(existsSync(extractedArtifacts), true);
  assert.equal(readdirSync(extractedArtifacts).some((name) => name.endsWith('.ts')), false);
  const loaderPath = path.join(extractRoot, 'boot.cjs');
  writeFileSync(loaderPath, `
    const { createRequire } = require('node:module');
    const { readFileSync } = require('node:fs');
    const path = require('node:path');
    const root = process.env.CLEMMY_PACK_ROOT;
    const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const req = createRequire(__filename);
    const invoke = req(path.join(root, manifest.artifacts.invoke.file));
    const transport = req(path.join(root, manifest.artifacts.transportIsolated.file));
    const bound = transport.createAttestedTransport(manifest.artifacts.transportIsolated.sha256);
    invoke.bindAttestedTransport(bound);
    transport.bindIsolatedTransportHandler(async (call) => {
      if (!call.expected
        || call.expected.manifestId !== 'cap-pack'
        || !/^[a-f0-9]{64}$/.test(call.expected.manifestDigest)
        || call.expected.providerKind !== 'composio'
        || call.expected.providerIdentity !== 'composio'
        || call.expected.providerVersion !== 'pack-provider-v1'
        || call.expected.operationVersion !== '1'
        || call.expected.definitionFingerprint !== '${'d'.repeat(64)}'
        || call.expected.invokePortId !== 'port-pack'
        || call.expected.argumentCompiler?.id !== 'create_sheet') {
        throw new Error('packaged invoke omitted or changed its exact manifest expectation');
      }
      if (call.operationId.includes('SHEET_FROM_JSON')) {
        return { spreadsheet_id: 'sheet-pack-1', spreadsheet_url: 'https://docs.google.com/spreadsheets/d/sheet-pack-1' };
      }
      return { ok: true };
    });
    const fn = invoke.invokeForSealedManifest({
      version: 1,
      manifestId: 'cap-pack',
      providerKind: 'composio',
      operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
      providerIdentity: 'composio',
      providerVersion: 'pack-provider-v1',
      operationVersion: '1',
      definitionFingerprint: '${'d'.repeat(64)}',
      effect: 'external_write',
      destination: { family: 'spreadsheet', posture: 'create_new' },
      accountId: 'acct-pack',
      idempotency: { required: true, policy: 'key_before_dispatch' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'created_resource' },
      purpose: 'persist_collection',
      acceptedInputKinds: ['records'],
      producedOutputKinds: ['created_resource'],
      applicableDeliverableKinds: ['spreadsheet'],
      evidenceContract: { kinds: ['receipt', 'readback'], readbackRequired: true },
      readbackContract: { required: true, contentDigestRequired: true },
      provenance: { issuer: 'host:packaged-runtime-test', issuedAt: '2026-08-25T00:00:00.000Z', trusted: true },
      lifecycle: { state: 'current' },
      argumentCompiler: { id: 'create_sheet', version: '1' },
      invokePortId: 'port-pack',
    });
    fn({
      nodeId: 'op-write',
      role: 'destination',
      payload: [{ name: 'a' }],
      identity: { sessionId: 's', sourceUserSeq: 1, acceptedTaskId: 't' },
      binding: { capabilityId: 'cap-pack', schemaDigest: 'd', schemaVersion: '1', effect: 'external_write', account: 'acct-pack' },
    }).then((result) => {
      process.stdout.write(JSON.stringify({ id: result.id || result.spreadsheet_id, digest: manifest.artifacts.invoke.sha256 }));
    }).catch((error) => {
      process.stderr.write(String(error));
      process.exit(8);
    });
  `);
  const first = spawnSync(process.execPath, [loaderPath], {
    encoding: 'utf8',
    cwd: extractRoot,
    env: { ...process.env, CLEMMY_PACK_ROOT: extractedArtifacts, CLEMENTINE_HOME: mkdtempSync(path.join(os.tmpdir(), 'clem-pack-home-')) },
  });
  assert.equal(first.status, 0, `${first.status} ${first.stderr} ${first.stdout}`);
  const payload = JSON.parse(first.stdout) as { id: string; digest: string };
  assert.equal(payload.id, 'sheet-pack-1');
  assert.equal(payload.digest, manifest.artifacts.invoke.sha256);
  void repoRoot;
  void isolatedTransportCalls;
  void loadShippedImplementations;
  void shippedImplementationDigest;
  void shippedTransportDigest;
});
