/** Stage a daemon-only patch before replacing installed bytes. Keep rollback.
 * Run after quitting Clementine: node --import tsx scripts/hotpatch-daemon.mjs
 * --check inspects the candidate without changing or stopping the application.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function installDaemonPatch({ sourceDist, targetDist }, fileOps = fs) {
  const source = path.resolve(sourceDist);
  const target = path.resolve(targetDist);
  if (source === target || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('Source and installation must be separate directories.');
  }
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
    fileOps.renameSync(target, backup);
    originalMoved = true;
    try {
      fileOps.renameSync(stagedDist, target);
    } catch (error) {
      fileOps.renameSync(backup, target);
      originalMoved = false;
      throw error;
    }
    return { ...before, backup, target };
  } catch (error) {
    if (originalMoved && !fs.existsSync(target)) {
      throw new Error(`Patch interrupted; prior daemon is retained at ${backup}. Restore it to ${target} before launching.`, { cause: error });
    }
    throw error;
  } finally {
    fileOps.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Replace a packaged asset directory the daemon reads at boot (the shipped
 * built-in skills) beside the daemon code, with the same verified staging copy
 * and retained rollback as the code itself. The daemon provisions each shipped
 * skill from this directory on every boot, so shipping new code without it
 * leaves a skill the new code names absent from the installation.
 */
export function installBundledAssetDirectory({ sourceDir, targetDir }, fileOps = fs) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (source === target || source.startsWith(`${target}${path.sep}`) || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('Source and installation must be separate directories.');
  }
  if (!fs.statSync(source).isDirectory()) throw new Error(`Packaged asset directory missing: ${source}`);
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
    return { digest, target, backup: hadTarget ? backup : null };
  } catch (error) {
    if (originalMoved && !fs.existsSync(target)) {
      throw new Error(`Asset patch interrupted; prior assets are retained at ${backup}. Restore them to ${target} before launching.`, { cause: error });
    }
    throw error;
  } finally {
    fileOps.rmSync(staging, { recursive: true, force: true });
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
        execFileSync('pgrep', ['-f', 'Clementine\\.app/Contents/'], { stdio: 'ignore' });
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
