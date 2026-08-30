import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-bracket-'));
process.env.CLEMENTINE_HOME = home;

const eventlog = await import('./eventlog.js');
const ledger = await import('./artifact-ledger.js');
const brackets = await import('./brackets.js');
const { ExternalWritePreDispatchError } = await import('./external-write-admission.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const currentCapabilities = await import('./current-capability-manifest.fixture.js');

const GOOGLE_DOC_CREATE_VERIFICATION = {
  mutation: {
    version: 1,
    resourceFamily: 'google_doc',
    producedHandleKind: 'created_resource',
    proof: 'resource_identity_v1',
    target: {
      source: 'authoritative_result',
      pointers: ['/document_id'],
    },
    resultEnvelope: 'successful_data_envelope_v1',
  },
} as const;
const GOOGLE_DOC_READBACK_VERIFICATION = {
  readback: {
    version: 1,
    resourceFamily: 'google_doc',
    acceptedHandleKind: 'created_resource',
    requestTargetPointers: ['/document_id'],
    responseTargetPointers: ['/document_id'],
    resultEnvelope: 'successful_data_envelope_v1',
  },
} as const;
const NETLIFY_SITE_CREATE_VERIFICATION = {
  mutation: {
    version: 1,
    resourceFamily: 'netlify_site',
    producedHandleKind: 'created_resource',
    proof: 'resource_identity_v1',
    target: {
      source: 'authoritative_result',
      pointers: ['/id'],
    },
    resultEnvelope: 'successful_data_envelope_v1',
  },
} as const;
const NETLIFY_SITE_READBACK_VERIFICATION = {
  readback: {
    version: 1,
    resourceFamily: 'netlify_site',
    acceptedHandleKind: 'created_resource',
    requestTargetPointers: ['/site_id'],
    responseTargetPointers: ['/id'],
    resultEnvelope: 'successful_data_envelope_v1',
  },
} as const;
const priorCapabilityCatalog = currentCapabilities.installCurrentCapabilityManifestFixtures([
  {
    operationId: 'googledocs__create_document',
    providerKind: 'native_mcp',
    effect: 'external_write',
    destination: { family: 'google_doc', posture: 'create_new' },
    operationSemantics: { version: 1, reversibility: 'reversible' },
    verification: GOOGLE_DOC_CREATE_VERIFICATION,
  },
  {
    operationId: 'googledocs__get_document',
    providerKind: 'native_mcp',
    effect: 'read',
    destination: { family: 'google_doc', posture: 'named_existing' },
    verification: GOOGLE_DOC_READBACK_VERIFICATION,
  },
  {
    operationId: 'netlify__sites_create',
    providerKind: 'native_mcp',
    effect: 'external_write',
    destination: { family: 'netlify_site', posture: 'create_new' },
    operationSemantics: { version: 1, reversibility: 'reversible' },
    verification: NETLIFY_SITE_CREATE_VERIFICATION,
  },
  {
    operationId: 'netlify__api_create_site',
    providerKind: 'native_mcp',
    effect: 'external_write',
    destination: { family: 'netlify_site', posture: 'create_new' },
    operationSemantics: { version: 1, reversibility: 'reversible' },
    verification: NETLIFY_SITE_CREATE_VERIFICATION,
  },
  {
    operationId: 'netlify__status',
    providerKind: 'native_mcp',
    effect: 'read',
    destination: { family: 'netlify_site', posture: 'named_existing' },
  },
  {
    operationId: 'netlify__get_site',
    providerKind: 'native_mcp',
    effect: 'read',
    destination: { family: 'netlify_site', posture: 'named_existing' },
    verification: NETLIFY_SITE_READBACK_VERIFICATION,
  },
]);

beforeEach(() => {
  eventlog.resetEventLog();
  ledger._resetArtifactLedgerForTests();
});

after(() => {
  currentCapabilities.restoreCurrentCapabilityManifestFixtures(priorCapabilityCatalog);
  eventlog.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

/** The settlement spine refuses wrapped-tool dispatch without an accepted
 *  source AND a persisted turn graph — anchor both on a chat session and
 *  carry the identity in every harness run context. */
function anchorTask(sessionId: string, turn: number, text: string): { sessionId: string; seq: number; turn: number } {
  const source = eventlog.appendEvent({
    sessionId,
    turn,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  const shadow = recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  });
  assert.ok(shadow, 'fixture persisted the turn graph for the accepted task');
  return { sessionId, seq: source.seq, turn: source.turn };
}

function anchoredChatSession(text: string): { sessionId: string; seq: number; turn: number } {
  const sessionId = eventlog.createSession({ kind: 'chat' }).id;
  return anchorTask(sessionId, 1, text);
}

function runContext(anchor: { sessionId: string; seq: number; turn: number }, runScopeId: string) {
  return {
    sessionId: anchor.sessionId,
    sourceUserSeq: anchor.seq,
    turn: anchor.turn,
    behaviorScopeId: runScopeId,
    counter: new brackets.ToolCallsCounter(100),
  };
}

function seedArtifactVerification(sessionId: string, callId: string, output: unknown): void {
  const called = eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_called',
    data: { callId, tool: 'provider_list', effect: 'read' },
  });
  eventlog.writeToolOutput({
    sessionId,
    callId,
    invocationNonce: `nonce-${callId}`,
    tool: 'provider_list',
    output: JSON.stringify(output),
  });
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: { callId, tool: 'provider_list', effect: 'read', result: 'stored separately' },
  });
}

