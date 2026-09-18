/**
 * A PLAN CITES THE OPERATIONS THE WORKFLOW IT AUTHORS WILL RUN.
 *
 * Live 2026-09-18 (`friday-sales-leadership-email`): the published plan bound
 * the authoring call and nothing else —
 *
 *   step create_friday_leadership_email_workflow → cap:local:workflow_create:reversible
 *   step verify_saved_workflow                   → null
 *
 * The Salesforce read and the Outlook send the authored workflow would run were
 * bound nowhere. They existed only as prose inside a step prompt, so at run
 * time the toolkit binder inferred a family, inferred the one the prompt had
 * explicitly forbidden, and validation failed the workflow the same turn had
 * just built.
 *
 * A citation is a FIELD, not a sentence. These pin both halves:
 *   1. an operation an authored step names is reopened from the CURRENT
 *      callable catalog and lands in that step's own tool scope;
 *   2. a step carrying a resolved citation is never re-bound to a guessed
 *      toolkit family.
 *
 * Strictly additive: an authored step that cites nothing keeps exactly the
 * scope it had, because an empty `allowedTools` is the wildcard at run time
 * (`workflowAutoApprovalTools`) and narrowing it from prose would silently
 * restrict steps that work today.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/authored-step-citations.test.ts
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-authored-step-citations-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-authored-step-citations\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const capabilityManifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const {
  bindDiscussedToolkitsIntoSteps,
  citedOperationsForAuthoredStep,
  recordAuthoredStepCitations,
} = await import('./orchestration-tools.js');

/** The one operation the owner's Friday plan named and never bound. */
const OPERATION_ID = 'salesforce_sf_soql_query';

test.before(() => {
  const store = manifestStores.createCapabilityManifestStore([], { durable: true });
  manifestStores.installCapabilityManifestStore(store);
  const factory = capabilityCatalogs.createHostCapabilityCatalogFactory();
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:fixture:reviewed-cli:${OPERATION_ID}`,
    providerKind: 'reviewed_cli',
    operationId: OPERATION_ID,
    providerIdentity: '/usr/bin/fixture-sf',
    providerVersion: 'fixture-v1',
    operationVersion: '1',
    definitionFingerprint: 'e'.repeat(64),
    effect: 'read',
    accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    purpose: 'collect_records',
    provenance: {
      issuer: 'orchestration:authored-step-citations',
      issuedAt: '2026-09-18T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
  });
  assert.equal(store.install(manifest).ok, true, 'the cited operation is installed in the real trusted store');
  factory.register({
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: capabilityManifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => {
      throw new Error('a citation never dispatches');
    },
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(factory);
});

test.after(() => {
  capabilityCatalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('an operation an authored step names is reopened from the current catalog', () => {
  assert.deepEqual(
    citedOperationsForAuthoredStep({ allowedTools: [OPERATION_ID] }),
    [OPERATION_ID],
    'an explicit tool scope names the operation',
  );
  assert.deepEqual(
    citedOperationsForAuthoredStep({ call: { tool: OPERATION_ID } }),
    [OPERATION_ID],
    'a direct call names the operation just as well',
  );
  assert.deepEqual(
    citedOperationsForAuthoredStep({ allowedTools: ['*'] }),
    [],
    'a wildcard names nothing',
  );
  assert.deepEqual(
    citedOperationsForAuthoredStep({
      prompt: `Query Salesforce with ${OPERATION_ID} for this week's closed-won.`,
    } as Parameters<typeof citedOperationsForAuthoredStep>[0]),
    [],
    'PROSE IS NOT A CITATION — naming the operation in a sentence cites nothing',
  );
  assert.deepEqual(
    citedOperationsForAuthoredStep({ allowedTools: ['salesforce_sf_soql_query_v2_invented'] }),
    [],
    'an operation the current catalog does not carry resolves to nothing',
  );
});

test('recording a citation lands it in the step scope and never narrows an uncited step', () => {
  const steps = [
    { id: 'pull_pipeline', allowedTools: [OPERATION_ID] },
    { id: 'draft_email', allowedTools: undefined },
    { id: 'summarize', allowedTools: ['*'] },
  ];
  const { citedNotes } = recordAuthoredStepCitations(
    steps as Parameters<typeof recordAuthoredStepCitations>[0],
  );

  assert.deepEqual(steps[0]!.allowedTools, [OPERATION_ID], 'the cited step carries its operation');
  assert.equal(steps[1]!.allowedTools, undefined,
    'a step that cited nothing keeps the workflow-level wildcard — this pass never narrows one');
  assert.deepEqual(steps[2]!.allowedTools, ['*'], 'an explicit wildcard is left alone');
  assert.deepEqual(citedNotes, [], 'a scope that already held the operation reports no change');
});

test('a direct call records its citation alongside the scope it already had', () => {
  const steps = [{ id: 'pull_pipeline', allowedTools: ['some_helper'], call: { tool: OPERATION_ID } }];
  const { citedNotes } = recordAuthoredStepCitations(
    steps as Parameters<typeof recordAuthoredStepCitations>[0],
  );
  assert.deepEqual(steps[0]!.allowedTools, ['some_helper', OPERATION_ID],
    'UNION ONLY — recording adds the citation and removes nothing');
  assert.deepEqual(citedNotes, [`Step \`pull_pipeline\` cites ${OPERATION_ID}.`]);
});

test('a cited step is never re-bound to a guessed toolkit family', () => {
  // The exact Friday shape: the prompt names Salesforce, the chat discussed the
  // Salesforce toolkit, and without a citation the binder locks the step to
  // composio — the access the step's own prompt forbids.
  const cited = [{
    id: 'pull_pipeline',
    prompt: 'Pull this week\'s closed-won pipeline from the Salesforce connector.',
    allowedTools: [OPERATION_ID],
  }];
  const citedResult = bindDiscussedToolkitsIntoSteps(
    cited as Parameters<typeof bindDiscussedToolkitsIntoSteps>[0],
    [{ slug: 'salesforce', name: 'Salesforce' }],
  );
  assert.deepEqual(citedResult.boundNotes, [], 'a citation is already the decision');
  assert.deepEqual(cited[0]!.allowedTools, [OPERATION_ID], 'the cited scope is untouched');
  assert.ok(!cited[0]!.prompt.includes('composio'), 'no toolkit directive is appended over a citation');

  // Control: the SAME step without a citation still binds, so this pin proves
  // the citation is what stopped it — not the prompt or the toolkit list.
  const uncited = [{
    id: 'pull_pipeline',
    prompt: 'Pull this week\'s closed-won pipeline from the Salesforce connector.',
  }];
  const uncitedResult = bindDiscussedToolkitsIntoSteps(
    uncited as Parameters<typeof bindDiscussedToolkitsIntoSteps>[0],
    [{ slug: 'salesforce', name: 'Salesforce' }],
  );
  assert.equal(uncitedResult.boundNotes.length, 1, 'an uncited step still takes the chat-discussed toolkit');
  assert.ok(uncited[0]!.allowedTools?.includes('composio_execute_tool'));
});
