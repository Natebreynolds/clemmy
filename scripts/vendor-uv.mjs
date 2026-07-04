#!/usr/bin/env node
// Vendor the `uv` runtime for every supported platform into vendor/uv/<target>/.
// Runs at prepack so the published npm tarball is self-contained (no
// "install Python/uv first" prerequisite). markitdown itself is still
// fetched by `uvx` on first conversion and cached under BASE_DIR/runtime.
//
// Usage:
//   node scripts/vendor-uv.mjs            # skip targets already present
//   node scripts/vendor-uv.mjs --force    # re-download everything
//
// The pinned version is read from src/runtime/markitdown.ts (UV_VERSION) so
// there is a single source of truth. Bump it there, then run with --force.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'uv');
const FORCE = process.argv.includes('--force');

const TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
];

function readPinnedVersion() {
  const src = readFileSync(path.join(ROOT, 'src', 'runtime', 'markitdown.ts'), 'utf-8');
  const m = src.match(/UV_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error('Could not read UV_VERSION from src/runtime/markitdown.ts');
  return m[1];
}

const VERSION = process.env.UV_VERSION || readPinnedVersion();

function assetName(target) {
  return target.endsWith('pc-windows-msvc') ? `uv-${target}.zip` : `uv-${target}.tar.gz`;
}

function releaseUrl(file) {
  return `https://github.com/astral-sh/uv/releases/download/${VERSION}/${file}`;
}

async function download(url, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      // 5xx / 429 are transient (GitHub release-CDN 504s have blocked releases);
      // retry with backoff. 4xx (except 429) are real → fail fast.
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) throw new Error(`${res.status} ${res.statusText} for ${url}`);
        throw Object.assign(new Error(`${res.status} ${res.statusText} for ${url}`), { fatal: true });
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (err && err.fatal) throw err;
      if (i < attempts) {
        const waitMs = Math.min(15000, 1000 * 2 ** (i - 1)); // 1s,2s,4s,8s,15s
        console.log(`  ↻ retry ${i}/${attempts - 1} after ${waitMs}ms — ${String(err.message || err).slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function parseExpectedHash(text) {
  // .sha256 files are either a bare hash or "<hash>  <filename>".
  const token = text.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error(`Unexpected .sha256 contents: ${text.slice(0, 80)}`);
  return token.toLowerCase();
}

function extractBinary(archivePath, target, destDir) {
  const isWindows = target.endsWith('pc-windows-msvc');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'uv-extract-'));
  try {
    if (isWindows) {
      const r = spawnSync('unzip', ['-o', archivePath, '-d', tmp], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('unzip failed (needed to extract the windows uv.zip)');
      const exe = findFile(tmp, 'uv.exe');
      if (!exe) throw new Error('uv.exe not found in archive');
      moveExtractedFile(exe, path.join(destDir, 'uv.exe'));
    } else {
      const r = spawnSync('tar', ['-xzf', archivePath, '-C', tmp], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('tar failed');
      const bin = findFile(tmp, 'uv');
      if (!bin) throw new Error('uv binary not found in archive');
      moveExtractedFile(bin, path.join(destDir, 'uv'));
      spawnSync('chmod', ['+x', path.join(destDir, 'uv')]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function moveExtractedFile(src, dest) {
  rmSync(dest, { force: true });
  try {
    renameSync(src, dest);
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
    copyFileSync(src, dest);
    rmSync(src, { force: true });
  }
}

function findFile(dir, name) {
  // uv archives are one level deep: uv-<target>/uv[.exe]
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === name) return full;
    }
  }
  return null;
}

async function vendorTarget(target) {
  const destDir = path.join(VENDOR_DIR, target);
  const binName = target.endsWith('pc-windows-msvc') ? 'uv.exe' : 'uv';
  const finalPath = path.join(destDir, binName);
  if (existsSync(finalPath) && !FORCE) {
    console.log(`✓ ${target} (already vendored)`);
    return;
  }
  mkdirSync(destDir, { recursive: true });

  const file = assetName(target);
  console.log(`↓ ${target} — downloading uv ${VERSION}…`);
  const [archive, shaText] = await Promise.all([download(releaseUrl(file)), download(releaseUrl(`${file}.sha256`))]);

  const expected = parseExpectedHash(shaText.toString('utf-8'));
  const actual = sha256(archive);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  }

  const tmpArchive = path.join(destDir, file);
  writeFileSync(tmpArchive, archive);
  try {
    extractBinary(tmpArchive, target, destDir);
  } finally {
    rmSync(tmpArchive, { force: true });
  }
  console.log(`✓ ${target} — verified + extracted`);
}

async function main() {
  console.log(`Vendoring uv ${VERSION} for ${TARGETS.length} targets → ${path.relative(ROOT, VENDOR_DIR)}`);
  for (const target of TARGETS) {
    await vendorTarget(target);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(`vendor-uv failed: ${err.message}`);
  process.exit(1);
});
