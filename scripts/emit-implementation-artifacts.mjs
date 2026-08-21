#!/usr/bin/env node
/**
 * Bundle executable invoke/reconcile/observer/transport artifacts and write
 * the build-produced implementation manifest. Files are digest-addressed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutDir = path.join(
  repoRoot,
  'src/runtime/harness/implementation-artifacts/emitted',
);

const ENTRIES = {
  invoke: path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/invoke-entry.ts'),
  reconcile: path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/reconcile-entry.ts'),
  observer: path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/observer-entry.ts'),
  transport: path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/transport-entry.ts'),
  transportIsolated: path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/transport-isolated-entry.ts'),
};

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function emitImplementationArtifacts(outDir = defaultOutDir) {
  mkdirSync(outDir, { recursive: true });
  const artifacts = {};
  for (const kind of Object.keys(ENTRIES)) {
    const tempOut = path.join(outDir, `${kind}.cjs`);
    const result = await esbuild.build({
      absWorkingDir: repoRoot,
      entryPoints: [ENTRIES[kind]],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: tempOut,
      packages: 'external',
      write: true,
      metafile: true,
      legalComments: 'none',
      logLevel: 'silent',
      banner: {
        js: 'var import_meta_url = require("node:url").pathToFileURL(__filename).href;',
      },
      define: {
        'import.meta.url': 'import_meta_url',
      },
    });
    const inputs = {};
    for (const [file, meta] of Object.entries(result.metafile?.inputs ?? {})) {
      if (file.endsWith('.ts') || file.endsWith('.js')) {
        inputs[file] = { bytes: meta.bytes };
      }
    }
    const bytes = readFileSync(tempOut);
    const sha256 = sha256Bytes(bytes);
    const file = `${kind}-${sha256}.cjs`;
    renameSync(tempOut, path.join(outDir, file));
    artifacts[kind] = { file, sha256, inputs };
  }
  const body = { version: 3, artifacts };
  const manifestDigest = sha256Bytes(JSON.stringify({
    version: 3,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([kind, entry]) => [kind, { file: entry.file, sha256: entry.sha256 }]),
    ),
  }));
  const manifest = { ...body, manifestDigest };
  writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Only the referenced generation may remain. A stale digest file left beside
  // a manifest is a second executable identity in the shipped set.
  const referenced = new Set([
    ...Object.values(artifacts).map((entry) => entry.file),
    'manifest.json',
    'build-stamp.json',
  ]);
  for (const name of readdirSync(outDir)) {
    if (!referenced.has(name)) rmSync(path.join(outDir, name), { force: true });
  }
  // An artifact set describes itself. Without a co-located stamp, a set emitted
  // to any root but the workspace one is validated against a stamp describing a
  // different set, so artifact and stamp could never move together.
  writeFileSync(
    path.join(outDir, 'build-stamp.json'),
    `${JSON.stringify({
      implementationManifestDigest: manifestDigest,
      artifacts: Object.fromEntries(
        Object.entries(artifacts).map(([kind, entry]) => [kind, entry.sha256]),
      ),
    }, null, 2)}\n`,
  );
  return manifest;
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultOutDir;
  const extra = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const manifest = await emitImplementationArtifacts(outDir);
  if (extra) {
    await emitImplementationArtifacts(extra);
  }
  process.stdout.write(`${JSON.stringify({
    outDir,
    manifestDigest: manifest.manifestDigest,
    artifacts: Object.fromEntries(
      Object.entries(manifest.artifacts).map(([kind, entry]) => [kind, entry.sha256]),
    ),
  })}\n`);
}
