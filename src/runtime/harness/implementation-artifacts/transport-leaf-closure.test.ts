/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/implementation-artifacts/transport-leaf-closure.test.ts */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), 'clem-transport-leaf-'));
const TEST_HOME = path.join(TEST_ROOT, 'home');
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_AUTHORITY_SEAL_KEY = '9d'.repeat(32);
mkdirSync(path.join(TEST_HOME, 'state'), { recursive: true });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const transportEntry = path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/transport-entry.ts');
const isolatedEntry = path.join(repoRoot, 'src/runtime/harness/implementation-artifacts/transport-isolated-entry.ts');

const cliConfig = await import('../reviewed-cli-read-config.js');
const cliTransport = await import('../reviewed-cli-read-transport.js');
const localTransport = await import('../reviewed-local-tool-transport.js');
const manifests = await import('../capability-manifest.js');

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
  return {
    bytes: output!.contents,
    source: output!.text,
    inputs: Object.keys(result.metafile?.inputs ?? {}),
  };
}

function assertTransportOnlyClosure(label: string, built: Awaited<ReturnType<typeof bundle>>) {
  const forbiddenInputs = built.inputs.filter((input) => (
    /(?:^|\/)eventlog(?:-|\.)/.test(input)
    || input.includes('/capability-manifest-store.')
    || input.includes('/sqlite-statement-cache.')
    || input.includes('/local-planning-capability.')
    || input.includes('/production-reviewed-cli-read-carrier.')
    || input.includes('/reviewed-local-tool-carrier.')
  ));
  assert.deepEqual(forbiddenInputs, [], `${label} imported host/storage inputs`);
  assert.doesNotMatch(built.source, /better-sqlite3|node-gyp-build/);
  assert.match(built.source, /reviewed CLI execution identity changed before dispatch/);
}

const nonce = randomBytes(6).toString('hex');
const operationId = `read_${nonce}_leaf`;
const argumentName = `query_${nonce}`;
const executable = path.join(TEST_ROOT, `reviewed-${nonce}`);
writeFileSync(executable, [
  `#!${process.execPath}`,
  "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');",
].join('\n'), 'utf8');
chmodSync(executable, 0o700);
const descriptor = await cliConfig.provisionReviewedCliReadDescriptor({
  version: 1,
  descriptorId: `descriptor-${nonce}`,
  operationId,
  displayName: `Transport leaf ${nonce}`,
  description: `Read through the sealed transport leaf ${nonce}`,
  effect: 'read',
  accountId: 'reviewed_cli:host',
  executablePath: executable,
  argvPrefix: ['inspect'],
  arguments: [{
    name: argumentName,
    kind: 'option',
    token: '--query',
    valueType: 'string',
    required: true,
  }],
  limits: {
    timeoutMs: 2_000,
    maxStdoutBytes: 8_192,
    maxStderrBytes: 4_096,
    maxArgumentBytes: 4_096,
  },
});
const cliObservation = cliTransport.observeReviewedCliReadTransport(
  operationId,
  'reviewed_cli:host',
);
assert.ok(cliObservation);
const cliCall = {
  operationId,
  accountId: 'reviewed_cli:host',
  args: { [argumentName]: 'one value; $(never-a-shell)' },
  expected: {
    manifestId: `cap:test:${nonce}`,
    manifestDigest: 'a'.repeat(64),
    providerKind: 'reviewed_cli',
    providerIdentity: descriptor.executableRealpath,
    providerVersion: descriptor.binarySha256,
    operationVersion: cliObservation!.operationVersion,
    definitionFingerprint: cliObservation!.definitionFingerprint,
    invokePortId: `port:reviewed-cli:v1:${cliObservation!.operationVersion}`,
    argumentCompiler: {
      id: cliConfig.REVIEWED_CLI_ARGUMENT_COMPILER_ID,
      version: cliObservation!.operationVersion,
    },
  },
};

