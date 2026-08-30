#!/usr/bin/env node
/**
 * Bundle executable invoke/reconcile/observer/transport artifacts and write
 * the build-produced implementation manifest. Files are digest-addressed.
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
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

function parseJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function canonicalArtifactSet(root, manifest) {
  if (manifest?.version !== 3 || !manifest.artifacts || typeof manifest.artifacts !== 'object') {
    throw new Error('implementation manifest is malformed');
  }
  const artifacts = {};
  for (const kind of Object.keys(ENTRIES).sort()) {
    const entry = manifest.artifacts[kind];
    if (!entry || typeof entry.file !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error(`implementation manifest ${kind} entry is malformed`);
    }
    const bytes = readFileSync(path.join(root, entry.file));
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== entry.sha256) {
      throw new Error(`implementation artifact ${kind} bytes do not match its manifest digest`);
    }
    artifacts[kind] = {
      file: entry.file,
      sha256: entry.sha256,
      inputs: Object.fromEntries(
        Object.entries(entry.inputs ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([file, input]) => [file, { bytes: input?.bytes }]),
      ),
    };
  }
  const stamp = parseJsonFile(path.join(root, 'build-stamp.json'), 'implementation build stamp');
  return {
    version: manifest.version,
    manifestDigest: manifest.manifestDigest,
    artifacts,
    stamp,
    files: readdirSync(root).sort(),
  };
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

/**
 * Rebuild the implementation set outside the workspace and compare executable
 * bytes plus the complete esbuild input inventory. This is deliberately a
 * second build: a timestamp or self-reported manifest cannot prove that a
 * checked-in bundle still represents the source tree about to launch.
 */
export async function assertImplementationArtifactsCurrent(outDir = defaultOutDir) {
  const disposableRoot = mkdtempSync(path.join(os.tmpdir(), 'clem-implementation-artifacts-'));
  try {
    const currentManifest = await emitImplementationArtifacts(disposableRoot);
    const emittedManifest = parseJsonFile(
      path.join(outDir, 'manifest.json'),
      'implementation manifest',
    );
    const current = canonicalArtifactSet(disposableRoot, currentManifest);
    const emitted = canonicalArtifactSet(outDir, emittedManifest);
    if (JSON.stringify(emitted) !== JSON.stringify(current)) {
      throw new Error('implementation artifacts are not current for this source tree');
    }
    return currentManifest;
  } finally {
    rmSync(disposableRoot, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const verifyOnly = process.argv[2] === '--verify-current';
  const outDirArg = verifyOnly ? process.argv[3] : process.argv[2];
  const outDir = outDirArg ? path.resolve(outDirArg) : defaultOutDir;
  const extra = !verifyOnly && process.argv[3] ? path.resolve(process.argv[3]) : null;
  const manifest = verifyOnly
    ? await assertImplementationArtifactsCurrent(outDir)
    : await emitImplementationArtifacts(outDir);
  if (extra) await emitImplementationArtifacts(extra);
  process.stdout.write(`${JSON.stringify({
    outDir,
    ...(verifyOnly ? { verifiedCurrent: true } : {}),
    manifestDigest: manifest.manifestDigest,
    artifacts: Object.fromEntries(
      Object.entries(manifest.artifacts).map(([kind, entry]) => [kind, entry.sha256]),
    ),
  })}\n`);
}
