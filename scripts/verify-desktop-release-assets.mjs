#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = { dir: 'apps/desktop/release', version: '', platform: 'mac' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') args.dir = argv[++i] ?? '';
    else if (arg === '--version') args.version = argv[++i] ?? '';
    else if (arg === '--platform') args.platform = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function parseLatestMacYml(text) {
  const version = text.match(/^version:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]?.trim() ?? '';
  const pathEntry = text.match(/^path:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]?.trim() ?? '';
  const files = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const url = line.match(/^\s*-\s+url:\s*['"]?([^'"\n]+)['"]?\s*$/);
    if (url) {
      if (current) files.push(current);
      current = { url: url[1].trim(), sha512: '', size: null };
      continue;
    }
    if (!current) continue;
    const sha = line.match(/^\s+sha512:\s*['"]?([^'"\n]+)['"]?\s*$/);
    if (sha) {
      current.sha512 = sha[1].trim();
      continue;
    }
    const size = line.match(/^\s+size:\s*([0-9]+)\s*$/);
    if (size) current.size = Number.parseInt(size[1], 10);
  }
  if (current) files.push(current);
  return { version, path: pathEntry, files };
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFilesRecursive(filePath);
    return [filePath];
  });
}

export function sha512FileSync(filePath) {
  const hash = createHash('sha512');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, 'r');
  try {
    let bytesRead;
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('base64');
}

