#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = { dir: 'apps/desktop/release', version: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') args.dir = argv[++i] ?? '';
    else if (arg === '--version') args.version = argv[++i] ?? '';
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

export function verifyDesktopReleaseAssets(options = {}) {
  const releaseDir = path.resolve(options.dir ?? 'apps/desktop/release');
  const expectedVersion = String(options.version ?? '').replace(/^v/, '').trim();
  const errors = [];
  const notes = [];
  const feedPath = path.join(releaseDir, 'latest-mac.yml');

  if (!existsSync(releaseDir)) {
    errors.push(`release directory does not exist: ${releaseDir}`);
    return { ok: false, errors, notes };
  }
  if (!existsSync(feedPath)) {
    errors.push(`missing updater feed: ${feedPath}`);
    return { ok: false, errors, notes };
  }

  const feed = parseLatestMacYml(readFileSync(feedPath, 'utf-8'));
  if (!feed.version) errors.push('latest-mac.yml is missing a version line');
  if (expectedVersion && feed.version !== expectedVersion) {
    errors.push(`latest-mac.yml version ${feed.version || '(missing)'} does not match expected ${expectedVersion}`);
  }
  if (!feed.path) errors.push('latest-mac.yml is missing top-level path');
  if (feed.files.length === 0) errors.push('latest-mac.yml has no files entries');
  if (!feed.files.some((file) => file.url.endsWith('.zip'))) errors.push('latest-mac.yml does not reference a .zip artifact');
  if (!feed.files.some((file) => file.url.endsWith('.dmg'))) errors.push('latest-mac.yml does not reference a .dmg artifact');

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
    const blockmapPath = `${artifactPath}.blockmap`;
    if (!existsSync(blockmapPath)) {
      errors.push(`missing blockmap for feed artifact: ${path.basename(blockmapPath)}`);
    } else if (statSync(blockmapPath).size <= 0) {
      errors.push(`empty blockmap for feed artifact: ${path.basename(blockmapPath)}`);
    }
  }

  if (expectedVersion) {
    const stale = listFilesRecursive(releaseDir)
      .map((filePath) => path.relative(releaseDir, filePath))
      .filter((rel) => /^Clementine-.*\.(?:dmg|zip|blockmap)$/.test(path.basename(rel)))
      .filter((rel) => !path.basename(rel).startsWith(`Clementine-${expectedVersion}`));
    if (stale.length > 0) {
      errors.push(`release directory contains stale Clementine artifacts for other versions: ${stale.join(', ')}`);
    }
  }

  notes.push(`checked ${feed.files.length} feed artifacts in ${releaseDir}`);
  return { ok: errors.length === 0, errors, notes, feed };
}

function printUsage() {
  console.log('Usage: node scripts/verify-desktop-release-assets.mjs --dir apps/desktop/release --version 1.3.3');
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
