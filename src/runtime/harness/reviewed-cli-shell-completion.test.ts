/**
 * Run: npx tsx --test src/runtime/harness/reviewed-cli-shell-completion.test.ts
 *
 * A plain shell command that spells a callable reviewed read is completed
 * into that read before the call binds; anything the shell would do beyond
 * running one program with declared options stays with the refusal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-reviewed-cli-completion-'));

const { CLI_CATALOG } = await import('../../integrations/cli-catalog/catalog.js');
const manifests = await import('./capability-manifest.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const { completeCarrierArguments } = await import('./carrier-completion.js');
const { completeReviewedCliShellCarrier, plainCommandWords } = await import('./reviewed-cli-shell-completion.js');

const reviewedEntry = CLI_CATALOG.find((entry) => entry.reviewedRead);
assert.ok(reviewedEntry?.reviewedRead, 'the catalog declares at least one reviewed read');
const reviewedRead = reviewedEntry!.reviewedRead!;
const requiredArgument = reviewedRead.arguments.find((argument) => argument.required && argument.token)!;
const optionalArgument = reviewedRead.arguments.find((argument) => !argument.required && argument.token);
const head = [reviewedEntry!.command, ...reviewedRead.argvPrefix.filter((token) => !token.startsWith('-'))].join(' ');
const prefixFlags = reviewedRead.argvPrefix.filter((token) => token.startsWith('-')).join(' ');
const value = "SELECT Id, Name FROM Account WHERE Name = 'Fixture Co'";
const plainCommand = `${head} ${prefixFlags} ${requiredArgument.token} "${value}"`.replace(/\s+/g, ' ');

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


function shellCarrier(command: string, extra: Record<string, unknown> = {}, requirement: unknown = 'cap:local:run_shell_command:ordinary') {
  return JSON.stringify({
    requirement_id: requirement, name: 'run_shell_command',
    args_json: JSON.stringify({ command, cwd: null, timeout_ms: 60000, ...extra }),
    universe_item_id: null,
  });
}

function withCallable<T>(run: () => T): T {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory([callableReviewedEntry(reviewedRead.operationId)]));
  try { return run(); } finally { catalogs.installHostCapabilityCatalogFactory(null); }
}

test('a plain shell spelling of a callable reviewed read becomes that read, other carrier fields kept', () => withCallable(() => {
  const completed = completeCarrierArguments(shellCarrier(plainCommand), []);
  assert.ok(completed, 'the registered completer claims the shell carrier');
  const outer = JSON.parse(completed!.argumentsJson);
  assert.equal(outer.name, reviewedRead.operationId);
  assert.equal(outer.requirement_id, reviewedRead.operationId);
  assert.equal(outer.universe_item_id, null, 'opaque carrier siblings survive');
  assert.deepEqual(JSON.parse(outer.args_json), { [requiredArgument.name]: value });
  assert.equal(completed!.toolSlug, reviewedRead.operationId);
  assert.match(completed!.changes[0]!, new RegExp(`ran as the reviewed read ${reviewedRead.operationId}`));
}));

test('an optional declared option compiles too', { skip: !optionalArgument }, () => withCallable(() => {
  const completed = completeReviewedCliShellCarrier(shellCarrier(`${plainCommand} ${optionalArgument!.token}=fixture-org`));
  assert.deepEqual(JSON.parse(JSON.parse(completed!.argumentsJson).args_json),
    { [requiredArgument.name]: value, [optionalArgument!.name]: 'fixture-org' });
}));

test('anything beyond one program with declared options stays with the refusal', () => withCallable(() => {
  for (const command of [
    `${plainCommand} | head -5`,
    `${plainCommand} > out.json`,
    `${plainCommand} && echo done`,
    `${head} ${requiredArgument.token} "$(cat q.txt)"`,
    `${head} ${requiredArgument.token} "$QUERY"`,
    `${plainCommand} --undeclared-option x`,
    `${head} ${requiredArgument.token} "unterminated`,
    'ls -la',
  ]) assert.equal(completeReviewedCliShellCarrier(shellCarrier(command)), null, command);
  assert.equal(completeReviewedCliShellCarrier(shellCarrier(plainCommand, { cwd: '/tmp/project' })), null, 'own working directory');
  assert.equal(completeReviewedCliShellCarrier(shellCarrier(plainCommand, {}, 'plan:req:7')), null, 'a plan requirement is never rewritten');
}));

test('no callable reviewed read, no completion', () => {
  catalogs.installHostCapabilityCatalogFactory(null);
  assert.equal(completeReviewedCliShellCarrier(shellCarrier(plainCommand)), null);
});

test('plain command words keep quoted text whole and refuse shell expansion', () => {
  assert.deepEqual(plainCommandWords(`a b "c 'd' e" 'f "g"'`), ['a', 'b', "c 'd' e", 'f "g"']);
  assert.deepEqual(plainCommandWords('a "b \\"c\\""'), ['a', 'b "c"']);
  assert.equal(plainCommandWords('a *.json'), null);
  assert.equal(plainCommandWords('a ~/x'), null);
  assert.equal(plainCommandWords('a "`id`"'), null);
  assert.equal(plainCommandWords('a\nb'), null);
});
