/**
 * Hotpatch the installed app from THIS tree: daemon, built-in skills, and both
 * web asset trees, in one pass, with rollback for each.
 *
 * Uses the repo's own helpers from hotpatch-daemon.mjs so every tree is staged,
 * digested and retained the same way the daemon patch path does it. Verifies
 * the installed bytes against the candidate before relaunching — the mobile
 * shell has been bitten before by a served copy that did not match what was
 * built, and a version or HEAD alone never identifies the patched bytes.
 *
 * Must run from a process holding macOS "App Management" permission: the bundle
 * carries com.apple.provenance, so anything without that grant gets EPERM.
 *
 * App bundles are refused unless --guarded-shell-snapshot names the native-part
 * hashes the caller recorded before quitting the app itself; the patch then
 * runs only while that proof holds (verifyGuardedSealedPatch) and re-proves it
 * after writing.
 * A snapshot may explicitly capture noActiveUpdateEvidence after consumed
 * updater records disappear. That mode still requires all signed-reference,
 * ordered receipt and complete current updater-inventory proofs; an empty
 * staging directory alone never grants repeat installation authority.
 * A lost historical receipt has no legacy fallback. Explicit present-state
 * recovery instead needs --current-state-recovery <capture>, its SHA256,
 * --recovery-evidence-directory <external durable directory>, and the same
 * pre-quit shell snapshot. Future receipts descended from that admission also
 * require --authorized-recovery-genesis and its SHA256; never invent history.
 *
 *   node --import tsx scripts/hotpatch-installed-tree.mjs [--no-relaunch] [--guarded-shell-snapshot <file>]
 */
