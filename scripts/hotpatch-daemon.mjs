/** Stage a daemon-only patch before replacing installed bytes. Keep rollback.
 * Run after quitting Clementine: node --import tsx scripts/hotpatch-daemon.mjs
 * --check inspects the candidate without changing or stopping the application.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function treeDigest(root) {
  const hash = createHash('sha256');
  function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected build symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify([relative, stat.size]));
      hash.update(fs.readFileSync(absolute));
    } else throw new Error(`Unexpected build entry: ${relative}`);
  }
  visit('');
  return hash.digest('hex');
}

export function inspectDaemonBuild(sourceDist) {
  if (!fs.statSync(path.join(sourceDist, 'index.js')).isFile()) throw new Error('Daemon entry point missing. Run npm run build.');
  const stamp = JSON.parse(fs.readFileSync(path.join(sourceDist, 'runtime/build-stamp.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(stamp.gitSha ?? '') || !/^[a-f0-9]{64}$/.test(stamp.sourceFingerprint ?? '')) {
    throw new Error('Daemon build stamp is invalid. Run npm run build.');
  }
  return { stamp, digest: treeDigest(sourceDist) };
}

/** The owner's install has lived in both /Applications and ~/Applications
 * (2026-09-14: the running 3.18.7 was ~/Applications while /Applications held a
 * root-owned 3.18.6). Patch the newest existing bundle; CLEMENTINE_APP_PATH
 * overrides. Never patch a bundle that is not the one the owner launches. */
export function resolveInstalledAppBundle(candidates, readDaemonVersion) {
  const found = [];
  for (const bundle of candidates) {
    let version = null;
    try { version = readDaemonVersion(bundle); } catch { continue; }
    if (typeof version === 'string' && version.trim()) found.push({ bundle, version: version.trim() });
  }
  if (found.length === 0) throw new Error(`No installed Clementine bundle among: ${candidates.join(', ')}`);
  const parse = (v) => v.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  found.sort((a, b) => {
    const left = parse(a.version); const right = parse(b.version);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const l = left[index]; const r = right[index];
      if (l === r) continue;
      if (l === undefined) return 1;
      if (r === undefined) return -1;
      if (typeof l === 'number' && typeof r === 'number') return r - l;
      return String(r).localeCompare(String(l));
    }
    return 0;
  });
  return found[0];
}

/** The native parts of a bundle: what launches, declares and seals it. A
 * guarded patch never writes them and proves they did not change. */
export const SEALED_SHELL_PARTS = Object.freeze([
  'Contents/MacOS/Clementine',
  'Contents/Info.plist',
  'Contents/Resources/app.asar',
  'Contents/_CodeSignature/CodeResources',
]);

const GUARDED_PATCHES = new WeakSet();

/** Exactly the four runtime roots replaced by the combined installer. A repeat
 * admission never exempts other resources or wildcard rollback directories. */
export const AUTHORIZED_RUNTIME_PARTS = Object.freeze({
  daemon: 'Contents/Resources/daemon/dist',
  'builtin-skills': 'Contents/Resources/daemon/builtin-skills',
  'console-web': 'Contents/Resources/daemon/apps/console-web/dist',
  'mobile-web': 'Contents/Resources/daemon/apps/mobile-web/dist',
});
const REPEAT_PATCHES = new WeakMap();
const DESKTOP_TEAM_IDENTIFIER = '4AR3Y8XD72';

function sameEvidence(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) guardRefusal(`${label} changed or differs`);
}

function safeRelative(value) {
  if (typeof value !== 'string' || /[\\\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) guardRefusal('unsafe reference entry path');
  return value;
}

function safeLink(root, relative, target) {
  if (!target || path.isAbsolute(target) || /[\\\x00-\x1f\x7f]/.test(target)) guardRefusal('unsafe reference symlink');
  const resolved = path.resolve(root, path.dirname(relative), target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) guardRefusal('reference symlink escapes the bundle');
}

/** Include directory roots, empty directories, permissions and link targets.
 * Never follow framework links; their exact entries must match the archive. */
function typedTree(root, fileOps = fs, { excluded = [], links = false } = {}) {
  regularPath(root, fileOps, true);
  const entries = []; const names = new Set();
  const visit = (relative) => {
    const key = relative.normalize('NFC').toLowerCase();
    if (names.has(key)) guardRefusal('case or Unicode alias in reference tree');
    names.add(key);
    if (excluded.some(rel => relative === rel || relative.startsWith(rel + '/'))) return;
    if (relative) safeRelative(relative);
    const absolute = path.join(root, relative); const stat = fileOps.lstatSync(absolute);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      if (!links) guardRefusal('unexpected runtime symlink');
      const raw = fileOps.readlinkSync(absolute, { encoding: 'buffer' });
      const target = raw.toString('utf8');
      if (!Buffer.from(target).equals(raw)) guardRefusal('invalid reference symlink encoding');
      safeLink(root, relative, target);
      entries.push([relative, 'link', mode, target]);
    } else if (stat.isDirectory()) {
      entries.push([relative, 'directory', mode]);
      for (const name of fileOps.readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      if (!links && stat.nlink !== 1) guardRefusal('unexpected runtime hard link');
      entries.push([relative, 'file', mode, fileDigest(absolute, 'sha256', 'hex', fileOps)]);
    } else guardRefusal('unexpected reference or runtime entry type');
  };
  visit('');
  return entries.sort((a, b) => a[0].localeCompare(b[0], 'en'));
}

/** Full typed archive inventory: the signed reference must come from the exact
 * retained official archive, rather than another validly signed application. */
function archivedBundleTree(archive, bundleName, fileOps = fs) {
  regularPath(archive, fileOps);
  const fd = fileOps.openSync(archive, 'r'); const length = fileOps.fstatSync(fd).size;
  const read = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > length) guardRefusal('invalid reference ZIP bounds');
    const buffer = Buffer.alloc(size);
    if (fileOps.readSync(fd, buffer, 0, size, offset) !== size) guardRefusal('incomplete reference ZIP');
    return buffer;
  };
  try {
    const tail = read(Math.max(0, length - 65557), Math.min(length, 65557)); let end = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) guardRefusal('unsupported reference ZIP directory');
    const count = tail.readUInt16LE(end + 10); const directorySize = tail.readUInt32LE(end + 12); const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 65535 || count !== tail.readUInt16LE(end + 8) || directorySize > 32 * 1024 * 1024) guardRefusal('unsupported reference ZIP size');
    const directory = read(directoryOffset, directorySize); const entries = []; const names = new Set(); let cursor = 0;
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) guardRefusal('malformed reference ZIP entry');
      const flags = directory.readUInt16LE(cursor + 8); const compression = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20); const size = directory.readUInt32LE(cursor + 24);
      const nameSize = directory.readUInt16LE(cursor + 28); const extraSize = directory.readUInt16LE(cursor + 30); const commentSize = directory.readUInt16LE(cursor + 32);
      const rawMode = directory.readUInt32LE(cursor + 38) >>> 16; const kind = rawMode & 0o170000; const mode = rawMode & 0o7777; const offset = directory.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameSize + extraSize + commentSize;
      if (next > directory.length || (flags & 1) || ![0, 8].includes(compression) || size > 512 * 1024 * 1024) guardRefusal('unsupported reference ZIP entry');
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameSize); const name = nameBytes.toString('utf8');
      if (!Buffer.from(name).equals(nameBytes) || !name.startsWith(bundleName + '/')) guardRefusal('reference ZIP bundle or encoding differs');
      const isDirectory = kind === 0o040000; const relative = name.slice(bundleName.length + 1).replace(/\/$/, '');
      if (relative) safeRelative(relative);
      if (name.endsWith('/') !== isDirectory || ![0o040000, 0o100000, 0o120000].includes(kind)) guardRefusal('unexpected reference ZIP entry type');
      const key = relative.normalize('NFC').toLowerCase();
      if (names.has(key)) guardRefusal('duplicate or aliased reference ZIP entry');
      names.add(key);
      const header = read(offset, 30);
      if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== compression) guardRefusal('reference ZIP header mismatch');
      const localNameSize = header.readUInt16LE(26);
      if (!read(offset + 30, localNameSize).equals(nameBytes)) guardRefusal('reference ZIP local name mismatch');
      const bytes = read(offset + 30 + localNameSize + header.readUInt16LE(28), compressedSize);
      const content = compression === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
      if (content.length !== size || (isDirectory && size)) guardRefusal('reference ZIP size mismatch');
      if (isDirectory) entries.push([relative, 'directory', mode]);
      else if (kind === 0o120000) {
        const target = content.toString('utf8');
        if (!Buffer.from(target).equals(content)) guardRefusal('invalid reference ZIP link encoding');
        safeLink(path.resolve('/', bundleName), relative, target);
        entries.push([relative, 'link', mode, target]);
      } else entries.push([relative, 'file', mode, createHash('sha256').update(content).digest('hex')]);
      cursor = next;
    }
    if (cursor !== directory.length || !entries.some(entry => entry[0] === '' && entry[1] === 'directory')) guardRefusal('reference ZIP bundle root missing');
    const directories = new Set(entries.filter(entry => entry[1] === 'directory').map(entry => entry[0]));
    for (const [relative] of entries) if (relative && !directories.has(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative))) guardRefusal('reference ZIP parent directory missing or aliased');
    return entries.sort((a, b) => a[0].localeCompare(b[0], 'en'));
  } finally { fileOps.closeSync(fd); }
}

