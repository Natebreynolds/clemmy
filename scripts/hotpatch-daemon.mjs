/** Stage a daemon-only patch before replacing installed bytes. Keep rollback.
 * Run after quitting Clementine: node --import tsx scripts/hotpatch-daemon.mjs
 * --check inspects the candidate without changing or stopping the application.
 */
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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
const CURRENT_STATE_RECOVERIES = new WeakMap();
const DESKTOP_TEAM_IDENTIFIER = '4AR3Y8XD72';

const RECOVERY_BUILT_ROOTS = Object.freeze({
  daemon: 'dist', 'builtin-skills': 'builtin-skills',
  'console-web': 'apps/console-web/dist', 'mobile-web': 'apps/mobile-web/dist',
});
const RECOVERY_JSON_LIMIT = 8 * 1024 * 1024;
const treePin = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function externalDirectory(directory, forbidden, fileOps) {
  if (typeof directory !== 'string' || path.resolve(directory) !== directory) guardRefusal('missing canonical recovery directory');
  regularPath(directory, fileOps, true);
  if (fileOps.realpathSync(directory) !== directory || forbidden.some(root => directory === root || directory.startsWith(root + path.sep))) {
    guardRefusal('recovery directory must be separate from application and build workspaces');
  }
  return directory;
}

function recoveryJSON(pin, fileOps) {
  if (!sameKeys(pin, ['path', 'sha256'])) guardRefusal('invalid recovery evidence pin');
  return pinnedRepeatJSON(pin.path, pin.sha256, fileOps, RECOVERY_JSON_LIMIT);
}

/** Convert the independently recorded Python typed inventory, including its
 * file sizes, to the guard's existing complete byte/mode/link inventory. */
function recoveryRecordedTree(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 50_000) guardRefusal('missing complete recovery inventory');
  const names = new Set(); const dirs = new Set();
  const tree = entries.map(entry => {
    if (!Array.isArray(entry)) guardRefusal('malformed recovery inventory entry');
    const [raw, kind, mode] = entry; const relative = raw === '.' ? '' : raw;
    if (relative !== '') safeRelative(relative);
    const alias = relative.normalize('NFC').toLowerCase();
    if (names.has(alias)) guardRefusal('aliased recovery inventory');
    names.add(alias);
    if (kind === 'directory' && entry.length === 3 && mode === 0o755) {
      dirs.add(relative); return [relative, kind, mode];
    }
    if (kind !== 'file' || entry.length !== 5 || mode !== 0o644 || !Number.isSafeInteger(entry[3])
      || entry[3] < 0 || !/^[a-f0-9]{64}$/.test(entry[4] ?? '')) guardRefusal('unsupported recovery inventory entry');
    return [relative, kind, mode, entry[4]];
  });
  if (!dirs.has('')) guardRefusal('recovery inventory root missing');
  for (const [relative] of tree) if (relative && !dirs.has(path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative))) {
    guardRefusal('recovery inventory parent missing');
  }
  return tree.sort((a, b) => a[0].localeCompare(b[0], 'en'));
}