import {
  assertMutableInstallTarget,
  inspectDaemonBuild,
  installBundledAssetDirectory,
  installDaemonPatch,
  isInstalledAppRunning,
  isUpdaterHelperRunning,
  resolveInstalledAppBundle,
  verifyGuardedSealedPatch,
  verifyCurrentStateRecoveryPatch,
  initializeCurrentStateRecoveryArtifacts,
  writeCurrentStateRecoveryReceipt,
  recordCurrentStateRecoveryFailure,
} from './hotpatch-daemon.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAUNCH = !process.argv.includes('--no-relaunch');
const SNAPSHOT_FLAG = process.argv.indexOf('--guarded-shell-snapshot');
const SHELL_SNAPSHOT = SNAPSHOT_FLAG >= 0 ? process.argv[SNAPSHOT_FLAG + 1] : null;
if (SNAPSHOT_FLAG >= 0 && (!SHELL_SNAPSHOT || SHELL_SNAPSHOT.startsWith('--'))) throw new Error('--guarded-shell-snapshot needs the pre-quit snapshot file.');
if (process.argv.filter(arg => arg === '--guarded-shell-snapshot').length > 1) throw new Error('Duplicate --guarded-shell-snapshot.');
const repeatFlags = { referenceBundle: '--signed-reference-bundle', authorizedReceipt: '--authorized-prior-receipt', authorizedReceiptSha256: '--authorized-prior-receipt-sha256', expectedPriorFingerprint: '--expected-prior-fingerprint', expectedReferenceCdHash: '--expected-reference-cdhash' };
const ancestorFlags = { authorizedAncestorManifest: '--authorized-ancestor-manifest', authorizedAncestorManifestSha256: '--authorized-ancestor-manifest-sha256' };
const genesisFlags = { authorizedRecoveryGenesis: '--authorized-recovery-genesis', authorizedRecoveryGenesisSha256: '--authorized-recovery-genesis-sha256' };
const recoveryFlags = { path: '--current-state-recovery', sha256: '--current-state-recovery-sha256', directory: '--recovery-evidence-directory' };
const repeatedReference = {};
const recovery = {};
for (const [key, flag] of Object.entries({ ...repeatFlags, ...ancestorFlags, ...genesisFlags, ...recoveryFlags })) {
  const positions = process.argv.flatMap((arg, index) => arg === flag ? [index] : []);
  if (positions.length > 1) throw new Error(`Duplicate ${flag}.`);
  if (!positions.length) continue;
  const value = process.argv[positions[0] + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires an exact value.`);
  (key in recoveryFlags ? recovery : repeatedReference)[key] = value;
}
if (Object.keys(repeatedReference).length && (!SHELL_SNAPSHOT || Object.keys(repeatFlags).some(key => repeatedReference[key] === undefined))) throw new Error('Repeat installation requires the shell snapshot and all five exact reference/receipt pins.');
if (Object.keys(ancestorFlags).some(key => repeatedReference[key] !== undefined) && Object.keys(ancestorFlags).some(key => repeatedReference[key] === undefined)) throw new Error('Ancestor manifest requires both the exact path and SHA256 pin.');
if (Object.keys(genesisFlags).some(key => repeatedReference[key] !== undefined) && Object.keys(genesisFlags).some(key => repeatedReference[key] === undefined)) throw new Error('Recovery genesis requires both the exact path and SHA256 pin.');
const currentRecovery = recovery.path !== undefined || recovery.sha256 !== undefined;
if (currentRecovery && (!SHELL_SNAPSHOT || !recovery.path || !recovery.sha256 || !recovery.directory || Object.keys(repeatedReference).length)) throw new Error('Current-state recovery requires its exact capture pins, shell snapshot and durable evidence directory, and cannot use prior-receipt authority.');
if (repeatedReference.authorizedRecoveryGenesis && !recovery.directory) throw new Error('A recovery-derived repeat requires a durable evidence directory.');
if (recovery.directory && !currentRecovery && !repeatedReference.authorizedRecoveryGenesis) throw new Error('Recovery evidence directory requires explicit recovery authority.');
const valuedFlags = new Set(['--guarded-shell-snapshot', ...Object.values(repeatFlags), ...Object.values(ancestorFlags), ...Object.values(genesisFlags), ...Object.values(recoveryFlags)]);
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--no-relaunch') continue;
  if (!valuedFlags.has(arg)) throw new Error(`Unknown installer argument: ${arg}`);
  index += 1;
}

function treeDigest(root) {
  const h = createHash('sha256');
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.join(rel, n));
    else if (st.isFile()) { h.update(rel); h.update(fs.readFileSync(abs)); }
    else throw new Error(`Unexpected runtime entry: ${rel}`);
  };
  walk('');
  return h.digest('hex');
}

function running() {
  return isInstalledAppRunning(APP, execFileSync);
}

/** Seconds since the newest event that is not the known restart-recovery loop. */
async function idleSeconds() {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(`${process.env.HOME}/.clementine-next/state/harness.db`, { readonly: true });
    const row = db.prepare(
      "SELECT created_at FROM events WHERE session_id != ? ORDER BY seq DESC LIMIT 1",
    ).get('sess-desktop-3f470fbb78675aff366300c6');
    db.close();
    if (!row) return Infinity;
    const at = typeof row.created_at === 'number' ? row.created_at : Date.parse(row.created_at);
    return Number.isFinite(at) ? (Date.now() - at) / 1000 : Infinity;
  } catch {
    return NaN; // unknown — treat as busy and make the caller decide
  }
}

const home = process.env.HOME ?? '';
const installed = resolveInstalledAppBundle(
  process.env.CLEMENTINE_APP_PATH
    ? [process.env.CLEMENTINE_APP_PATH]
    : ['/Applications/Clementine.app', path.join(home, 'Applications', 'Clementine.app')],
  (bundle) => JSON.parse(
    fs.readFileSync(path.join(bundle, 'Contents/Resources/daemon/package.json'), 'utf8'),
  ).version,
);
const APP = installed.bundle;
// Refuse sealed resources before even checking or stopping the running app.
// A guarded patch is proven after the caller's quit instead, so this script
// never quits the app itself on that path.
if (!SHELL_SNAPSHOT) assertMutableInstallTarget(path.join(APP, 'Contents/Resources/daemon/dist'));
else if (running()) {
  console.error('REFUSED: a guarded patch runs only after the caller has quit Clementine by its bundle path.');
  process.exit(1);
}
const snapshot = SHELL_SNAPSHOT ? JSON.parse(fs.readFileSync(SHELL_SNAPSHOT, 'utf8')) : null;
if (currentRecovery && snapshot.noActiveUpdateEvidence) throw new Error('Current-state recovery cannot use no-active-update admission.');
let guarded;
const proveGuard = () => currentRecovery ? verifyCurrentStateRecoveryPatch({
  app: APP, home, evidence: { path: recovery.path, sha256: recovery.sha256 },
  shellSnapshot: snapshot.shellSnapshot, appliedUpdateEvidence: snapshot.appliedUpdateEvidence,
  priorProof: guarded, isRunning: running, isUpdaterRunning: () => isUpdaterHelperRunning(execFileSync),
}) : verifyGuardedSealedPatch({
  app: APP, home,
  shellSnapshot: snapshot.shellSnapshot ?? snapshot,
  appliedUpdateEvidence: snapshot.appliedUpdateEvidence,
  noActiveUpdateEvidence: snapshot.noActiveUpdateEvidence,
  priorProof: guarded,
  repeatedReference: Object.keys(repeatedReference).length ? repeatedReference : undefined,
  isRunning: running,
  isUpdaterRunning: () => isUpdaterHelperRunning(execFileSync),
});
guarded = SHELL_SNAPSHOT ? proveGuard() : undefined;
if (recovery.directory) initializeCurrentStateRecoveryArtifacts({ guarded, directory: recovery.directory, forbiddenRoots: [REPO] });

const IDLE_REQUIRED_SECONDS = 90;

if (running()) {
  const idle = await idleSeconds();
  if (!Number.isFinite(idle)) {
    console.error('REFUSED: could not read the event log to confirm Clementine is idle. Quit it yourself, then re-run.');
    process.exit(1);
  }
  if (idle < IDLE_REQUIRED_SECONDS) {
    console.error(`REFUSED: a run finished ${Math.round(idle)}s ago — Clementine may still be working.`);
    console.error(`Wait until it has been quiet for ${IDLE_REQUIRED_SECONDS}s, or quit it yourself and re-run.`);
    process.exit(1);
  }
  console.log(`Clementine is running and has been idle ${Math.round(idle)}s — quitting it cleanly.`);
  execFileSync('osascript', ['-e', 'quit app "Clementine"']);
  for (let i = 0; i < 20; i += 1) {
    if (!running()) break;
    execFileSync('sleep', ['1']);
  }
  if (running()) {
    console.error('REFUSED: Clementine did not quit within 20s. Quit it yourself, then re-run.');
    process.exit(1);
  }
  console.log('quit cleanly.\n');
}

console.log(`target ${APP} (was ${installed.version})\n`);

const { stamp } = inspectDaemonBuild(path.join(REPO, 'dist'));
const report = { patchedAt: new Date().toISOString(), bundle: APP, wasVersion: installed.version, sourceFingerprint: stamp.sourceFingerprint, gitSha: stamp.gitSha, parts: {} };

try {
// 1. The daemon itself.
const daemon = installDaemonPatch({
  sourceDist: path.join(REPO, 'dist'),
  targetDist: path.join(APP, 'Contents/Resources/daemon/dist'),
  guarded,
});
report.parts.daemon = { digest: daemon.digest, backup: daemon.backup ?? null };
console.log(`daemon        ${daemon.digest.slice(0, 16)}  prior: ${daemon.backup ?? '(none)'}`);

// 2. Built-in skills, and 3-4. both web asset trees.
const trees = [
  ['builtin-skills', path.join(REPO, 'builtin-skills'), path.join(APP, 'Contents/Resources/daemon/builtin-skills')],
  ['console-web', path.join(REPO, 'apps/console-web/dist'), path.join(APP, 'Contents/Resources/daemon/apps/console-web/dist')],
  ['mobile-web', path.join(REPO, 'apps/mobile-web/dist'), path.join(APP, 'Contents/Resources/daemon/apps/mobile-web/dist')],
];
for (const [name, sourceDir, targetDir] of trees) {
  if (guarded) proveGuard();
  const built = treeDigest(sourceDir);
  const result = installBundledAssetDirectory({ sourceDir, targetDir, guarded });
  const served = treeDigest(targetDir);
  const match = built === served;
  report.parts[name] = { built, served, match, backup: result.backup ?? null };
  console.log(`${name.padEnd(14)}${served.slice(0, 16)}  ${match ? 'MATCH' : '*** MISMATCH ***'}  prior: ${result.backup ?? '(none)'}`);
  if (!match) {
    console.error(`\nServed ${name} bytes do not match the candidate. Stopping before relaunch.`);
    fs.writeFileSync(path.join(REPO, 'output/ui-hotpatch-receipt.json'), JSON.stringify(report, null, 2) + '\n');
    if (recovery.directory) throw new Error('Recovery asset bytes do not match; no completed recovery receipt was written.');
    process.exit(2);
  }
}

if (guarded) {
  // The patch wrote only runtime resources; prove the native parts still match.
  proveGuard();
  report.guardedShell = 'unchanged';
  console.log('native parts   unchanged after the patch');
}

// A later replacement must not invalidate an earlier part's byte proof while
// leaving the native shell unchanged. Recheck the complete runtime together
// before the receipt or relaunch, retaining every rollback on a mismatch.
const installedDaemon = inspectDaemonBuild(path.join(APP, 'Contents/Resources/daemon/dist'));
report.parts.daemon.served = installedDaemon.digest;
report.parts.daemon.match = installedDaemon.digest === daemon.digest;
for (const [name, , targetDir] of trees) {
  report.parts[name].served = treeDigest(targetDir);
  report.parts[name].match = report.parts[name].served === report.parts[name].built;
}
if (Object.values(report.parts).some(part => !part.match)) {
  fs.mkdirSync(path.join(REPO, 'output'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'output/ui-hotpatch-receipt.json'), JSON.stringify(report, null, 2) + '\n');
  throw new Error('Installed runtime changed before final byte verification. Rollbacks retained; refusing relaunch.');
}

fs.mkdirSync(path.join(REPO, 'output'), { recursive: true });
if (recovery.directory) {
  const completed = writeCurrentStateRecoveryReceipt({ guarded, report });
  Object.assign(report, completed.receipt);
  console.log(`durable recovery receipt: ${completed.pin.path}`);
}
fs.writeFileSync(path.join(REPO, 'output/ui-hotpatch-receipt.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\nsource fingerprint ${stamp.sourceFingerprint}`);
console.log('receipt: output/ui-hotpatch-receipt.json');
} catch (error) {
  if (recovery.directory) {
    try { recordCurrentStateRecoveryFailure({ guarded }); }
    catch { console.error('Could not persist the incomplete recovery observation; existing genesis and root observations are retained.'); }
  }
  throw error;
}

if (RELAUNCH) {
  execFileSync('open', ['-a', APP]);
  console.log('\nrelaunched — confirm the running fingerprint before testing.');
}