const localArgs = {
  bundle_id: `leaf-${nonce}`,
  mode: 'content_addressed' as const,
  files: [{ path: 'index.html', content: `<h1>${nonce}</h1>` }],
};
const localObserved = localTransport.observeReviewedLocalTool('artifact_bundle_save');
assert.ok(localObserved);
const localManifest = localTransport.reviewedLocalCapabilityManifest(localObserved!);
assert.ok(localManifest);
const localCall = {
  operationId: 'artifact_bundle_save',
  accountId: localTransport.REVIEWED_LOCAL_ACCOUNT,
  args: localArgs,
  expected: {
    manifestId: localObserved!.manifestId,
    manifestDigest: manifests.capabilityManifestDigest(localManifest!),
    providerKind: 'local_registry',
    providerIdentity: localTransport.REVIEWED_LOCAL_PROVIDER_IDENTITY,
    providerVersion: localTransport.REVIEWED_LOCAL_PROVIDER_VERSION,
    operationVersion: localTransport.REVIEWED_LOCAL_OPERATION_VERSION,
    definitionFingerprint: localObserved!.definition.envelopeFingerprint,
    invokePortId: localObserved!.invokePortId,
    argumentCompiler: { ...localTransport.REVIEWED_LOCAL_ARGUMENT_COMPILER },
  },
};

test.after(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

test('both sealed transport metafiles exclude the host event-log and native DB graph', async () => {
  const [production, isolated] = await Promise.all([
    bundle(transportEntry),
    bundle(isolatedEntry),
  ]);
  assertTransportOnlyClosure('transport', production);
  assertTransportOnlyClosure('transportIsolated', isolated);
  assert.match(production.source, /reviewed local execution identity changed before dispatch/);
  assert.doesNotMatch(isolated.source, /reviewed local execution identity changed before dispatch/);
  assert.ok(production.bytes.byteLength < 300_000, `unexpected transport closure: ${production.bytes.byteLength}`);
  assert.ok(isolated.bytes.byteLength < 100_000, `unexpected isolated closure: ${isolated.bytes.byteLength}`);
});

function runPackagedChild(input: {
  artifact: string;
  source: string;
  home: string;
}): ReturnType<typeof spawnSync> {
  const childFile = path.join(TEST_ROOT, `child-${randomBytes(4).toString('hex')}.cjs`);
  writeFileSync(childFile, input.source, 'utf8');
  return spawnSync(process.execPath, [childFile], {
    cwd: TEST_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      CLEMENTINE_HOME: input.home,
      CLEMMY_TEST_ISOLATED_HOME: '1',
      CLEMMY_AUTHORITY_SEAL_KEY: '9d'.repeat(32),
      NODE_PATH: path.join(repoRoot, 'node_modules'),
      TRANSPORT_ARTIFACT: input.artifact,
    },
  });
}

