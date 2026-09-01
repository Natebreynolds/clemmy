/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/implementation-artifacts/invoke-artifact-leaf-closure.test.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * The shipped invoke/reconcile artifacts are digest-addressed leaves: they
 * carry the adapter table and reach everything else — the attested transport
 * and the host's storage carrier — through seams the host binds at load.
 *
 * On 2026-08-31 the invoke artifact silently regained the host/storage graph
 * (16 retained modules / 69 KB / node:* only → 101 modules / 1.17 MB requiring
 * zod, better-sqlite3 and pino) because the adapter table imported the
 * reviewed-local transport and dynamically imported the Workspace carrier,
 * which esbuild inlines. A packaged extract has no node_modules, so the
 * artifact could not load there at all; in dev it executed a SECOND
 * event-log/database module instance inside the artifact. This pin holds the
 * class: no non-builtin require, a bounded retained-module set, and the
 * Workspace commit reaching the artifact only through the bound carrier.
 */
const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clem-invoke-leaf-'));
const TEST_HOME = path.join(TEST_ROOT, 'home');
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const invokeEntry = path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/invoke-entry.ts');
const reconcileEntry = path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/reconcile-entry.ts');

const localTransport = await import('../reviewed-local-tool-transport.js');
const manifests = await import('../capability-manifest.js');