test('the tool bracket binds one create and reuses it across renamed retries in the same run', async () => {
  const anchor = anchoredChatSession('Create the document.');
  const sessionId = anchor.sessionId;
  let dispatches = 0;
  const tool = brackets.wrapToolForHarness({
    name: 'googledocs__create_document',
    async execute() {
      dispatches += 1;
      return {
        successful: true,
        data: {
          document_id: 'doc_bound_123456789',
          display_url: 'https://docs.google.com/document/d/doc_bound_123456789/edit',
        },
      };
    },
  });

  const invoke = (title: string, runScopeId = 'run:first', taskAnchor = anchor) => brackets.withHarnessRunContext(
    runContext(taskAnchor, runScopeId),
    () => tool.execute!({ title }),
  );

  await invoke('Original title');
  const duplicate = await invoke('Renamed retry');
  assert.equal(dispatches, 1, 'the second call never crosses the provider boundary');
  assert.match(String(duplicate), /already bound/i);
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:first')[0]?.status, 'bound');

  // A later logical run is a later ACCEPTED USER REQUEST — the artifact run
  // scope roots at the accepted source, so the fixture anchors a second one.
  const laterTask = anchorTask(sessionId, 2, 'Create the follow-up document.');
  await invoke('A later user request', 'run:second', laterTask);
  assert.equal(dispatches, 2, 'a later logical run in the same chat keeps the feature available');
});

