#!/usr/bin/env node
/** Build every whisper.cpp target referenced by this host's desktop package. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_SCRIPT = path.join(ROOT, 'scripts', 'vendor-whispercpp.mjs');

export function desktopTargets(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') {
    return ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
  }
  if (platform === 'win32' && arch === 'x64') {
    return ['x86_64-pc-windows-msvc'];
  }
  if (platform === 'linux') {
    // The daemon reports local transcription unavailable on Linux. Keep the
    // generic AppImage/package:dist path working without pretending that a
    // whisper.cpp runtime was bundled for an unsupported platform.
    return [];
  }
  throw new Error(`Desktop whisper.cpp vendoring is unsupported on ${platform}/${arch}.`);
}

function main() {
  try {
    const passthrough = [];
    if (process.argv.includes('--force')) passthrough.push('--force');
    if (process.argv.includes('--adopt-validated-cache')) passthrough.push('--adopt-validated-cache');
    const targets = desktopTargets();
    if (targets.length === 0) {
      console.log(`ℹ Local whisper.cpp transcription is not packaged on ${process.platform}/${process.arch}; skipping vendoring.`);
    }
    for (const target of targets) {
      const result = spawnSync(process.execPath, [VENDOR_SCRIPT, '--target', target, ...passthrough], {
        cwd: ROOT,
        env: process.env,
        shell: false,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`whisper.cpp vendoring failed for ${target} (exit ${result.status}).`);
    }
  } catch (error) {
    console.error(`vendor-whispercpp-desktop failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
