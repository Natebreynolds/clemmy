import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { SEALED_SHELL_PARTS, AUTHORIZED_RUNTIME_PARTS, captureAppliedUpdateEvidence, captureNoActiveUpdateEvidence,
  verifyGuardedSealedPatch, captureCurrentStateRecoveryEvidence, verifyCurrentStateRecoveryPatch,
  initializeCurrentStateRecoveryArtifacts, writeCurrentStateRecoveryReceipt,
  recordCurrentStateRecoveryFailure, inspectDaemonBuild, installDaemonPatch, installBundledAssetDirectory,
} from './hotpatch-daemon.mjs';

// Complete private synthetic archives; no real app, user home or network.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-patch-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDist = path.join(root, 'build');
  const targetDist = path.join(root, 'installed/dist');
  fs.mkdirSync(path.join(sourceDist, 'runtime'), { recursive: true });
  fs.mkdirSync(targetDist, { recursive: true });
  fs.writeFileSync(path.join(sourceDist, 'index.js'), 'new daemon');
  fs.writeFileSync(path.join(sourceDist, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64) }));
  fs.writeFileSync(path.join(targetDist, 'index.js'), 'old daemon');
  fs.writeFileSync(path.join(root, 'installed/ui.html'), 'untouched UI');
  return { root, sourceDist, targetDist };
}

function guardedFixture(t) {
  const f = fixture(t);
  const app = path.join(f.root, 'Fixture.app');
  const home = path.join(f.root, 'home');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), text);
  };
  write('Contents/MacOS/Clementine', 'native launcher');
  write('Contents/Info.plist', '<dict>\n  <key>CFBundleIdentifier</key>\n  <string>com.example.fixture</string>\n</dict>');
  write('Contents/Resources/app.asar', 'packaged shell');
  write('Contents/_CodeSignature/CodeResources', 'seal');
  write('Contents/Resources/app-update.yml', "provider: github\nupdaterCacheDirName: '@fixture-updater'\n");
  write('Contents/Resources/daemon/dist/index.js', 'old daemon');
  fs.mkdirSync(path.join(home, 'Library', 'Caches'), { recursive: true });
  const snapshot = Object.fromEntries(SEALED_SHELL_PARTS.map((rel) => [
    rel, createHash('sha256').update(fs.readFileSync(path.join(app, rel))).digest('hex'),
  ]));
  const prove = (overrides = {}) => verifyGuardedSealedPatch({
    app, home, shellSnapshot: snapshot, isRunning: () => false, isUpdaterRunning: () => false, ...overrides,
  });
  return { ...f, app, home, snapshot, prove, daemonDist: path.join(app, 'Contents/Resources/daemon/dist') };
}

function nativeZip(g, entries = SEALED_SHELL_PARTS, compressed = false) {
  const local = []; const central = []; let offset = 0;
  for (const rel of entries) {
    const name = Buffer.from(`Fixture.app/${rel}`);
    const bytes = fs.readFileSync(path.join(g.app, rel));
    const stored = compressed ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(compressed ? 8 : 0, 8); header.writeUInt32LE(stored.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, stored);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE((3 << 8) | 20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(compressed ? 8 : 0, 10); directory.writeUInt32LE(stored.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + stored.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function appliedUpdateFixture(t) {
  const g = guardedFixture(t);
  fs.writeFileSync(path.join(g.app, 'Contents/Info.plist'), '<dict><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleShortVersionString</key><string>3.18.35</string></dict>');
  g.snapshot = Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel, createHash('sha256').update(fs.readFileSync(path.join(g.app, rel))).digest('hex')]));
  g.cache = path.join(g.home, 'Library/Caches/@fixture-updater');
  g.shipIt = path.join(g.home, 'Library/Caches/com.example.fixture.ShipIt');
  g.archiveName = 'Fixture-3.18.35-arm64-mac.zip';
  g.writeArchives = (bytes = nativeZip(g), held = false) => {
    for (const suffix of held ? ['', '.held-latest'] : ['']) {
      const pending = path.join(g.cache, `pending${suffix}`);
      fs.mkdirSync(pending, { recursive: true });
      fs.writeFileSync(path.join(pending, g.archiveName), bytes);
      fs.writeFileSync(path.join(g.cache, `update.zip${suffix}`), bytes);
      fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: g.archiveName, sha512: createHash('sha512').update(bytes).digest('base64'), isAdminRightsRequired: false }));
    }
  };
  g.writeArchives();
  fs.mkdirSync(g.shipIt, { recursive: true });
  g.state = { launchAfterInstallation: true, updateBundleURL: pathToFileURL(path.join(g.shipIt, 'update.ABC123/Fixture.app')).href + '/', useUpdateBundleName: true, bundleIdentifier: 'com.example.fixture', targetBundleURL: pathToFileURL(g.app).href + '/' };
  g.statePath = path.join(g.shipIt, 'ShipItState.plist');
  fs.writeFileSync(g.statePath, JSON.stringify(g.state));
  g.capture = (commands = () => {}) => captureAppliedUpdateEvidence({ app: g.app, home: g.home }, fs, commands);
  g.proveApplied = (evidence, overrides = {}) => verifyGuardedSealedPatch({
    app: g.app, home: g.home, shellSnapshot: g.snapshot, appliedUpdateEvidence: evidence,
    isRunning: () => false, isUpdaterRunning: () => false, verifyNativeSignature: () => {}, ...overrides,
  });
  return g;
}