function recoveryGit(repository, args, commands) {
  return commands('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: repository, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat' },
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verifyRecoveryStamp(dist, expected, expectedSha256, fileOps) {
  const stampPath = path.join(dist, 'runtime/build-stamp.json');
  if (fileDigest(stampPath, 'sha256', 'hex', fileOps) !== expectedSha256) guardRefusal('recovery full build stamp differs');
  const stamp = JSON.parse(fileOps.readFileSync(stampPath, 'utf8'));
  for (const key of ['gitSha', 'gitDirty', 'sourceFingerprint', 'expectedSchemaVersion']) {
    if (stamp[key] !== expected[key]) guardRefusal('recovery stamp source identity differs');
  }
  const dependencies = ['dist/integrations/composio/client.js', 'dist/runtime/harness/production-mcp-read-carrier.js'];
  if (!sameKeys(stamp.backendRuntimeDependencies, dependencies)) guardRefusal('recovery backend binding missing');
  for (const relative of dependencies) if (fileDigest(path.join(dist, relative.slice('dist/'.length)), 'sha256', 'hex', fileOps) !== stamp.backendRuntimeDependencies[relative]) {
    guardRefusal('recovery backend bytes differ from full stamp');
  }
  const emitted = path.join(dist, 'runtime/harness/implementation-artifacts/emitted');
  const manifest = JSON.parse(fileOps.readFileSync(path.join(emitted, 'manifest.json'), 'utf8'));
  const kinds = ['invoke', 'reconcile', 'observer', 'transport', 'transportIsolated'];
  if (manifest.version !== 3 || !sameKeys(manifest.artifacts, kinds) || !sameKeys(stamp.artifacts, kinds)) guardRefusal('recovery implementation inventory missing');
  for (const [kind, entry] of Object.entries(manifest.artifacts)) {
    if (!/^[a-f0-9]{64}$/.test(entry?.sha256 ?? '') || entry.file !== `${kind}-${entry.sha256}.cjs`
      || stamp.artifacts[kind] !== entry.sha256 || fileDigest(path.join(emitted, entry.file), 'sha256', 'hex', fileOps) !== entry.sha256) {
      guardRefusal('recovery implementation artifact differs');
    }
  }
  const manifestDigest = treePin({ version: 3, artifacts: Object.fromEntries(Object.entries(manifest.artifacts)
    .map(([kind, entry]) => [kind, { file: entry.file, sha256: entry.sha256 }])) });
  if (manifestDigest !== manifest.manifestDigest || manifestDigest !== stamp.implementationManifestDigest) guardRefusal('recovery implementation manifest differs');
  const emittedStamp = JSON.parse(fileOps.readFileSync(path.join(emitted, 'build-stamp.json'), 'utf8'));
  sameEvidence(emittedStamp, { implementationManifestDigest: manifestDigest, artifacts: stamp.artifacts }, 'recovery co-located implementation stamp');
  if (fileOps.readdirSync(emitted).sort().join('|') !== [...Object.values(manifest.artifacts).map(entry => entry.file), 'manifest.json', 'build-stamp.json'].sort().join('|')) {
    guardRefusal('recovery implementation has an unreferenced generation');
  }
  return stamp;
}

/** Pins name the root's actual independent build observation. Success fields
 * alone never authorize anything: reread clean Git, every recorded byte and
 * full stamp, plus built-in skills' separately bound Git blobs. */
function recoveryBaseline(parameters, fileOps, commands) {
  for (const pin of [parameters.reproducibility, parameters.builtinGitBinding]) {
    if (typeof pin?.path !== 'string' || pin.path === parameters.app || pin.path.startsWith(parameters.app + path.sep)) guardRefusal('recovery evidence must be outside the installed bundle');
  }
  const report = recoveryJSON(parameters.reproducibility, fileOps);
  if (report.kind !== 'independent_current_source_four_root_reproducibility_feasibility' || !/^[a-f0-9]{40}$/.test(report.sourceCommit ?? '')
    || !Array.isArray(report.parts) || report.parts.length !== 4 || new Set(report.parts.map(part => part.name)).size !== 4) guardRefusal('invalid independent recovery build record');
  const daemon = report.parts.find(part => part.name === 'daemon');
  if (!daemon || typeof daemon.builtRoot !== 'string') guardRefusal('recovery daemon build path missing');
  const repository = path.dirname(daemon.builtRoot);
  externalDirectory(repository, [parameters.app], fileOps);
  const head = String(recoveryGit(repository, ['rev-parse', 'HEAD'], commands)).trim();
  if (head !== report.sourceCommit || String(recoveryGit(repository, ['status', '--porcelain', '--untracked-files=all'], commands)).trim()) guardRefusal('recovery source is not the exact clean Git commit');
  const fingerprint = createHash('sha256').update('clementine-runtime-source-v1\0').update(head).update('\0tracked-diff\0').digest('hex');
  const expected = report.installedStampIdentity;
  if (!expected || expected.gitSha !== head || expected.gitDirty !== false || expected.sourceFingerprint !== fingerprint
    || !Number.isSafeInteger(expected.expectedSchemaVersion) || expected.expectedSchemaVersion < 1
    || !/^[a-f0-9]{64}$/.test(report.builtStampSha256 ?? '') || report.builtStampSha256 !== report.installedStampSha256) guardRefusal('recovery source/stamp pins differ');
  const roots = {}; const pins = [parameters.reproducibility, parameters.builtinGitBinding];
  for (const part of report.parts) {
    if (!(part.name in RECOVERY_BUILT_ROOTS) || part.builtRoot !== path.join(repository, RECOVERY_BUILT_ROOTS[part.name])
      || part.installedRoot !== path.join(parameters.app, AUTHORIZED_RUNTIME_PARTS[part.name])) guardRefusal('recovery root identity differs');
    const pin = { path: part.manifestPath, sha256: part.manifestSha256 }; const inventory = recoveryJSON(pin, fileOps); pins.push(pin);
    if (pin.path === parameters.app || pin.path.startsWith(parameters.app + path.sep)) guardRefusal('recovery inventory must be outside the installed bundle');
    const built = recoveryRecordedTree(inventory.built);
    sameEvidence(recoveryRecordedTree(inventory.installed), built, 'independent recorded recovery roots');
    sameEvidence(typedTree(part.builtRoot, fileOps), built, 'fresh independent recovery build bytes');
    roots[part.name] = built;
  }
  if (!sameKeys(roots, Object.keys(AUTHORIZED_RUNTIME_PARTS))) guardRefusal('incomplete recovery build roots');
  const gitBinding = recoveryJSON(parameters.builtinGitBinding, fileOps);
  if (gitBinding.kind !== 'builtin_skills_complete_clean_Git_binding' || gitBinding.commit !== head || !Array.isArray(gitBinding.exactFiles)) guardRefusal('built-in Git binding missing');
  const entries = String(recoveryGit(repository, ['ls-tree', '-r', '-z', head, '--', 'builtin-skills'], commands)).split('\0').filter(Boolean).map(raw => {
    const match = raw.match(/^(100644) blob ([a-f0-9]{40})\t(builtin-skills\/.+)$/);
    if (!match) guardRefusal('unsupported built-in Git entry');
    safeRelative(match[3]); return { path: match[3], gitMode: match[1], gitBlob: match[2] };
  });
  const gitTree = [['', 'directory', 0o755]]; const directories = new Set(['']);
  for (const entry of entries) {
    const recorded = gitBinding.exactFiles.find(item => item.path === entry.path);
    const bytes = recoveryGit(repository, ['cat-file', 'blob', entry.gitBlob], commands);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (!recorded || recorded.gitBlob !== entry.gitBlob || recorded.gitMode !== entry.gitMode || recorded.sha256 !== digest) guardRefusal('built-in Git bytes differ');
    const relative = entry.path.slice('builtin-skills/'.length);
    for (let parent = path.posix.dirname(relative); parent !== '.'; parent = path.posix.dirname(parent)) directories.add(parent);
    gitTree.push([relative, 'file', 0o644, digest]);
  }
  if (entries.length !== gitBinding.exactFiles.length) guardRefusal('built-in Git inventory differs');
  for (const directory of [...directories].filter(Boolean)) gitTree.push([directory, 'directory', 0o755]);
  sameEvidence(gitTree.sort((a, b) => a[0].localeCompare(b[0], 'en')), roots['builtin-skills'], 'complete built-in Git tree');
  const stamp = verifyRecoveryStamp(path.join(repository, 'dist'), expected, report.builtStampSha256, fileOps);
  // Git/config/build files can change while the byte inventory is read.
  if (String(recoveryGit(repository, ['rev-parse', 'HEAD'], commands)).trim() !== head
    || String(recoveryGit(repository, ['status', '--porcelain', '--untracked-files=all'], commands)).trim()) guardRefusal('recovery source changed during inspection');
  return { repository, roots, stamp, stampSha256: report.builtStampSha256, pins };
}

function recoveryHistoryMode(parameters) {
  const interrupted = parameters?.interruptionHistory !== undefined;
  const common = ['app', 'home', 'referenceBundle', 'expectedReferenceCdHash', 'reproducibility', 'builtinGitBinding'];
  if (!sameKeys(parameters, [...common, ...(interrupted ? ['interruptionHistory'] : ['pristineBackups', 'retainedArchiveReference'])])
    || (!interrupted && !sameKeys(parameters.pristineBackups, Object.keys(AUTHORIZED_RUNTIME_PARTS)))) guardRefusal('unsupported current-state recovery parameters');
  return interrupted;
}

function inspectCurrentStateRecovery(parameters, fileOps, commands, verifySignature, readIdentity) {
  const interrupted = recoveryHistoryMode(parameters);
  const bundle = parameters.app;
  externalDirectory(bundle, [], fileOps);
  if (!parameters.home || path.resolve(parameters.home) !== parameters.home) guardRefusal('noncanonical recovery home');
  const reference = externalDirectory(parameters.referenceBundle, [bundle], fileOps);
  if (bundle.startsWith(reference + path.sep) || !/^[a-f0-9]{40}$/.test(parameters.expectedReferenceCdHash ?? '')) guardRefusal('invalid current recovery reference');
  const baseline = recoveryBaseline(parameters, fileOps, commands);
  const observed = inspectAppliedUpdateEvidence({ app: bundle, home: parameters.home, retainedArchiveReference: parameters.retainedArchiveReference }, fileOps, readIdentity);
  if (observed.version !== (interrupted ? 1 : 2)) guardRefusal(interrupted
    ? 'interrupted recovery requires exact same-generation updater evidence'
    : 'current recovery requires exact mixed-generation updater evidence');
  const referenceTree = typedTree(reference, fileOps, { links: true });
  const archive = path.join(updaterLocations({ app: bundle, home: parameters.home }, fileOps).cache, 'update.zip');
  sameEvidence(archivedBundleTree(archive, path.basename(bundle), fileOps), referenceTree, 'current recovery archive/reference footprint');
  verifySignature(reference);
  if (!interrupted) verifySignature(parameters.retainedArchiveReference.referenceBundle);
  const codeIdentity = readIdentity(reference);
  sameEvidence(codeIdentity, { bundleId: observed.identity.bundleId, team: DESKTOP_TEAM_IDENTIFIER, cdHash: parameters.expectedReferenceCdHash }, 'current recovery publisher/identity');
  sameEvidence(nativeIdentity(fileOps.readFileSync(path.join(reference, 'Contents/Info.plist'), 'utf8')), observed.identity, 'current recovery native identity');
  for (const relative of SEALED_SHELL_PARTS) if (fileDigest(path.join(reference, relative), 'sha256', 'hex', fileOps) !== observed.shellSnapshot[relative]) guardRefusal('current recovery native bytes differ');
  if (fileDigest(path.join(reference, 'Contents/Resources/app-update.yml'), 'sha256', 'hex', fileOps) !== observed.files[path.join(bundle, 'Contents/Resources/app-update.yml')]) guardRefusal('current recovery updater config differs');
  const context = { bundle, observed, verifyNativeSignature: verifySignature, readReferenceCodeIdentity: readIdentity };
  const history = interrupted ? inspectInterruptionHistory(parameters.interruptionHistory, context, fileOps) : null;
  if (history) {
    sameEvidence(history.reference, reference, 'interrupted recovery signed reference');
    sameEvidence(history.codeIdentity, codeIdentity, 'interrupted recovery signed identity');
  }
  const backups = history ? new Map(history.backups) : new Map(); const aliases = new Set();
  for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
    if (history) {
      if (!Object.hasOwn(parameters.interruptionHistory.interruptedBackups, name)) {
        receiptRuntimeFootprint(path.join(bundle, relative), name, history.chain.receipts.at(-1), fileOps);
      }
      sameEvidence(typedTree(path.join(bundle, relative), fileOps), baseline.roots[name], 'current recovery installed/build bytes');
      continue;
    }
    const target = path.join(bundle, relative); const backup = parameters.pristineBackups[name];
    if (typeof backup !== 'string' || !backup.startsWith(target + '.backup-') || !/^[A-Za-z0-9]+$/.test(backup.slice((target + '.backup-').length))
      || path.resolve(backup) !== backup || aliases.has(backup.normalize('NFC').toLowerCase())) guardRefusal('invalid exact pristine recovery backup');
    aliases.add(backup.normalize('NFC').toLowerCase());
    const footprint = typedTree(backup, fileOps);
    sameEvidence(footprint, typedTree(path.join(reference, relative), fileOps), 'pristine recovery rollback/reference');
    backups.set(backup, footprint);
    sameEvidence(typedTree(target, fileOps), baseline.roots[name], 'current recovery installed/build bytes');
  }
  const immutable = typedTree(reference, fileOps, { links: true, excluded: Object.values(AUTHORIZED_RUNTIME_PARTS) });
  const excluded = [...Object.values(AUTHORIZED_RUNTIME_PARTS), ...[...backups.keys()].map(backup => path.relative(bundle, backup).split(path.sep).join('/'))];
  sameEvidence(typedTree(bundle, fileOps, { links: true, excluded }), immutable, 'current recovery immutable installed footprint');
  sameEvidence(typedTree(reference, fileOps, { links: true }), referenceTree, 'current recovery verified reference footprint');
  const finalBaseline = recoveryBaseline(parameters, fileOps, commands);
  sameEvidence(finalBaseline.roots, baseline.roots, 'recovery build after signature verification');
  sameEvidence(finalBaseline.stamp, baseline.stamp, 'recovery stamp after signature verification');
  for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
    sameEvidence(typedTree(path.join(bundle, relative), fileOps), baseline.roots[name], 'current recovery runtime after verification');
  }
  for (const [backup, expected] of backups) sameEvidence(typedTree(backup, fileOps), expected, 'current recovery rollback after verification');
  sameEvidence(typedTree(bundle, fileOps, { links: true, excluded }), immutable, 'current recovery immutable footprint after verification');
  sameEvidence(inspectAppliedUpdateEvidence({ app: bundle, home: parameters.home, retainedArchiveReference: parameters.retainedArchiveReference }, fileOps, readIdentity), observed, 'current recovery updater evidence after verification');
  const historyPins = history ? [...history.receiptFiles, ...(history.manifest ? [history.manifest] : [])] : [];
  for (const pin of historyPins) pinnedRepeatJSON(pin.path, pin.sha256, fileOps, pin.limit);
  const state = { sourceStamp: baseline.stamp, stampSha256: baseline.stampSha256, currentRoots: baseline.roots,
    referenceCodeIdentity: codeIdentity, referenceTreeDigest: treePin(referenceTree),
    ...(interrupted ? { interruptionHistory: parameters.interruptionHistory } : { pristineBackups: parameters.pristineBackups }) };
  return { baseline, observed, reference, referenceTree, archive, checksum: observed.files[archive], codeIdentity, backups, immutable, state, historyPins };
}