function referenceCodeIdentity(bundle) {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { encoding: 'utf8' });
  if (result.error || result.status !== 0) guardRefusal('cannot read signed reference identity');
  const read = key => {
    const matches = [...`${result.stdout}\n${result.stderr}`.matchAll(new RegExp(`^${key}=(.+)$`, 'gm'))];
    if (matches.length !== 1) guardRefusal('ambiguous signed reference identity');
    return matches[0][1];
  };
  return { bundleId: read('Identifier'), team: read('TeamIdentifier'), cdHash: read('CDHash') };
}

function legacyAssetDigest(root, fileOps) {
  const hash = createHash('sha256');
  const walk = relative => {
    const absolute = path.join(root, relative); const stat = fileOps.lstatSync(absolute);
    if (stat.isDirectory()) for (const name of fileOps.readdirSync(absolute).sort()) walk(path.join(relative, name));
    else if (stat.isFile()) { hash.update(relative); hash.update(fileOps.readFileSync(absolute)); }
    else guardRefusal('unexpected runtime entry in historical digest');
  };
  walk(''); return hash.digest('hex');
}

const REPEAT_REFERENCE_KEYS = Object.freeze(['referenceBundle', 'authorizedReceipt', 'authorizedReceiptSha256', 'expectedPriorFingerprint', 'expectedReferenceCdHash', 'authorizedAncestorManifest', 'authorizedAncestorManifestSha256']);

/** Pins authenticate bytes, never a success flag. Refuse ambiguous JSON keys
 * at every nesting level rather than silently choosing the last value. */
function pinnedRepeatJSON(absolute, sha256, fileOps, limit = 512 * 1024) {
  if (typeof absolute !== 'string' || !absolute || path.resolve(absolute) !== absolute || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) guardRefusal('missing canonical receipt/manifest path or hash pin');
  regularPath(absolute, fileOps);
  const stat = fileOps.lstatSync(absolute);
  if (fileOps.realpathSync(absolute) !== absolute || stat.nlink !== 1 || stat.size > limit) guardRefusal('aliased or oversized receipt/manifest evidence');
  const bytes = fileOps.readFileSync(absolute);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) guardRefusal('historical authorized receipt or manifest hash differs');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) guardRefusal('invalid receipt/manifest encoding');
  const value = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g) ?? [];
  let cursor = 0;
  const visit = () => {
    const token = tokens[cursor++];
    if (token === '{') {
      const keys = new Set();
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++]);
        if (keys.has(key)) guardRefusal('duplicate receipt/manifest JSON keys');
        keys.add(key); cursor += 1; visit();
        if (tokens[cursor] === ',') cursor += 1;
      }
      cursor += 1;
    } else if (token === '[') {
      while (tokens[cursor] !== ']') { visit(); if (tokens[cursor] === ',') cursor += 1; }
      cursor += 1;
    }
  };
  visit();
  return value;
}

function repeatReceiptChain(options, context, fileOps) {
  if (Object.keys(options).some(key => !REPEAT_REFERENCE_KEYS.includes(key))) guardRefusal('unknown repeat-install authority option');
  const { authorizedAncestorManifest, authorizedAncestorManifestSha256, authorizedReceipt, authorizedReceiptSha256, expectedPriorFingerprint } = options;
  const hasManifest = authorizedAncestorManifest !== undefined || authorizedAncestorManifestSha256 !== undefined;
  let ancestors = []; let manifest = null;
  if (hasManifest) {
    const value = pinnedRepeatJSON(authorizedAncestorManifest, authorizedAncestorManifestSha256, fileOps, 64 * 1024);
    if (!value || Object.keys(value).sort().join('|') !== 'receipts|version' || value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.length < 1 || value.receipts.length > 26) guardRefusal('unsupported bounded ancestor manifest');
    ancestors = value.receipts;
    if (ancestors.some(item => !item || Object.keys(item).sort().join('|') !== 'path|sha256')) guardRefusal('unexpected ancestor receipt pin shape');
    manifest = { path: authorizedAncestorManifest, sha256: authorizedAncestorManifestSha256 };
    if (manifest.path === context.bundle || manifest.path.startsWith(context.bundle + path.sep)) guardRefusal('ancestor manifest must be outside the installed bundle');
  }
  const files = [...ancestors, { path: authorizedReceipt, sha256: authorizedReceiptSha256 }];
  const paths = new Set(); const hashes = new Set(); const inodes = new Set();
  if (manifest) paths.add(manifest.path.normalize('NFC').toLowerCase());
  const receipts = files.map((pin, index) => {
    const receipt = pinnedRepeatJSON(pin.path, pin.sha256, fileOps);
    const key = pin.path.normalize('NFC').toLowerCase(); const stat = fileOps.lstatSync(pin.path); const inode = `${stat.dev}:${stat.ino}`;
    if (paths.has(key) || hashes.has(pin.sha256) || inodes.has(inode) || pin.path === context.bundle || pin.path.startsWith(context.bundle + path.sep)) guardRefusal('duplicate or aliased ancestor receipt evidence');
    paths.add(key); hashes.add(pin.sha256); inodes.add(inode);
    if (!receipt || receipt.bundle !== context.bundle || receipt.wasVersion !== context.observed.identity.version || !/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint ?? '') || Object.keys(receipt.parts ?? {}).sort().join('|') !== Object.keys(AUTHORIZED_RUNTIME_PARTS).sort().join('|')) guardRefusal('historical receipt identity or runtime roots differ');
    if (index === files.length - 1 && receipt.sourceFingerprint !== expectedPriorFingerprint) guardRefusal('latest receipt fingerprint differs from its pin');
    for (const [name, part] of Object.entries(receipt.parts)) {
      const digest = name === 'daemon' ? part?.digest : part?.built;
      if (!/^[a-f0-9]{64}$/.test(digest ?? '') || part.served !== digest) guardRefusal('historical receipt runtime digest differs');
    }
    return receipt;
  });
  return { receipts, files: files.map(pin => ({ ...pin })), manifest };
}

