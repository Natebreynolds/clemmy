import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-frozen-work-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-frozen-work\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const authority = await import('./accepted-task-authority.js');
const contracts = await import('./expected-work-contract.js');
const surface = await import('./frozen-work-surface.js');
const toolChoice = await import('../../memory/tool-choice-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function accept(text: string) {
  const session = eventlog.createSession({ kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const graphEvent = shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  assert.ok(graphEvent);
  assert.equal(authority.armAcceptedTaskAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status, 'armed');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function collectContract() {
  const task = accept('Find the top 5 widgets based on ratings and add them to a new workbook for me.');
  const fixed = contracts.freezeDeterministicExpectedWorkContract(task);
  assert.equal(fixed.status, 'fixed');
  return {
    ...task,
    contract: fixed.status === 'fixed' ? fixed.contract : undefined!,
  };
}

test('frozen surface names the host-owned requirement ids and does not invent a proposal', () => {
  const { contract } = collectContract();
  const authorityText = surface.formatFrozenWorkAuthority(contract);
  assert.match(authorityText, /already froze/);
  assert.match(authorityText, /proposal:null/);
  for (const operation of contract.operations) {
    assert.match(authorityText, new RegExp(`- ${operation.id}:`));
  }
  assert.doesNotMatch(authorityText, /write_per_record/);
});

test('a unique generic create descriptor binds only the accepted destination family', () => {
  const { contract } = collectContract();
  const write = contract.operations.find((operation) => operation.effect !== 'read');
  assert.ok(write);
  const destinationFamily = surface.frozenCreateDestinationFamily(contract);
  assert.equal(destinationFamily, 'workbook');
  const descriptor = (
    identifier: string,
    bindingIdentity: string,
    family: string,
  ): surface.FrozenCatalogBindingDescriptorV1 => ({
    identifier,
    bindingIdentity,
    effect: 'external_write',
    destinationFamily: family,
    destinationPosture: 'create_new',
  });

  const unique = surface.resolveFrozenNodeBindings({
    contract,
    destinationFamily,
    catalogDescriptors: [
      descriptor('RANDOM_TABULAR_CREATE_41', 'manifest:a', 'workbook'),
      descriptor('RANDOM_CHANNEL_CREATE_73', 'manifest:b', 'channel'),
    ],
  });
  assert.deepEqual(unique, [{
    requirementId: write.id,
    identifier: 'RANDOM_TABULAR_CREATE_41',
    source: 'catalog_semantic',
  }]);

  assert.equal(surface.uniqueCatalogCreateBinding([
    descriptor('RANDOM_CHANNEL_CREATE_73', 'manifest:b', 'channel'),
  ], destinationFamily), null, 'a sole wrong-family create must not bind');
  for (const candidates of [
    [descriptor('RANDOM_TABULAR_CREATE_41', 'manifest:a', 'workbook'), descriptor('RANDOM_TABULAR_CREATE_42', 'manifest:c', 'workbook')],
    [descriptor('RANDOM_TABULAR_CREATE_42', 'manifest:c', 'workbook'), descriptor('RANDOM_TABULAR_CREATE_41', 'manifest:a', 'workbook')],
  ]) {
    assert.equal(
      surface.uniqueCatalogCreateBinding(candidates, destinationFamily),
      null,
      'two matching identities must abstain in every catalog order',
    );
  }
});

test('an exact structural pin outranks the catalog and never uses user prose', () => {
  const { contract } = collectContract();
  const write = contract.operations.find((operation) => operation.effect !== 'read');
  assert.ok(write);
  toolChoice.rememberToolChoice({
    intent: surface.FROZEN_NODE_WRITE_INTENT,
    choice: {
      kind: 'composio',
      identifier: 'GOOGLESHEETS_SHEET_FROM_JSON',
    },
  });
  toolChoice.updateToolChoiceOutcome(surface.FROZEN_NODE_WRITE_INTENT, 'success');
  toolChoice.updateToolChoiceOutcome(surface.FROZEN_NODE_WRITE_INTENT, 'success');
  const bindings = surface.resolveFrozenNodeBindings({
    contract,
    catalogIdentifiers: ['GOOGLESHEETS_SHEET_FROM_JSON'],
  });
  assert.deepEqual(bindings, [{
    requirementId: write.id,
    identifier: 'GOOGLESHEETS_SHEET_FROM_JSON',
    source: 'memory_pin',
  }]);
});

test('an exact source-strategy binding owns the read node and its work_call description', () => {
  const { contract } = collectContract();
  const read = contract.operations.find((operation) => operation.effect === 'read');
  assert.ok(read);
  const sourceStrategyBinding = {
    version: 1,
    primary: {
      capabilityId: 'capability:composio:APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET',
      schemaFingerprint: 'a'.repeat(64),
    },
    equivalentFallbacks: [],
    topology: 'single_aggregate_read_then_single_artifact_write',
    topologyDigest: 'b'.repeat(64),
    destination: { family: 'workbook', posture: 'create_new' },
    effect: 'external_write',
  } as const;
  const bindings = surface.resolveFrozenNodeBindings({
    contract,
    sourceStrategyBinding,
  });
  assert.deepEqual(bindings.filter((binding) => binding.requirementId === read.id), [{
    requirementId: read.id,
    identifier: 'APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET',
    source: 'source_strategy',
  }]);
  const description = surface.formatFrozenWorkCallDescription({
    frozenContract: contract,
    sourceStrategyBinding,
  });
  assert.match(description ?? '', /APIFY_ACT_RUN_SYNC_GET_DATASET_ITEMS_GET/);
});

test('a bound collect-then-construct contract is loadable for the work_call surface', () => {
  const { sessionId, sourceUserSeq, contract } = collectContract();
  assert.deepEqual(surface.loadBoundExpectedWorkContract(sessionId, sourceUserSeq), contract);
  const description = surface.formatFrozenWorkCallDescription({ frozenContract: contract });
  assert.match(description ?? '', /already froze/);
  assert.match(description ?? '', /proposal:null/);
});
