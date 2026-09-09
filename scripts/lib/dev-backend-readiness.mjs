import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Package-only imports used by the attested transport. Keep the source
 * launcher on the same compiled dependency contract as packaged execution. */
export const BACKEND_RUNTIME_DEPENDENCIES = Object.freeze({
  'dist/integrations/composio/client.js': [
    'isComposioEnabled', 'peekConnectedToolkits', 'revalidateSelectedComposioConnections',
    'prepareComposioOneShotDispatch', 'executePreparedComposioTool', 'getExactComposioToolBySlug',
    'composioToolSchemaObservedAt', 'composioToolOperationVersion',
  ],
  'dist/runtime/harness/production-mcp-read-carrier.js': [
    'executeProductionMcpRead', 'refreshProductionMcpReadObservation',
  ],
});

export function captureBackendRuntimeDependencyDigests(repoRoot) {
  return Object.fromEntries(Object.keys(BACKEND_RUNTIME_DEPENDENCIES).map(relativePath => {
    let bytes;
    try { bytes = readFileSync(path.join(repoRoot, relativePath)); }
    catch { throw new Error(`compiled backend dependency missing: ${relativePath}`); }
    if (bytes.length === 0) throw new Error(`compiled backend dependency empty: ${relativePath}`);
    return [relativePath, createHash('sha256').update(bytes).digest('hex')];
  }));
}

/** Probe exactly createRequire(package.json), as the attested CJS leaf does.
 * Import side effects are confined to a throwaway home, with no credentials,
 * caller preloads or provider/file-transfer features. No exported function is
 * invoked and no provider action is performed. */
function probePackagedDependencyImports(repoRoot) {
  const temporaryHome = mkdtempSync(path.join(os.tmpdir(), 'clem-backend-import-'));
  const probe = `
    const { createRequire } = require('node:module');
    const path = require('node:path');
    const req = createRequire(path.join(process.argv[1], 'package.json'));
    const dependencies = JSON.parse(process.argv[2]);
    try {
      for (const [relativePath, exports] of Object.entries(dependencies)) {
        const loaded = req(path.join(process.argv[1], relativePath));
        for (const name of exports) {
          if (typeof loaded[name] !== 'function') throw new Error(relativePath + ' lacks export ' + name);
        }
      }
      process.stdout.write('backend-imports-ready\\n');
      process.exit(0);
    } catch (error) {
      process.stderr.write(String(error?.message ?? error).split('\\n')[0].slice(0, 300) + '\\n');
      process.exit(1);
    }
  `;
  try {
    const env = { ...process.env, CLEMENTINE_HOME: temporaryHome, CLEMMY_TEST_ISOLATED_HOME: '1',
      MCP_AUTO_IMPORT_ENABLED: 'false', EMBEDDINGS_DISABLED: 'true', NODE_OPTIONS: '',
      CLEMMY_COMPOSIO_FILES: 'off' };
    for (const key of Object.keys(env)) {
      if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete env[key];
    }
    const result = spawnSync(process.execPath, ['--input-type=commonjs', '--eval', probe, repoRoot,
      JSON.stringify(BACKEND_RUNTIME_DEPENDENCIES)], { cwd: temporaryHome, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 });
    if (result.status !== 0 || !result.stdout?.includes('backend-imports-ready')) {
      const detail = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
      throw new Error(`compiled backend dependency cannot load: ${String(detail).slice(0, 400)}`);
    }
  } finally { rmSync(temporaryHome, { recursive: true, force: true }); }
}

export function assertBuiltBackendReady({ repoRoot, sourceFingerprint, gitHead, schemaVersion, probeImports = true }) {
  let stamp;
  try { stamp = JSON.parse(readFileSync(path.join(repoRoot, 'dist/runtime/build-stamp.json'), 'utf8')); }
  catch { throw new Error('compiled backend build stamp missing or unreadable; rebuild this candidate'); }
  if (stamp.sourceFingerprint !== sourceFingerprint || stamp.gitSha !== gitHead
    || stamp.expectedSchemaVersion !== schemaVersion) {
    throw new Error('compiled backend build does not match the exact source candidate; rebuild before launch');
  }
  const actual = captureBackendRuntimeDependencyDigests(repoRoot);
  for (const [relativePath, digest] of Object.entries(actual)) {
    if (stamp.backendRuntimeDependencies?.[relativePath] !== digest) {
      throw new Error(`compiled backend dependency is unstamped or changed: ${relativePath}`);
    }
  }
  if (probeImports) probePackagedDependencyImports(repoRoot);
  return { sourceFingerprint, backendRuntimeDependencies: actual };
}