function receiptRuntimeFootprint(target, name, receipt, fileOps) {
  const footprint = typedTree(target, fileOps);
  if (footprint.some(entry => entry[2] !== (entry[1] === 'directory' ? 0o755 : 0o644))) guardRefusal('historical runtime permissions are not ordinary packaged assets');
  const daemon = name === 'daemon' ? inspectDaemonBuild(target) : null;
  const digest = daemon ? daemon.digest : legacyAssetDigest(target, fileOps);
  const expected = name === 'daemon' ? receipt.parts[name].digest : receipt.parts[name].built;
  if (digest !== expected) guardRefusal('runtime differs from its ordered authorized receipt');
  if (daemon && daemon.stamp.sourceFingerprint !== receipt.sourceFingerprint) guardRefusal('runtime fingerprint differs from its ordered authorized receipt');
  return footprint;
}

function inspectRepeatReference(options, context, fileOps) {
  const { referenceBundle, authorizedReceipt, authorizedReceiptSha256, expectedPriorFingerprint, expectedReferenceCdHash } = options;
  if (![authorizedReceiptSha256, expectedPriorFingerprint].every(value => /^[a-f0-9]{64}$/.test(value ?? '')) || !/^[a-f0-9]{40}$/.test(expectedReferenceCdHash ?? '')) guardRefusal('missing exact repeat-install identity pins');
  if (typeof referenceBundle !== 'string' || !referenceBundle || typeof authorizedReceipt !== 'string' || !authorizedReceipt) guardRefusal('missing exact repeat-install evidence paths');
  const optionSnapshot = JSON.parse(JSON.stringify(options));
  const reference = path.resolve(referenceBundle);
  regularPath(reference, fileOps, true);
  if (fileOps.realpathSync(reference) !== reference || reference === context.bundle || reference.startsWith(context.bundle + path.sep) || context.bundle.startsWith(reference + path.sep)) guardRefusal('signed reference must be a separate canonical bundle');
  const chain = repeatReceiptChain(options, context, fileOps);
  const referenceTree = typedTree(reference, fileOps, { links: true });
  const archive = context.observed.mode === 'no-active-update'
    ? context.observed.archive.path
    : path.join(updaterLocations({ app: context.bundle, home: context.observed.home }, fileOps).cache, 'update.zip');
  const checksum = context.observed.files[archive];
  if (typeof checksum !== 'string' || Buffer.from(checksum, 'base64').length !== 64) guardRefusal('no exact retained reference archive');
  if (fileDigest(archive, 'sha512', 'base64', fileOps) !== checksum) guardRefusal('reference archive checksum changed');
  sameEvidence(archivedBundleTree(archive, path.basename(context.bundle), fileOps), referenceTree, 'archive/reference typed footprint');
  context.verifyNativeSignature(reference);
  const codeIdentity = context.readReferenceCodeIdentity(reference);
  sameEvidence(codeIdentity, { bundleId: context.observed.identity.bundleId, team: DESKTOP_TEAM_IDENTIFIER, cdHash: expectedReferenceCdHash }, 'signed reference publisher/identity');
  // Recheck bytes after the signature subprocess and identity inspection.
  sameEvidence(typedTree(reference, fileOps, { links: true }), referenceTree, 'verified reference footprint');
  if (fileDigest(archive, 'sha512', 'base64', fileOps) !== checksum) guardRefusal('verified reference archive changed');
  for (const rel of SEALED_SHELL_PARTS) if (fileDigest(path.join(reference, rel), 'sha256', 'hex', fileOps) !== context.observed.shellSnapshot[rel]) guardRefusal('reference native part differs');
  if (fileDigest(path.join(reference, 'Contents/Resources/app-update.yml'), 'sha256', 'hex', fileOps) !== context.observed.files[path.join(context.bundle, 'Contents/Resources/app-update.yml')]) guardRefusal('reference updater configuration differs');
  const roots = new Map(); const backups = new Map();
  const backupAliases = new Set();
  for (const [index, receipt] of chain.receipts.entries()) {
    for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
      const target = path.join(context.bundle, relative); const part = receipt.parts[name];
      const backup = typeof part?.backup === 'string' ? path.resolve(part.backup) : '';
      const alias = backup.normalize('NFC').toLowerCase();
      if (!backup.startsWith(target + '.backup-') || !/^[A-Za-z0-9]+$/.test(backup.slice((target + '.backup-').length)) || part.backup !== backup || backupAliases.has(alias)) guardRefusal('historical backup is not a distinct exact runtime sibling');
      backupAliases.add(alias);
      const footprint = index === 0 ? typedTree(backup, fileOps) : receiptRuntimeFootprint(backup, name, chain.receipts[index - 1], fileOps);
      if (index === 0) sameEvidence(footprint, typedTree(path.join(reference, relative), fileOps), 'oldest historical backup/reference footprint');
      backups.set(backup, footprint);
    }
  }
  const latest = chain.receipts.at(-1);
  for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
    const target = path.join(context.bundle, relative);
    roots.set(target, { expected: receiptRuntimeFootprint(target, name, latest, fileOps), replaced: false });
  }
  const immutable = typedTree(reference, fileOps, { links: true, excluded: Object.values(AUTHORIZED_RUNTIME_PARTS) });
  sameEvidence(options, optionSnapshot, 'repeat-install authority options');
  const ledger = { reference, referenceTree, archive, checksum, receiptFiles: chain.files, manifest: chain.manifest, optionSnapshot, codeIdentity, roots, backups, immutable, context };
  recheckRepeatReference(ledger, fileOps);
  return ledger;
}

function recheckRepeatReference(ledger, fileOps) {
  for (const pin of [...ledger.receiptFiles, ...(ledger.manifest ? [ledger.manifest] : [])]) pinnedRepeatJSON(pin.path, pin.sha256, fileOps);
  if (fileDigest(ledger.archive, 'sha512', 'base64', fileOps) !== ledger.checksum) guardRefusal('repeat reference archive bytes changed');
  sameEvidence(typedTree(ledger.reference, fileOps, { links: true }), ledger.referenceTree, 'signed reference footprint');
  sameEvidence(ledger.context.readReferenceCodeIdentity(ledger.reference), ledger.codeIdentity, 'signed reference identity');
  const excluded = [...Object.values(AUTHORIZED_RUNTIME_PARTS), ...[...ledger.backups.keys()].map(backup => path.relative(ledger.context.bundle, backup).split(path.sep).join('/'))];
  sameEvidence(typedTree(ledger.context.bundle, fileOps, { links: true, excluded }), ledger.immutable, 'installed immutable footprint');
  for (const [target, state] of ledger.roots) sameEvidence(typedTree(target, fileOps), state.expected, 'installed runtime footprint');
  for (const [backup, expected] of ledger.backups) sameEvidence(typedTree(backup, fileOps), expected, 'retained rollback footprint');
}

