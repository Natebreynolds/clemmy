/**
 * Run: node --test scripts/hotpatch-signed-build-anchor.test.mjs
 *
 * A whole signed bundle built and notarized here and installed in place has no
 * updater download to anchor a hotpatch chain. Its pinned replacement record,
 * a separate signed reference copy and the signature/notarization checks
 * anchor it instead. No fixture uses a real application, updater or signer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { SEALED_SHELL_PARTS, assertMutableInstallTarget, verifyGuardedSealedPatch } from './hotpatch-daemon.mjs';

const CDHASH = 'c'.repeat(40);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PARTS = {
  daemon: 'Contents/Resources/daemon/dist',
  'builtin-skills': 'Contents/Resources/daemon/builtin-skills',
  'console-web': 'Contents/Resources/daemon/apps/console-web/dist',
  'mobile-web': 'Contents/Resources/daemon/apps/mobile-web/dist',
};

function daemonDigest(root) {
  const hash = createHash('sha256');
  const visit = (rel) => {
    const absolute = path.join(root, rel); const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(rel, name));
    else { hash.update(JSON.stringify([rel, stat.size])); hash.update(fs.readFileSync(absolute)); }
  };
  visit(''); return hash.digest('hex');
}

function assetDigest(root) {
  const hash = createHash('sha256');
  const visit = (rel) => {
    const absolute = path.join(root, rel);
    if (fs.lstatSync(absolute).isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(path.join(rel, name));
    else { hash.update(rel); hash.update(fs.readFileSync(absolute)); }
  };
  visit(''); return hash.digest('hex');
}

function anchorFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signed-build-anchor-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Fixture.app');
  const home = path.join(root, 'home');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true }); fs.writeFileSync(path.join(app, rel), text); };
  write('Contents/MacOS/Clementine', 'native launcher');
  write('Contents/Info.plist', '<dict><key>CFBundleIdentifier</key><string>com.example.fixture</string><key>CFBundleShortVersionString</key><string>3.18.42</string></dict>');
  write('Contents/Resources/app.asar', 'packaged shell');
  write('Contents/_CodeSignature/CodeResources', 'seal');
  write('Contents/Resources/app-update.yml', "provider: github\nupdaterCacheDirName: '@fixture-updater'\n");
  for (const relative of Object.values(PARTS)) write(path.join(relative, 'official.txt'), 'signed build runtime');
  const reference = path.join(root, 'kit/signed-candidate-reference/Fixture.app');
  fs.cpSync(app, reference, { recursive: true, verbatimSymlinks: true });
  // The updater holds only consumed state: a request whose staged bundle is
  // gone, and a retained download of the installed version.
  const shipIt = path.join(home, 'Library/Caches/com.example.fixture.ShipIt');
  const cache = path.join(home, 'Library/Caches/@fixture-updater');
  fs.mkdirSync(shipIt, { recursive: true });
  fs.writeFileSync(path.join(shipIt, 'ShipItState.plist'), JSON.stringify({
    launchAfterInstallation: false, useUpdateBundleName: true, bundleIdentifier: 'com.example.fixture',
    updateBundleURL: `${pathToFileURL(path.join(shipIt, 'update.ABC123/Fixture.app')).href}/`, targetBundleURL: `${pathToFileURL(app).href}/`,
  }));
  fs.mkdirSync(path.join(cache, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'pending/update-info.json'), JSON.stringify({ fileName: 'Fixture-3.18.42-arm64-mac.zip', sha512: 'x', isAdminRightsRequired: false }));
  const record = {
    version: 1, kind: 'whole_signed_bundle_replacement', app, signedReference: reference,
    candidate: { code: { identifier: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: CDHASH } },
    installed: { code: { identifier: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: CDHASH } },
    codeResigned: false, xattrsCleared: false,
  };
  const anchorPath = path.join(root, 'kit/whole-bundle-replacement-receipt.json');
  const writeAnchor = (value = record) => { fs.writeFileSync(anchorPath, JSON.stringify(value)); return { path: anchorPath, sha256: sha(fs.readFileSync(anchorPath)) }; };
  const snapshot = () => Object.fromEntries(SEALED_SHELL_PARTS.map((rel) => [rel, sha(fs.readFileSync(path.join(app, rel)))]));
  const g = { root, app, home, reference, shipIt, cache, record, writeAnchor, anchor: writeAnchor(), signed: [], notarized: [] };
  g.shellSnapshot = snapshot();
  g.prove = (overrides = {}) => verifyGuardedSealedPatch({
    app, home, shellSnapshot: g.shellSnapshot, signedBuildAnchor: g.anchor,
    isRunning: () => false, isUpdaterRunning: () => false,
    verifyNativeSignature: (bundle) => { g.signed.push(bundle); },
    assessNotarization: (bundle) => { g.notarized.push(bundle); },
    readReferenceCodeIdentity: () => ({ bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: CDHASH }),
    ...overrides,
  });
  return g;
}

/** What the first anchored patch leaves behind: new runtime bytes, the signed
 * build's runtime retained as rollback, and a receipt naming the anchor. */
