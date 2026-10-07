import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assertWindowsAclProbeManifest, PROBE_FILENAME } from './build-windows-private-filesystem-probe.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = () => { throw new Error('Packaged Windows ACL probe differs beyond the permitted Authenticode envelope.'); };

function peFields(bytes) {
  if (bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d) refuse();
  const pe = bytes.readUInt32LE(60);
  if (pe < 64 || pe + 24 > bytes.length || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== 0x8664) refuse();
  const optional = pe + 24, optionalSize = bytes.readUInt16LE(pe + 20);
  const sections = bytes.readUInt16LE(pe + 6), sectionTable = optional + optionalSize;
  if (optionalSize < 152 || sectionTable > bytes.length || bytes.readUInt16LE(optional) !== 0x20b
    || bytes.readUInt32LE(optional + 108) < 5 || sections < 1 || sections > 96 || sectionTable + sections * 40 > bytes.length) refuse();
  const ranges = [];
  for (let index = 0; index < sections; index += 1) {
    const entry = sectionTable + index * 40;
    const count = bytes.readUInt32LE(entry + 16), start = bytes.readUInt32LE(entry + 20);
    if (!count) continue;
    if (start < sectionTable + sections * 40 || start + count > bytes.length) refuse();
    ranges.push([start, start + count]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (!ranges.length || ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1])) refuse();
  return { checksum: optional + 64, security: optional + 144, lastSectionEnd: ranges.at(-1)[1] };
}

function checkCertificateTable(bytes, start, count) {
  const end = start + count;
  let offset = start, records = 0;
  while (offset < end) {
    if (++records > 4 || offset + 10 > end) refuse();
    const length = bytes.readUInt32LE(offset);
    if (length < 10 || offset + length > end || bytes.readUInt16LE(offset + 4) !== 0x200 || bytes.readUInt16LE(offset + 6) !== 2) refuse();
    const payload = offset + 8;
    if (bytes[payload] !== 0x30) refuse();
    let header = 2, dataLength = bytes[payload + 1];
    if (dataLength & 0x80) {
      const width = dataLength & 0x7f;
      if (width < 1 || width > 4 || payload + 2 + width > offset + length || bytes[payload + 2] === 0) refuse();
      dataLength = 0; header += width;
      for (let index = 0; index < width; index += 1) dataLength = dataLength * 256 + bytes[payload + 2 + index];
      if (dataLength < 128) refuse();
    }
    const derEnd = payload + header + dataLength;
    if (derEnd > offset + length || offset + length - derEnd > 7) refuse();
    const alignedEnd = offset + Math.ceil(length / 8) * 8;
    if (alignedEnd > end || bytes.subarray(derEnd, alignedEnd).some(byte => byte !== 0)) refuse();
    offset = alignedEnd;
  }
  if (offset !== end || records === 0) refuse();
  return records;
}

/** Exact canonical bytes, allowing only Microsoft's documented PE checksum,
 * certificate-table directory and appended WIN_CERTIFICATE envelope:
 * https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
 * This is byte provenance, never a signature/trust verification verdict. */
export function assertAclProbeAuthenticodeEnvelope(canonical, packaged) {
  const original = peFields(canonical), final = peFields(packaged);
  if (canonical.readUInt32LE(original.security) !== 0 || canonical.readUInt32LE(original.security + 4) !== 0
    || original.lastSectionEnd !== canonical.length || final.checksum !== original.checksum || final.security !== original.security) refuse();
  if (canonical.equals(packaged)) return { kind: 'unchanged', certificateRecords: 0 };
  const certificateStart = packaged.readUInt32LE(final.security), certificateBytes = packaged.readUInt32LE(final.security + 4);
  if (!certificateBytes || certificateBytes > 1024 * 1024 || certificateStart !== Math.ceil(canonical.length / 8) * 8
    || certificateStart + certificateBytes !== packaged.length || final.lastSectionEnd !== original.lastSectionEnd
    || packaged.subarray(canonical.length, certificateStart).some(byte => byte !== 0)) refuse();
  const prefix = Buffer.from(packaged.subarray(0, canonical.length));
  canonical.copy(prefix, original.checksum, original.checksum, original.checksum + 4);
  canonical.copy(prefix, original.security, original.security, original.security + 8);
  if (!prefix.equals(canonical)) refuse();
  return { kind: 'authenticode-envelope-only', certificateRecords: checkCertificateTable(packaged, certificateStart, certificateBytes) };
}

export function bindPackagedWindowsAclProbe({ sourceDirectory, resourcesDirectory, classSource }) {
  const original = assertWindowsAclProbeManifest(sourceDirectory, classSource);
  const destination = path.join(resourcesDirectory, 'windows-private-filesystem');
  const copied = JSON.parse(readFileSync(path.join(destination, 'manifest.json'), 'utf8'));
  if (JSON.stringify(copied) !== JSON.stringify(original)) throw new Error('Copied Windows ACL probe manifest changed before signing binding.');
  const canonical = readFileSync(path.join(sourceDirectory, PROBE_FILENAME));
  const packaged = readFileSync(path.join(destination, PROBE_FILENAME));
  const envelope = assertAclProbeAuthenticodeEnvelope(canonical, packaged);
  const manifest = { ...original, canonicalProbeSha256: original.probeSha256, canonicalProbeBytes: original.probeBytes,
    probeSha256: sha256(packaged), probeBytes: packaged.length,
    packagingBinding: 'exact-canonical-authenticode-envelope-v1', envelope,
    signatureTrustQualified: false };
  const target = path.join(destination, 'manifest.json'), temporary = `${target}.sign-binding.tmp`;
  try { writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
  return manifest;
}

export function verifyPackagedWindowsAclProbe({ sourceDirectory, resourcesDirectory, classSource }) {
  const original = assertWindowsAclProbeManifest(sourceDirectory, classSource);
  const destination = path.join(resourcesDirectory, 'windows-private-filesystem');
  const manifest = assertWindowsAclProbeManifest(destination, classSource);
  const canonical = readFileSync(path.join(sourceDirectory, PROBE_FILENAME)), packaged = readFileSync(path.join(destination, PROBE_FILENAME));
  const envelope = assertAclProbeAuthenticodeEnvelope(canonical, packaged);
  for (const [field, value] of Object.entries(original)) {
    if (!['probeSha256', 'probeBytes'].includes(field) && JSON.stringify(manifest[field]) !== JSON.stringify(value)) {
      throw new Error('Packaged Windows ACL canonical build identity changed.');
    }
  }
  if (manifest.canonicalProbeSha256 !== original.probeSha256 || manifest.canonicalProbeBytes !== original.probeBytes
    || manifest.packagingBinding !== 'exact-canonical-authenticode-envelope-v1'
    || JSON.stringify(manifest.envelope) !== JSON.stringify(envelope) || manifest.signatureTrustQualified !== false) {
    throw new Error('Packaged Windows ACL canonical/signing binding is missing.');
  }
  return manifest;
}
