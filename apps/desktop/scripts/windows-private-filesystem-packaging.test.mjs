import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertAclProbeAuthenticodeEnvelope, bindPackagedWindowsAclProbe, verifyPackagedWindowsAclProbe } from './windows-private-filesystem-packaging.mjs';
import { PROBE_FILENAME, PROBE_RESPONSE, WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER } from './build-windows-private-filesystem-probe.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const optional = 0x80 + 24, checksum = optional + 64, security = optional + 144;
function canonicalPe() {
  const bytes = Buffer.alloc(0x400);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 60); bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94);
  bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(16, optional + 108);
  const section = optional + 240; bytes.writeUInt32LE(0x200, section + 16); bytes.writeUInt32LE(0x200, section + 20);
  bytes.fill(0x63, 0x200); return bytes;
}
function envelopeFixture(original, padded = false) {
  // Layout fixture only. This is not an actual signed/trusted certificate.
  const bytes = Buffer.concat([original, Buffer.alloc(16)]);
  bytes.writeUInt32LE(0x12345678, checksum); bytes.writeUInt32LE(original.length, security); bytes.writeUInt32LE(16, security + 4);
  const start = original.length; bytes.writeUInt32LE(padded ? 12 : 16, start);
  bytes.writeUInt16LE(0x200, start + 4); bytes.writeUInt16LE(2, start + 6);
  Buffer.from(padded ? [0x30, 2, 1, 2] : [0x30, 6, 1, 2, 3, 4, 5, 6]).copy(bytes, start + 8);
  return bytes;
}

test('byte equivalence admits unchanged helper and only documented checksum/security/certificate envelope changes', () => {
  const original = canonicalPe();
  assert.deepEqual(assertAclProbeAuthenticodeEnvelope(original, Buffer.from(original)), { kind: 'unchanged', certificateRecords: 0 });
  assert.deepEqual(assertAclProbeAuthenticodeEnvelope(original, envelopeFixture(original)), { kind: 'authenticode-envelope-only', certificateRecords: 1 });
  assert.deepEqual(assertAclProbeAuthenticodeEnvelope(original, envelopeFixture(original, true)), { kind: 'authenticode-envelope-only', certificateRecords: 1 });
});

test('code/import/resource/section/header mutations cannot be blessed by attaching a certificate envelope', () => {
  const original = canonicalPe();
  for (const location of [0x250, optional + 112, optional + 128, optional + 56, optional + 240 + 8]) {
    const candidate = envelopeFixture(original); candidate[location] ^= 1;
    assert.throws(() => assertAclProbeAuthenticodeEnvelope(original, candidate), /beyond/);
  }
  assert.throws(() => assertAclProbeAuthenticodeEnvelope(Buffer.concat([original, Buffer.from('overlay')]), envelopeFixture(Buffer.concat([original, Buffer.from('overlay')]))), /beyond/);
});

test('malformed certificate headers, padding, placement and trailing overlays are refused', () => {
  const original = canonicalPe();
  const mutations = [
    candidate => candidate.writeUInt16LE(1, original.length + 6),
    candidate => candidate.writeUInt16LE(0x100, original.length + 4),
    candidate => candidate.writeUInt32LE(100, original.length),
    candidate => candidate.writeUInt32LE(original.length - 8, security),
    candidate => { candidate[original.length + 8] = 0x31; },
    candidate => { candidate[original.length + 9] = 100; },
  ];
  for (const mutate of mutations) {
    const candidate = envelopeFixture(original); mutate(candidate);
    assert.throws(() => assertAclProbeAuthenticodeEnvelope(original, candidate), /beyond/);
  }
  const padded = envelopeFixture(original, true); padded[padded.length - 1] = 1;
  assert.throws(() => assertAclProbeAuthenticodeEnvelope(original, padded), /beyond/);
  assert.throws(() => assertAclProbeAuthenticodeEnvelope(original, Buffer.concat([envelopeFixture(original), Buffer.from('overlay')])), /beyond/);
});

test('afterPack binds final exact bytes while retaining canonical hash and no signature-trust verdict', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-probe-sign-binding-'));
  const sourceDirectory = path.join(root, 'source'), resourcesDirectory = path.join(root, 'resources');
  const destination = path.join(resourcesDirectory, 'windows-private-filesystem');
  mkdirSync(sourceDirectory, { recursive: true }); mkdirSync(destination, { recursive: true });
  const classSource = 'controlled canonical class', original = canonicalPe(), packaged = envelopeFixture(original);
  const manifest = { version: 2, target: 'windows-x64-netframework4', classSourceSha256: sha(classSource),
    driverSourceSha256: sha(WINDOWS_PRIVATE_FILESYSTEM_JSON_DRIVER), probeSha256: sha(original), probeBytes: original.length,
    compilerSha256: 'a'.repeat(64), references: [{ name: 'controlled-reference.dll', sha256: 'b'.repeat(64) }],
    deterministic: true, response: PROBE_RESPONSE, credentialOperations: 0, providerCalls: 0 };
  try {
    for (const directory of [sourceDirectory, destination]) writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(path.join(sourceDirectory, PROBE_FILENAME), original); writeFileSync(path.join(destination, PROBE_FILENAME), packaged);
    const args = { sourceDirectory, resourcesDirectory, classSource };
    const bound = bindPackagedWindowsAclProbe(args);
    assert.equal(bound.canonicalProbeSha256, sha(original)); assert.equal(bound.probeSha256, sha(packaged));
    assert.equal(bound.signatureTrustQualified, false); assert.deepEqual(verifyPackagedWindowsAclProbe(args), bound);
    const retained = readFileSync(path.join(destination, 'manifest.json'));
    writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ ...bound, references: [] }));
    assert.throws(() => verifyPackagedWindowsAclProbe(args), /canonical build identity/);
    writeFileSync(path.join(destination, 'manifest.json'), retained);
    packaged[0x250] ^= 1; writeFileSync(path.join(destination, PROBE_FILENAME), packaged);
    assert.throws(() => verifyPackagedWindowsAclProbe(args), /canonical/);
    assert.deepEqual(readFileSync(path.join(destination, 'manifest.json')), retained, 'refusal does not rehash or rebless changed code');
    assert.deepEqual(JSON.parse(readFileSync(path.join(sourceDirectory, 'manifest.json'), 'utf8')), manifest);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
