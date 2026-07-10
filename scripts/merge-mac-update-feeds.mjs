#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dump, load } from 'js-yaml';

function parseArgs(argv) {
  const args = { arm64: '', x64: '', output: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--arm64') args.arm64 = argv[++i] ?? '';
    else if (arg === '--x64') args.x64 = argv[++i] ?? '';
    else if (arg === '--output') args.output = argv[++i] ?? '';
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function parseMacUpdateFeed(text, label = 'feed') {
  const feed = load(text);
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    throw new Error(`${label} must contain a YAML object`);
  }
  if (typeof feed.version !== 'string' || !feed.version.trim()) {
    throw new Error(`${label} is missing version`);
  }
  if (!Array.isArray(feed.files)) {
    throw new Error(`${label} is missing files[]`);
  }
  return feed;
}

function selectOneFile(feed, label, predicate) {
  const matches = feed.files.filter((file) => file && typeof file === 'object' && predicate(String(file.url ?? '')));
  if (matches.length !== 1) {
    throw new Error(`${label} must contain exactly one matching file, found ${matches.length}`);
  }
  const file = matches[0];
  if (typeof file.sha512 !== 'string' || !file.sha512) throw new Error(`${label} file is missing sha512`);
  if (!Number.isFinite(file.size) || file.size <= 0) throw new Error(`${label} file has an invalid size`);
  return { ...file };
}

function isArm64(url) {
  return path.basename(url).includes('-arm64');
}

export function mergeMacUpdateFeeds(arm64Feed, x64Feed) {
  if (arm64Feed.version !== x64Feed.version) {
    throw new Error(`feed versions differ: arm64=${arm64Feed.version} x64=${x64Feed.version}`);
  }

  const arm64Zip = selectOneFile(arm64Feed, 'arm64 ZIP', (url) => isArm64(url) && url.endsWith('.zip'));
  const arm64Dmg = selectOneFile(arm64Feed, 'arm64 DMG', (url) => isArm64(url) && url.endsWith('.dmg'));
  const x64Zip = selectOneFile(x64Feed, 'x64 ZIP', (url) => !isArm64(url) && url.endsWith('.zip'));
  const x64Dmg = selectOneFile(x64Feed, 'x64 DMG', (url) => !isArm64(url) && url.endsWith('.dmg'));

  return {
    ...x64Feed,
    files: [arm64Zip, arm64Dmg, x64Zip, x64Dmg],
    // Legacy updater clients use the top-level path/hash. Keep that fallback on
    // x64 while current MacUpdater selects the matching entry from files[].
    path: x64Zip.url,
    sha512: x64Zip.sha512,
  };
}

export function mergeMacUpdateFeedFiles({ arm64Path, x64Path, outputPath }) {
  const arm64Feed = parseMacUpdateFeed(readFileSync(arm64Path, 'utf-8'), 'arm64 feed');
  const x64Feed = parseMacUpdateFeed(readFileSync(x64Path, 'utf-8'), 'x64 feed');
  const merged = mergeMacUpdateFeeds(arm64Feed, x64Feed);
  const output = dump(merged, { noRefs: true, lineWidth: -1, sortKeys: false });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, output, 'utf-8');
  renameSync(temporaryPath, outputPath);
  return merged;
}

function printUsage() {
  console.log('Usage: node scripts/merge-mac-update-feeds.mjs --arm64 ARM_YML --x64 X64_YML --output latest-mac.yml');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      process.exit(0);
    }
    if (!args.arm64 || !args.x64 || !args.output) throw new Error('--arm64, --x64, and --output are required');
    const merged = mergeMacUpdateFeedFiles({
      arm64Path: path.resolve(args.arm64),
      x64Path: path.resolve(args.x64),
      outputPath: path.resolve(args.output),
    });
    console.log(`Merged ${merged.files.length} updater artifacts for macOS ${merged.version}.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    printUsage();
    process.exit(1);
  }
}
