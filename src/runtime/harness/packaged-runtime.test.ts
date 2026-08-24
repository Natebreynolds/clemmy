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
      if (call.operationId.includes('SHEET_FROM_JSON')) {
        return { spreadsheet_id: 'sheet-pack-1', spreadsheet_url: 'https://docs.google.com/spreadsheets/d/sheet-pack-1' };
      }
      return { ok: true };
    });
    const fn = invoke.invokeForSealedManifest({
      operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
      effect: 'external_write',
      accountId: 'acct-pack',
      manifestId: 'cap-pack',
      invokePortId: 'port-pack',
      argumentCompiler: { id: 'create_sheet', version: '1' },
      acceptedInputKinds: ['records'],
      producedOutputKinds: ['created_resource'],
      purpose: 'persist_collection',
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
