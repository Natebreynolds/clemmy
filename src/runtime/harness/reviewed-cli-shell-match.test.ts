/**
 * Run: npx tsx --test src/runtime/harness/reviewed-cli-shell-match.test.ts
 *
 * A shell command whose head is a reviewed CLI read resolves to the callable
 * operation the host already holds; anything else stays an ad-hoc shell
 * command. The match is generic over the CLI catalog and is only ever
 * `matched` when the host catalog holds a current callable entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-cli-shell-'));

const { CLI_CATALOG } = await import('../../integrations/cli-catalog/catalog.js');
const manifests = await import('./capability-manifest.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const {
  compileReviewedCliArgv,
  renderReviewedCliArgumentMap,
  renderReviewedCliWorkCallExample,
  reviewedCliArgumentMapForOperation,
  reviewedCliShellMatch,
} = await import('./reviewed-cli-shell-match.js');

const reviewedEntry = CLI_CATALOG.find((entry) => entry.reviewedRead);
assert.ok(reviewedEntry?.reviewedRead, 'the catalog declares at least one reviewed read');
const reviewedRead = reviewedEntry!.reviewedRead!;
const requiredArgument = reviewedRead.arguments.find((argument) => argument.required && argument.token);
assert.ok(requiredArgument, 'the reviewed read declares a required option');
const reviewedCommand = [
  reviewedEntry!.command,
  ...reviewedRead.argvPrefix.filter((token) => !token.startsWith('-')),
  requiredArgument!.token,
  '"SELECT Id FROM Account"',
  ...reviewedRead.argvPrefix.filter((token) => token.startsWith('-')),
].join(' ');

function callableReviewedEntry(operationId: string) {
  const marker = 'b';
  const manifest = manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:reviewed_cli:${operationId}`,
    providerKind: 'reviewed_cli',
    operationId,
    providerIdentity: 'reviewed_cli:fixture',
    providerVersion: `provider-${marker}`,
    operationVersion: `operation-${marker}`,
    definitionFingerprint: marker.repeat(64),
    effect: 'read',
    accountId: `reviewed_cli:account:${marker.repeat(8)}`,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'collect_records',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: { issuer: 'host:reviewed-cli-fixture:v1', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source', 'collection'],
    argumentCompiler: { id: 'compile:reviewed_cli:fixture:v1', version: '1' },
    invokePortId: `port:reviewed_cli:fixture:${marker.repeat(8)}`,
  });
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    providerKind: manifest.providerKind,
    sourceSchemaFingerprint: marker.repeat(32),
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ records: [] }),
  };
}

test('a reviewed read typed through the shell matches its callable operation id and argument map', () => {
  const entry = callableReviewedEntry(reviewedRead.operationId);
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  try {
    assert.ok(catalogs.isCurrentCallableCatalogEntry(entry), 'fixture entry is callable');
    const match = reviewedCliShellMatch(reviewedCommand);
    assert.equal(match.status, 'matched');
    if (match.status !== 'matched') return;
    assert.equal(match.operationId, reviewedRead.operationId);
    assert.equal(match.descriptorId, reviewedRead.descriptorId);
    assert.deepEqual(
      match.argumentMap.map((argument) => argument.name),
      reviewedRead.arguments.map((argument) => argument.name),
    );
    const required = match.argumentMap.find((argument) => argument.name === requiredArgument!.name);
    assert.equal(required?.token, requiredArgument!.token);
    assert.equal(required?.required, true);
    // The renders the packet and the refusal use come from the same map.
    assert.match(renderReviewedCliArgumentMap(match.argumentMap),
      new RegExp(`${JSON.stringify(requiredArgument!.name)} ← ${requiredArgument!.token}`));
    const example = renderReviewedCliWorkCallExample(match.operationId, match.argumentMap);
    assert.match(example, new RegExp(`^work_call name=${reviewedRead.operationId} args_json=\\{`));
    assert.match(example, new RegExp(JSON.stringify(requiredArgument!.name)));
    assert.doesNotMatch(example, /run_shell_command/);
  } finally {
    catalogs.installHostCapabilityCatalogFactory(null);
  }
});

test('ordinary shell commands and other subcommands of the same program stay unmatched', () => {
  const entry = callableReviewedEntry(reviewedRead.operationId);
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  try {
    assert.deepEqual(reviewedCliShellMatch('ls -la'), { status: 'unmatched' });
    assert.deepEqual(reviewedCliShellMatch(`${reviewedEntry!.command} org display`), { status: 'unmatched' });
    assert.deepEqual(reviewedCliShellMatch(''), { status: 'unmatched' });
    // A longer head is a different command, not a reviewed read with extras.
    assert.deepEqual(reviewedCliShellMatch(`${reviewedCommand.split(' --')[0]} extra`), { status: 'unmatched' });
  } finally {
    catalogs.installHostCapabilityCatalogFactory(null);
  }
});

test('a head match with no current callable entry is unmatched — the shell stays ad hoc', () => {
  catalogs.installHostCapabilityCatalogFactory(null);
  assert.deepEqual(reviewedCliShellMatch(reviewedCommand), { status: 'unmatched' }, 'no factory installed');
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([]));
  try {
    assert.deepEqual(reviewedCliShellMatch(reviewedCommand), { status: 'unmatched' }, 'empty catalog');
    const other = callableReviewedEntry('some_other_reviewed_read');
    catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([other]));
    assert.deepEqual(reviewedCliShellMatch(reviewedCommand), { status: 'unmatched' }, 'callable entry for a different operation');
  } finally {
    catalogs.installHostCapabilityCatalogFactory(null);
  }
});

test('the argument map is recoverable from the operation id alone, for a refusal that already names it', () => {
  const map = reviewedCliArgumentMapForOperation(reviewedRead.operationId);
  assert.ok(map);
  assert.deepEqual(map!.map((argument) => argument.name), reviewedRead.arguments.map((argument) => argument.name));
  assert.equal(reviewedCliArgumentMapForOperation('not_a_reviewed_read'), null);
});

test('a frozen argv whose head is a reviewed read compiles into that operation and its arguments', () => {
  const entry = CLI_CATALOG.find((candidate) => candidate.reviewedRead);
  assert.ok(entry?.reviewedRead, 'the catalog declares at least one reviewed read');
  const reviewed = entry.reviewedRead;
  const required = reviewed.arguments.find((argument) => argument.required);
  assert.ok(required?.token, 'the reviewed read declares a required option');
  const optional = reviewed.arguments.find((argument) => !argument.required);
  const prefixFlags = reviewed.argvPrefix.filter((token) => token.startsWith('-'));
  const head = [entry.command, ...reviewed.argvPrefix.filter((token) => !token.startsWith('-'))];

  // Prefix flags the carrier adds itself are accepted and dropped; a value
  // with spaces is one argv element, exactly as a Space freezes it.
  const compiled = compileReviewedCliArgv([
    ...head,
    required.token, 'SELECT Id FROM Opportunity LIMIT 5',
    ...prefixFlags,
    ...(optional?.token ? [`${optional.token}=me`] : []),
  ]);
  assert.equal(compiled.status, 'matched');
  if (compiled.status !== 'matched') return;
  assert.equal(compiled.operationId, reviewed.operationId);
  assert.equal(compiled.descriptorId, reviewed.descriptorId);
  assert.equal(compiled.args[required.name], 'SELECT Id FROM Opportunity LIMIT 5');
  if (optional) assert.equal(compiled.args[optional.name], 'me');

  // An option the reviewed read does not declare is refused by name: the
  // operation cannot carry it, so nothing pretends to.
  const stray = compileReviewedCliArgv([...head, required.token, 'SELECT Id FROM Lead', '--result-format', 'csv']);
  assert.equal(stray.status, 'refused');
  if (stray.status === 'refused') {
    assert.equal(stray.operationId, reviewed.operationId);
    assert.match(stray.reason, /option "--result-format" is not part of/);
  }

  const missing = compileReviewedCliArgv([...head, ...prefixFlags]);
  assert.equal(missing.status, 'refused');
  if (missing.status === 'refused') assert.match(missing.reason, new RegExp(`required option "${required.token}" is missing`));

  const noValue = compileReviewedCliArgv([...head, required.token]);
  assert.equal(noValue.status, 'refused');
  if (noValue.status === 'refused') assert.match(noValue.reason, /has no value/);

  const positional = compileReviewedCliArgv([...head, required.token, 'SELECT Id FROM Lead', 'extra']);
  assert.equal(positional.status, 'refused');
  if (positional.status === 'refused') assert.match(positional.reason, /unexpected argument "extra"/);

  // Anything else stays an ad-hoc command line with no executor.
  assert.deepEqual(compileReviewedCliArgv(['node', '-e', 'console.log(1)']), { status: 'unmatched' });
  assert.deepEqual(compileReviewedCliArgv([entry.command, 'org', 'display', '--json']), { status: 'unmatched' });
  assert.deepEqual(compileReviewedCliArgv([]), { status: 'unmatched' });
});

test('a shell call refused as unreachable names the reviewed read it spells', async () => {
  const { buildCallTool } = await import('../../tools/call-tool.js');
  const { withHarnessRunContext, ToolCallsCounter } = await import('./brackets.js');
  const { withToolOutputContext } = await import('./tool-output-context.js');
  const entry = callableReviewedEntry(reviewedRead.operationId);
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([entry]));
  try {
    const callTool = buildCallTool({ reachableBuiltinNames: new Set(['tool_search']) }) as unknown as {
      invoke: (context: unknown, input: string, details: unknown) => Promise<unknown>;
    };
    const sessionId = 'sess-shell-reviewed-read';
    const output = await withHarnessRunContext({ sessionId, counter: new ToolCallsCounter(10) }, () =>
      withToolOutputContext({ sessionId, callId: 'call-shell-reviewed', toolName: 'call_tool' }, () =>
        callTool.invoke({ context: { sessionId } }, JSON.stringify({
          name: 'run_shell_command',
          args_json: JSON.stringify({ command: reviewedCommand }),
        }), { toolCall: { callId: 'call-shell-reviewed' } })));
    const refusal = JSON.parse(String(output)) as { error?: string; detail?: string };
    assert.equal(refusal.error, 'not_reachable');
    assert.match(String(refusal.detail), new RegExp(`reviewed read ${reviewedRead.operationId}`));
    assert.match(String(refusal.detail), new RegExp(`work_call name=${reviewedRead.operationId}`));
  } finally {
    catalogs.installHostCapabilityCatalogFactory(null);
  }
});