export function verifyDesktopReleaseAssets(options = {}) {
  const releaseDir = path.resolve(options.dir ?? 'apps/desktop/release');
  const expectedVersion = String(options.version ?? '').replace(/^v/, '').trim();
  const platform = String(options.platform ?? 'mac').trim().toLowerCase();
  const errors = [];
  const notes = [];

  if (platform !== 'mac' && platform !== 'windows') {
    errors.push(`unsupported release platform: ${platform || '(empty)'}`);
    return { ok: false, errors, notes };
  }

  const feedName = platform === 'windows' ? 'latest.yml' : 'latest-mac.yml';
  const feedPath = path.join(releaseDir, feedName);

  if (!existsSync(releaseDir)) {
    errors.push(`release directory does not exist: ${releaseDir}`);
    return { ok: false, errors, notes };
  }
  if (!existsSync(feedPath)) {
    errors.push(`missing updater feed: ${feedPath}`);
    return { ok: false, errors, notes };
  }

  const feed = parseLatestMacYml(readFileSync(feedPath, 'utf-8'));
  if (!feed.version) errors.push(`${feedName} is missing a version line`);
  if (expectedVersion && feed.version !== expectedVersion) {
    errors.push(`${feedName} version ${feed.version || '(missing)'} does not match expected ${expectedVersion}`);
  }
  if (!feed.path) errors.push(`${feedName} is missing top-level path`);
  if (feed.files.length === 0) errors.push(`${feedName} has no files entries`);

  if (platform === 'mac') {
    if (!feed.files.some((file) => file.url.endsWith('.zip'))) errors.push('latest-mac.yml does not reference a .zip artifact');
    if (!feed.files.some((file) => file.url.endsWith('.dmg'))) errors.push('latest-mac.yml does not reference a .dmg artifact');
  } else if (!feed.files.some((file) => file.url.endsWith('.exe'))) {
    errors.push('latest.yml does not reference an .exe artifact');
  }

  if (expectedVersion) {
    const feedUrls = new Set(feed.files.map((file) => file.url));
    if (platform === 'mac') {
      const requiredMacArtifacts = [
        `Clementine-${expectedVersion}-arm64-mac.zip`,
        `Clementine-${expectedVersion}-arm64.dmg`,
        `Clementine-${expectedVersion}-mac.zip`,
        `Clementine-${expectedVersion}.dmg`,
      ];
      for (const artifact of requiredMacArtifacts) {
        if (!feedUrls.has(artifact)) errors.push(`latest-mac.yml is missing architecture artifact: ${artifact}`);
      }
      if (feed.path !== `Clementine-${expectedVersion}-mac.zip`) {
        errors.push(`top-level path must remain the x64 legacy fallback, got: ${feed.path || '(missing)'}`);
      }
    } else {
      const expectedInstaller = `Clementine-Setup-${expectedVersion}.exe`;
      if (!feedUrls.has(expectedInstaller)) {
        errors.push(`latest.yml is missing updater-safe installer artifact: ${expectedInstaller}`);
      }
      if (feed.path !== expectedInstaller) {
        errors.push(`top-level path must match the updater-safe Windows installer, got: ${feed.path || '(missing)'}`);
      }
    }
  }

  const feedUrls = new Set(feed.files.map((file) => file.url));
  if (feed.path && !feedUrls.has(feed.path)) {
    errors.push(`top-level path ${feed.path} is not present in files[]`);
  }

  for (const file of feed.files) {
    if (!file.url || file.url.includes('/') || file.url.includes('\\')) {
      errors.push(`feed artifact url must be a local asset filename, got: ${file.url || '(empty)'}`);
      continue;
    }
    if (!file.sha512) errors.push(`${file.url} is missing sha512`);
    if (!Number.isFinite(file.size) || file.size <= 0) errors.push(`${file.url} has invalid size ${file.size}`);
    const artifactPath = path.join(releaseDir, file.url);
    if (!existsSync(artifactPath)) {
      errors.push(`feed references missing artifact: ${file.url}`);
      continue;
    }
    const actualSize = statSync(artifactPath).size;
    if (Number.isFinite(file.size) && actualSize !== file.size) {
      errors.push(`${file.url} size mismatch: feed=${file.size} actual=${actualSize}`);
    }
    if (file.sha512 && sha512FileSync(artifactPath) !== file.sha512) {
      errors.push(`${file.url} sha512 mismatch`);
    }
    const blockmapPath = `${artifactPath}.blockmap`;
    if (!existsSync(blockmapPath)) {
      errors.push(`missing blockmap for feed artifact: ${path.basename(blockmapPath)}`);
    } else if (statSync(blockmapPath).size <= 0) {
      errors.push(`empty blockmap for feed artifact: ${path.basename(blockmapPath)}`);
    }
  }

  if (expectedVersion) {
    const relativeFiles = listFilesRecursive(releaseDir).map((filePath) => path.relative(releaseDir, filePath));
    if (platform === 'mac') {
      const stale = relativeFiles
        .filter((rel) => /^Clementine-.*\.(?:dmg|zip|blockmap)$/.test(path.basename(rel)))
        .filter((rel) => !path.basename(rel).startsWith(`Clementine-${expectedVersion}`));
      if (stale.length > 0) {
        errors.push(`release directory contains stale Clementine artifacts for other versions: ${stale.join(', ')}`);
      }
    } else {
      const expectedInstaller = `Clementine-Setup-${expectedVersion}.exe`;
      const expectedNames = new Set([expectedInstaller, `${expectedInstaller}.blockmap`]);
      const unexpected = relativeFiles
        .filter((rel) => /^Clementine(?:[ .-])Setup.*\.exe(?:\.blockmap)?$/i.test(path.basename(rel)))
        .filter((rel) => !expectedNames.has(path.basename(rel)));
      if (unexpected.length > 0) {
        errors.push(`release directory contains updater-unsafe Windows installer names: ${unexpected.join(', ')}`);
      }
    }
  }

  notes.push(`checked ${feed.files.length} ${platform} feed artifacts in ${releaseDir}`);
  return { ok: errors.length === 0, errors, notes, feed, platform };
}

function printUsage() {
  console.log('Usage: node scripts/verify-desktop-release-assets.mjs --dir apps/desktop/release --version 1.3.3 [--platform mac|windows]');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      process.exit(0);
    }
    const result = verifyDesktopReleaseAssets(args);
    for (const note of result.notes) console.log(`  ✓ ${note}`);
    if (!result.ok) {
      for (const error of result.errors) console.error(`  ✗ ${error}`);
      process.exit(1);
    }
    console.log('✓ desktop release assets verified');
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    printUsage();
    process.exit(2);
  }
}