// The exact emitter options (scripts/emit-implementation-artifacts.mjs).
async function bundle(entryPoint: string) {
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
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
  const output = result.outputFiles?.[0];
  assert.ok(output);
  const outputMeta = Object.values(result.metafile?.outputs ?? {})[0];
  assert.ok(outputMeta);
  const retained = Object.entries(outputMeta!.inputs)
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([file]) => file)
    .sort();
  return {
    bytes: output!.contents,
    source: output!.text,
    retained,
    requires: [...new Set(output!.text.match(/require\("[^"]+"\)/g) ?? [])].sort(),
  };
}

function assertLeafClosure(label: string, built: Awaited<ReturnType<typeof bundle>>) {
  const external = built.requires.filter((entry) => !entry.startsWith('require("node:'));
  assert.deepEqual(external, [], `${label} artifact requires non-builtin modules`);
  const forbidden = built.retained.filter((input) => (
    /(?:^|\/)eventlog(?:-|\.)/.test(input)
    || input.includes('/spaces/store.')
    || input.includes('/spaces/workspace-db')
    || input.includes('/spaces/workspace-set-data-carrier.')
    || input.includes('/memory/db.')
    || input.includes('/operational-telemetry.')
    || input.includes('/audit-ledger.')
    || input.includes('/capability-manifest-store.')
    || input.includes('/host-capability-catalog-factory.')
    || input.includes('/shipped-implementation-identity.')
    || input.includes('/production-capability-ports.')
    || input.includes('/reviewed-local-tool-transport.')
    || input.includes('/reviewed-local-tool-carrier.')
    || input.includes('/reviewed-local-storage-carrier.')
    || input.includes('/tools/tool-registry.')
    || input.includes('/schema-normalizer.')
  ));
  assert.deepEqual(forbidden, [], `${label} artifact retained host/storage modules`);
  assert.doesNotMatch(built.source, /better-sqlite3|node-gyp-build/);
  // HEAD (81b7e2f7) retained 16 modules in 69,295 bytes. The host storage
  // seam adds one import-free leaf. Growth beyond this is a new edge into the
  // host graph, not drift.
  assert.ok(built.retained.length <= 24, `${label} retained ${built.retained.length} modules: ${built.retained.join(', ')}`);
  assert.ok(built.bytes.byteLength < 160_000, `${label} closure grew to ${built.bytes.byteLength} bytes`);
  assert.ok(
    built.retained.includes('src/runtime/harness/implementation-artifacts/host-local-write-carrier.ts'),
    `${label} artifact lost the host local-write carrier seam`,
  );
}

test('the shipped invoke and reconcile artifacts are leaves: node builtins only, bounded retained module set', async () => {
  const [invoke, reconcile] = await Promise.all([bundle(invokeEntry), bundle(reconcileEntry)]);
  assertLeafClosure('invoke', invoke);
  assertLeafClosure('reconcile', reconcile);
  assert.match(invoke.source, /reviewed local invoke requires canonical object arguments/);
});

function runPackagedChild(input: { source: string }): ReturnType<typeof spawnSync> {
  const childFile = path.join(TEST_ROOT, `child-${randomBytes(4).toString('hex')}.cjs`);
  writeFileSync(childFile, input.source, 'utf8');
  return spawnSync(process.execPath, [childFile], {
    cwd: TEST_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CLEMENTINE_HOME: TEST_HOME,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      // No NODE_PATH on purpose: a packaged extract has no node_modules, so a
      // single non-builtin require fails the child.
      NODE_PATH: '',
    },
  });
}

const observed = localTransport.observeReviewedLocalTool('space_set_data');
assert.ok(observed);
assert.equal(observed!.execution.adapter, 'workspace_dataset_v1');
const workspaceManifest = localTransport.reviewedLocalCapabilityManifest(observed!);
assert.ok(workspaceManifest);
const workspaceArgs = {
  slug: 'leaf-dashboard',
  source_id: 'dashboard',
  data_json: JSON.stringify({ rows: [{ id: 'opp-1' }] }),
};
const bundleObserved = localTransport.observeReviewedLocalTool('artifact_bundle_save');
assert.ok(bundleObserved);
const bundleManifest = localTransport.reviewedLocalCapabilityManifest(bundleObserved!);
assert.ok(bundleManifest);
const bundleArgs = {
  bundle_id: 'leaf-bundle',
  mode: 'content_addressed',
  files: [{ path: 'index.html', content: '<h1>leaf</h1>' }],
};

test.after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

test('a packaged child without node_modules executes the Workspace commit only through the bound host carrier', async () => {
  const [invoke, reconcile] = await Promise.all([bundle(invokeEntry), bundle(reconcileEntry)]);
  const invokeArtifact = path.join(TEST_ROOT, 'invoke.cjs');
  const reconcileArtifact = path.join(TEST_ROOT, 'reconcile.cjs');
  writeFileSync(invokeArtifact, invoke.bytes);
  writeFileSync(reconcileArtifact, reconcile.bytes);
  const child = runPackagedChild({
    source: `
      const Module = require('node:module');
      const originalLoad = Module._load;
      const loaded = [];
      Module._load = function(request, parent, isMain) {
        const spec = String(request);
        // Bare specifiers only: the two artifact files themselves are loaded
        // by absolute path below; anything else non-builtin is a package.
        if (!spec.startsWith('node:') && !spec.startsWith('/') && !spec.startsWith('.')
          && !require('node:module').builtinModules.includes(spec)) {
          loaded.push(spec);
        }
        if (request === 'better-sqlite3' || request === 'zod' || request === 'pino' || String(request).includes('/eventlog')) {
          throw new Error('forbidden invoke dependency loaded: ' + request);
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      const invoke = require(${JSON.stringify(invokeArtifact)});
      const reconcile = require(${JSON.stringify(reconcileArtifact)});
      const workspaceManifest = ${JSON.stringify(workspaceManifest)};
      const bundleManifest = ${JSON.stringify(bundleManifest)};
      const workspaceArgs = ${JSON.stringify(workspaceArgs)};
      const bundleArgs = ${JSON.stringify(bundleArgs)};
      const workspaceDigest = ${JSON.stringify(manifests.capabilityManifestDigest(workspaceManifest!))};
      const transportCalls = [];
      const transportReconciles = [];
      const transport = {
        digest: 'f'.repeat(64),
        async execute(call) { transportCalls.push(call); return { transport: call.operationId }; },
        observe() { return null; },
        async reconcile(input) { transportReconciles.push(input); return { exists: false }; },
      };
      invoke.bindAttestedTransport(transport);
      reconcile.bindAttestedTransport(transport);
      const carrierCalls = [];
      const carrierReconciles = [];
      const storage = {
        async execute(call) {
          carrierCalls.push(call);
          return { artifactId: 'workspace-dataset:v1:leaf', created: true, contentDigest: 'c'.repeat(64) };
        },
        async reconcile(input) {
          carrierReconciles.push(input);
          return {
            exists: true,
            artifactId: input.artifactId,
            handle: 'leaf-dashboard/data.json#source=dashboard',
            contentDigest: 'c'.repeat(64),
            receipt: 'workspace-observation:leaf',
          };
        },
      };
      const selections = [];
      const carrier = {
        select(input) {
          selections.push(input);
          return input.operationId === 'space_set_data' && input.accountId === 'local_registry:host' ? storage : null;
        },
      };
      function binding(manifest, args) {
        return {
          capabilityId: manifest.manifestId,
          toolName: manifest.operationId,
          schemaVersion: manifest.operationVersion,
          schemaDigest: manifest.definitionFingerprint,
          args,
          account: manifest.accountId,
          effect: manifest.effect,
          providerKind: manifest.providerKind,
        };
      }
      (async () => {
        const unboundWorkspace = await invoke.invokeForSealedManifest(workspaceManifest)({
          nodeId: 'refresh', role: 'update', payload: workspaceArgs,
          identity: { sessionId: 'workflow:leaf', sourceUserSeq: 1, acceptedTaskId: 'leaf' },
          binding: binding(workspaceManifest, workspaceArgs),
        });
        invoke.bindHostLocalWriteCarrier(carrier);
        reconcile.bindHostLocalWriteCarrier(carrier);
        const workspace = await invoke.invokeForSealedManifest(workspaceManifest)({
          nodeId: 'refresh', role: 'update', payload: workspaceArgs,
          identity: { sessionId: 'workflow:leaf', sourceUserSeq: 1, acceptedTaskId: 'leaf' },
          binding: binding(workspaceManifest, workspaceArgs),
        });
        const bundle = await invoke.invokeForSealedManifest(bundleManifest)({
          nodeId: 'build', role: 'update', payload: bundleArgs,
          identity: { sessionId: 'workflow:leaf', sourceUserSeq: 1, acceptedTaskId: 'leaf' },
          binding: binding(bundleManifest, bundleArgs),
        });
        const reconciled = await reconcile.reconcileForSealedManifest(workspaceManifest)({
          artifactId: 'workspace-dataset:v1:leaf', intendedDigest: 'c'.repeat(64),
        });
        const digestMismatch = await reconcile.reconcileForSealedManifest(workspaceManifest)({
          artifactId: 'workspace-dataset:v1:leaf', intendedDigest: 'd'.repeat(64),
        });
        const bundleReconciled = await reconcile.reconcileForSealedManifest(bundleManifest)({
          artifactId: 'bundle:leaf', intendedDigest: 'c'.repeat(64),
        });
        process.stdout.write(JSON.stringify({
          loaded, unboundWorkspace, workspace, bundle, reconciled, digestMismatch, bundleReconciled,
          transportCalls, transportReconciles, carrierCalls, carrierReconciles, selections,
          workspaceDigest,
        }));
      })().catch((error) => {
        process.stderr.write(error?.stack || String(error));
        process.exit(9);
      });
    `,
  });
  assert.equal(child.status, 0, `${child.status} ${child.stderr} ${child.stdout}`);
  const result = JSON.parse(child.stdout) as {
    loaded: string[];
    unboundWorkspace: { transport: string };
    workspace: { artifactId: string; created: boolean };
    bundle: { transport: string };
    reconciled: { exists: boolean; id?: string; contentDigest?: string; receipt?: string };
    digestMismatch: { exists: boolean };
    bundleReconciled: { exists: boolean };
    transportCalls: Array<{ operationId: string; accountId: string; expected?: { manifestDigest: string; providerKind: string } }>;
    transportReconciles: Array<{ operationId: string; artifactId: string }>;
    carrierCalls: Array<{ operationId: string; accountId: string; args: unknown; expected?: { manifestDigest: string; manifestId: string; invokePortId: string } }>;
    carrierReconciles: Array<{ operationId: string; artifactId: string; accountId: string; expected?: { manifestDigest: string } }>;
    selections: Array<{ operationId: string; accountId: string }>;
    workspaceDigest: string;
  };
  // Nothing outside the Node builtins was loaded in the packaged child.
  assert.deepEqual(result.loaded, []);
  // Without a bound host carrier the reviewed write goes to the attested
  // transport exactly as at HEAD — the artifact never reaches for storage.
  assert.deepEqual(result.unboundWorkspace, { transport: 'space_set_data' });
  // With the host carrier bound, the Workspace commit crosses through it with
  // the sealed expectation, and the file-system adapter still uses the
  // transport: selection happens on the host side, by operation identity.
  assert.deepEqual(result.workspace, { artifactId: 'workspace-dataset:v1:leaf', created: true, contentDigest: 'c'.repeat(64) });
  assert.equal(result.carrierCalls.length, 1);
  assert.equal(result.carrierCalls[0]!.operationId, 'space_set_data');
  assert.equal(result.carrierCalls[0]!.accountId, 'local_registry:host');
  assert.deepEqual(result.carrierCalls[0]!.args, workspaceArgs);
  assert.equal(result.carrierCalls[0]!.expected?.manifestDigest, result.workspaceDigest);
  assert.equal(result.carrierCalls[0]!.expected?.manifestId, workspaceManifest!.manifestId);
  assert.equal(result.carrierCalls[0]!.expected?.invokePortId, workspaceManifest!.invokePortId);
  assert.deepEqual(result.bundle, { transport: 'artifact_bundle_save' });
  assert.deepEqual(
    result.transportCalls.map((call) => [call.operationId, call.expected?.providerKind]),
    [['space_set_data', 'local_registry'], ['artifact_bundle_save', 'local_registry']],
  );
  assert.deepEqual(result.selections.map((entry) => entry.operationId), [
    'space_set_data', 'artifact_bundle_save', 'space_set_data', 'space_set_data', 'artifact_bundle_save',
  ]);
  // Reconcile mirrors the invoke boundary and keeps the exact-content bar.
  assert.deepEqual(result.reconciled, {
    exists: true,
    id: 'workspace-dataset:v1:leaf',
    handle: 'leaf-dashboard/data.json#source=dashboard',
    receipt: 'workspace-observation:leaf',
    contentDigest: 'c'.repeat(64),
  });
  assert.equal(result.carrierReconciles.length, 2);
  assert.equal(result.carrierReconciles[0]!.expected?.manifestDigest, result.workspaceDigest);
  assert.deepEqual(result.digestMismatch, { exists: false });
  assert.deepEqual(result.bundleReconciled, { exists: false });
  assert.deepEqual(result.transportReconciles.map((entry) => entry.operationId), ['artifact_bundle_save']);
});