/** Read-only capture, never a capability or a fabricated installation receipt.
 * It verifies the independent current source/build and required signed references;
 * the closed-app admission repeats these checks before minting authority. */
export function captureCurrentStateRecoveryEvidence(parameters, fileOps = fs, commands = execFileSync, readIdentity = referenceCodeIdentity) {
  const verified = inspectCurrentStateRecovery(parameters, fileOps, commands,
    bundle => commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' }), readIdentity);
  return { version: 1, kind: 'verified_current_state_recovery', capturedAt: new Date().toISOString(), parameters: JSON.parse(JSON.stringify(parameters)),
    shellSnapshot: verified.observed.shellSnapshot, appliedUpdateEvidence: verified.observed, state: verified.state };
}

export function verifyCurrentStateRecoveryPatch({ app, home, evidence, shellSnapshot, appliedUpdateEvidence, priorProof, isRunning,
  isUpdaterRunning = isUpdaterHelperRunning, commands = execFileSync, readReferenceCodeIdentity = referenceCodeIdentity,
  verifyNativeSignature = bundle => commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' }),
}, fileOps = fs) {
  const closed = () => { if (isRunning() || isUpdaterRunning()) guardRefusal('app or installer helper is running during current recovery'); };
  closed();
  const document = recoveryJSON(evidence, fileOps);
  if (app !== path.resolve(app) || home !== path.resolve(home) || evidence.path === app || evidence.path.startsWith(app + path.sep)) guardRefusal('noncanonical or internal current recovery context');
  if (!sameKeys(document, ['version', 'kind', 'capturedAt', 'parameters', 'shellSnapshot', 'appliedUpdateEvidence', 'state'])
    || document.version !== 1 || document.kind !== 'verified_current_state_recovery' || !Number.isFinite(Date.parse(document.capturedAt))
    || document.parameters?.app !== path.resolve(app) || document.parameters?.home !== path.resolve(home)) guardRefusal('current recovery context differs');
  sameEvidence(shellSnapshot, document.shellSnapshot, 'current recovery pre-quit native snapshot');
  sameEvidence(appliedUpdateEvidence, document.appliedUpdateEvidence, 'current recovery pre-quit updater snapshot');
  let ledger = priorProof && CURRENT_STATE_RECOVERIES.get(priorProof);
  if (priorProof && !ledger) guardRefusal('no matching private current recovery proof');
  if (ledger) {
    sameEvidence(evidence, ledger.recoveryEvidence, 'private current recovery evidence pin');
    sameEvidence(document, ledger.recoveryDocument, 'private current recovery document');
    const baseline = recoveryBaseline(document.parameters, fileOps, commands);
    sameEvidence(baseline.roots, document.state.currentRoots, 'current recovery baseline changed');
    sameEvidence(baseline.stamp, document.state.sourceStamp, 'current recovery baseline stamp changed');
    sameEvidence(inspectAppliedUpdateEvidence({ app, home, retainedArchiveReference: document.parameters.retainedArchiveReference }, fileOps, readReferenceCodeIdentity), document.appliedUpdateEvidence, 'current recovery updater evidence');
    recheckRepeatReference(ledger, fileOps);
  } else {
    const checked = inspectCurrentStateRecovery(document.parameters, fileOps, commands, verifyNativeSignature, readReferenceCodeIdentity);
    sameEvidence(checked.state, document.state, 'captured current recovery state');
    sameEvidence(checked.observed, document.appliedUpdateEvidence, 'captured current recovery updater state');
    const roots = new Map(Object.entries(AUTHORIZED_RUNTIME_PARTS).map(([name, relative]) => [path.join(app, relative), { expected: checked.state.currentRoots[name], replaced: false }]));
    ledger = { ...checked, roots, receiptFiles: [{ ...evidence, limit: RECOVERY_JSON_LIMIT }, ...checked.historyPins], manifest: null,
      recoveryEvidence: { ...evidence }, recoveryDocument: document, currentStateRecovery: true,
      context: { bundle: app, observed: checked.observed, readReferenceCodeIdentity } };
    ledger.context.reprove = proof => verifyCurrentStateRecoveryPatch({ app, home, evidence, shellSnapshot, appliedUpdateEvidence,
      priorProof: proof, isRunning, isUpdaterRunning, commands, readReferenceCodeIdentity, verifyNativeSignature }, fileOps);
  }
  closed();
  const proof = Object.freeze({ app, canonical: fileOps.realpathSync(app), appliedEvidenceDigest: treePin(document.appliedUpdateEvidence) });
  GUARDED_PATCHES.add(proof); REPEAT_PATCHES.set(proof, ledger); CURRENT_STATE_RECOVERIES.set(proof, ledger);
  return proof;
}

/** Exclusive durable artifacts establish new present-state provenance. They
 * deliberately make no assertion about the missing earlier installation. */
function exclusiveRecoveryJSON(directory, prefix, value, fileOps) {
  externalDirectory(directory, [], fileOps);
  const absolute = path.join(directory, `${prefix}-${randomUUID()}.json`);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = fileOps.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fileOps.writeFileSync(fd, bytes); fileOps.fsyncSync(fd); }
  finally { fileOps.closeSync(fd); }
  const pin = { path: absolute, sha256: createHash('sha256').update(bytes).digest('hex') };
  pinnedRepeatJSON(pin.path, pin.sha256, fileOps, RECOVERY_JSON_LIMIT);
  const directoryFd = fileOps.openSync(directory, 'r');
  try { fileOps.fsyncSync(directoryFd); } finally { fileOps.closeSync(directoryFd); }
  return pin;
}

export function initializeCurrentStateRecoveryArtifacts({ guarded, directory, forbiddenRoots = [] }, fileOps = fs) {
  const ledger = guarded && REPEAT_PATCHES.get(guarded);
  if (!ledger || (!ledger.currentStateRecovery && !ledger.recoveryGenesis)) guardRefusal('no private recovery authority for durable artifacts');
  ledger.context.reprove(guarded);
  const forbidden = [ledger.context.bundle, ...(ledger.baseline ? [ledger.baseline.repository] : []), ...forbiddenRoots];
  for (const root of forbidden) if (typeof root !== 'string' || path.resolve(root) !== root) guardRefusal('noncanonical recovery workspace exclusion');
  externalDirectory(directory, forbidden, fileOps);
  for (const pin of [ledger.recoveryEvidence, ...(ledger.baseline?.pins ?? []), ...(ledger.receiptFiles ?? []), ledger.recoveryGenesis,
    ledger.manifest].filter(Boolean)) {
    if (forbidden.some(root => pin.path === root || pin.path.startsWith(root + path.sep))) guardRefusal('recovery capture and provenance must be durable outside build workspaces');
    regularPath(pin.path, fileOps);
  }
  if (ledger.artifactDirectory && ledger.artifactDirectory !== directory) guardRefusal('private recovery artifact directory changed');
  if (!ledger.recoveryGenesis) {
    const genesis = { version: 1, kind: 'current_state_recovery_genesis', verifiedAt: new Date().toISOString(),
      historicalInstallationReceipt: 'unavailable-not-reconstructed', bundle: ledger.context.bundle,
      evidence: ledger.recoveryEvidence, captured: ledger.recoveryDocument };
    ledger.recoveryGenesis = exclusiveRecoveryJSON(directory, 'current-state-recovery-genesis', genesis, fileOps);
    ledger.receiptFiles.push({ ...ledger.recoveryGenesis, limit: RECOVERY_JSON_LIMIT });
  }
  ledger.artifactDirectory = directory;
  return { ...ledger.recoveryGenesis };
}