function prepareRepeatReplacement(guarded, target, source, fileOps) {
  const ledger = guarded && REPEAT_PATCHES.get(guarded);
  if (!ledger) return null;
  // Refresh native, cache, process and full typed evidence immediately before
  // staging; possession of an earlier capability is not a stale-state bypass.
  ledger.context.reprove(guarded);
  const state = ledger.roots.get(target);
  if (!state || state.replaced) guardRefusal('repeat replacement is not a fresh exact runtime root');
  return { ledger, state, before: state.expected, candidate: typedTree(source, fileOps) };
}

function verifyRepeatStaging(transaction, staged, source, fileOps) {
  if (!transaction) return;
  sameEvidence(typedTree(staged, fileOps), transaction.candidate, 'typed staging copy');
  sameEvidence(typedTree(source, fileOps), transaction.candidate, 'typed source');
}

function registerRepeatReplacement(transaction, target, backup, fileOps) {
  if (!transaction) return;
  if (!backup || transaction.ledger.backups.has(backup)) guardRefusal('repeat rollback path is not newly generated');
  sameEvidence(typedTree(backup, fileOps), transaction.before, 'new rollback footprint');
  sameEvidence(typedTree(target, fileOps), transaction.candidate, 'replacement footprint');
  transaction.ledger.backups.set(backup, transaction.before);
  transaction.state.expected = transaction.candidate;
  transaction.state.replaced = true;
}


function guardRefusal(message) {
  throw new Error(`Refusing a guarded patch: ${message}.`);
}

function regularPath(absolute, fileOps = fs, directory = false) {
  for (let current = path.resolve(absolute); ; current = path.dirname(current)) {
    const stat = fileOps.lstatSync(current);
    if (stat.isSymbolicLink()) guardRefusal(`updater evidence contains a symlink at ${current}`);
    if (current === path.resolve(absolute) && !(directory ? stat.isDirectory() : stat.isFile())) {
      guardRefusal(`unexpected updater evidence type at ${current}`);
    }
    if (path.dirname(current) === current) break;
  }
}

function absentPath(absolute, fileOps = fs) {
  try { fileOps.lstatSync(absolute); guardRefusal(`an update is staged to apply on quit (${absolute})`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function fileDigest(absolute, algorithm = 'sha256', encoding = 'hex', fileOps = fs) {
  regularPath(absolute, fileOps);
  const hash = createHash(algorithm);
  const fd = fileOps.openSync(absolute, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const length = fileOps.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      hash.update(chunk.subarray(0, length));
    }
  } finally { fileOps.closeSync(fd); }
  return hash.digest(encoding);
}

function nativeIdentity(info) {
  const value = (key) => {
    const matches = [...info.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, 'g'))];
    if (matches.length !== 1) guardRefusal(`cannot prove native ${key}`);
    return matches[0][1];
  };
  const bundleId = value('CFBundleIdentifier');
  const version = value('CFBundleShortVersionString');
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId) || !/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?$/.test(version)) {
    guardRefusal('invalid native bundle identity');
  }
  return { bundleId, version };
}

function flatJSONObject(absolute, fileOps) {
  const text = fileOps.readFileSync(absolute, 'utf8');
  const object = JSON.parse(text);
  if (!object || Array.isArray(object) || typeof object !== 'object' || Object.values(object).some(value => !['string', 'boolean'].includes(typeof value))) guardRefusal('unexpected updater JSON shape');
  const keys = [...text.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map(match => JSON.parse(`"${match[1]}"`));
  if (keys.length !== Object.keys(object).length || new Set(keys).size !== keys.length) guardRefusal('duplicate or ambiguous updater JSON keys');
  return object;
}

/** Read four exact regular ZIP entries in memory; never unpack an installer. */
function archivedNativeParts(archive, bundleName, fileOps = fs) {
  regularPath(archive, fileOps);
  const fd = fileOps.openSync(archive, 'r');
  const read = (offset, size) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > length) {
      guardRefusal('invalid retained ZIP bounds');
    }
    const bytes = Buffer.alloc(size);
    if (fileOps.readSync(fd, bytes, 0, size, offset) !== size) guardRefusal('incomplete retained ZIP');
    return bytes;
  };
  const length = fileOps.fstatSync(fd).size;
  try {
    const tail = read(Math.max(0, length - 65557), Math.min(length, 65557));
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) !== 0 || tail.readUInt16LE(end + 6) !== 0) guardRefusal('unsupported retained ZIP directory');
    const count = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (count === 65535 || count !== tail.readUInt16LE(end + 8) || directorySize > 32 * 1024 * 1024) guardRefusal('unsupported retained ZIP size');
    const directory = read(directoryOffset, directorySize);
    const wanted = new Map(SEALED_SHELL_PARTS.map(rel => [`${bundleName}/${rel}`, rel]));
    const native = {};
    let cursor = 0;
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) guardRefusal('malformed retained ZIP entry');
      const flags = directory.readUInt16LE(cursor + 8);
      const compression = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const size = directory.readUInt32LE(cursor + 24);
      const nameSize = directory.readUInt16LE(cursor + 28);
      const extraSize = directory.readUInt16LE(cursor + 30);
      const commentSize = directory.readUInt16LE(cursor + 32);
      const mode = directory.readUInt32LE(cursor + 38) >>> 16;
      const offset = directory.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameSize + extraSize + commentSize;
      if (next > directory.length) guardRefusal('malformed retained ZIP name');
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameSize);
      const name = nameBytes.toString('utf8');
      const rel = wanted.get(name);
      if (rel) {
        if (native[rel] || (mode & 0o170000) !== 0o100000 || (flags & 1) || ![0, 8].includes(compression) || size > 32 * 1024 * 1024) {
          guardRefusal('unsupported or duplicate retained native ZIP entry');
        }
        const header = read(offset, 30);
        if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== compression) guardRefusal('retained ZIP header mismatch');
        const localNameSize = header.readUInt16LE(26);
        if (!read(offset + 30, localNameSize).equals(nameBytes)) guardRefusal('retained ZIP local name mismatch');
        const bytes = read(offset + 30 + localNameSize + header.readUInt16LE(28), compressedSize);
        const content = compression === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
        if (content.length !== size) guardRefusal('retained ZIP size mismatch');
        native[rel] = { sha256: createHash('sha256').update(content).digest('hex'), ...(rel === 'Contents/Info.plist' ? { identity: nativeIdentity(content.toString('utf8')) } : {}) };
      }
      cursor = next;
    }
    if (cursor !== directory.length || Object.keys(native).length !== SEALED_SHELL_PARTS.length) guardRefusal('retained ZIP native entries missing');
    return native;
  } finally { fileOps.closeSync(fd); }
}

