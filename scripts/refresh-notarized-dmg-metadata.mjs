#!/usr/bin/env node
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dump, load } from 'js-yaml';

function parseArgs(argv) {
  const args = { feed: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--feed') args.feed = argv[++index] ?? '';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function loadBlockMapBuilder() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const requireFromDesktop = createRequire(path.join(repoRoot, 'apps/desktop/package.json'));
  const loaded = requireFromDesktop('app-builder-lib/out/targets/blockmap/blockmap.js');
  if (typeof loaded.buildBlockMap !== 'function') {
    throw new Error('electron-builder blockmap implementation is unavailable');
  }
  return loaded.buildBlockMap;
}

export async function refreshNotarizedDmgMetadata({ feedPath, buildBlockMap } = {}) {
  const resolvedFeed = path.resolve(feedPath ?? '');
  if (!existsSync(resolvedFeed)) throw new Error(`updater feed not found: ${resolvedFeed}`);

  const feed = load(readFileSync(resolvedFeed, 'utf-8'));
  if (!feed || typeof feed !== 'object' || Array.isArray(feed) || !Array.isArray(feed.files)) {
    throw new Error(`${resolvedFeed} must contain a YAML object with files[]`);
  }

  const releaseDir = path.dirname(resolvedFeed);
  const dmgEntries = feed.files.filter((entry) => String(entry?.url ?? '').endsWith('.dmg'));
  const build = buildBlockMap ?? loadBlockMapBuilder();

  for (const entry of dmgEntries) {
    const url = String(entry.url ?? '');
    if (!url || path.basename(url) !== url) throw new Error(`unsafe DMG feed path: ${url || '(empty)'}`);
    const artifactPath = path.join(releaseDir, url);
    if (!existsSync(artifactPath)) throw new Error(`feed references missing notarized DMG: ${url}`);

    const update = await build(artifactPath, 'gzip', `${artifactPath}.blockmap`);
    if (!update || typeof update.sha512 !== 'string' || !Number.isFinite(update.size) || update.size <= 0) {
      throw new Error(`blockmap builder returned invalid metadata for ${url}`);
    }
    entry.sha512 = update.sha512;
    entry.size = update.size;
    if (feed.path === url) feed.sha512 = update.sha512;
  }

  const temporaryPath = `${resolvedFeed}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, dump(feed, { noRefs: true, lineWidth: -1, sortKeys: false }), 'utf-8');
  renameSync(temporaryPath, resolvedFeed);
  return { count: dmgEntries.length, feed };
}

function printUsage() {
  console.log('Usage: node scripts/refresh-notarized-dmg-metadata.mjs --feed apps/desktop/release/latest-mac.yml');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      process.exit(0);
    }
    if (!args.feed) throw new Error('--feed is required');
    const result = await refreshNotarizedDmgMetadata({ feedPath: args.feed });
    console.log(`Refreshed ${result.count} notarized DMG updater entr${result.count === 1 ? 'y' : 'ies'}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exit(1);
  }
}