export function writeCurrentStateRecoveryReceipt({ guarded, report }, fileOps = fs) {
  const ledger = guarded && REPEAT_PATCHES.get(guarded);
  if (!ledger?.recoveryGenesis || !ledger.artifactDirectory) guardRefusal('no durable recovery genesis');
  ledger.context.reprove(guarded);
  if (report.bundle !== ledger.context.bundle || report.wasVersion !== ledger.context.observed.identity.version
    || !sameKeys(report.parts, Object.keys(AUTHORIZED_RUNTIME_PARTS))) guardRefusal('recovery receipt identity differs');
  for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
    const target = path.join(ledger.context.bundle, relative); const state = ledger.roots.get(target); const part = report.parts[name];
    if (!state?.replaced || state.backup !== part.backup || part.match !== true) guardRefusal('recovery receipt has an incomplete replacement');
    receiptRuntimeFootprint(target, name, report, fileOps);
    if (part.served !== (name === 'daemon' ? part.digest : part.built)) guardRefusal('recovery receipt served bytes differ');
  }
  if (inspectDaemonBuild(path.join(ledger.context.bundle, AUTHORIZED_RUNTIME_PARTS.daemon)).stamp.gitSha !== report.gitSha) guardRefusal('recovery receipt Git identity differs');
  ledger.context.reprove(guarded);
  const complete = { ...report, recoveryGenesis: { ...ledger.recoveryGenesis }, recoveryStatus: 'four_roots_verified', completedAt: new Date().toISOString() };
  const pin = exclusiveRecoveryJSON(ledger.artifactDirectory, 'current-state-recovery-completed', complete, fileOps);
  return { receipt: complete, pin };
}

export function recordCurrentStateRecoveryFailure({ guarded }, fileOps = fs) {
  const ledger = guarded && REPEAT_PATCHES.get(guarded);
  if (!ledger?.artifactDirectory || !ledger.recoveryGenesis) return null;
  // Safe fixed metadata only; no arbitrary exception, source content or URLs.
  return exclusiveRecoveryJSON(ledger.artifactDirectory, 'current-state-recovery-incomplete', {
    version: 1, kind: 'current_state_recovery_incomplete', observedAt: new Date().toISOString(), bundle: ledger.context.bundle,
    recoveryGenesis: ledger.recoveryGenesis, roots: [...ledger.roots].map(([target, state]) => ({ target, replaced: state.replaced, backup: state.backup ?? null })),
    completion: 'not-certified',
  }, fileOps);
}

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

const REPEAT_REFERENCE_KEYS = Object.freeze(['referenceBundle', 'authorizedReceipt', 'authorizedReceiptSha256', 'expectedPriorFingerprint', 'expectedReferenceCdHash', 'authorizedAncestorManifest', 'authorizedAncestorManifestSha256', 'authorizedRecoveryGenesis', 'authorizedRecoveryGenesisSha256']);

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
    if (!value || Object.keys(value).sort().join('|') !== 'receipts|version' || value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.length < 1 || value.receipts.length > 40) guardRefusal('unsupported bounded ancestor manifest');
    ancestors = value.receipts;
    if (ancestors.some(item => !item || Object.keys(item).sort().join('|') !== 'path|sha256')) guardRefusal('unexpected ancestor receipt pin shape');
    manifest = { path: authorizedAncestorManifest, sha256: authorizedAncestorManifestSha256 };
    if (manifest.path === context.bundle || manifest.path.startsWith(context.bundle + path.sep)) guardRefusal('ancestor manifest must be outside the installed bundle');
  }
  const files = [...ancestors, { path: authorizedReceipt, sha256: authorizedReceiptSha256 }];
  const recoveryGenesis = options.authorizedRecoveryGenesis !== undefined || options.authorizedRecoveryGenesisSha256 !== undefined
    ? { path: options.authorizedRecoveryGenesis, sha256: options.authorizedRecoveryGenesisSha256 } : null;
  if (recoveryGenesis) {
    recoveryJSON(recoveryGenesis, fileOps);
    if (recoveryGenesis.path === context.bundle || recoveryGenesis.path.startsWith(context.bundle + path.sep)) guardRefusal('recovery genesis must be outside the installed bundle');
  }
  const paths = new Set(); const hashes = new Set(); const inodes = new Set();
  if (manifest) paths.add(manifest.path.normalize('NFC').toLowerCase());
  const receipts = files.map((pin, index) => {
    const receipt = pinnedRepeatJSON(pin.path, pin.sha256, fileOps);
    const key = pin.path.normalize('NFC').toLowerCase(); const stat = fileOps.lstatSync(pin.path); const inode = `${stat.dev}:${stat.ino}`;
    if (paths.has(key) || hashes.has(pin.sha256) || inodes.has(inode) || pin.path === context.bundle || pin.path.startsWith(context.bundle + path.sep)) guardRefusal('duplicate or aliased ancestor receipt evidence');
    paths.add(key); hashes.add(pin.sha256); inodes.add(inode);
    if (!receipt || receipt.bundle !== context.bundle || receipt.wasVersion !== context.observed.identity.version || !/^[a-f0-9]{64}$/.test(receipt.sourceFingerprint ?? '') || Object.keys(receipt.parts ?? {}).sort().join('|') !== Object.keys(AUTHORIZED_RUNTIME_PARTS).sort().join('|')) guardRefusal('historical receipt identity or runtime roots differ');
    if (recoveryGenesis) {
      sameEvidence(receipt.recoveryGenesis, recoveryGenesis, 'explicit recovery genesis for every ordered receipt');
      if (receipt.recoveryStatus !== 'four_roots_verified' || !Number.isFinite(Date.parse(receipt.completedAt))) guardRefusal('incomplete recovery receipt');
    } else if (receipt.recoveryGenesis !== undefined) guardRefusal('recovery receipt requires explicit genesis pins');
    if (context.observed.mode === 'signed-build-anchor') sameEvidence(receipt.signedBuildAnchor, context.observed.anchor, 'signed build anchor for every ordered receipt');
    else if (receipt.signedBuildAnchor !== undefined) guardRefusal('an anchored receipt requires its signed build anchor');
    if (index === files.length - 1 && receipt.sourceFingerprint !== expectedPriorFingerprint) guardRefusal('latest receipt fingerprint differs from its pin');
    for (const [name, part] of Object.entries(receipt.parts)) {
      const digest = name === 'daemon' ? part?.digest : part?.built;
      if (!/^[a-f0-9]{64}$/.test(digest ?? '') || part.served !== digest) guardRefusal('historical receipt runtime digest differs');
    }
    return receipt;
  });
  return { receipts, files: files.map(pin => ({ ...pin })), manifest, recoveryGenesis };
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

/** Shared signed reference and ordered rollback proof. Current runtime
 * admission is deliberately left to the ordinary repeat or recovery caller. */