function updaterLocations({ app, home }, fileOps = fs) {
  const bundle = path.resolve(app);
  regularPath(bundle, fileOps, true);
  const config = path.join(bundle, 'Contents/Resources/app-update.yml');
  regularPath(config, fileOps);
  const cacheNames = [...fileOps.readFileSync(config, 'utf8').matchAll(/^updaterCacheDirName:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)];
  const cacheDir = cacheNames.length === 1 ? cacheNames[0][1] : null;
  const infoPath = path.join(bundle, 'Contents/Info.plist');
  regularPath(infoPath, fileOps);
  const { bundleId } = nativeIdentity(fileOps.readFileSync(infoPath, 'utf8'));
  if (!cacheDir || !/^[@A-Za-z0-9._-]+$/.test(cacheDir) || ['.', '..'].includes(cacheDir)) guardRefusal(`cannot read where ${bundle} stages updates`);
  const caches = path.join(path.resolve(home), 'Library', 'Caches');
  return { bundle, config, cache: path.join(caches, cacheDir), shipIt: path.join(caches, `${bundleId}.ShipIt`), bundleId };
}

/** A completed native update can retain downloads and its consumed request.
 * Admit only bytes that independently match the installed signed native shell,
 * with no remaining staging directory. Capture while that full seal is valid.
 * The serialized receipt is evidence to recheck, never a boolean bypass. */
export function captureAppliedUpdateEvidence({ app, home }, fileOps = fs, commands = execFileSync) {
  const evidence = inspectAppliedUpdateEvidence({ app, home }, fileOps);
  commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', evidence.app], { stdio: 'pipe' });
  return evidence;
}

/** Read-only observation, never installation authority on its own. An explicit
 * no-active-update repeat must still prove the signed official archive, every
 * immutable installed entry and the ordered runtime/rollback receipt chain. */
export function captureNoActiveUpdateEvidence({ app, home }, fileOps = fs) {
  return inspectNoActiveUpdateEvidence({ app, home }, fileOps);
}

function inspectNoActiveUpdateEvidence({ app, home }, fileOps = fs) {
  const { bundle, config, cache, shipIt } = updaterLocations({ app, home }, fileOps);
  for (const target of updaterStagingPaths({ app: bundle, home }, fileOps)) absentPath(target, fileOps);
  regularPath(cache, fileOps, true);
  regularPath(shipIt, fileOps, true);
  const shipNames = fileOps.readdirSync(shipIt).sort();
  const allowedShipNames = new Set(['ShipIt_stdout.log', 'ShipIt_stdout.log.1', 'ShipIt_stderr.log', 'ShipIt_stderr.log.1']);
  if (shipNames.some(name => !allowedShipNames.has(name))) guardRefusal('unknown no-active installer inventory');
  const cacheNames = fileOps.readdirSync(cache).sort();
  const allowedCacheNames = new Set(['current.blockmap', 'pending.held-latest', 'update.zip.held-latest']);
  if (cacheNames.some(name => !allowedCacheNames.has(name))
    || !cacheNames.includes('pending.held-latest') || !cacheNames.includes('update.zip.held-latest')) {
    guardRefusal('no-active update requires exact retained held archive inventory');
  }
  const pending = path.join(cache, 'pending.held-latest');
  regularPath(pending, fileOps, true);
  const metadataPath = path.join(pending, 'update-info.json');
  const metadata = flatJSONObject(metadataPath, fileOps);
  if (Object.keys(metadata).sort().join('|') !== 'fileName|isAdminRightsRequired|sha512'
    || metadata.isAdminRightsRequired !== false || !/^[A-Za-z0-9._-]+\.zip$/.test(metadata.fileName)
    || typeof metadata.sha512 !== 'string' || Buffer.from(metadata.sha512, 'base64').length !== 64
    || Buffer.from(metadata.sha512, 'base64').toString('base64') !== metadata.sha512) {
    guardRefusal('unrecognized no-active retained download metadata');
  }
  if (fileOps.readdirSync(pending).sort().join('|') !== [metadata.fileName, 'update-info.json'].sort().join('|')) {
    guardRefusal('unexpected no-active retained download inventory');
  }
  const archive = path.join(pending, metadata.fileName);
  const shellSnapshot = Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel, fileDigest(path.join(bundle, rel), 'sha256', 'hex', fileOps)]));
  const identity = nativeIdentity(fileOps.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8'));
  const files = { [config]: fileDigest(config, 'sha256', 'hex', fileOps), [metadataPath]: fileDigest(metadataPath, 'sha256', 'hex', fileOps) };
  for (const archivePath of [archive, path.join(cache, 'update.zip.held-latest')]) {
    const checksum = fileDigest(archivePath, 'sha512', 'base64', fileOps);
    if (checksum !== metadata.sha512) guardRefusal('no-active retained archive checksum differs');
    files[archivePath] = checksum;
  }
  const native = archivedNativeParts(archive, path.basename(bundle), fileOps);
  if (JSON.stringify(native['Contents/Info.plist'].identity) !== JSON.stringify(identity)
    || SEALED_SHELL_PARTS.some(rel => native[rel].sha256 !== shellSnapshot[rel])) {
    guardRefusal('no-active retained archive differs from native shell');
  }
  if (cacheNames.includes('current.blockmap')) files[path.join(cache, 'current.blockmap')] = fileDigest(path.join(cache, 'current.blockmap'), 'sha256', 'hex', fileOps);
  return { version: 1, mode: 'no-active-update', app: bundle, home: path.resolve(home), identity, shellSnapshot,
    shipNames, cacheNames, shipItInventory: typedTree(shipIt, fileOps), cacheInventory: typedTree(cache, fileOps),
    archive: { path: archive, sha512: metadata.sha512 }, files };
}