test('a disposable packaged production child executes and observes reviewed CLI/local leaves without DB loading', async () => {
  const built = await bundle(transportEntry);
  const artifact = path.join(TEST_ROOT, 'transport.cjs');
  writeFileSync(artifact, built.bytes);
  const child = runPackagedChild({
    artifact,
    home: TEST_HOME,
    source: `
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'better-sqlite3' || String(request).includes('/eventlog')) {
          throw new Error('forbidden transport dependency loaded: ' + request);
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      const transport = require(process.env.TRANSPORT_ARTIFACT);
      const cliCall = ${JSON.stringify(cliCall)};
      const localCall = ${JSON.stringify(localCall)};
      (async () => {
        const cliObserved = await transport.refreshAttestedTransportObservation({
          operationId: cliCall.operationId,
          accountId: cliCall.accountId,
        });
        const cli = await transport.executeAttestedTransport(cliCall);
        const localObserved = await transport.refreshAttestedTransportObservation({
          operationId: localCall.operationId,
          accountId: localCall.accountId,
        });
        const local = await transport.executeAttestedTransport(localCall);
        const reconciled = await transport.reconcileAttestedTransport({
          operationId: localCall.operationId,
          accountId: localCall.accountId,
          artifactId: local.artifactId,
        });
        process.stdout.write(JSON.stringify({ cliObserved, cli, localObserved, local, reconciled }));
      })().catch((error) => {
        process.stderr.write(error?.stack || String(error));
        process.exit(9);
      });
    `,
  });
  assert.equal(child.status, 0, `${child.status} ${child.stderr} ${child.stdout}`);
  const result = JSON.parse(child.stdout) as {
    cliObserved: { definitionFingerprint: string };
    cli: { status: string; argv: string[] };
    localObserved: { definitionFingerprint: string };
    local: { artifactId: string; created: boolean; revisionDigest: string };
    reconciled: { exists: boolean; artifactId: string; contentDigest: string };
  };
  assert.equal(result.cliObserved.definitionFingerprint, cliCall.expected.definitionFingerprint);
  assert.equal(result.cli.status, 'exited');
  assert.deepEqual(result.cli.argv, ['inspect', '--query', 'one value; $(never-a-shell)']);
  assert.equal(result.localObserved.definitionFingerprint, localCall.expected.definitionFingerprint);
  assert.equal(result.local.created, true);
  assert.deepEqual(result.reconciled, {
    exists: true,
    artifactId: result.local.artifactId,
    handle: path.join(TEST_HOME, 'files', 'bundles', localArgs.bundle_id, result.local.revisionDigest),
    contentDigest: result.local.revisionDigest,
    receipt: path.join(
      TEST_HOME,
      'files',
      'bundles',
      localArgs.bundle_id,
      result.local.revisionDigest,
      '.clementine-bundle.json',
    ),
  });
});

test('the packaged Composio leaf JIT-revalidates the sealed account and fails before the business body on mismatch', async () => {
  const built = await bundle(transportEntry);
  const packageRoot = path.join(TEST_ROOT, `clemmy-composio-${nonce}`);
  const artifact = path.join(packageRoot, 'runtime', 'transport.cjs');
  const clientFile = path.join(packageRoot, 'dist', 'integrations', 'composio', 'client.js');
  mkdirSync(path.dirname(artifact), { recursive: true });
  mkdirSync(path.dirname(clientFile), { recursive: true });
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'clemmy' }));
  writeFileSync(artifact, built.bytes);
  writeFileSync(clientFile, `
    const events = [];
    let current = null;
    module.exports = {
      events,
      isComposioEnabled: () => true,
      peekConnectedToolkits: () => [],
      async revalidateSelectedComposioConnections(selections) {
        events.push({ kind: 'connection', selections });
        const selected = selections[0];
        if (selected?.identifier !== 'SLACK_FETCH_CONVERSATION_HISTORY'
          || selected?.connectionId !== 'ca-current') {
          current = null;
          return {
            ok: false,
            identifier: selected?.identifier || '',
            reason: 'missing_or_changed',
          };
        }
        current = selected.connectionId;
        return { ok: true };
      },
      prepareComposioOneShotDispatch(input) {
        events.push({ kind: 'prepare', input });
        if (current !== input.connectedAccountId) throw new Error('connection was not JIT-revalidated');
        return { input };
      },
      async executePreparedComposioTool(prepared) {
        events.push({ kind: 'business', prepared });
        return { ok: true, accountId: prepared.input.connectedAccountId };
      },
    };
  `, 'utf8');
  const child = runPackagedChild({
    artifact,
    home: TEST_HOME,
    source: `
      for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) delete process.env[key];
      const transport = require(process.env.TRANSPORT_ARTIFACT);
      const client = require(${JSON.stringify(clientFile)});
      const base = {
        operationId: 'SLACK_FETCH_CONVERSATION_HISTORY',
        args: { channel: 'C123' },
        expected: { providerKind: 'composio', operationVersion: '20260831_01' },
      };
      (async () => {
        await transport.prepareAttestedComposioDispatch({
          operationId: base.operationId,
          accountId: 'ca-current',
        });
        const result = await transport.executeAttestedTransport({ ...base, accountId: 'ca-current' });
        let refusal = '';
        try {
          await transport.prepareAttestedComposioDispatch({
            operationId: base.operationId,
            accountId: 'ca-changed',
          });
        } catch (error) {
          refusal = error?.message || String(error);
        }
        process.stdout.write(JSON.stringify({ result, refusal, events: client.events }));
      })().catch((error) => {
        process.stderr.write(error?.stack || String(error));
        process.exit(9);
      });
    `,
  });
  assert.equal(child.status, 0, `${child.status} ${child.stderr} ${child.stdout}`);
  const result = JSON.parse(child.stdout) as {
    result: { ok: boolean; accountId: string };
    refusal: string;
    events: Array<{ kind: string; selections?: Array<{ identifier: string; connectionId: string }> }>;
  };
  assert.deepEqual(result.result, { ok: true, accountId: 'ca-current' });
  assert.match(result.refusal, /sealed connected account ca-changed is missing_or_changed/);
  assert.deepEqual(result.events.map((event) => event.kind), [
    'connection',
    'prepare',
    'business',
    'connection',
  ]);
  assert.deepEqual(result.events[0]?.selections, [{
    identifier: 'SLACK_FETCH_CONVERSATION_HISTORY',
    connectionId: 'ca-current',
  }]);
  assert.deepEqual(result.events[3]?.selections, [{
    identifier: 'SLACK_FETCH_CONVERSATION_HISTORY',
    connectionId: 'ca-changed',
  }]);
});