test('a proven pre-dispatch block releases the slot, while an ambiguous failure stays fail-closed', async () => {
  const anchor = anchoredChatSession('Create the retryable document.');
  const sessionId = anchor.sessionId;
  let mode: 'blocked' | 'ambiguous' | 'success' = 'blocked';
  let dispatches = 0;
  const tool = brackets.wrapToolForHarness({
    name: 'googledocs__create_document',
    async execute() {
      dispatches += 1;
      if (mode === 'blocked') {
        throw new ExternalWritePreDispatchError('Missing title; provider dispatch did not start.');
      }
      if (mode === 'ambiguous') return 'provider connection closed before a response; creation is unknown';
      return { successful: true, data: { document_id: 'doc_retry_123456789' } };
    },
  });
  const invoke = (scope: string, taskAnchor = anchor) => brackets.withHarnessRunContext(
    runContext(taskAnchor, scope),
    () => tool.execute!({ title: 'Retryable' }),
  );

  await invoke('run:blocked');
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:blocked').length, 0, 'zero-dispatch proof releases the claim');
  mode = 'success';
  await invoke('run:blocked');
  assert.equal(dispatches, 2);
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:blocked')[0]?.status, 'bound');

  // The ambiguous phase is a separate logical run — and the artifact run
  // scope roots at the accepted source, so it gets its own accepted task.
  const ambiguousTask = anchorTask(sessionId, 2, 'Create the second retryable document.');
  mode = 'ambiguous';
  await invoke('run:ambiguous', ambiguousTask);
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:ambiguous')[0]?.status, 'uncertain');
  mode = 'success';
  const denied = await invoke('run:ambiguous', ambiguousTask);
  assert.match(String(denied), /Verify that attempt before retrying/i);
  assert.match(String(denied), new RegExp(`artifactId ${ledger.listRunArtifacts(sessionId, 'run:ambiguous')[0]!.id}`));
  assert.match(String(denied), /artifact_claim_resolve/);
  assert.equal(dispatches, 3, 'an uncertain write is never blindly replayed');
});

test('manifest-bound Netlify API creates share one slot and cannot bypass an uncertain claim', async () => {
  const anchor = anchoredChatSession('Create the rc-proof site.');
  const sessionId = anchor.sessionId;
  const runScope = 'run:netlify-api-create';
  let dispatches = 0;
  const sitesCreate = brackets.wrapToolForHarness({
    name: 'netlify__sites_create',
    async execute() {
      dispatches += 1;
      return 'Netlify provider connection closed before a response; outcome unknown';
    },
  });
  const apiCreate = brackets.wrapToolForHarness({
    name: 'netlify__api_create_site',
    async execute() {
      dispatches += 1;
      return {
        successful: true,
        data: {
          id: 'site_api_123456789',
          ssl_url: 'https://rc-proof.netlify.app',
        },
      };
    },
  });
  const getSite = brackets.wrapToolForHarness({
    name: 'netlify__get_site',
    async execute() {
      return {
        successful: true,
        data: {
          id: 'site_api_123456789',
          ssl_url: 'https://rc-proof.netlify.app',
        },
      };
    },
  });
  const invokeSitesCreate = () => brackets.withHarnessRunContext(
    runContext(anchor, runScope),
    () => sitesCreate.execute!({ name: 'rc-proof' }),
  );
  const invokeApiCreate = () => brackets.withHarnessRunContext(
    runContext(anchor, runScope),
    () => apiCreate.execute!({ account_slug: 'team', name: 'rc-proof' }),
  );
  const invokeGetSite = () => brackets.withHarnessRunContext(
    runContext(anchor, runScope),
    () => getSite.execute!({ site_id: 'site_api_123456789' }),
  );

  await invokeSitesCreate();
  const [uncertain] = ledger.listRunArtifacts(sessionId, runScope);
  assert.equal(uncertain?.status, 'uncertain');

  const denied = await invokeApiCreate();
  assert.match(String(denied), new RegExp(`artifactId ${uncertain!.id}`));
  assert.equal(dispatches, 1, 'the alternate Netlify API spelling cannot bypass the claim');

  seedArtifactVerification(sessionId, 'verify-site-absent', { resources: [] });
  assert.equal(
    ledger.resolveUncertainArtifactClaim(sessionId, uncertain!.id, {
      kind: 'absent', verificationCallId: 'verify-site-absent',
    }).ok,
    true,
    'a read-only absence proof releases the exact claim',
  );
  await invokeApiCreate();
  let [bound] = ledger.listRunArtifacts(sessionId, runScope);
  assert.equal(dispatches, 2, 'the resolved claim permits exactly one fresh create');
  assert.equal(bound?.status, 'bound');
  assert.equal(bound?.resourceId, 'site_api_123456789');

  await invokeGetSite();
  [bound] = ledger.listRunArtifacts(sessionId, runScope);
  assert.ok(bound?.bindingVerifiedAt, 'the exact read-back closes the artifact verification node');
  assert.equal(ledger.listUnresolvedCreateClaims(sessionId, runScope).length, 0);
});

