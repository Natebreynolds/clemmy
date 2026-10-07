import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCredentialPolicy } from './build-credential-policy.mjs';

test('desktop policy bundles canonical helper once with exact CJS module location and no runtime TS dependency', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-policy-bundle-'));
  const sourceRoot = path.join(root, 'src/runtime'); mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'windows-private-filesystem.ts'), "export function observedModuleLocation(){return typeof __filename === 'string' ? __filename : import.meta.url;}");
  writeFileSync(path.join(sourceRoot, 'credential-private-filesystem.ts'), "import {observedModuleLocation} from './windows-private-filesystem.js'; export const location=observedModuleLocation; export const abi=2;");
  try {
    const built = buildCredentialPolicy(root);
    const loaded = createRequire(import.meta.url)(built.outfile);
    assert.equal(loaded.abi, 2); assert.equal(loaded.location(), built.outfile);
    assert.equal(readFileSync(built.outfile, 'utf8').includes("require('./windows-private-filesystem"), false);
    assert.match(built.sha256, /^[0-9a-f]{64}$/);
    const repeated = buildCredentialPolicy(root);
    assert.equal(repeated.sha256, built.sha256, 'same canonical policy creates identical CJS bytes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('foreign configuration import refuses publication and preserves prior qualified bundle bytes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-policy-refusal-'));
  const sourceRoot = path.join(root, 'src/runtime'); mkdirSync(sourceRoot, { recursive: true });
  const source = path.join(sourceRoot, 'credential-private-filesystem.ts');
  writeFileSync(source, 'export const abi=2;');
  try {
    const prior = buildCredentialPolicy(root); const bytes = readFileSync(prior.outfile);
    writeFileSync(path.join(sourceRoot, 'unsafe-config.ts'), 'export const runtimeHome="must-not-be-bundled";');
    writeFileSync(source, "export { runtimeHome } from './unsafe-config.js';");
    assert.throws(() => buildCredentialPolicy(root), /must remain config independent/);
    assert.deepEqual(readFileSync(prior.outfile), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing canonical policy refuses before creating a desktop credential adapter target', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'clem-policy-missing-'));
  try {
    assert.throws(() => buildCredentialPolicy(root), /source is missing/);
    assert.equal(existsSync(path.join(root, 'apps/desktop/dist/credential-private-filesystem.cjs')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