function inspectRepeatHistory(options, context, fileOps) {
  const { referenceBundle, authorizedReceipt, authorizedReceiptSha256, expectedPriorFingerprint, expectedReferenceCdHash } = options;
  if (![authorizedReceiptSha256, expectedPriorFingerprint].every(value => /^[a-f0-9]{64}$/.test(value ?? '')) || !/^[a-f0-9]{40}$/.test(expectedReferenceCdHash ?? '')) guardRefusal('missing exact repeat-install identity pins');
  if (typeof referenceBundle !== 'string' || !referenceBundle || typeof authorizedReceipt !== 'string' || !authorizedReceipt) guardRefusal('missing exact repeat-install evidence paths');
  const optionSnapshot = JSON.parse(JSON.stringify(options));
  const reference = path.resolve(referenceBundle);
  regularPath(reference, fileOps, true);
  if (fileOps.realpathSync(reference) !== reference || reference === context.bundle || reference.startsWith(context.bundle + path.sep) || context.bundle.startsWith(reference + path.sep)) guardRefusal('signed reference must be a separate canonical bundle');
  const chain = repeatReceiptChain(options, context, fileOps);
  const referenceTree = typedTree(reference, fileOps, { links: true });
  // An anchored chain's reference is proven by its own notarization and the
  // pinned replacement record, not by an updater download.
  const anchored = context.observed.mode === 'signed-build-anchor';
  const archive = anchored ? null : context.observed.mode === 'no-active-update'
    ? context.observed.archive.path
    : path.join(updaterLocations({ app: context.bundle, home: context.observed.home }, fileOps).cache, 'update.zip');
  const checksum = anchored ? null : context.observed.files[archive];
  if (anchored) {
    if (reference !== context.observed.reference) guardRefusal('anchored reference differs from its signed build anchor');
  } else {
    if (typeof checksum !== 'string' || Buffer.from(checksum, 'base64').length !== 64) guardRefusal('no exact retained reference archive');
    if (fileDigest(archive, 'sha512', 'base64', fileOps) !== checksum) guardRefusal('reference archive checksum changed');
    sameEvidence(archivedBundleTree(archive, path.basename(context.bundle), fileOps), referenceTree, 'archive/reference typed footprint');
  }
  context.verifyNativeSignature(reference);
  if (anchored) context.assessNotarization(reference);
  const codeIdentity = context.readReferenceCodeIdentity(reference);
  sameEvidence(codeIdentity, { bundleId: context.observed.identity.bundleId, team: DESKTOP_TEAM_IDENTIFIER, cdHash: expectedReferenceCdHash }, 'signed reference publisher/identity');
  // Recheck bytes after the signature subprocess and identity inspection.
  sameEvidence(typedTree(reference, fileOps, { links: true }), referenceTree, 'verified reference footprint');
  if (!anchored && fileDigest(archive, 'sha512', 'base64', fileOps) !== checksum) guardRefusal('verified reference archive changed');
  for (const rel of SEALED_SHELL_PARTS) if (fileDigest(path.join(reference, rel), 'sha256', 'hex', fileOps) !== context.observed.shellSnapshot[rel]) guardRefusal('reference native part differs');
  if (fileDigest(path.join(reference, 'Contents/Resources/app-update.yml'), 'sha256', 'hex', fileOps) !== context.observed.files[path.join(context.bundle, 'Contents/Resources/app-update.yml')]) guardRefusal('reference updater configuration differs');
  const backups = new Map();
  const backupAliases = new Set();
  let genesis = null; let inheritedHistory = null;
  if (chain.recoveryGenesis) {
    genesis = recoveryJSON(chain.recoveryGenesis, fileOps);
    if (!sameKeys(genesis, ['version', 'kind', 'verifiedAt', 'historicalInstallationReceipt', 'bundle', 'evidence', 'captured'])
      || genesis.version !== 1 || genesis.kind !== 'current_state_recovery_genesis' || genesis.bundle !== context.bundle
      || genesis.historicalInstallationReceipt !== 'unavailable-not-reconstructed' || !Number.isFinite(Date.parse(genesis.verifiedAt))) guardRefusal('invalid distinct current-state recovery genesis');
    const captured = genesis.captured;
    if (captured?.version !== 1 || captured.kind !== 'verified_current_state_recovery' || captured.parameters?.app !== context.bundle
      || captured.parameters?.home !== context.observed.home || captured.parameters?.referenceBundle !== reference
      || captured.parameters?.expectedReferenceCdHash !== expectedReferenceCdHash || !sameKeys(captured.state?.currentRoots, Object.keys(AUTHORIZED_RUNTIME_PARTS))) guardRefusal('recovery genesis context or exact roots differ');
    const interrupted = recoveryHistoryMode(captured.parameters);
    if (!interrupted && !sameKeys(captured.state?.pristineBackups, Object.keys(AUTHORIZED_RUNTIME_PARTS))) guardRefusal('recovery genesis pristine roots differ');
    sameEvidence(captured.shellSnapshot, context.observed.shellSnapshot, 'recovery genesis native snapshot');
    sameEvidence(captured.state.referenceCodeIdentity, codeIdentity, 'recovery genesis signed reference identity');
    if (captured.state.referenceTreeDigest !== treePin(referenceTree)) guardRefusal('recovery genesis reference footprint differs');
    // The pinned capture remains separately durable and byte exact; it is not
    // relabelled as the missing historical installation receipt.
    sameEvidence(recoveryJSON(genesis.evidence, fileOps), captured, 'recovery genesis original capture');
    if (interrupted) {
      if (captured.state.pristineBackups !== undefined) guardRefusal('mixed recovery genesis history');
      sameEvidence(captured.state.interruptionHistory, captured.parameters.interruptionHistory, 'recovery genesis interruption history');
      inheritedHistory = inspectInterruptionHistory(captured.state.interruptionHistory, context, fileOps);
      sameEvidence(inheritedHistory.reference, reference, 'recovery genesis inherited reference');
      sameEvidence(inheritedHistory.codeIdentity, codeIdentity, 'recovery genesis inherited signed identity');
      for (const [backup, footprint] of inheritedHistory.backups) {
        backups.set(backup, footprint); backupAliases.add(backup.normalize('NFC').toLowerCase());
      }
    } else for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
      const target = path.join(context.bundle, relative); const backup = captured.state.pristineBackups[name];
      if (typeof backup !== 'string' || path.resolve(backup) !== backup || !backup.startsWith(target + '.backup-')
        || !/^[A-Za-z0-9]+$/.test(backup.slice((target + '.backup-').length))) guardRefusal('recovery genesis pristine backup path differs');
      const alias = backup.normalize('NFC').toLowerCase();
      if (backupAliases.has(alias)) guardRefusal('aliased pristine recovery backups');
      backupAliases.add(alias);
      const footprint = typedTree(backup, fileOps);
      sameEvidence(footprint, typedTree(path.join(reference, relative), fileOps), 'recovery genesis pristine rollback/reference');
      backups.set(backup, footprint);
    }
  }
  for (const [index, receipt] of chain.receipts.entries()) {
    for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
      const target = path.join(context.bundle, relative); const part = receipt.parts[name];
      const backup = typeof part?.backup === 'string' ? path.resolve(part.backup) : '';
      const alias = backup.normalize('NFC').toLowerCase();
      if (!backup.startsWith(target + '.backup-') || !/^[A-Za-z0-9]+$/.test(backup.slice((target + '.backup-').length)) || part.backup !== backup || backupAliases.has(alias)) guardRefusal('historical backup is not a distinct exact runtime sibling');
      backupAliases.add(alias);
      const footprint = index === 0 ? typedTree(backup, fileOps) : receiptRuntimeFootprint(backup, name, chain.receipts[index - 1], fileOps);
      if (index === 0) {
        sameEvidence(footprint, genesis ? genesis.captured.state.currentRoots[name] : typedTree(path.join(reference, relative), fileOps), 'oldest historical backup/reference footprint');
        if (genesis && name === 'daemon') verifyRecoveryStamp(backup, genesis.captured.state.sourceStamp, genesis.captured.state.stampSha256, fileOps);
        // The original interrupted transaction did not touch this suffix. Its
        // first recovery rollback must still prove the last genuine receipt.
        if (inheritedHistory && !Object.hasOwn(genesis.captured.state.interruptionHistory.interruptedBackups, name)) {
          receiptRuntimeFootprint(backup, name, inheritedHistory.chain.receipts.at(-1), fileOps);
        }
      }
      backups.set(backup, footprint);
    }
  }
  const immutable = typedTree(reference, fileOps, { links: true, excluded: Object.values(AUTHORIZED_RUNTIME_PARTS) });
  sameEvidence(options, optionSnapshot, 'repeat-install authority options');
  const recoveryFiles = genesis ? [{ ...chain.recoveryGenesis, limit: RECOVERY_JSON_LIMIT }, { ...genesis.evidence, limit: RECOVERY_JSON_LIMIT }] : [];
  const inheritedPins = inheritedHistory ? [...inheritedHistory.receiptFiles, ...(inheritedHistory.manifest ? [inheritedHistory.manifest] : [])] : [];
  return { reference, referenceTree, archive, checksum, receiptFiles: [...chain.files, ...recoveryFiles, ...inheritedPins], manifest: chain.manifest, optionSnapshot, codeIdentity, backups, immutable, context, chain,
    ...(genesis ? { recoveryGenesis: chain.recoveryGenesis } : {}) };
}

/** A bounded observed prefix of a failed ordinary repeat. The retained old
 * chain proves only rollback ancestry; it never authorizes changed currents.
 * Disallow nested recovery/anchor chains so replay cannot recurse or cycle. */
function inspectInterruptionHistory(history, context, fileOps) {
  if (!sameKeys(history, ['version', 'repeatedReference', 'interruptedBackups']) || history.version !== 1
    || !history.repeatedReference || typeof history.repeatedReference !== 'object' || Array.isArray(history.repeatedReference)
    || Object.keys(history.repeatedReference).some(key => key === 'authorizedRecoveryGenesis' || key === 'authorizedRecoveryGenesisSha256')
    || context.observed.version !== 1 || context.observed.mode !== undefined) guardRefusal('unsupported bounded interruption history');
  const names = Object.keys(AUTHORIZED_RUNTIME_PARTS); const count = Object.keys(history.interruptedBackups ?? {}).length;
  if (count < 1 || count > names.length || !sameKeys(history.interruptedBackups, names.slice(0, count))) guardRefusal('interrupted backups are not an exact nonempty runtime prefix');
  const ledger = inspectRepeatHistory(history.repeatedReference, context, fileOps);
  const aliases = new Set([...ledger.backups.keys()].map(backup => backup.normalize('NFC').toLowerCase()));
  for (const name of names.slice(0, count)) {
    const target = path.join(context.bundle, AUTHORIZED_RUNTIME_PARTS[name]); const backup = history.interruptedBackups[name];
    if (typeof backup !== 'string' || path.resolve(backup) !== backup || !backup.startsWith(target + '.backup-')
      || !/^[A-Za-z0-9]+$/.test(backup.slice((target + '.backup-').length)) || aliases.has(backup.normalize('NFC').toLowerCase())) guardRefusal('invalid distinct interrupted runtime backup');
    aliases.add(backup.normalize('NFC').toLowerCase());
    ledger.backups.set(backup, receiptRuntimeFootprint(backup, name, ledger.chain.receipts.at(-1), fileOps));
  }
  return ledger;
}