function inspectAppliedUpdateEvidence({ app, home }, fileOps = fs) {
  const locations = updaterLocations({ app, home }, fileOps);
  const { bundle, config, cache, shipIt, bundleId } = locations;
  regularPath(cache, fileOps, true);
  regularPath(shipIt, fileOps, true);
  const shipNames = fileOps.readdirSync(shipIt).sort();
  const allowedShipNames = new Set(['ShipItState.plist', 'ShipIt_stdout.log', 'ShipIt_stdout.log.1', 'ShipIt_stderr.log', 'ShipIt_stderr.log.1']);
  if (shipNames.some(name => !allowedShipNames.has(name))) guardRefusal('unknown or unpacked installer state');
  for (const name of shipNames) regularPath(path.join(shipIt, name), fileOps);
  const statePath = path.join(shipIt, 'ShipItState.plist');
  const state = flatJSONObject(statePath, fileOps);
  const expectedKeys = ['bundleIdentifier', 'launchAfterInstallation', 'targetBundleURL', 'updateBundleURL', 'useUpdateBundleName'];
  if (Object.keys(state).sort().join('|') !== expectedKeys.sort().join('|') || state.bundleIdentifier !== bundleId || state.launchAfterInstallation !== true || state.useUpdateBundleName !== true) guardRefusal('unrecognized consumed installer request');
  const exactFileURL = (value) => {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) guardRefusal('unexpected installer request URL');
    return fileURLToPath(url);
  };
  const target = exactFileURL(state.targetBundleURL);
  if (path.resolve(target) !== bundle || fileOps.realpathSync(bundle) !== bundle || state.targetBundleURL !== pathToFileURL(bundle + path.sep).href) guardRefusal('consumed installer target differs from installed bundle');
  const stagedBundle = exactFileURL(state.updateBundleURL);
  const stagedDirectory = path.dirname(path.resolve(stagedBundle));
  if (path.dirname(stagedDirectory) !== shipIt || !/^update\.[A-Za-z0-9]+$/.test(path.basename(stagedDirectory)) || path.basename(path.resolve(stagedBundle)) !== path.basename(bundle)) guardRefusal('consumed installer staging path differs');
  if (state.updateBundleURL !== pathToFileURL(path.join(stagedDirectory, path.basename(bundle)) + path.sep).href) guardRefusal('noncanonical consumed installer staging URL');
  absentPath(stagedDirectory, fileOps);
  const cacheNames = fileOps.readdirSync(cache).sort();
  const allowedCacheNames = new Set(['pending', 'update.zip', 'current.blockmap', 'pending.held-latest', 'update.zip.held-latest']);
  if (cacheNames.some(name => !allowedCacheNames.has(name)) || !cacheNames.includes('pending') || !cacheNames.includes('update.zip') || cacheNames.includes('pending.held-latest') !== cacheNames.includes('update.zip.held-latest')) guardRefusal('unexpected retained updater cache inventory');
  const shellSnapshot = Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel, fileDigest(path.join(bundle, rel), 'sha256', 'hex', fileOps)]));
  const identity = nativeIdentity(fileOps.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8'));
  const files = { [config]: fileDigest(config, 'sha256', 'hex', fileOps), [statePath]: fileDigest(statePath, 'sha256', 'hex', fileOps) };
  for (const suffix of ['', '.held-latest'].filter(suffix => cacheNames.includes(`pending${suffix}`))) {
    const pending = path.join(cache, `pending${suffix}`);
    regularPath(pending, fileOps, true);
    const metadataPath = path.join(pending, 'update-info.json');
    regularPath(metadataPath, fileOps);
    const metadata = flatJSONObject(metadataPath, fileOps);
    if (Object.keys(metadata).sort().join('|') !== 'fileName|isAdminRightsRequired|sha512' || metadata.isAdminRightsRequired !== false || !/^[A-Za-z0-9._-]+\.zip$/.test(metadata.fileName) || typeof metadata.sha512 !== 'string' || Buffer.from(metadata.sha512, 'base64').length !== 64 || Buffer.from(metadata.sha512, 'base64').toString('base64') !== metadata.sha512) guardRefusal('unrecognized retained download metadata');
    const names = fileOps.readdirSync(pending).sort();
    if (names.join('|') !== [metadata.fileName, 'update-info.json'].sort().join('|')) guardRefusal('unexpected retained pending download inventory');
    files[metadataPath] = fileDigest(metadataPath, 'sha256', 'hex', fileOps);
    const pendingArchive = path.join(pending, metadata.fileName);
    const archive = path.join(cache, `update.zip${suffix}`);
    for (const archivePath of [pendingArchive, archive]) {
      const checksum = fileDigest(archivePath, 'sha512', 'base64', fileOps);
      if (checksum !== metadata.sha512) guardRefusal('retained archive checksum differs from download metadata');
      files[archivePath] = checksum;
    }
    const native = archivedNativeParts(pendingArchive, path.basename(bundle), fileOps);
    if (JSON.stringify(native['Contents/Info.plist'].identity) !== JSON.stringify(identity) || SEALED_SHELL_PARTS.some(rel => native[rel].sha256 !== shellSnapshot[rel])) guardRefusal('retained archive differs from applied native shell');
  }
  if (cacheNames.includes('current.blockmap')) files[path.join(cache, 'current.blockmap')] = fileDigest(path.join(cache, 'current.blockmap'), 'sha256', 'hex', fileOps);
  return { version: 1, app: bundle, home: path.resolve(home), identity, shellSnapshot, shipNames, cacheNames, stagedDirectory, files };
}

/** Installer helpers can apply a request independently of the native app. An
 * unreadable process inventory throws; command arguments are never printed. */