function firstPatchApplied(g, receiptOverrides = {}) {
  const build = path.join(g.root, 'build');
  fs.mkdirSync(path.join(build, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(build, 'index.js'), 'new daemon');
  fs.writeFileSync(path.join(build, 'runtime/build-stamp.json'), JSON.stringify({ gitSha: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64) }));
  const receipt = { bundle: g.app, wasVersion: '3.18.42', sourceFingerprint: 'b'.repeat(64), parts: {}, signedBuildAnchor: g.anchor, ...receiptOverrides };
  for (const [name, relative] of Object.entries(PARTS)) {
    const target = path.join(g.app, relative); const backup = `${target}.backup-Anchor${name.replace(/-/g, '')}`;
    fs.renameSync(target, backup);
    fs.cpSync(build, target, { recursive: true });
    const digest = name === 'daemon' ? daemonDigest(target) : assetDigest(target);
    receipt.parts[name] = { ...(name === 'daemon' ? { digest } : { built: digest }), served: digest, backup, match: true };
  }
  const receiptPath = path.join(g.root, 'receipt-c1v1.json');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt));
  return { referenceBundle: g.reference, authorizedReceipt: receiptPath, authorizedReceiptSha256: sha(fs.readFileSync(receiptPath)),
    expectedPriorFingerprint: 'b'.repeat(64), expectedReferenceCdHash: CDHASH };
}

test('the first patch on a signed local build verifies the installed bundle itself and admits only its runtime', (t) => {
  const g = anchorFixture(t);
  const proof = g.prove();
  assert.deepEqual(g.signed, [g.app], 'the pristine installed seal is verified');
  assert.deepEqual(g.notarized, [g.app], 'and assessed by Gatekeeper');
  assert.doesNotThrow(() => assertMutableInstallTarget(path.join(g.app, 'Contents/Resources/daemon/dist'), proof));
  assert.throws(() => assertMutableInstallTarget(path.join(g.app, 'Contents/MacOS/Clementine'), proof));
});

test('an anchored repeat proves the native parts through the signed reference and a receipt naming the anchor', (t) => {
  const g = anchorFixture(t);
  const repeatedReference = firstPatchApplied(g);
  const proof = g.prove({ repeatedReference });
  assert.deepEqual([...new Set(g.signed)], [g.reference], 'the patched installed seal is never claimed to pass');
  assert.deepEqual([...new Set(g.notarized)], [g.reference]);
  assert.doesNotThrow(() => assertMutableInstallTarget(path.join(g.app, 'Contents/Resources/daemon/dist'), proof));
});

test('anything the updater could apply on quit refuses the anchor', (t) => {
  const staged = anchorFixture(t);
  fs.mkdirSync(path.join(staged.shipIt, 'update.XYZ789'));
  assert.throws(() => staged.prove(), /installer bundle is staged/);
  const newer = anchorFixture(t);
  fs.writeFileSync(path.join(newer.cache, 'pending/update-info.json'), JSON.stringify({ fileName: 'Fixture-3.18.99-arm64-mac.zip', sha512: 'x', isAdminRightsRequired: false }));
  assert.throws(() => newer.prove(), /newer download is retained/);
  const live = anchorFixture(t);
  fs.mkdirSync(path.join(live.shipIt, 'update.ABC123/Fixture.app'), { recursive: true });
  assert.throws(() => live.prove());
});

test('the anchor must be exactly the pinned record for this bundle, signed by us, never re-signed', (t) => {
  const g = anchorFixture(t);
  assert.throws(() => g.prove({ signedBuildAnchor: { ...g.anchor, sha256: 'd'.repeat(64) } }), /hash differs/);
  for (const change of [{ app: path.join(g.root, 'Other.app') }, { codeResigned: true }, { xattrsCleared: true },
    { candidate: { code: { identifier: 'com.example.fixture', team: 'ZZZZZZZZZZ', cdHash: CDHASH } } },
    { installed: { code: { cdHash: 'e'.repeat(40) } } }, { kind: 'r42_hotpatch' }]) {
    const pin = g.writeAnchor({ ...g.record, ...change });
    assert.throws(() => g.prove({ signedBuildAnchor: pin }), JSON.stringify(change));
  }
});

test('a failed signature, failed notarization, other identity or changed native part refuses', (t) => {
  const g = anchorFixture(t);
  assert.throws(() => g.prove({ verifyNativeSignature: () => { throw new Error('invalid signature'); } }), /invalid signature/);
  assert.throws(() => g.prove({ assessNotarization: () => { throw new Error('rejected'); } }), /rejected/);
  assert.throws(() => g.prove({ readReferenceCodeIdentity: () => ({ bundleId: 'com.example.fixture', team: '4AR3Y8XD72', cdHash: 'f'.repeat(40) }) }));
  fs.writeFileSync(path.join(g.app, 'Contents/Resources/app.asar'), 'changed shell');
  assert.throws(() => g.prove(), /changed since the pre-quit snapshot/);
});

test('a receipt of another chain, or a reference the anchor does not name, never extends the anchored chain', (t) => {
  const other = anchorFixture(t);
  const foreign = firstPatchApplied(other, { signedBuildAnchor: undefined });
  assert.throws(() => other.prove({ repeatedReference: foreign }), /signed build anchor for every ordered receipt/);
  const moved = anchorFixture(t);
  const repeatedReference = firstPatchApplied(moved);
  const copy = path.join(moved.root, 'elsewhere/Fixture.app');
  fs.cpSync(moved.reference, copy, { recursive: true });
  assert.throws(() => moved.prove({ repeatedReference: { ...repeatedReference, referenceBundle: copy } }), /differs from its signed build anchor/);
});
