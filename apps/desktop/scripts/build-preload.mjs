#!/usr/bin/env node
/**
 * Bundles the preload scripts into single self-contained CJS files.
 *
 * The dashboard and live windows run with `sandbox: true`, and a sandboxed
 * Electron preload gets only a shimmed require() that can resolve 'electron'
 * and a handful of builtins — it can never load a sibling file. The previous
 * bare-tsc emit left `require("./workspace-view-url.cjs")` in the shipped
 * preload, which threw on load and silently killed the entire window.clemmy
 * bridge (updater UI, notch settings, meeting capture) in the packaged app —
 * live incident, v3.0.x–v3.1.0. Bundling removes the class: any import a
 * future preload picks up is inlined instead of becoming a runtime require.
 *
 * Fail-closed: after bundling, any require() of something other than
 * 'electron' aborts the build rather than shipping a dead bridge.
 */
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const name of ['preload', 'live-preload']) {
  const outfile = path.join(desktopDir, 'dist', `${name}.cjs`);
  buildSync({
    entryPoints: [path.join(desktopDir, 'src', `${name}.ts`)],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    external: ['electron'],
    outfile,
    logLevel: 'error',
  });

  const built = readFileSync(outfile, 'utf-8');
  const foreign = [...built.matchAll(/\brequire\((["'])([^"']+)\1\)/g)]
    .map((m) => m[2])
    .filter((specifier) => specifier !== 'electron');
  if (foreign.length > 0) {
    throw new Error(
      `${name}.cjs requires ${foreign.join(', ')} — a sandboxed preload can only require 'electron'. `
      + 'Inline or bundle the dependency instead.',
    );
  }
}