function inspectRepeatReference(options, context, fileOps) {
  const ledger = inspectRepeatHistory(options, context, fileOps);
  ledger.roots = new Map();
  for (const [name, relative] of Object.entries(AUTHORIZED_RUNTIME_PARTS)) {
    const target = path.join(context.bundle, relative);
    ledger.roots.set(target, { expected: receiptRuntimeFootprint(target, name, ledger.chain.receipts.at(-1), fileOps), replaced: false });
  }
  recheckRepeatReference(ledger, fileOps);
  return ledger;
}

function recheckRepeatReference(ledger, fileOps) {
  for (const pin of [...ledger.receiptFiles, ...(ledger.manifest ? [ledger.manifest] : [])]) pinnedRepeatJSON(pin.path, pin.sha256, fileOps, pin.limit);
  if (ledger.archive !== null && fileDigest(ledger.archive, 'sha512', 'base64', fileOps) !== ledger.checksum) guardRefusal('repeat reference archive bytes changed');
  sameEvidence(typedTree(ledger.reference, fileOps, { links: true }), ledger.referenceTree, 'signed reference footprint');
  sameEvidence(ledger.context.readReferenceCodeIdentity(ledger.reference), ledger.codeIdentity, 'signed reference identity');
  if (ledger.pendingStage) sameEvidence(typedTree(ledger.pendingStage.path, fileOps), ledger.pendingStage.expected, 'exact pending staging footprint');
  const excluded = [...Object.values(AUTHORIZED_RUNTIME_PARTS), ...[...ledger.backups.keys()].map(backup => path.relative(ledger.context.bundle, backup).split(path.sep).join('/')),
    ...(ledger.pendingStage ? [path.relative(ledger.context.bundle, ledger.pendingStage.path).split(path.sep).join('/')] : [])];
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
  if ((ledger.currentStateRecovery || ledger.recoveryGenesis) && (!ledger.recoveryGenesis || !ledger.artifactDirectory)) guardRefusal('durable recovery genesis and receipt directory required before replacement');
  const state = ledger.roots.get(target);
  if (!state || state.replaced) guardRefusal('repeat replacement is not a fresh exact runtime root');
  return { ledger, state, guarded, target, before: state.expected, candidate: typedTree(source, fileOps) };
}

function verifyRepeatStaging(transaction, staged, source, fileOps) {
  if (!transaction) return;
  sameEvidence(typedTree(staged, fileOps), transaction.candidate, 'typed staging copy');
  sameEvidence(typedTree(source, fileOps), transaction.candidate, 'typed source');
  // Only this verified, exact generated staging tree is temporarily excluded;
  // cache/process/native/current/rollback proofs are refreshed before rename.
  const staging = path.dirname(staged);
  if (path.dirname(staging) !== path.dirname(transaction.target)) guardRefusal('staging directory is not an exact runtime sibling');
  transaction.ledger.pendingStage = { path: staging, expected: typedTree(staging, fileOps) };
  transaction.ledger.context.reprove(transaction.guarded);
}

function registerRepeatReplacement(transaction, target, backup, fileOps) {
  if (!transaction) return;
  if (!backup || transaction.ledger.backups.has(backup)) guardRefusal('repeat rollback path is not newly generated');
  sameEvidence(typedTree(backup, fileOps), transaction.before, 'new rollback footprint');
  sameEvidence(typedTree(target, fileOps), transaction.candidate, 'replacement footprint');
  if (transaction.ledger.recoveryGenesis) exclusiveRecoveryJSON(transaction.ledger.artifactDirectory, 'current-state-recovery-root-observed', {
    version: 1, kind: 'current_state_recovery_root_observed', observedAt: new Date().toISOString(),
    recoveryGenesis: transaction.ledger.recoveryGenesis, target, backup, before: treePin(transaction.before), after: treePin(transaction.candidate), completion: 'not-certified',
  }, fileOps);
  transaction.ledger.backups.set(backup, transaction.before);
  transaction.state.expected = transaction.candidate;
  transaction.state.replaced = true;
  transaction.state.backup = backup;
}

function recordRecoveryStageFailure(transaction, staging, fileOps) {
  if (!transaction?.ledger.recoveryGenesis || !transaction.ledger.artifactDirectory) return;
  // Preserve evidence of a failed partial copy before the existing cleanup.
  // Unexpected/unsafe entries are not read or admitted as ordinary assets.
  try {
    let footprint = null;
    try { footprint = treePin(typedTree(staging, fileOps)); } catch { /* Unknown remains explicitly unqualified. */ }
    exclusiveRecoveryJSON(transaction.ledger.artifactDirectory, 'current-state-recovery-stage-failed', {
      version: 1, kind: 'current_state_recovery_stage_failed', observedAt: new Date().toISOString(),
      recoveryGenesis: transaction.ledger.recoveryGenesis, target: transaction.target, staging,
      observedTypedDigest: footprint, completion: 'not-certified',
    }, fileOps);
  } catch { /* Never replace the transaction's original failure. */ }
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

const RETAINED_ARCHIVE_REFERENCE_KEYS = Object.freeze(['referenceBundle', 'historicalSnapshot', 'historicalSnapshotSha256', 'expectedReferenceCdHash']);

/** An older retained download is historical evidence only. It cannot stand in
 * for the active archive, the installed shell or a current runtime receipt. */
function inspectRetainedArchiveReference(options, { bundle, home, identity, archive, metadataPath, files }, fileOps, readCodeIdentity) {
  if (!options || Object.keys(options).sort().join('|') !== [...RETAINED_ARCHIVE_REFERENCE_KEYS].sort().join('|')
    || !/^[a-f0-9]{40}$/.test(options.expectedReferenceCdHash ?? '')) guardRefusal('invalid retained archive reference options');
  const { referenceBundle, historicalSnapshot, historicalSnapshotSha256, expectedReferenceCdHash } = options;
  if (typeof referenceBundle !== 'string' || path.resolve(referenceBundle) !== referenceBundle) guardRefusal('missing canonical retained reference bundle');
  regularPath(referenceBundle, fileOps, true);
  if (fileOps.realpathSync(referenceBundle) !== referenceBundle || referenceBundle === bundle
    || referenceBundle.startsWith(bundle + path.sep) || bundle.startsWith(referenceBundle + path.sep)) guardRefusal('retained reference must be a separate canonical bundle');
  if (typeof historicalSnapshot !== 'string' || historicalSnapshot === bundle || historicalSnapshot.startsWith(bundle + path.sep)) guardRefusal('historical snapshot must be outside the installed bundle');
  const snapshot = pinnedRepeatJSON(historicalSnapshot, historicalSnapshotSha256, fileOps);
  const prior = snapshot?.appliedUpdateEvidence;
  const referenceIdentity = nativeIdentity(fileOps.readFileSync(path.join(referenceBundle, 'Contents/Info.plist'), 'utf8'));
  const stableVersion = value => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) guardRefusal('retained version order is unsupported');
    const parts = value.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) guardRefusal('retained version order is unsupported');
    return parts;
  };
  const older = stableVersion(referenceIdentity.version); const current = stableVersion(identity.version);
  const different = older.findIndex((part, index) => part !== current[index]);
  if (different < 0 || older[different] >= current[different] || referenceIdentity.bundleId !== identity.bundleId
    || prior?.version !== 1 || prior.app !== bundle || prior.home !== path.resolve(home)) guardRefusal('retained reference is not a pinned older same-bundle generation');
  sameEvidence(prior.identity, referenceIdentity, 'historical retained identity');
  for (const rel of SEALED_SHELL_PARTS) {
    const digest = fileDigest(path.join(referenceBundle, rel), 'sha256', 'hex', fileOps);
    if (digest !== prior.shellSnapshot?.[rel] || digest !== snapshot.shellSnapshot?.[rel]) guardRefusal('retained reference native part differs from historical snapshot');
  }
  const pairedArchive = path.join(path.dirname(path.dirname(archive)), 'update.zip.held-latest');
  for (const name of [archive, pairedArchive, metadataPath]) {
    if (typeof prior.files?.[name] !== 'string' || prior.files[name] !== files[name]) guardRefusal('retained archive or metadata differs from historical snapshot');
  }
  const referenceTree = typedTree(referenceBundle, fileOps, { links: true });
  sameEvidence(archivedBundleTree(archive, path.basename(bundle), fileOps), referenceTree, 'retained archive/reference typed footprint');
  const codeIdentity = readCodeIdentity(referenceBundle);
  sameEvidence(codeIdentity, { bundleId: identity.bundleId, team: DESKTOP_TEAM_IDENTIFIER, cdHash: expectedReferenceCdHash }, 'retained signed reference publisher/identity');
  return { identity: referenceIdentity, codeIdentity,
    archiveSha256: fileDigest(archive, 'sha256', 'hex', fileOps),
    referenceTreeDigest: createHash('sha256').update(JSON.stringify(referenceTree)).digest('hex') };
}

