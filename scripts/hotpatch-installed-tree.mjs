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
 *   node --import tsx scripts/patch-web-assets.mjs [--no-relaunch]
 */
import {
  inspectDaemonBuild,
  installBundledAssetDirectory,
  installDaemonPatch,
  resolveInstalledAppBundle,
} from './hotpatch-daemon.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAUNCH = !process.argv.includes('--no-relaunch');

function treeDigest(root) {
  const h = createHash('sha256');
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.join(rel, n));
    else if (st.isFile()) { h.update(rel); h.update(fs.readFileSync(abs)); }
  };
  walk('');
  return h.digest('hex');
}

function running() {
  try {
    execFileSync('pgrep', ['-f', 'Clementine\\.app/Contents/'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status !== 1) throw error;
    return false;
  }
}

if (running()) {
  console.error('REFUSED: Clementine is running. Quit it first so the active run finishes cleanly.');
  process.exit(1);
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
console.log(`target ${APP} (was ${installed.version})\n`);

const { stamp } = inspectDaemonBuild(path.join(REPO, 'dist'));
const report = { patchedAt: new Date().toISOString(), bundle: APP, wasVersion: installed.version, sourceFingerprint: stamp.sourceFingerprint, gitSha: stamp.gitSha, parts: {} };

// 1. The daemon itself.
const daemon = installDaemonPatch({
  sourceDist: path.join(REPO, 'dist'),
  targetDist: path.join(APP, 'Contents/Resources/daemon/dist'),
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
  const built = treeDigest(sourceDir);
  const result = installBundledAssetDirectory({ sourceDir, targetDir });
  const served = treeDigest(targetDir);
  const match = built === served;
  report.parts[name] = { built, served, match, backup: result.backup ?? null };
  console.log(`${name.padEnd(14)}${served.slice(0, 16)}  ${match ? 'MATCH' : '*** MISMATCH ***'}  prior: ${result.backup ?? '(none)'}`);
  if (!match) {
    console.error(`\nServed ${name} bytes do not match the candidate. Stopping before relaunch.`);
    fs.writeFileSync(path.join(REPO, 'output/ui-hotpatch-receipt.json'), JSON.stringify(report, null, 2) + '\n');
    process.exit(2);
  }
}

fs.mkdirSync(path.join(REPO, 'output'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'output/ui-hotpatch-receipt.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`\nsource fingerprint ${stamp.sourceFingerprint}`);
console.log('receipt: output/ui-hotpatch-receipt.json');

if (RELAUNCH) {
  execFileSync('open', ['-a', APP]);
  console.log('\nrelaunched — confirm the running fingerprint before testing.');
}