test('the packaged isolated transport requires exact registered Composio preparation and keeps its bound handlers', async () => {
  const built = await bundle(isolatedEntry);
  const artifact = path.join(TEST_ROOT, 'transport-isolated.cjs');
  writeFileSync(artifact, built.bytes);
  const child = runPackagedChild({
    artifact,
    home: TEST_HOME,
    source: `
      const Module = require('node:module');
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'better-sqlite3' || String(request).includes('/eventlog')) {
          throw new Error('forbidden transport dependency loaded: ' + request);
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      const transport = require(process.env.TRANSPORT_ARTIFACT);
      const cliCall = ${JSON.stringify(cliCall)};
      let handlerCalls = 0;
      transport.bindIsolatedTransportHandler(async (call) => {
        handlerCalls += 1;
        return { handled: call.operationId };
      });
      (async () => {
        transport.registerIsolatedObservation({
          operationId: 'fixture_generic_read',
          accountId: 'fixture:account',
          definitionFingerprint: 'f'.repeat(64),
          providerVersion: '2026-08-31',
          operationVersion: '1',
          observedAt: Date.now(),
        });
        await transport.prepareAttestedComposioDispatch({
          operationId: 'fixture_generic_read',
          accountId: 'fixture:account',
        });
        let preparationRefusal = '';
        try {
          await transport.prepareAttestedComposioDispatch({
            operationId: 'fixture_generic_read',
            accountId: 'fixture:changed',
          });
        } catch (error) {
          preparationRefusal = error?.message || String(error);
        }
        const cli = await transport.executeAttestedTransport(cliCall);
        const generic = await transport.executeAttestedTransport({
          operationId: 'fixture_generic_read',
          accountId: 'fixture:account',
          args: { query: 'x' },
        });
        process.stdout.write(JSON.stringify({
          cli,
          generic,
          handlerCalls,
          preparationRefusal,
          calls: transport.isolatedTransportCalls(),
        }));
      })().catch((error) => {
        process.stderr.write(error?.stack || String(error));
        process.exit(9);
      });
    `,
  });
  assert.equal(child.status, 0, `${child.status} ${child.stderr} ${child.stdout}`);
  const result = JSON.parse(child.stdout) as {
    cli: { status: string };
    generic: { handled: string };
    handlerCalls: number;
    preparationRefusal: string;
    calls: Array<{ operationId: string }>;
  };
  assert.equal(result.cli.status, 'exited');
  assert.deepEqual(result.generic, { handled: 'fixture_generic_read' });
  assert.equal(result.handlerCalls, 1);
  assert.match(result.preparationRefusal, /sealed connected account fixture:changed is missing_or_changed/);
  assert.deepEqual(result.calls.map((call) => call.operationId), [operationId, 'fixture_generic_read']);
});