function fullBundleZip(root, extraRecords = []) {
  const records = [];
  const visit = rel => {
    const absolute = path.join(root, rel); const stat = fs.lstatSync(absolute);
    const directory = stat.isDirectory(); const link = stat.isSymbolicLink();
    records.push({ name: `${path.basename(root)}/${rel}${directory && rel ? '/' : ''}`, mode: stat.mode, content: directory ? Buffer.alloc(0) : link ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute) });
    if (directory) for (const name of fs.readdirSync(absolute).sort()) visit(rel ? `${rel}/${name}` : name);
  };
  visit(''); records.push(...extraRecords);
  const locals = []; const central = []; let offset = 0;
  for (const { name: text, mode, content } of records) {
    const name = Buffer.from(text); const bytes = deflateRawSync(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    locals.push(header, name, bytes);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE((3 << 8) | 20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(content.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((mode << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(records.length, 8); end.writeUInt16LE(records.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function mixedAppliedGenerationsFixture(t, { priorVersion = '3.18.37' } = {}) {
  const g = appliedUpdateFixture(t);
  const setNative = (bundle, version) => {
    fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<dict><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleShortVersionString</key><string>${version}</string></dict>`);
    fs.writeFileSync(path.join(bundle, 'Contents/MacOS/Clementine'), `native launcher ${version}`);
    fs.writeFileSync(path.join(bundle, 'Contents/Resources/app.asar'), `packaged shell ${version}`);
    fs.writeFileSync(path.join(bundle, 'Contents/_CodeSignature/CodeResources'), `seal ${version}`);
  };
  const snapshot = () => Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel,
    createHash('sha256').update(fs.readFileSync(path.join(g.app, rel))).digest('hex')]));
  setNative(g.app, priorVersion);
  {
    const framework = path.join(g.app, 'Contents/Frameworks/Prior.framework');
    fs.mkdirSync(path.join(framework, 'Versions/A'), { recursive: true });
    fs.writeFileSync(path.join(framework, 'Versions/A/Prior'), 'complete old signed framework');
    fs.symlinkSync('A', path.join(framework, 'Versions/Current'));
    fs.symlinkSync('Versions/Current/Prior', path.join(framework, 'Prior'));
    g.reference = path.join(g.root, 'official-prior/Fixture.app');
    fs.cpSync(g.app, g.reference, { recursive: true, verbatimSymlinks: true });
  }
  for (const suffix of ['', '.held-latest']) fs.rmSync(path.join(g.cache, `pending${suffix}`), { recursive: true, force: true });
  g.archiveName = `Fixture-${priorVersion}-arm64-mac.zip`;
  g.writeArchives(fullBundleZip(g.reference), true);
  g.snapshot = snapshot();
  g.evidence = g.capture();
  assert.equal(g.evidence.version, 1, 'the prior generation is genuinely captured under the original same-version contract');
  const historical = { appliedUpdateEvidence: g.evidence, shellSnapshot: g.snapshot };
  g.historicalPath = path.join(g.root, 'prior-applied-snapshot.json');
  fs.writeFileSync(g.historicalPath, JSON.stringify(historical));
  g.retained = {
    referenceBundle: g.reference,
    historicalSnapshot: g.historicalPath,
    historicalSnapshotSha256: createHash('sha256').update(fs.readFileSync(g.historicalPath)).digest('hex'),
    expectedReferenceCdHash: 'c'.repeat(40),
  };
  g.priorNative = Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel, fs.readFileSync(path.join(g.app, rel))]));
  g.heldArchive = path.join(g.cache, 'pending.held-latest', g.archiveName);
  g.heldPair = path.join(g.cache, 'update.zip.held-latest');
  g.heldMetadata = path.join(g.cache, 'pending.held-latest/update-info.json');
  setNative(g.app, '3.18.38');
  g.snapshot = snapshot();
  fs.rmSync(path.join(g.cache, 'pending'), { recursive: true });
  g.archiveName = 'Fixture-3.18.38-arm64-mac.zip';
  g.writeArchives(fullBundleZip(g.app));
  g.readIdentity = bundle => {
    assert.equal(bundle, g.reference, 'only the separately pinned prior reference supplies old publisher identity');
    return { bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: 'c'.repeat(40) };
  };
  g.signatures = [];
  g.commands = (command, args) => {
    assert.equal(command, '/usr/bin/codesign');
    assert.deepEqual(args.slice(0, 3), ['--verify', '--deep', '--strict']);
    assert.ok([g.app, g.reference].includes(args[3]));
    assert.equal(args.length, 4);
    g.signatures.push(args[3]);
  };
  g.captureMixed = (options = {}, operations = fs, commands = g.commands, readIdentity = g.readIdentity) =>
    captureAppliedUpdateEvidence({ app: g.app, home: g.home, retainedArchiveReference: g.retained, ...options }, operations, commands, readIdentity);
  g.proveMixed = (evidence, overrides = {}, operations = fs) => verifyGuardedSealedPatch({
    app: g.app, home: g.home, shellSnapshot: g.snapshot, appliedUpdateEvidence: evidence,
    isRunning: () => false, isUpdaterRunning: () => false,
    verifyNativeSignature: bundle => { assert.ok([g.app, g.reference].includes(bundle)); g.signatures.push(bundle); },
    readReferenceCodeIdentity: g.readIdentity, ...overrides,
  }, operations);
  g.retainedBytes = () => [g.heldArchive, g.heldPair, g.heldMetadata, g.historicalPath]
    .map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
  return g;
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function pinJSON(absolute, value) {
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(value, null, 2) + '\n');
  return { path: absolute, sha256: sha(fs.readFileSync(absolute)) };
}
function recordedTree(root) {
  const entries = [];
  const visit = relative => {
    const absolute = path.join(root, relative); const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      entries.push([relative || '.', 'directory', stat.mode & 0o777]);
      for (const name of fs.readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push([relative, 'file', stat.mode & 0o777, stat.size, sha(fs.readFileSync(absolute))]);
    else throw new Error('private fixture inventory expects regular entries');
  };
  visit(''); return entries;
}

function recoveryFixture(t, { actualGit = false, interruptedHistory = false } = {}) {
  const g = mixedAppliedGenerationsFixture(t);
  g.baseline = path.join(g.root, 'independent-clean-build');
  g.durable = path.join(g.root, 'durable-evidence');
  fs.mkdirSync(g.baseline); fs.mkdirSync(g.durable);
  const write = (relative, bytes) => { const absolute = path.join(g.baseline, relative); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, bytes); };
  write('builtin-skills/fixture/SKILL.md', '# Shared fixture skill\n');
  g.gitHead = '4'.repeat(40);
  if (actualGit) {
    write('.gitignore', 'dist/\napps/\n');
    const run = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: g.baseline, stdio: ['ignore', 'pipe', 'pipe'] });
    run(['init', '--initial-branch=fixture']); run(['add', '.gitignore', 'builtin-skills']);
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Private clean source']);
    g.gitHead = String(run(['rev-parse', 'HEAD'])).trim();
  }
  const sourceFingerprint = createHash('sha256').update('clementine-runtime-source-v1\0').update(g.gitHead).update('\0tracked-diff\0').digest('hex');
  const artifacts = {};
  const emitted = 'dist/runtime/harness/implementation-artifacts/emitted';
  for (const kind of ['invoke', 'reconcile', 'observer', 'transport', 'transportIsolated']) {
    const bytes = Buffer.from(`module.exports = '${kind}';\n`); const digest = sha(bytes); const file = `${kind}-${digest}.cjs`;
    write(`${emitted}/${file}`, bytes); artifacts[kind] = { file, sha256: digest };
  }
  const manifestDigest = sha(JSON.stringify({ version: 3, artifacts }));
  write(`${emitted}/manifest.json`, JSON.stringify({ version: 3, artifacts, manifestDigest }));
  const artifactDigests = Object.fromEntries(Object.entries(artifacts).map(([key, entry]) => [key, entry.sha256]));
  write(`${emitted}/build-stamp.json`, JSON.stringify({ implementationManifestDigest: manifestDigest, artifacts: artifactDigests }));
  const backendRuntimeDependencies = {};
  for (const relative of ['dist/integrations/composio/client.js', 'dist/runtime/harness/production-mcp-read-carrier.js']) {
    const bytes = `export const fixture = '${relative}';\n`; write(relative, bytes); backendRuntimeDependencies[relative] = sha(bytes);
  }
  write('dist/index.js', 'independently rebuilt current daemon\n');
  g.stamp = { gitSha: g.gitHead, gitDirty: false, sourceFingerprint, expectedSchemaVersion: 93,
    backendRuntimeDependencies, implementationManifestDigest: manifestDigest, artifacts: artifactDigests };
  write('dist/runtime/build-stamp.json', JSON.stringify(g.stamp) + '\n');
  write('apps/console-web/dist/index.html', '<p>current console</p>\n');
  write('apps/mobile-web/dist/index.html', '<p>current mobile</p>\n');
  const sourceRoots = { daemon: 'dist', 'builtin-skills': 'builtin-skills', 'console-web': 'apps/console-web/dist', 'mobile-web': 'apps/mobile-web/dist' };
  for (const relative of Object.values(AUTHORIZED_RUNTIME_PARTS)) {
    fs.mkdirSync(path.join(g.app, relative), { recursive: true });
    fs.writeFileSync(path.join(g.app, relative, 'official.txt'), 'signed native38 packaged runtime');
  }
  g.currentReference = path.join(g.root, 'official-current/Fixture.app');
  fs.cpSync(g.app, g.currentReference, { recursive: true, verbatimSymlinks: true });
  g.writeArchives(fullBundleZip(g.currentReference));
  g.backups = {};
  if (interruptedHistory) {
    // The held archive is genuinely the same native generation. Do not relabel
    // mixed-generation evidence or claim that the interrupted install passed.
    fs.rmSync(path.join(g.cache, 'pending.held-latest'), { recursive: true });
    g.writeArchives(fullBundleZip(g.currentReference), true);
    g.retained = undefined;
    const identity = () => ({ bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: 'd'.repeat(40) });
    const evidence = captureAppliedUpdateEvidence({ app: g.app, home: g.home }, fs, () => {});
    assert.equal(evidence.version, 1);
    const prove = repeatedReference => verifyGuardedSealedPatch({ app: g.app, home: g.home,
      shellSnapshot: evidence.shellSnapshot, appliedUpdateEvidence: evidence, repeatedReference,
      isRunning: () => false, isUpdaterRunning: () => false, verifyNativeSignature() {}, readReferenceCodeIdentity: identity });
    const receipts = [];
    for (let round = 1; round <= 2; round++) {
      const proof = prove(g.repeatedReference);
      const fingerprint = String(round).repeat(64);
      fs.writeFileSync(path.join(g.sourceDist, 'index.js'), `prior authorized round ${round}`);
      fs.writeFileSync(path.join(g.sourceDist, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: String(round).repeat(40), sourceFingerprint: fingerprint }));
      const receipt = { bundle: g.app, wasVersion: '3.18.38', sourceFingerprint: fingerprint, parts: {} };
      for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
        const target = path.join(g.app, relative);
        const source = name === 'mobile-web' ? path.join(g.baseline, sourceRoots[name]) : g.sourceDist;
        const result = name === 'daemon' ? installDaemonPatch({ sourceDist: source, targetDist: target, guarded: proof })
          : installBundledAssetDirectory({ sourceDir: source, targetDir: target, guarded: proof });
        const digest = name === 'daemon' ? inspectDaemonBuild(target).digest : assetDigest(target);
        receipt.parts[name] = { ...(name === 'daemon' ? { digest } : { built: digest }), served: digest, match: true, backup: result.backup };
      }
      const pin = pinJSON(path.join(g.durable, `authorized-round-${round}.json`), receipt);
      receipts.push(pin);
      g.repeatedReference = { referenceBundle: g.currentReference, expectedReferenceCdHash: 'd'.repeat(40),
        authorizedReceipt: pin.path, authorizedReceiptSha256: pin.sha256, expectedPriorFingerprint: fingerprint,
        ...(round === 2 ? (() => { const manifest = pinJSON(path.join(g.durable, 'authorized-ancestors.json'), { version: 1, receipts: receipts.slice(0, -1) });
          return { authorizedAncestorManifest: manifest.path, authorizedAncestorManifestSha256: manifest.sha256 }; })() : {}) };
    }
    const proof = prove(g.repeatedReference);
    g.interruptedBackups = {};
    for (const name of ['daemon', 'builtin-skills', 'console-web']) {
      const target = path.join(g.app, AUTHORIZED_RUNTIME_PARTS[name]); const source = path.join(g.baseline, sourceRoots[name]);
      const result = name === 'daemon' ? installDaemonPatch({ sourceDist: source, targetDist: target, guarded: proof })
        : installBundledAssetDirectory({ sourceDir: source, targetDir: target, guarded: proof });
      g.interruptedBackups[name] = result.backup;
    }
    assert.throws(() => prove(g.repeatedReference), /runtime differs|immutable footprint/,
      'the genuine old receipt cannot authorize the changed current roots');
    g.priorPins = receipts;
    fs.writeFileSync(path.join(g.sourceDist, 'index.js'), 'new recovery candidate');
    fs.writeFileSync(path.join(g.sourceDist, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64) }));
  } else {
    for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
      const target = path.join(g.app, relative); const backup = `${target}.backup-Pristine${name.replaceAll('-', '')}`;
      fs.renameSync(target, backup); fs.cpSync(path.join(g.baseline, sourceRoots[name]), target, { recursive: true }); g.backups[name] = backup;
    }
  }
  const parts = Object.entries(AUTHORIZED_RUNTIME_PARTS).map(([name, relative]) => {
    const builtRoot = path.join(g.baseline, sourceRoots[name]); const installedRoot = path.join(g.app, relative);
    const pin = pinJSON(path.join(g.durable, `${name}-inventory.json`), { built: recordedTree(builtRoot), installed: recordedTree(installedRoot) });
    return { name, builtRoot, installedRoot, manifestPath: pin.path, manifestSha256: pin.sha256, typedEqual: true };
  });
  g.report = { kind: 'independent_current_source_four_root_reproducibility_feasibility', sourceCommit: g.gitHead, sourceClean: true, parts,
    builtStampSha256: sha(fs.readFileSync(path.join(g.baseline, 'dist/runtime/build-stamp.json'))),
    installedStampSha256: sha(fs.readFileSync(path.join(g.app, AUTHORIZED_RUNTIME_PARTS.daemon, 'runtime/build-stamp.json'))),
    installedStampIdentity: { gitSha: g.gitHead, gitDirty: false, sourceFingerprint, expectedSchemaVersion: 93 }, allFourTypedEqual: true };
  const skillPath = 'builtin-skills/fixture/SKILL.md'; const skillBytes = fs.readFileSync(path.join(g.baseline, skillPath));
  g.blob = createHash('sha1').update(`blob ${skillBytes.length}\0`).update(skillBytes).digest('hex');
  g.binding = { kind: 'builtin_skills_complete_clean_Git_binding', commit: g.gitHead, exactFiles: [{ path: skillPath, gitMode: '100644', gitBlob: g.blob, sha256: sha(skillBytes) }] };
  g.parameters = { app: g.app, home: g.home, referenceBundle: g.currentReference, expectedReferenceCdHash: 'd'.repeat(40),
    reproducibility: pinJSON(path.join(g.durable, 'independent-build.json'), g.report),
    builtinGitBinding: pinJSON(path.join(g.durable, 'builtin-binding.json'), g.binding),
    ...(interruptedHistory ? { interruptionHistory: { version: 1, repeatedReference: g.repeatedReference, interruptedBackups: g.interruptedBackups } }
      : { pristineBackups: g.backups, retainedArchiveReference: g.retained }) };
  g.readIdentity = bundle => {
    assert.ok([g.reference, g.currentReference].includes(bundle), 'never claim the patched installed seal is pristine');
    return { bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: (bundle === g.reference ? 'c' : 'd').repeat(40) };
  };
  g.gitDirty = false; g.signatureCalls = []; g.gitCalls = [];
  g.commands = (command, args, options) => {
    if (command === '/usr/bin/codesign') {
      assert.deepEqual(args.slice(0, 3), ['--verify', '--deep', '--strict']);
      assert.ok([g.reference, g.currentReference].includes(args[3])); g.signatureCalls.push(args[3]); return '';
    }
    assert.equal(command, 'git'); assert.deepEqual(args.slice(0, 2), ['-c', 'core.fsmonitor=false']);
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0'); assert.equal(options.env.GIT_NO_LAZY_FETCH, '1'); assert.equal(options.env.GIT_NO_REPLACE_OBJECTS, '1');
    assert.equal(options.cwd, g.baseline); g.gitCalls.push(args.slice(2));
    if (actualGit) return execFileSync(command, args, options);
    const operation = args[2];
    if (operation === 'rev-parse') return Buffer.from(g.gitHead + '\n');
    if (operation === 'status') return Buffer.from(g.gitDirty ? ' M builtin-skills/fixture/SKILL.md\n' : '');
    if (operation === 'ls-tree') return Buffer.from(`100644 blob ${g.blob}\t${skillPath}\0`);
    if (operation === 'cat-file' && args[4] === g.blob) return skillBytes;
    throw new Error('unexpected fixture Git command');
  };
  g.capture = (operations = fs) => captureCurrentStateRecoveryEvidence(g.parameters, operations, g.commands, g.readIdentity);
  g.repinCapture = () => { g.document = g.capture(); g.capturePin = pinJSON(path.join(g.durable, 'current-capture.json'), g.document); };
  g.repinCapture();
  g.prove = (overrides = {}, operations = fs) => verifyCurrentStateRecoveryPatch({ app: g.app, home: g.home, evidence: g.capturePin,
    shellSnapshot: g.document.shellSnapshot, appliedUpdateEvidence: g.document.appliedUpdateEvidence,
    isRunning: () => false, isUpdaterRunning: () => false, commands: g.commands, readReferenceCodeIdentity: g.readIdentity,
    verifyNativeSignature: bundle => g.commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]), ...overrides }, operations);
  g.initialize = guarded => initializeCurrentStateRecoveryArtifacts({ guarded, directory: g.durable, forbiddenRoots: [path.join(g.root, 'candidate-workspace')] });
  g.patch = guarded => {
    const report = { bundle: g.app, wasVersion: '3.18.38', sourceFingerprint: 'b'.repeat(64), gitSha: 'a'.repeat(40), parts: {} };
    for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
      const target = path.join(g.app, relative);
      const result = name === 'daemon' ? installDaemonPatch({ sourceDist: g.sourceDist, targetDist: target, guarded })
        : installBundledAssetDirectory({ sourceDir: g.sourceDist, targetDir: target, guarded });
      const digest = name === 'daemon' ? inspectDaemonBuild(target).digest : assetDigest(target);
      report.parts[name] = { ...(name === 'daemon' ? { digest } : { built: digest }), served: digest, backup: result.backup, match: true };
    }
    return report;
  };
  return g;
}

function assetDigest(root) {
  const digest = createHash('sha256');
  const visit = relative => { const absolute = path.join(root, relative); if (fs.lstatSync(absolute).isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name)); else { digest.update(relative); digest.update(fs.readFileSync(absolute)); } };
  visit(''); return digest.digest('hex');
}

test('explicit present-state recovery verifies real clean Git and all typed current roots without asserting installed signature', t => {
  const g = recoveryFixture(t, { actualGit: true }); const proof = g.prove();
  assert.ok(g.gitCalls.some(args => args[0] === 'ls-tree'));
  assert.ok(g.gitCalls.some(args => args[0] === 'cat-file'));
  assert.ok(g.signatureCalls.includes(g.currentReference) && g.signatureCalls.includes(g.reference));
  assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }), /durable recovery genesis/);
  assert.throws(() => g.prove({ priorProof: JSON.parse(JSON.stringify(proof)) }), /private current recovery/);
  assert.throws(() => verifyGuardedSealedPatch({ app: g.app, home: g.home, priorProof: proof }), /legacy admission path/);
  assert.doesNotThrow(() => g.prove({ priorProof: proof }));
});

test('new durable genesis, exact four-root transaction and explicit future receipt chain remain distinct from missing history', t => {
  const g = recoveryFixture(t); const proof = g.prove(); const genesis = g.initialize(proof);
  const value = JSON.parse(fs.readFileSync(genesis.path));
  assert.equal(value.kind, 'current_state_recovery_genesis'); assert.equal(value.historicalInstallationReceipt, 'unavailable-not-reconstructed');
  assert.equal(fs.lstatSync(genesis.path).nlink, 1); assert.equal(fs.statSync(genesis.path).mode & 0o777, 0o600);
  const report = g.patch(proof); const completed = writeCurrentStateRecoveryReceipt({ guarded: proof, report });
  assert.equal(completed.receipt.recoveryStatus, 'four_roots_verified');
  assert.deepEqual(completed.receipt.recoveryGenesis, genesis);
  assert.equal(fs.readdirSync(g.durable).filter(name => name.startsWith('current-state-recovery-root-observed-')).length, 4);
  const repeat = { referenceBundle: g.currentReference, authorizedReceipt: completed.pin.path, authorizedReceiptSha256: completed.pin.sha256,
    expectedPriorFingerprint: report.sourceFingerprint, expectedReferenceCdHash: 'd'.repeat(40), authorizedRecoveryGenesis: genesis.path, authorizedRecoveryGenesisSha256: genesis.sha256 };
  const prove = options => verifyGuardedSealedPatch({ app: g.app, home: g.home, shellSnapshot: g.document.shellSnapshot, appliedUpdateEvidence: g.document.appliedUpdateEvidence,
    repeatedReference: options, isRunning: () => false, isUpdaterRunning: () => false,
    verifyNativeSignature: bundle => g.commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]), readReferenceCodeIdentity: g.readIdentity });
  const next = prove(repeat);
  assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: next }), /durable recovery genesis/);
  const { authorizedRecoveryGenesis: _a, authorizedRecoveryGenesisSha256: _b, ...legacy } = repeat;
  assert.throws(() => prove(legacy), /requires explicit genesis pins/);
  assert.throws(() => prove({ ...repeat, authorizedReceipt: path.join(g.durable, 'missing-original38.json') }), /no such file/);
  initializeCurrentStateRecoveryArtifacts({ guarded: next, directory: g.durable });
  const second = writeCurrentStateRecoveryReceipt({ guarded: next, report: g.patch(next) });
  assert.equal(second.receipt.parts.daemon.match, true);
  const ancestors = pinJSON(path.join(g.durable, 'genuine-new-ancestors.json'), { version: 1, receipts: [completed.pin] });
  assert.doesNotThrow(() => prove({ ...repeat, authorizedReceipt: second.pin.path, authorizedReceiptSha256: second.pin.sha256,
    authorizedAncestorManifest: ancestors.path, authorizedAncestorManifestSha256: ancestors.sha256 }));
});

test('future recovery admission requires genuine completed new receipts and the exact explicit genesis and capture', async t => {
  const g = recoveryFixture(t); const proof = g.prove(); const genesis = g.initialize(proof);
  const completed = writeCurrentStateRecoveryReceipt({ guarded: proof, report: g.patch(proof) });
  const base = { referenceBundle: g.currentReference, authorizedReceipt: completed.pin.path, authorizedReceiptSha256: completed.pin.sha256,
    expectedPriorFingerprint: completed.receipt.sourceFingerprint, expectedReferenceCdHash: 'd'.repeat(40),
    authorizedRecoveryGenesis: genesis.path, authorizedRecoveryGenesisSha256: genesis.sha256 };
  const prove = options => verifyGuardedSealedPatch({ app: g.app, home: g.home, shellSnapshot: g.document.shellSnapshot, appliedUpdateEvidence: g.document.appliedUpdateEvidence,
    repeatedReference: options, isRunning: () => false, isUpdaterRunning: () => false, verifyNativeSignature() {}, readReferenceCodeIdentity: g.readIdentity });
  for (const [name, options] of [
    ['missing genesis hash', { ...base, authorizedRecoveryGenesisSha256: undefined }],
    ['wrong genesis hash', { ...base, authorizedRecoveryGenesisSha256: '1'.repeat(64) }],
    ['missing genesis path', { ...base, authorizedRecoveryGenesis: undefined }],
  ]) await t.test(name, () => assert.throws(() => prove(options)));
  for (const [name, change] of [
    ['status-only receipt', value => { value.recoveryStatus = 'partial'; }],
    ['receipt has different genesis', value => { value.recoveryGenesis.sha256 = '1'.repeat(64); }],
    ['receipt omits genesis', value => { delete value.recoveryGenesis; }],
    ['receipt omits a runtime part', value => { delete value.parts['console-web']; }],
    ['receipt names pristine native38 backup as current4023 rollback', value => { value.parts.daemon.backup = g.backups.daemon; }],
  ]) await t.test(name, () => {
    const receipt = structuredClone(completed.receipt); change(receipt);
    const pin = pinJSON(path.join(g.durable, `invalid-${name.replaceAll(/[^a-z0-9]/gi, '-')}.json`), receipt);
    assert.throws(() => prove({ ...base, authorizedReceipt: pin.path, authorizedReceiptSha256: pin.sha256 }));
  });
  await t.test('genesis original capture bytes changed', () => {
    fs.appendFileSync(g.capturePin.path, ' '); assert.throws(() => prove(base));
  });
});

test('installer CLI selects the explicit recovery verifier and refuses mixed or partial recovery options before work', async t => {
  const g = recoveryFixture(t);
  fs.writeFileSync(path.join(g.app, 'Contents/Resources/daemon/package.json'), JSON.stringify({ version: '3.18.38' }));
  const moduleUrl = new URL('./hotpatch-installed-tree.mjs', import.meta.url);
  const body = fs.readFileSync(moduleUrl, 'utf8').replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*$/gm, '').replaceAll('import.meta.url', JSON.stringify(moduleUrl.href));
  const { Script } = await import('node:vm'); const { fileURLToPath } = await import('node:url'); const helpers = await import('./hotpatch-daemon.mjs');
  const valid = ['--no-relaunch', '--guarded-shell-snapshot', g.capturePin.path,
    '--current-state-recovery', g.capturePin.path, '--current-state-recovery-sha256', g.capturePin.sha256, '--recovery-evidence-directory', g.durable];
  const run = args => new Script(`(async () => { ${body}\n})()`).runInNewContext({
    ...helpers, fs, path, createHash, fileURLToPath,
    process: { argv: ['node', moduleUrl.pathname, ...args], env: { HOME: g.home, CLEMENTINE_APP_PATH: g.app }, exit() { throw new Error('unexpected exit'); } },
    console: { log() {}, error() {} }, execFileSync() { throw new Error('unexpected subprocess'); },
    isInstalledAppRunning: () => false,
    verifyCurrentStateRecoveryPatch(options) { assert.equal(options.evidence.path, g.capturePin.path); throw new Error('explicit recovery verifier selected'); },
    verifyGuardedSealedPatch() { throw new Error('legacy verifier must not run'); },
  });
  await assert.rejects(run(valid), /explicit recovery verifier selected/);
  await assert.rejects(run(valid.filter((_, index) => index !== valid.length - 1)), /requires an exact value/);
  await assert.rejects(run([...valid, '--current-state-recovery', g.capturePin.path]), /Duplicate/);
  await assert.rejects(run([...valid, '--authorized-prior-receipt', '/missing']), /all five/);
  await assert.rejects(run(['--recovery-evidence-directory', g.durable]), /requires explicit recovery authority/);
  const snapshot = pinJSON(path.join(g.durable, 'bad-no-active-snapshot.json'), { ...g.document, noActiveUpdateEvidence: {} });
  await assert.rejects(run(valid.map(value => value === g.capturePin.path ? snapshot.path : value)), /cannot use no-active-update/);
});

test('success labels never replace fresh exact source, stamp, inventory, Git and built-in proofs', async t => {
  for (const [name, change] of [
    ['same forged current and rebuild bytes', g => { for (const root of [path.join(g.baseline, 'dist'), g.daemonDist]) fs.appendFileSync(path.join(root, 'index.js'), 'unrecorded bytes'); }],
    ['clean-source claim but dirty actual Git', g => { g.gitDirty = true; }],
    ['wrong actual Git head', g => { g.gitHead = '9'.repeat(40); }],
    ['forged built-in Git blob', g => { g.blob = '9'.repeat(40); }],
    ['ignored extra built-in file', g => fs.writeFileSync(path.join(g.baseline, 'builtin-skills/ignored.txt'), 'extra')],
    ['same full-stamp mutation in both trees', g => { for (const root of [path.join(g.baseline, 'dist'), g.daemonDist]) fs.appendFileSync(path.join(root, 'runtime/build-stamp.json'), ' '); }],
    ['stale implementation artifact', g => fs.writeFileSync(path.join(g.baseline, 'dist/runtime/harness/implementation-artifacts/emitted/stale.cjs'), 'old generation')],
    ['changed backend bytes', g => fs.appendFileSync(path.join(g.baseline, 'dist/integrations/composio/client.js'), 'changed')],
    ['mode drift', g => fs.chmodSync(path.join(g.baseline, 'apps/mobile-web/dist'), 0o700)],
    ['build symlink', g => fs.symlinkSync('index.js', path.join(g.baseline, 'dist/linked.js'))],
    ['build hardlink', g => fs.linkSync(path.join(g.baseline, 'dist/index.js'), path.join(g.baseline, 'dist/linked.js'))],
    ['noncanonical root', g => { g.parameters.referenceBundle += '/.'; }],
    ['extra root authority', g => { g.parameters.pristineBackups.extra = g.parameters.pristineBackups.daemon; }],
    ['missing independent report', g => fs.rmSync(g.parameters.reproducibility.path)],
    ['pinned inventory altered', g => fs.appendFileSync(g.report.parts[0].manifestPath, ' ')],
    ['capture bytes altered', g => fs.appendFileSync(g.capturePin.path, ' ')],
    ['capture hardlinked', g => fs.linkSync(g.capturePin.path, path.join(g.durable, 'alias.json'))],
    ['capture symlinked', g => { const moved = path.join(g.durable, 'capture-copy.json'); fs.renameSync(g.capturePin.path, moved); fs.symlinkSync(moved, g.capturePin.path); }],
  ]) await t.test(name, t => {
    const g = recoveryFixture(t); change(g);
    assert.throws(() => name === 'noncanonical root' || name === 'extra root authority' ? g.capture() : g.prove());
    assert.equal(fs.readdirSync(g.durable).some(name => name.startsWith('current-state-recovery-genesis-')), false);
  });
});

test('complete signed references, all four pristine backups and exact updater history stay mandatory', async t => {
  for (const [name, change] of [
    ['extra immutable file', g => fs.writeFileSync(path.join(g.app, 'Contents/Resources/unaccounted.txt'), 'extra')],
    ['native changed', g => fs.appendFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'changed')],
    ['unknown rollback is never wildcard excluded', g => fs.mkdirSync(g.daemonDist + '.backup-Unaccounted')],
    ['pristine backup changed', g => fs.appendFileSync(path.join(g.backups['mobile-web'], 'official.txt'), 'changed')],
    ['pristine backup missing', g => fs.rmSync(g.backups['console-web'], { recursive: true })],
    ['old reference changed', g => fs.appendFileSync(path.join(g.reference, 'Contents/Resources/app.asar'), 'changed')],
    ['current reference changed', g => fs.appendFileSync(path.join(g.currentReference, 'Contents/Resources/app.asar'), 'changed')],
    ['old genuine snapshot changed', g => fs.appendFileSync(g.historicalPath, ' ')],
    ['held archive changed', g => fs.appendFileSync(g.heldArchive, 'changed')],
    ['active archive changed', g => fs.appendFileSync(path.join(g.cache, 'update.zip'), 'changed')],
    ['new installer state', g => fs.mkdirSync(path.join(g.shipIt, 'update.NEW'))],
  ]) await t.test(name, t => { const g = recoveryFixture(t); change(g); assert.throws(() => g.prove()); });
  await t.test('wrong actual signer', t => {
    const g = recoveryFixture(t);
    assert.throws(() => g.prove({ readReferenceCodeIdentity: bundle => ({ ...g.readIdentity(bundle), team: 'WRONGSIGNER' }) }));
  });
  await t.test('full signature failure', t => {
    const g = recoveryFixture(t); assert.throws(() => g.prove({ verifyNativeSignature() { throw new Error('signature failure'); } }), /signature failure/);
  });
  await t.test('old legacy missing receipt remains missing', t => {
    const g = recoveryFixture(t);
    assert.throws(() => verifyGuardedSealedPatch({ app: g.app, home: g.home, shellSnapshot: g.document.shellSnapshot,
      appliedUpdateEvidence: g.document.appliedUpdateEvidence, repeatedReference: { referenceBundle: g.currentReference,
        authorizedReceipt: path.join(g.durable, 'missing-original38.json'), authorizedReceiptSha256: '1'.repeat(64),
        expectedPriorFingerprint: g.stamp.sourceFingerprint, expectedReferenceCdHash: 'd'.repeat(40) },
      isRunning: () => false, isUpdaterRunning: () => false, verifyNativeSignature() {}, readReferenceCodeIdentity: g.readIdentity }), /no such file/);
  });
});

test('fresh process/signature/source checks refuse races before capability and before each root rename', async t => {
  await t.test('app starts across admission', t => {
    const g = recoveryFixture(t); let checks = 0;
    assert.throws(() => g.prove({ isRunning: () => ++checks > 1 }), /app or installer helper is running/);
  });
  await t.test('helper already running', t => { const g = recoveryFixture(t); assert.throws(() => g.prove({ isUpdaterRunning: () => true })); });
  await t.test('signature subprocess changes clean build', t => {
    const g = recoveryFixture(t);
    assert.throws(() => g.prove({ verifyNativeSignature: () => fs.appendFileSync(path.join(g.baseline, 'dist/index.js'), 'changed during signature') }));
  });
  for (const [name, change] of [
    ['native changes during staging', g => fs.appendFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'changed')],
    ['queued update during staging', g => fs.mkdirSync(path.join(g.shipIt, 'update.NEW'))],
    ['independent baseline changes during staging', g => fs.appendFileSync(path.join(g.baseline, 'dist/index.js'), 'changed')],
    ['candidate changes during staging', g => fs.appendFileSync(path.join(g.sourceDist, 'index.js'), 'changed')],
  ]) await t.test(name, t => {
    const g = recoveryFixture(t); const proof = g.prove(); g.initialize(proof);
    const before = fs.readFileSync(path.join(g.daemonDist, 'index.js'));
    let renames = 0;
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, { ...fs,
      cpSync(...args) { fs.cpSync(...args); change(g); }, renameSync(...args) { renames++; return fs.renameSync(...args); } }));
    assert.equal(renames, 0); assert.deepEqual(fs.readFileSync(path.join(g.daemonDist, 'index.js')), before);
    assert.equal(fs.readdirSync(g.durable).some(name => name.startsWith('current-state-recovery-completed-')), false);
  });
  await t.test('baseline changes after a completed first root', t => {
    const g = recoveryFixture(t); const proof = g.prove(); g.initialize(proof);
    installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof });
    fs.appendFileSync(path.join(g.baseline, 'builtin-skills/fixture/SKILL.md'), 'changed');
    assert.throws(() => installBundledAssetDirectory({ sourceDir: g.sourceDist, targetDir: path.join(g.app, AUTHORIZED_RUNTIME_PARTS['builtin-skills']), guarded: proof }));
    const failure = recordCurrentStateRecoveryFailure({ guarded: proof }); const value = JSON.parse(fs.readFileSync(failure.path));
    assert.equal(value.completion, 'not-certified'); assert.equal(value.roots.filter(root => root.replaced).length, 1);
  });
});

test('durable evidence failures and partial copy never become successful adoption or completion', async t => {
  await t.test('directory cannot live in baseline or candidate workspace', t => {
    const g = recoveryFixture(t); const proof = g.prove();
    assert.throws(() => initializeCurrentStateRecoveryArtifacts({ guarded: proof, directory: g.baseline }), /separate from application and build/);
    assert.throws(() => initializeCurrentStateRecoveryArtifacts({ guarded: proof, directory: g.durable, forbiddenRoots: [g.root] }), /separate from application and build/);
  });
  await t.test('capture provenance cannot live in discarded build workspace', t => {
    const g = recoveryFixture(t); const capture = pinJSON(path.join(g.baseline, 'discarded-capture.json'), g.document);
    const proof = g.prove({ evidence: capture });
    assert.throws(() => g.initialize(proof), /durable outside build workspaces/);
  });
  await t.test('exclusive genesis write failure gives no mutation authority', t => {
    const g = recoveryFixture(t); const proof = g.prove();
    assert.throws(() => initializeCurrentStateRecoveryArtifacts({ guarded: proof, directory: g.durable }, { ...fs, openSync(absolute, ...args) {
      if (String(absolute).includes('/current-state-recovery-genesis-')) throw new Error('durable write denied'); return fs.openSync(absolute, ...args);
    } }), /durable write denied/);
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }), /durable recovery genesis/);
  });
  await t.test('root-journal failure restores the old root before changing private state', t => {
    const g = recoveryFixture(t); const proof = g.prove(); g.initialize(proof); const before = fs.readFileSync(path.join(g.daemonDist, 'index.js'));
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, { ...fs, openSync(absolute, ...args) {
      if (String(absolute).includes('/current-state-recovery-root-observed-')) throw new Error('root journal denied'); return fs.openSync(absolute, ...args);
    } }), /root journal denied/);
    assert.deepEqual(fs.readFileSync(path.join(g.daemonDist, 'index.js')), before);
    assert.doesNotThrow(() => g.prove({ priorProof: proof }));
    const observation = JSON.parse(fs.readFileSync(recordCurrentStateRecoveryFailure({ guarded: proof }).path));
    assert.equal(observation.roots.some(root => root.replaced), false);
  });
  await t.test('partial stage is journaled, cleaned, and never certified', t => {
    const g = recoveryFixture(t); const proof = g.prove(); g.initialize(proof);
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, { ...fs, cpSync(_source, destination) {
      fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, 'partial.txt'), 'partial stage'); throw new Error('copy interrupted');
    } }), /copy interrupted/);
    const file = fs.readdirSync(g.durable).find(name => name.startsWith('current-state-recovery-stage-failed-'));
    const journal = JSON.parse(fs.readFileSync(path.join(g.durable, file)));
    assert.match(journal.observedTypedDigest, /^[a-f0-9]{64}$/); assert.equal(journal.completion, 'not-certified'); assert.equal(fs.existsSync(journal.staging), false);
    assert.throws(() => writeCurrentStateRecoveryReceipt({ guarded: proof, report: { bundle: g.app, wasVersion: '3.18.38', parts: {} } }), /identity differs/);
  });
});


test('interrupted repeat recovery admits true v1 evidence without adopting a failed transaction', t => {
  const g = recoveryFixture(t, { actualGit: true, interruptedHistory: true });
  assert.equal(g.document.appliedUpdateEvidence.version, 1);
  assert.equal(g.document.parameters.retainedArchiveReference, undefined);
  assert.deepEqual(Object.keys(g.document.parameters.interruptionHistory.interruptedBackups), ['daemon', 'builtin-skills', 'console-web']);
  const proof = g.prove();
  assert.equal(fs.readdirSync(g.durable).some(name => name.startsWith('current-state-recovery-completed-')), false);
  assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }), /durable recovery genesis/);
  g.initialize(proof);
  const completed = writeCurrentStateRecoveryReceipt({ guarded: proof, report: g.patch(proof) });
  assert.equal(completed.receipt.recoveryStatus, 'four_roots_verified');
  assert.equal(fs.readdirSync(g.durable).filter(name => name.startsWith('current-state-recovery-root-observed-')).length, 4);
  for (const backup of Object.values(g.interruptedBackups)) assert.ok(fs.existsSync(backup));
  for (const pin of g.priorPins) assert.equal(sha(fs.readFileSync(pin.path)), pin.sha256);
});

test('interrupted repeat recovery replays inherited history on future completed receipts', t => {
  const g = recoveryFixture(t, { interruptedHistory: true }); const proof = g.prove(); const genesis = g.initialize(proof);
  const first = writeCurrentStateRecoveryReceipt({ guarded: proof, report: g.patch(proof) });
  const repeat = { referenceBundle: g.currentReference, authorizedReceipt: first.pin.path, authorizedReceiptSha256: first.pin.sha256,
    expectedPriorFingerprint: first.receipt.sourceFingerprint, expectedReferenceCdHash: 'd'.repeat(40),
    authorizedRecoveryGenesis: genesis.path, authorizedRecoveryGenesisSha256: genesis.sha256 };
  const prove = options => verifyGuardedSealedPatch({ app: g.app, home: g.home, shellSnapshot: g.document.shellSnapshot,
    appliedUpdateEvidence: g.document.appliedUpdateEvidence, repeatedReference: options,
    isRunning: () => false, isUpdaterRunning: () => false, verifyNativeSignature() {}, readReferenceCodeIdentity: g.readIdentity });
  const next = prove(repeat);
  initializeCurrentStateRecoveryArtifacts({ guarded: next, directory: g.durable });
  const second = writeCurrentStateRecoveryReceipt({ guarded: next, report: g.patch(next) });
  const ancestors = pinJSON(path.join(g.durable, 'post-recovery-ancestors.json'), { version: 1, receipts: [first.pin] });
  const future = { ...repeat, authorizedReceipt: second.pin.path, authorizedReceiptSha256: second.pin.sha256,
    authorizedAncestorManifest: ancestors.path, authorizedAncestorManifestSha256: ancestors.sha256 };
  assert.doesNotThrow(() => prove(future));
  fs.appendFileSync(path.join(g.interruptedBackups.daemon, 'index.js'), 'corrupt interrupted rollback');
  assert.throws(() => prove(future), /runtime differs|rollback/);
});

test('interrupted repeat recovery refuses missing, aliased, unordered or unrelated authority', async t => {
  for (const [name, mutate] of [
    ['empty prefix', g => { g.parameters.interruptionHistory.interruptedBackups = {}; }],
    ['nonprefix keys', g => { delete g.parameters.interruptionHistory.interruptedBackups['builtin-skills']; }],
    ['extra prefix key', g => { g.parameters.interruptionHistory.interruptedBackups.extra = g.interruptedBackups.daemon; }],
    ['wrong root alias', g => { g.parameters.interruptionHistory.interruptedBackups['console-web'] = g.interruptedBackups.daemon; }],
    ['older prior root', g => { const old = JSON.parse(fs.readFileSync(g.priorPins[0].path)); g.parameters.interruptionHistory.interruptedBackups.daemon = old.parts.daemon.backup; }],
    ['missing interrupted backup', g => fs.rmSync(g.interruptedBackups.daemon, { recursive: true })],
    ['interrupted backup bytes', g => fs.appendFileSync(path.join(g.interruptedBackups.daemon, 'index.js'), 'changed')],
    ['interrupted backup mode', g => fs.chmodSync(g.interruptedBackups.daemon, 0o700)],
    ['unknown backup', g => fs.mkdirSync(g.daemonDist + '.backup-Unknown')],
    ['unknown stage', g => fs.mkdirSync(g.daemonDist + '.stage-Unknown')],
    ['immutable addition', g => fs.writeFileSync(path.join(g.app, 'Contents/Resources/extra.txt'), 'unaccounted')],
    ['legacy missing receipt', g => fs.rmSync(g.priorPins[0].path)],
    ['prior receipt altered', g => fs.appendFileSync(g.priorPins[1].path, ' ')],
    ['manifest altered', g => fs.appendFileSync(g.repeatedReference.authorizedAncestorManifest, ' ')],
    ['recursive genesis', g => { g.parameters.interruptionHistory.repeatedReference.authorizedRecoveryGenesis = g.capturePin.path; }],
    ['extra history field', g => { g.parameters.interruptionHistory.skipVerification = true; }],
    ['native changed', g => fs.appendFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'changed')],
    ['reference changed', g => fs.appendFileSync(path.join(g.currentReference, 'Contents/Resources/app.asar'), 'changed')],
    ['current baseline drift', g => fs.appendFileSync(path.join(g.baseline, 'dist/index.js'), 'changed')],
  ]) await t.test(name, t => {
    const g = recoveryFixture(t, { interruptedHistory: true }); mutate(g);
    assert.throws(() => g.capture());
    assert.equal(fs.readdirSync(g.durable).some(file => file.startsWith('current-state-recovery-genesis-')), false);
  });
});

test('interrupted repeat recovery keeps pin checks across admission, staging and future replay', async t => {
  await t.test('closed app required across admission', t => {
    const g = recoveryFixture(t, { interruptedHistory: true }); let count = 0;
    assert.throws(() => g.prove({ isRunning: () => ++count > 1 }), /app or installer helper/);
  });
  await t.test('inherited receipt change after admission prevents rename', t => {
    const g = recoveryFixture(t, { interruptedHistory: true }); const proof = g.prove(); g.initialize(proof);
    let renames = 0;
    assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, { ...fs,
      cpSync(...args) { fs.cpSync(...args); fs.appendFileSync(g.priorPins[0].path, ' '); },
      renameSync(...args) { renames++; return fs.renameSync(...args); } }));
    assert.equal(renames, 0);
    assert.equal(fs.readdirSync(g.durable).some(file => file.startsWith('current-state-recovery-completed-')), false);
  });
  await t.test('history pins must be durable outside source workspaces', t => {
    const g = recoveryFixture(t, { interruptedHistory: true });
    const prior = g.parameters.interruptionHistory.repeatedReference;
    const moved = path.join(g.baseline, 'receipt.json'); fs.copyFileSync(prior.authorizedReceipt, moved); prior.authorizedReceipt = moved;
    g.repinCapture(); const proof = g.prove();
    assert.throws(() => g.initialize(proof), /durable outside build/);
  });
  await t.test('untouched mobile cannot be silently adopted from a different generation', t => {
    const g = recoveryFixture(t, { interruptedHistory: true });
    for (const root of [path.join(g.baseline, 'apps/mobile-web/dist'), path.join(g.app, AUTHORIZED_RUNTIME_PARTS['mobile-web'])]) {
      fs.writeFileSync(path.join(root, 'index.html'), '<p>changed without a rollback</p>');
    }
    const part = g.report.parts.find(part => part.name === 'mobile-web');
    const pin = pinJSON(part.manifestPath, { built: recordedTree(part.builtRoot), installed: recordedTree(part.installedRoot) });
    part.manifestSha256 = pin.sha256;
    g.parameters.reproducibility = pinJSON(g.parameters.reproducibility.path, g.report);
    assert.throws(() => g.capture(), /runtime differs/);
  });
});

test('interrupted repeat recovery rechecks future process races before admission and rename', async t => {
  for (const stage of ['admission', 'staging']) await t.test(stage, t => {
    const g = recoveryFixture(t, { interruptedHistory: true }); const initial = g.prove(); const genesis = g.initialize(initial);
    const completed = writeCurrentStateRecoveryReceipt({ guarded: initial, report: g.patch(initial) });
    const repeatedReference = { referenceBundle: g.currentReference,
      authorizedReceipt: completed.pin.path, authorizedReceiptSha256: completed.pin.sha256,
      expectedPriorFingerprint: completed.receipt.sourceFingerprint, expectedReferenceCdHash: 'd'.repeat(40),
      authorizedRecoveryGenesis: genesis.path, authorizedRecoveryGenesisSha256: genesis.sha256 };
    let running = false; let staged = false; let renames = 0; let checks = 0;
    const operations = { ...fs,
      cpSync(...args) { fs.cpSync(...args); staged = true; },
      readFileSync(absolute, ...args) {
        const value = fs.readFileSync(absolute, ...args);
        if (staged && String(absolute) === g.priorPins[0].path) running = true;
        return value;
      },
      renameSync(...args) { renames++; return fs.renameSync(...args); },
    };
    const prove = () => verifyGuardedSealedPatch({ app: g.app, home: g.home,
      shellSnapshot: g.document.shellSnapshot, appliedUpdateEvidence: g.document.appliedUpdateEvidence,
      repeatedReference, isRunning: () => stage === 'admission' ? ++checks > 1 : running,
      isUpdaterRunning: () => false, verifyNativeSignature() {}, readReferenceCodeIdentity: g.readIdentity }, operations);
    if (stage === 'admission') assert.throws(prove, /app or installer helper/);
    else {
      const proof = prove(); initializeCurrentStateRecoveryArtifacts({ guarded: proof, directory: g.durable });
      const before = fs.readFileSync(path.join(g.daemonDist, 'index.js'));
      assert.throws(() => installDaemonPatch({ sourceDist: g.sourceDist, targetDist: g.daemonDist, guarded: proof }, operations), /app or installer helper|still running/);
      assert.equal(renames, 0, 'a process starting during the final staging proof must prevent both renames');
      assert.deepEqual(fs.readFileSync(path.join(g.daemonDist, 'index.js')), before);
    }
  });
});

test('interrupted repeat recovery preserves existing pristine-genesis no-active compatibility', t => {
  const g = recoveryFixture(t); const proof = g.prove(); const genesis = g.initialize(proof);
  const completed = writeCurrentStateRecoveryReceipt({ guarded: proof, report: g.patch(proof) });
  // Exercise the preexisting no-active route independently of the new history
  // mode. Its own closing process check must not read absent applied evidence.
  fs.rmSync(path.join(g.cache, 'pending.held-latest'), { recursive: true });
  g.writeArchives(fullBundleZip(g.currentReference), true);
  fs.rmSync(path.join(g.cache, 'pending'), { recursive: true });
  fs.rmSync(path.join(g.cache, 'update.zip'));
  fs.rmSync(g.statePath);
  const noActiveUpdateEvidence = captureNoActiveUpdateEvidence({ app: g.app, home: g.home });
  assert.doesNotThrow(() => verifyGuardedSealedPatch({ app: g.app, home: g.home,
    shellSnapshot: g.document.shellSnapshot, noActiveUpdateEvidence,
    repeatedReference: { referenceBundle: g.currentReference, expectedReferenceCdHash: 'd'.repeat(40),
      authorizedReceipt: completed.pin.path, authorizedReceiptSha256: completed.pin.sha256,
      expectedPriorFingerprint: completed.receipt.sourceFingerprint,
      authorizedRecoveryGenesis: genesis.path, authorizedRecoveryGenesisSha256: genesis.sha256 },
    isRunning: () => false, isUpdaterRunning: () => false, verifyNativeSignature() {}, readReferenceCodeIdentity: g.readIdentity }));
});