/** A completed native update can retain downloads and its consumed request.
 * Admit only bytes that independently match the installed signed native shell,
 * with no remaining staging directory. Capture while that full seal is valid.
 * The serialized receipt is evidence to recheck, never a boolean bypass. */
export function captureAppliedUpdateEvidence({ app, home, retainedArchiveReference }, fileOps = fs, commands = execFileSync, readCodeIdentity = referenceCodeIdentity) {
  const evidence = inspectAppliedUpdateEvidence({ app, home, retainedArchiveReference }, fileOps, readCodeIdentity);
  if (retainedArchiveReference !== undefined) commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', retainedArchiveReference.referenceBundle], { stdio: 'pipe' });
  commands('/usr/bin/codesign', ['--verify', '--deep', '--strict', evidence.app], { stdio: 'pipe' });
  if (retainedArchiveReference !== undefined) sameEvidence(inspectAppliedUpdateEvidence({ app, home, retainedArchiveReference }, fileOps, readCodeIdentity), evidence, 'verified applied-update evidence');
  return evidence;
}

/** Recapture an already patched installation without claiming its modified
 * resource seal is pristine. The complete repeat guard instead proves the
 * independent signed references, exact archive and ordered runtime/rollback
 * chain. This returns observation data only; the installer must prove it again.
 * Take shellSnapshot before quitting, then call only after app/updater exit. */