function privateProcessInventory(commands) {
  try {
    return commands('/bin/ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    // Child-process errors can retain full argv in stdout/stderr. Unknown
    // inventory still refuses, without exposing that original error or cause.
    guardRefusal('process_inventory_unavailable');
  }
}

export function isUpdaterHelperRunning(commands = execFileSync) {
  const output = privateProcessInventory(commands);
  return output.split('\n').some(command => /(?:^|\/)ShipIt(?:\s|$)|(?:^|\/)Squirrel(?:\s|$)/i.test(command.trim()));
}

/** Match executable paths from a private process inventory, including the
 * external Node executable used by the daemon. A shell merely mentioning the
 * bundle in its arguments is not its native process. Known bundle paths with
 * spaces remain exact prefixes, rather than being parsed as shell tokens. */
export function isInstalledAppRunning(app, commands = execFileSync) {
  const bundle = path.resolve(app);
  const daemonEntry = path.join(bundle, 'Contents/Resources/daemon/dist/index.js');
  const output = privateProcessInventory(commands);
  return output.split('\n').some(line => {
    const command = line.trim();
    if (command.startsWith(`${bundle}/Contents/`)) return true;
    if (!/^(?:\/[^\n]*\/)?node(?:\s|$)/.test(command)) return false;
    const entry = command.indexOf(daemonEntry);
    return entry > 0 && /\s/.test(command[entry - 1]) && (entry + daemonEntry.length === command.length || /\s/.test(command[entry + daemonEntry.length]));
  });
}

/**
 * Everywhere this bundle's updater can stage an install that applies on quit,
 * read from the bundle itself: its download cache (app-update.yml) and its
 * installer's staging (named for the bundle id). Unreadable names refuse,
 * since an unknown staging place cannot be proven empty.
 */
export function updaterStagingPaths({ app, home }, fileOps = fs) {
  const bundle = path.resolve(app);
  const cacheDir = /^updaterCacheDirName:\s*['"]?([^'"\n]+?)['"]?\s*$/m
    .exec(fileOps.readFileSync(path.join(bundle, 'Contents/Resources/app-update.yml'), 'utf8'))?.[1];
  const bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/
    .exec(fileOps.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8'))?.[1];
  if (!cacheDir || !bundleId) throw new Error(`Refusing a guarded patch: cannot read where ${bundle} stages updates.`);
  const caches = path.join(home, 'Library', 'Caches');
  const shipIt = path.join(caches, `${bundleId}.ShipIt`);
  const shipItUpdates = fileOps.existsSync(shipIt)
    ? fileOps.readdirSync(shipIt).filter((name) => name.startsWith('update.')).map((name) => path.join(shipIt, name))
    : [];
  return [
    path.join(caches, cacheDir, 'pending'),
    path.join(caches, cacheDir, 'update.zip'),
    path.join(shipIt, 'ShipItState.plist'),
    ...shipItUpdates,
  ];
}

/**
 * Proof that patching an installed app's runtime resources in place is safe.
 *
 * A bundle patched while the updater replaces its native parts during the same
 * quit relaunches as neither the signed release nor the patch, and macOS calls
 * it damaged. A guarded patch is allowed only when nothing can do that: the app
 * is not running, no update is staged to apply on quit, and every native part
 * is byte-identical to the snapshot the caller took before quitting. Anything
 * unproven refuses.
 */
export function verifyGuardedSealedPatch({ app, home, shellSnapshot, appliedUpdateEvidence, noActiveUpdateEvidence, priorProof, repeatedReference, isRunning,
  readReferenceCodeIdentity = referenceCodeIdentity,
  isUpdaterRunning = isUpdaterHelperRunning,
  verifyNativeSignature = (bundle) => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' }),
}, fileOps = fs) {
  const bundle = path.resolve(app);
  if (isRunning()) throw new Error(`Refusing a guarded patch: ${bundle} is still running.`);
  if (isUpdaterRunning()) guardRefusal('an installer helper is still running');
  if (!home) guardRefusal('no updater home for a fresh staging inventory');
  if (appliedUpdateEvidence && noActiveUpdateEvidence) guardRefusal('updater evidence modes are mutually exclusive');
  const previousRepeat = priorProof && REPEAT_PATCHES.get(priorProof);
  if (previousRepeat) {
    if (previousRepeat.context.bundle !== bundle || previousRepeat.context.observed.home !== path.resolve(home)) guardRefusal('private repeat proof context differs');
    sameEvidence(noActiveUpdateEvidence ?? appliedUpdateEvidence, previousRepeat.context.observed, 'private repeat applied-update evidence');
    sameEvidence(shellSnapshot, previousRepeat.context.observed.shellSnapshot, 'private repeat shell snapshot');
    if (repeatedReference !== undefined) sameEvidence(repeatedReference, previousRepeat.optionSnapshot, 'private repeat authority context');
  }
  const staged = updaterStagingPaths({ app: bundle, home }, fileOps).filter((candidate) => {
    try { fileOps.lstatSync(candidate); return true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
  });
  let appliedEvidenceDigest = null; let repeatLedger = null;
  if (repeatedReference && !appliedUpdateEvidence && !noActiveUpdateEvidence) guardRefusal('repeat admission requires exact applied-update evidence');
  if (noActiveUpdateEvidence) {
    if (staged.length > 0) guardRefusal('no-active update snapshot now has staged installer state');
    if (!repeatedReference && !previousRepeat) guardRefusal('no-active update requires the exact signed reference and receipt chain');
    const observed = inspectNoActiveUpdateEvidence({ app: bundle, home }, fileOps);
    sameEvidence(observed, noActiveUpdateEvidence, 'no-active updater evidence');
    appliedEvidenceDigest = createHash('sha256').update(JSON.stringify(observed)).digest('hex');
    if (priorProof) {
      if (!GUARDED_PATCHES.has(priorProof) || priorProof.app !== bundle
        || priorProof.appliedEvidenceDigest !== appliedEvidenceDigest || !previousRepeat) guardRefusal('no matching private no-active repeat-install proof');
      repeatLedger = previousRepeat;
      recheckRepeatReference(repeatLedger, fileOps);
    } else {
      const context = { bundle, observed, verifyNativeSignature, readReferenceCodeIdentity };
      context.reprove = (proof) => verifyGuardedSealedPatch({ app: bundle, home, shellSnapshot, noActiveUpdateEvidence,
        priorProof: proof, repeatedReference, isRunning, isUpdaterRunning, verifyNativeSignature, readReferenceCodeIdentity }, fileOps);
      repeatLedger = inspectRepeatReference(repeatedReference, context, fileOps);
    }
  } else if (staged.length > 0) {
    if (!appliedUpdateEvidence) throw new Error(`Refusing a guarded patch: an update is staged to apply on quit (${staged.join(', ')}).`);
    const observed = inspectAppliedUpdateEvidence({ app: bundle, home }, fileOps);
    if (JSON.stringify(observed) !== JSON.stringify(appliedUpdateEvidence)) guardRefusal('applied-update evidence changed since the snapshot');
    appliedEvidenceDigest = createHash('sha256').update(JSON.stringify(observed)).digest('hex');
    // Only an authentic initial proof allows resource-seal changes from this
    // patch. Before minting it, independently verify the complete native seal.
    if (priorProof) {
      if (!GUARDED_PATCHES.has(priorProof) || priorProof.app !== bundle || priorProof.appliedEvidenceDigest !== appliedEvidenceDigest) guardRefusal('no matching initial applied-update proof');
      repeatLedger = REPEAT_PATCHES.get(priorProof) ?? null;
      if (repeatedReference && !repeatLedger) guardRefusal('no matching private repeat-install proof');
      if (repeatLedger) recheckRepeatReference(repeatLedger, fileOps);
    } else if (repeatedReference) {
      const context = { bundle, observed, verifyNativeSignature, readReferenceCodeIdentity };
      context.reprove = (proof) => verifyGuardedSealedPatch({ app: bundle, home, shellSnapshot, appliedUpdateEvidence, priorProof: proof, repeatedReference, isRunning, isUpdaterRunning, verifyNativeSignature, readReferenceCodeIdentity }, fileOps);
      repeatLedger = inspectRepeatReference(repeatedReference, context, fileOps);
    } else verifyNativeSignature(bundle);
  } else if (appliedUpdateEvidence) guardRefusal('applied-update evidence no longer has the captured retained state');
  const digest = (rel) => createHash('sha256').update(fileOps.readFileSync(path.join(bundle, rel))).digest('hex');
  for (const rel of SEALED_SHELL_PARTS) {
    if (typeof shellSnapshot?.[rel] !== 'string') throw new Error(`Refusing a guarded patch: no pre-quit snapshot of ${rel}.`);
    if (digest(rel) !== shellSnapshot[rel]) throw new Error(`Refusing a guarded patch: ${rel} changed since the pre-quit snapshot.`);
  }
  if (noActiveUpdateEvidence) {
    if (isRunning() || isUpdaterRunning()) guardRefusal('app or installer helper started during no-active verification');
    sameEvidence(inspectNoActiveUpdateEvidence({ app: bundle, home }, fileOps), noActiveUpdateEvidence,
      'no-active updater evidence after verification');
  }
  // The install guard compares resolved paths, so the proof names both.
  const proof = Object.freeze({ app: bundle, canonical: fileOps.realpathSync(bundle), appliedEvidenceDigest });
  GUARDED_PATCHES.add(proof);
  if (repeatLedger) REPEAT_PATCHES.set(proof, repeatLedger);
  return proof;
}

/** In-place patching cannot preserve an app's resource seal. Reject every
 * app/Contents target, including damaged or unsigned bundles; signature failure
 * is never permission to modify one. The one exception is a guarded patch
 * (verifyGuardedSealedPatch) of that app's runtime resources, never its native
 * parts. Otherwise install a signed whole bundle. */
export function assertMutableInstallTarget(targetPath, guarded) {
  const target = path.resolve(targetPath);
  const repeatLedger = guarded && REPEAT_PATCHES.get(guarded);
  if (repeatLedger && !repeatLedger.roots.has(target)) guardRefusal('repeat proof admits only the four exact runtime roots');
  const runtimes = guarded && GUARDED_PATCHES.has(guarded)
    ? [guarded.app, guarded.canonical].map((root) => path.join(root, 'Contents', 'Resources', 'daemon') + path.sep)
    : [];
  const rejectAppContents = (candidate) => {
    if (runtimes.some((runtime) => candidate.startsWith(runtime))) return;
    const parts = candidate.split(path.sep);
    if (parts.some((part, index) => /\.app$/i.test(part) && /^contents$/i.test(parts[index + 1] ?? ''))) {
      throw new Error(`Refusing in-place installation inside an app bundle: ${target}. Use the signed whole-bundle installation path (scripts/hotpatch-installed.sh).`);
    }
  };
  // A link out of a bundle still leaves a sealed directory entry to replace.
  rejectAppContents(target);
  let ancestor = target;
  const missing = [];
  for (;;) {
    try {
      fs.lstatSync(ancestor);
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (error.code !== 'ENOENT' || parent === ancestor) {
        throw new Error(`Cannot verify installation target: ${target}`, { cause: error });
      }
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    // Resolve existing ancestors even when the final asset directory is new.
    // A dangling/looping link or unreadable ancestor is not an unsigned target.
    let canonical;
    try { canonical = fs.realpathSync(ancestor); }
    catch (error) { throw new Error(`Cannot verify installation target: ${target}`, { cause: error }); }
    rejectAppContents(path.join(canonical, ...missing));
    return;
  }
}

export function installDaemonPatch({ sourceDist, targetDist, guarded }, fileOps = fs) {
  const source = path.resolve(sourceDist);
  const target = path.resolve(targetDist);
  assertMutableInstallTarget(target, guarded);
  if (source === target || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('Source and installation must be separate directories.');
  }
  const transaction = prepareRepeatReplacement(guarded, target, source, fileOps);
  const before = inspectDaemonBuild(source);
  if (!fs.statSync(target).isDirectory()) throw new Error('Installed daemon directory missing. Restore the installation first.');
  // macOS may deny bundle writes. That failure must happen before moving the
  // working daemon, not after deleting it as the older hot-patch.sh did.
  const staging = fileOps.mkdtempSync(path.join(path.dirname(target), '.daemon-stage-'));
  const stagedDist = path.join(staging, 'dist');
  const backup = `${target}.backup-${path.basename(staging).slice('.daemon-stage-'.length)}`;
  let originalMoved = false;
  try {
    fileOps.cpSync(source, stagedDist, { recursive: true });
    if (treeDigest(stagedDist) !== before.digest || treeDigest(source) !== before.digest) {
      throw new Error('Build changed or staging copy is incomplete. Installed daemon is untouched.');
    }
    verifyRepeatStaging(transaction, stagedDist, source, fileOps);
    fileOps.renameSync(target, backup);
    originalMoved = true;
    try {
      fileOps.renameSync(stagedDist, target);
    } catch (error) {
      fileOps.renameSync(backup, target);
      originalMoved = false;
      throw error;
    }
    try { registerRepeatReplacement(transaction, target, backup, fileOps); }
    catch (error) { fileOps.rmSync(target, { recursive: true, force: true }); fileOps.renameSync(backup, target); originalMoved = false; throw error; }
    return { ...before, backup, target };
  } catch (error) {
    if (originalMoved && !fs.existsSync(target)) {
      throw new Error(`Patch interrupted; prior daemon is retained at ${backup}. Restore it to ${target} before launching.`, { cause: error });
    }
    throw error;
  } finally {
    fileOps.rmSync(staging, { recursive: true, force: true });
    if (transaction?.state.replaced) transaction.ledger.context.reprove(guarded);
  }
}

/**
 * Replace a packaged asset directory the daemon reads at boot (the shipped
 * built-in skills) beside the daemon code, with the same verified staging copy
 * and retained rollback as the code itself. The daemon provisions each shipped
 * skill from this directory on every boot, so shipping new code without it
 * leaves a skill the new code names absent from the installation.
 */
export function installBundledAssetDirectory({ sourceDir, targetDir, guarded }, fileOps = fs) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  assertMutableInstallTarget(target, guarded);
  if (source === target || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('Source and installation must be separate directories.');
  }
  if (!fs.statSync(source).isDirectory()) throw new Error(`Packaged asset directory missing: ${source}`);
  const transaction = prepareRepeatReplacement(guarded, target, source, fileOps);
  const digest = treeDigest(source);
  const staging = fileOps.mkdtempSync(path.join(path.dirname(target), '.assets-stage-'));
  const staged = path.join(staging, path.basename(target));
  const hadTarget = fs.existsSync(target);
  const backup = `${target}.backup-${path.basename(staging).slice('.assets-stage-'.length)}`;
  let originalMoved = false;
  try {
    fileOps.cpSync(source, staged, { recursive: true });
    if (treeDigest(staged) !== digest || treeDigest(source) !== digest) {
      throw new Error('Asset source changed or staging copy is incomplete. Installed assets are untouched.');
    }
    verifyRepeatStaging(transaction, staged, source, fileOps);
    if (hadTarget) {
      fileOps.renameSync(target, backup);
      originalMoved = true;
    }
    try {
      fileOps.renameSync(staged, target);
    } catch (error) {
      if (originalMoved) fileOps.renameSync(backup, target);
      originalMoved = false;
      throw error;
    }
    try { registerRepeatReplacement(transaction, target, hadTarget ? backup : null, fileOps); }
    catch (error) { fileOps.rmSync(target, { recursive: true, force: true }); if (originalMoved) fileOps.renameSync(backup, target); originalMoved = false; throw error; }
    return { digest, target, backup: hadTarget ? backup : null };
  } catch (error) {
    if (originalMoved && !fs.existsSync(target)) {
      throw new Error(`Asset patch interrupted; prior assets are retained at ${backup}. Restore them to ${target} before launching.`, { cause: error });
    }
    throw error;
  } finally {
    fileOps.rmSync(staging, { recursive: true, force: true });
    if (transaction?.state.replaced) transaction.ledger.context.reprove(guarded);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--check')) throw new Error('Usage: node --import tsx scripts/hotpatch-daemon.mjs [--check]');
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sourceDist = path.join(repoRoot, 'dist');
    const { stamp, digest } = inspectDaemonBuild(sourceDist);
    const { fingerprintRuntimeSourceFromGit } = await import('../src/runtime/source-fingerprint.ts');
    if (fingerprintRuntimeSourceFromGit({ repoRoot }) !== stamp.sourceFingerprint) {
      throw new Error('Source differs from the built candidate. Run npm run build before patching.');
    }
    if (args.includes('--check')) {
      console.log(JSON.stringify({ ready: true, sourceFingerprint: stamp.sourceFingerprint, distDigest: digest }));
    } else {
      const home = process.env.HOME ?? '';
      const candidates = process.env.CLEMENTINE_APP_PATH
        ? [process.env.CLEMENTINE_APP_PATH]
        : ['/Applications/Clementine.app', path.join(home, 'Applications', 'Clementine.app')];
      const installed = resolveInstalledAppBundle(candidates, (bundle) => (
        JSON.parse(fs.readFileSync(path.join(bundle, 'Contents/Resources/daemon/package.json'), 'utf8')).version
      ));
      let running = false;
      try {
        // Anchored to a command line that STARTS inside a bundle: an unanchored
        // match also catches any shell whose arguments merely mention the
        // bundle path (an operator's verification command), refuses to patch,
        // and leaves the app quit with no relaunch.
        execFileSync('pgrep', ['-f', '^/[^ ]*/Clementine\\.app/Contents/'], { stdio: 'ignore' });
        running = true;
      } catch (error) { if (error.status !== 1) throw error; }
      if (running) throw new Error('Quit Clementine before patching so the active run can finish cleanly.');
      const result = installDaemonPatch({ sourceDist, targetDist: path.join(installed.bundle, 'Contents/Resources/daemon/dist') });
      const skills = installBundledAssetDirectory({
        sourceDir: path.join(repoRoot, 'builtin-skills'),
        targetDir: path.join(installed.bundle, 'Contents/Resources/daemon/builtin-skills'),
      });
      console.log(`Daemon patched (${installed.bundle}, was ${installed.version}): ${result.stamp.sourceFingerprint}\nPrior daemon retained: ${result.backup}\nBuilt-in skills shipped (${skills.digest.slice(0, 12)})${skills.backup ? `; prior skills retained: ${skills.backup}` : ''}\nDesktop and web UI unchanged. Launch Clementine to test.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