test('execute wrapper records an exact Google Docs provider read-back but ignores mismatches', async () => {
  const anchor = anchoredChatSession('Verify the firm brief document.');
  const sessionId = anchor.sessionId;
  const runScope = 'run:verify-doc';
  const intent = {
    kind: 'resource', provider: 'google_doc', slotKey: 'resource:primary',
    title: 'Firm brief', createShape: 'CREATE',
  } as const;
  ledger.claimArtifactSlot(sessionId, intent, 'create-doc', runScope);
  ledger.bindArtifactSlot(sessionId, intent.slotKey, {
    resourceId: 'doc_bracket_123456789',
    uri: 'https://docs.google.com/document/d/doc_bracket_123456789/edit',
  }, 'create-doc', runScope);

  let responseId = 'wrong_doc_123456789';
  const getter = brackets.wrapToolForHarness({
    name: 'googledocs__get_document',
    async execute() {
      return {
        successful: true,
        data: {
          document_id: responseId,
          display_url: `https://docs.google.com/document/d/${responseId}/edit`,
        },
      };
    },
  });
  const invoke = () => brackets.withHarnessRunContext(
    runContext(anchor, runScope),
    () => getter.execute!({ document_id: 'doc_bracket_123456789' }),
  );

  await invoke();
  assert.equal(ledger.listRunArtifacts(sessionId, runScope)[0]?.bindingVerifiedAt, null);
  responseId = 'doc_bracket_123456789';
  await invoke();
  const verified = ledger.listRunArtifacts(sessionId, runScope)[0];
  assert.ok(verified?.bindingVerifiedAt);
  assert.equal(verified?.verificationShape, 'googledocs__get_document');
});

test('invoke wrapper records an exact Netlify getSite readback and never treats status as proof', async () => {
  const anchor = anchoredChatSession('Verify the asset site.');
  const sessionId = anchor.sessionId;
  const runScope = 'run:verify-site';
  const siteId = '00000000-0000-4000-8000-000000000001';
  const intent = {
    kind: 'resource', provider: 'netlify_site', slotKey: 'resource:primary',
    title: 'asset-site', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  ledger.claimArtifactSlot(sessionId, intent, 'create-site', runScope);
  ledger.bindArtifactSlot(sessionId, intent.slotKey, {
    resourceId: siteId, uri: 'https://asset-site.netlify.app',
  }, 'create-site', runScope);

  const status = brackets.wrapToolForHarness({
    name: 'netlify__status',
    async invoke() {
      return { successful: true, data: { id: siteId, state: 'ready' } };
    },
  });
  const getSite = brackets.wrapToolForHarness({
    name: 'netlify__get_site',
    async invoke() {
      return {
        successful: true,
        data: { id: siteId, ssl_url: 'https://asset-site.netlify.app' },
      };
    },
  });
  const invoke = (
    tool: typeof status,
    args: Record<string, unknown>,
    callId: string,
  ) => brackets.withHarnessRunContext(
    runContext(anchor, runScope),
    () => tool.invoke!({}, args, { toolCall: { callId } }),
  );

  await invoke(status, { site_id: siteId }, 'status-read');
  assert.equal(ledger.listRunArtifacts(sessionId, runScope)[0]?.bindingVerifiedAt, null);
  await invoke(getSite, { site_id: siteId }, 'get-site');
  const verified = ledger.listRunArtifacts(sessionId, runScope)[0];
  assert.ok(verified?.bindingVerifiedAt);
  assert.equal(verified?.verificationCallId, 'get-site');
});