export function captureRepeatedAppliedUpdateEvidence({ app, home, shellSnapshot, retainedArchiveReference, repeatedReference,
  isRunning = () => isInstalledAppRunning(app), isUpdaterRunning = isUpdaterHelperRunning,
  verifyNativeSignature, readReferenceCodeIdentity = referenceCodeIdentity,
}, fileOps = fs) {
  if (typeof app !== 'string' || path.resolve(app) !== app || typeof home !== 'string' || path.resolve(home) !== home) guardRefusal('repeat capture requires canonical app and home paths');
  if (!repeatedReference) guardRefusal('repeat capture requires the exact signed reference and receipt chain');
  const closed = () => { if (isRunning() || isUpdaterRunning()) guardRefusal('app or installer helper is running during repeat capture'); };
  closed();
  const evidence = inspectAppliedUpdateEvidence({ app, home, retainedArchiveReference }, fileOps, readReferenceCodeIdentity);
  verifyGuardedSealedPatch({ app, home, shellSnapshot, appliedUpdateEvidence: evidence, repeatedReference,
    isRunning, isUpdaterRunning, verifyNativeSignature, readReferenceCodeIdentity,
  }, fileOps);
  sameEvidence(inspectAppliedUpdateEvidence({ app, home, retainedArchiveReference }, fileOps, readReferenceCodeIdentity), evidence,
    'repeat applied-update evidence after verification');
  for (const rel of SEALED_SHELL_PARTS) if (shellSnapshot?.[rel] !== evidence.shellSnapshot[rel]) guardRefusal('repeat capture native snapshot differs');
  closed();
  return { shellSnapshot: { ...evidence.shellSnapshot }, appliedUpdateEvidence: evidence };
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

function inspectAppliedUpdateEvidence({ app, home, retainedArchiveReference }, fileOps = fs, readCodeIdentity = referenceCodeIdentity) {
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
  // Restart-to-update asks the installer to relaunch; an update staged to
  // install on quit does not. Either way the request was consumed, and the
  // checks below prove the installed bundle is that verified download.
  if (Object.keys(state).sort().join('|') !== expectedKeys.sort().join('|') || state.bundleIdentifier !== bundleId || typeof state.launchAfterInstallation !== 'boolean' || state.useUpdateBundleName !== true) guardRefusal('unrecognized consumed installer request');
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
  let retainedArchive;
  if (retainedArchiveReference !== undefined && !cacheNames.includes('pending.held-latest')) guardRefusal('retained reference has no held archive');
  for (const suffix of ['', '.held-latest'].filter(suffix => cacheNames.includes(`pending${suffix}`))) {
    const pending = path.join(cache, `pending${suffix}`);
    regularPath(pending, fileOps, true);
    const metadataPath = path.join(pending, 'update-info.json');
    regularPath(metadataPath, fileOps);
    const metadata = flatJSONObject(metadataPath, fileOps);
    if (Object.keys(metadata).sort().join('|') !== 'fileName|isAdminRightsRequired|sha512' || metadata.isAdminRightsRequired !== false || !/^[A-Za-z0-9._-]+\.zip$/.test(metadata.fileName) || typeof metadata.sha512 !== 'string' || Buffer.from(metadata.sha512, 'base64').length !== 64 || Buffer.from(metadata.sha512, 'base64').toString('base64') !== metadata.sha512) guardRefusal('unrecognized retained download metadata');
    // The updater keeps the download's blockmap beside it for the next
    // differential download; it is the only other file it writes there.
    const names = fileOps.readdirSync(pending).sort();
    const blockmap = names.includes('current.blockmap');
    if (names.filter(name => name !== 'current.blockmap').join('|') !== [metadata.fileName, 'update-info.json'].sort().join('|')) guardRefusal('unexpected retained pending download inventory');
    files[metadataPath] = fileDigest(metadataPath, 'sha256', 'hex', fileOps);
    if (blockmap) {
      const pendingBlockmap = path.join(pending, 'current.blockmap');
      regularPath(pendingBlockmap, fileOps);
      files[pendingBlockmap] = fileDigest(pendingBlockmap, 'sha256', 'hex', fileOps);
    }
    const pendingArchive = path.join(pending, metadata.fileName);
    const archive = path.join(cache, `update.zip${suffix}`);
    for (const archivePath of [pendingArchive, archive]) {
      const checksum = fileDigest(archivePath, 'sha512', 'base64', fileOps);
      if (checksum !== metadata.sha512) guardRefusal('retained archive checksum differs from download metadata');
      files[archivePath] = checksum;
    }
    const native = archivedNativeParts(pendingArchive, path.basename(bundle), fileOps);
    if (suffix === '.held-latest' && retainedArchiveReference !== undefined) {
      retainedArchive = inspectRetainedArchiveReference(retainedArchiveReference, { bundle, home, identity, archive: pendingArchive, metadataPath, files }, fileOps, readCodeIdentity);
    } else if (JSON.stringify(native['Contents/Info.plist'].identity) !== JSON.stringify(identity) || SEALED_SHELL_PARTS.some(rel => native[rel].sha256 !== shellSnapshot[rel])) guardRefusal('retained archive differs from applied native shell');
  }
  if (cacheNames.includes('current.blockmap')) files[path.join(cache, 'current.blockmap')] = fileDigest(path.join(cache, 'current.blockmap'), 'sha256', 'hex', fileOps);
  return { version: retainedArchiveReference === undefined ? 1 : 2, app: bundle, home: path.resolve(home), identity, shellSnapshot, shipNames, cacheNames, stagedDirectory, files,
    ...(retainedArchiveReference === undefined ? {} : { retainedArchiveReference: { ...retainedArchiveReference }, retainedArchive }) };
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
function compareVersions(left, right) {
  const a = left.split(/[.-]/).map(Number); const b = right.split(/[.-]/).map(Number);
  for (let index = 0; index < 3; index += 1) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

/**
 * A SIGNED LOCAL BUILD AS THE TRUST ANCHOR.
 *
 * The updater admissions start from what the updater delivered: its verified
 * download is the signed reference. A whole signed bundle built, signed and
 * notarized here and installed in place (a whole_signed_bundle_replacement
 * record) has no such download. Its anchor is that record, pinned by SHA-256:
 * it names this installed bundle, a separate retained signed reference copy,
 * our team and the exact CDHash, and states that nothing was re-signed and no
 * attributes were cleared. The updater may hold only consumed state: no staged
 * installer bundle, and retained downloads no newer than the installed version,
 * so nothing can be applied on quit. Every receipt chained from the anchor
 * names it, so a receipt of another chain on the same bundle path never counts.
 */
export function inspectSignedBuildAnchor({ app, home, anchor }, fileOps = fs) {
  const bundle = path.resolve(app);
  if (!anchor || typeof anchor.path !== 'string' || !path.isAbsolute(anchor.path) || !/^[a-f0-9]{64}$/.test(anchor.sha256 ?? '')) guardRefusal('missing exact signed build anchor pins');
  if (anchor.path === bundle || anchor.path.startsWith(bundle + path.sep)) guardRefusal('signed build anchor must be outside the installed bundle');
  const record = pinnedRepeatJSON(anchor.path, anchor.sha256, fileOps, 256 * 1024);
  const code = record?.candidate?.code;
  if (record?.version !== 1 || record.kind !== 'whole_signed_bundle_replacement' || record.app !== bundle
    || typeof record.signedReference !== 'string' || !path.isAbsolute(record.signedReference)
    || !code || code.team !== DESKTOP_TEAM_IDENTIFIER || !/^[a-f0-9]{40}$/.test(code.cdHash ?? '')
    || record.installed?.code?.cdHash !== code.cdHash || record.codeResigned !== false || record.xattrsCleared !== false) guardRefusal('unrecognized signed build anchor');
  const { config, cache, shipIt, bundleId } = updaterLocations({ app: bundle, home }, fileOps);
  if (code.identifier !== bundleId) guardRefusal('signed build anchor names another bundle identity');
  const identity = nativeIdentity(fileOps.readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8'));
  const files = { [config]: fileDigest(config, 'sha256', 'hex', fileOps) };
  if (fileOps.existsSync(shipIt)) {
    regularPath(shipIt, fileOps, true);
    for (const name of fileOps.readdirSync(shipIt).sort()) {
      if (name.startsWith('update.')) guardRefusal('an installer bundle is staged to apply on quit');
    }
    const statePath = path.join(shipIt, 'ShipItState.plist');
    if (fileOps.existsSync(statePath)) {
      const state = flatJSONObject(statePath, fileOps);
      const url = new URL(String(state.updateBundleURL ?? ''));
      if (url.protocol !== 'file:' || url.host) guardRefusal('unexpected installer request URL');
      absentPath(path.dirname(path.resolve(fileURLToPath(url))), fileOps);
      files[statePath] = fileDigest(statePath, 'sha256', 'hex', fileOps);
    }
  }
  if (fileOps.existsSync(cache)) {
    regularPath(cache, fileOps, true);
    for (const name of fileOps.readdirSync(cache).sort().filter(entry => entry === 'pending' || entry.startsWith('pending.'))) {
      const metadataPath = path.join(cache, name, 'update-info.json');
      regularPath(metadataPath, fileOps);
      const metadata = flatJSONObject(metadataPath, fileOps);
      const version = /-(\d+\.\d+\.\d+)(?=[-.])/.exec(String(metadata.fileName ?? ''))?.[1];
      if (!version || compareVersions(version, identity.version) > 0) guardRefusal('a newer download is retained and could apply on quit');
      files[metadataPath] = fileDigest(metadataPath, 'sha256', 'hex', fileOps);
    }
  }
  const shellSnapshot = Object.fromEntries(SEALED_SHELL_PARTS.map(rel => [rel, fileDigest(path.join(bundle, rel), 'sha256', 'hex', fileOps)]));
  return { version: 1, mode: 'signed-build-anchor', app: bundle, home: path.resolve(home), identity, shellSnapshot,
    anchor: { path: anchor.path, sha256: anchor.sha256 }, reference: path.resolve(record.signedReference),
    code: { bundleId, team: code.team, cdHash: code.cdHash }, files };
}

export function verifyGuardedSealedPatch({ app, home, shellSnapshot, appliedUpdateEvidence, noActiveUpdateEvidence, signedBuildAnchor, priorProof, repeatedReference, isRunning,
  readReferenceCodeIdentity = referenceCodeIdentity,
  isUpdaterRunning = isUpdaterHelperRunning,
  verifyNativeSignature = (bundle) => execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' }),
  assessNotarization = (bundle) => execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', bundle], { stdio: 'pipe' }),
}, fileOps = fs) {
  const bundle = path.resolve(app);
  if (priorProof && CURRENT_STATE_RECOVERIES.has(priorProof)) guardRefusal('current recovery authority cannot enter the legacy admission path');
  if (isRunning()) throw new Error(`Refusing a guarded patch: ${bundle} is still running.`);
  if (isUpdaterRunning()) guardRefusal('an installer helper is still running');
  if (!home) guardRefusal('no updater home for a fresh staging inventory');
  if (appliedUpdateEvidence && noActiveUpdateEvidence) guardRefusal('updater evidence modes are mutually exclusive');
  if (signedBuildAnchor) {
    if (appliedUpdateEvidence || noActiveUpdateEvidence) guardRefusal('a signed build anchor replaces updater evidence');
    const observed = inspectSignedBuildAnchor({ app: bundle, home, anchor: signedBuildAnchor }, fileOps);
    const anchorDigest = createHash('sha256').update(JSON.stringify(observed)).digest('hex');
    let ledger = null;
    if (priorProof) {
      if (!GUARDED_PATCHES.has(priorProof) || priorProof.app !== bundle || priorProof.appliedEvidenceDigest !== anchorDigest) guardRefusal('no matching signed-build anchor proof');
      ledger = REPEAT_PATCHES.get(priorProof) ?? null;
      if (repeatedReference && !ledger) guardRefusal('no matching private anchored repeat proof');
      if (ledger) {
        if (ledger.context.bundle !== bundle || ledger.context.observed.home !== path.resolve(home)) guardRefusal('private repeat proof context differs');
        sameEvidence(shellSnapshot, ledger.context.observed.shellSnapshot, 'private repeat shell snapshot');
        if (repeatedReference !== undefined) sameEvidence(repeatedReference, ledger.optionSnapshot, 'private repeat authority context');
        recheckRepeatReference(ledger, fileOps);
      }
    } else if (repeatedReference) {
      if (path.resolve(String(repeatedReference.referenceBundle ?? '')) !== observed.reference || repeatedReference.expectedReferenceCdHash !== observed.code.cdHash) guardRefusal('anchored repeat reference differs from its signed build anchor');
      const context = { bundle, observed, verifyNativeSignature, readReferenceCodeIdentity, assessNotarization };
      context.reprove = (proof) => verifyGuardedSealedPatch({ app: bundle, home, shellSnapshot, signedBuildAnchor, priorProof: proof, repeatedReference,
        isRunning, isUpdaterRunning, verifyNativeSignature, readReferenceCodeIdentity, assessNotarization }, fileOps);
      ledger = inspectRepeatReference(repeatedReference, context, fileOps);
    } else {
      // First link: the installed bundle is still exactly the signed build.
      verifyNativeSignature(bundle);
      assessNotarization(bundle);
      sameEvidence(readReferenceCodeIdentity(bundle), observed.code, 'installed signed build identity');
    }
    for (const rel of SEALED_SHELL_PARTS) {
      if (typeof shellSnapshot?.[rel] !== 'string') throw new Error(`Refusing a guarded patch: no pre-quit snapshot of ${rel}.`);
      if (observed.shellSnapshot[rel] !== shellSnapshot[rel]) throw new Error(`Refusing a guarded patch: ${rel} changed since the pre-quit snapshot.`);
    }
    if (isRunning() || isUpdaterRunning()) guardRefusal('app or installer helper started during anchored verification');
    sameEvidence(inspectSignedBuildAnchor({ app: bundle, home, anchor: signedBuildAnchor }, fileOps), observed, 'signed build anchor evidence after verification');
    const proof = Object.freeze({ app: bundle, canonical: fileOps.realpathSync(bundle), appliedEvidenceDigest: anchorDigest });
    GUARDED_PATCHES.add(proof);
    if (ledger) REPEAT_PATCHES.set(proof, ledger);
    return proof;
  }
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
    const observed = inspectAppliedUpdateEvidence({ app: bundle, home, retainedArchiveReference: appliedUpdateEvidence.retainedArchiveReference }, fileOps, readReferenceCodeIdentity);
    if (JSON.stringify(observed) !== JSON.stringify(appliedUpdateEvidence)) guardRefusal('applied-update evidence changed since the snapshot');
    appliedEvidenceDigest = createHash('sha256').update(JSON.stringify(observed)).digest('hex');
    if (!priorProof && observed.version === 2) verifyNativeSignature(observed.retainedArchiveReference.referenceBundle);
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
  if (appliedUpdateEvidence?.version === 2 || (appliedUpdateEvidence && repeatLedger?.recoveryGenesis)) {
    sameEvidence(inspectAppliedUpdateEvidence({ app: bundle, home, retainedArchiveReference: appliedUpdateEvidence.retainedArchiveReference }, fileOps, readReferenceCodeIdentity), appliedUpdateEvidence,
      'applied-update evidence after verification');
    if (isRunning() || isUpdaterRunning()) guardRefusal('app or installer helper started during applied-update verification');
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
    recordRecoveryStageFailure(transaction, staging, fileOps);
    if (originalMoved && !fs.existsSync(target)) {
      throw new Error(`Patch interrupted; prior daemon is retained at ${backup}. Restore it to ${target} before launching.`, { cause: error });
    }
    throw error;
  } finally {
    fileOps.rmSync(staging, { recursive: true, force: true });
    if (transaction) delete transaction.ledger.pendingStage;
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
    recordRecoveryStageFailure(transaction, staging, fileOps);
    if (originalMoved && !fs.existsSync(target)) {
      throw new Error(`Asset patch interrupted; prior assets are retained at ${backup}. Restore them to ${target} before launching.`, { cause: error });
    }
    throw error;
  } finally {
    fileOps.rmSync(staging, { recursive: true, force: true });
    if (transaction) delete transaction.ledger.pendingStage;
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
