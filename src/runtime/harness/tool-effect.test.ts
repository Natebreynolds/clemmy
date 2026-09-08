import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  attachSemanticContract,
  capabilityManifestDigest,
  type CapabilityManifestV1,
  type CapabilityProviderKind,
  type ManifestEffect,
} from './capability-manifest.js';
import {
  createHostCapabilityCatalogFactory,
  installHostCapabilityCatalogFactory,
  peekHostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import {
  actionTopologyRoleForRuntimeCall,
  classifyRuntimeToolEffect,
  isDelegationPrimitiveRuntimeCall,
  isUnscopedShellRuntimeCall,
  isCanonicalTopLevelToolEvent,
  pairTransportMirrorToolCalls,
  projectCanonicalTopLevelToolEvents,
  runtimeToolAccountingMetadata,
  runtimeToolAuthorityBinding,
  resolveProviderCarrierLocalReadControl,
  unwrapRuntimeEffectiveToolIdentity,
} from './tool-effect.js';

type ExternalProviderKind = Extract<CapabilityProviderKind, 'composio' | 'native_mcp' | 'reviewed_cli'>;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Production effect authority is a current, registration-attested manifest
 * row. Provider/tool spelling is identity only, so read fixtures must install
 * the same positive authority production receives from capability discovery.
 */
function externalEffectManifest(input: {
  operationId: string;
  providerKind: ExternalProviderKind;
  effect: Extract<ManifestEffect, 'read' | 'external_write'>;
  reversibility?: 'reversible' | 'irreversible';
  exactArtifactRecovery?: boolean;
}): CapabilityManifestV1 {
  const write = input.effect === 'external_write';
  const identity = `${input.providerKind}:${input.operationId}`;
  const providerInputSchemaDigest = digest(`provider-input:${identity}`);
  return attachSemanticContract({
    version: 1,
    manifestId: `cap:tool-effect:${digest(identity).slice(0, 24)}`,
    providerKind: input.providerKind,
    operationId: input.operationId,
    providerIdentity: `fixture:${input.providerKind}:connected`,
    providerVersion: digest(`provider:${input.providerKind}`),
    operationVersion: digest(`operation:${identity}`),
    definitionFingerprint: digest(`definition:${identity}`),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest,
      semanticName: input.operationId,
      behaviorHints: {
        readOnly: !write,
        destructive: write ? false : null,
        idempotent: !write,
        openWorld: false,
      },
    },
    effect: input.effect,
    ...(write && input.reversibility
      ? { operationSemantics: { version: 1 as const, reversibility: input.reversibility } }
      : {}),
    ...(write ? { destination: { family: 'fixture-provider', posture: 'create_new' } } : {}),
    accountId: `account:${input.providerKind}:fixture`,
    idempotency: write
      ? { required: true, policy: 'key_before_dispatch' }
      : { required: false, policy: 'none' },
    reconciliation: write
      ? { supported: true, policy: 'exact_artifact' }
      : { supported: false, policy: 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: {
      kinds: write ? ['receipt', 'readback'] : ['records'],
      readbackRequired: write,
    },
    provenance: {
      issuer: `host:${input.providerKind}:fixture-materializer:v1`,
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: write ? ['destination'] : ['source'],
  });
}

function registeredCapability(
  manifest: CapabilityManifestV1,
  exactArtifactRecovery = false,
): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    ...(manifest.destination ? { destination: manifest.destination } : {}),
    account: manifest.accountId,
    manifestDigest: capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerInputSchemaDigest: manifest.externalDefinition?.providerInputSchemaDigest,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    ...(exactArtifactRecovery
      ? { reconcile: async () => ({ exists: true }) }
      : {}),
    invoke: async () => ({ successful: true }),
  };
}

function withCurrentExternalEffects<T>(
  effects: readonly Array<{
    operationId: string;
    providerKind: ExternalProviderKind;
    effect: Extract<ManifestEffect, 'read' | 'external_write'>;
    reversibility?: 'reversible' | 'irreversible';
    exactArtifactRecovery?: boolean;
  }>,
  run: () => T,
): T {
  const prior = peekHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory(
    effects.map((effect) => registeredCapability(
      externalEffectManifest(effect),
      effect.exactArtifactRecovery === true,
    )),
  ));
  try {
    return run();
  } finally {
    installHostCapabilityCatalogFactory(prior);
  }
}

test('delegation primitive classification is exact registry authority, not a name heuristic', () => {
  assert.equal(isDelegationPrimitiveRuntimeCall('run_worker', { item: 'x' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('run_batch', { action: 'execute' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('pending_action_execute', { approval_id: 'a' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('local_cli_list', { command: 'git' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('local_cli_probe', { command: 'git' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('check_capability', { name: 'git' }), true);
  for (const name of ['space_save', 'space_refresh', 'space_edit_runner', 'space_revert_runner', 'space_action_prepare']) {
    assert.equal(isDelegationPrimitiveRuntimeCall(name, { slug: 'source-backed-space' }), true, name);
  }
  assert.equal(isDelegationPrimitiveRuntimeCall('space_try_runner', { slug: 'x' }), false);
  assert.equal(isDelegationPrimitiveRuntimeCall('mcp__clementine-local__run_worker', { item: 'x' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('mcp__clementine-local__local_cli_probe', { command: 'git' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('mcp__clementine-local__check_capability', { name: 'git' }), true);
  assert.equal(isDelegationPrimitiveRuntimeCall('mcp__foreign__run_worker', { item: 'x' }), false);
  assert.equal(isDelegationPrimitiveRuntimeCall('mcp__foreign__local_cli_probe', { command: 'git' }), false);
  assert.equal(isDelegationPrimitiveRuntimeCall('mcp__foreign__check_capability', { name: 'git' }), false);
  assert.equal(isDelegationPrimitiveRuntimeCall('run_worker_like', { item: 'x' }), false);
  assert.equal(isDelegationPrimitiveRuntimeCall('local_cli_probe_like', { command: 'git' }), false);
  assert.equal(isDelegationPrimitiveRuntimeCall('check_capability_like', { name: 'git' }), false);
  assert.equal(isUnscopedShellRuntimeCall('run_shell_command', { command: 'curl https://example.test' }), true);
  assert.equal(isUnscopedShellRuntimeCall('mcp__foreign__run_shell_command', { command: 'curl https://example.test' }), false);
});
import {
  durableLogicalCallContract,
  logicalCallArgumentsAreContractible,
} from './logical-call-contract.js';
import { toolCallCorrelationFingerprint } from './tool-correlation.js';

test('runtime authority binding is structural and future sources fail closed', () => {
  assert.equal(runtimeToolAuthorityBinding(
    classifyRuntimeToolEffect('list_files', {}),
  ), 'local_envelope');
  assert.equal(runtimeToolAuthorityBinding(
    classifyRuntimeToolEffect('mcp__directory__list_records', {}),
  ), 'catalog_manifest');
  assert.equal(runtimeToolAuthorityBinding(
    classifyRuntimeToolEffect('team_reply', {}),
  ), 'catalog_manifest', 'consequential effects cannot inherit a local envelope');
  for (const effect of ['read', 'external_write'] as const) {
    assert.equal(runtimeToolAuthorityBinding({
      effect,
      mutating: effect === 'external_write',
      dangerousWrite: effect === 'external_write',
      source: 'future_adapter' as never,
    }), 'unknown', 'an unrecognized future source is never authorized implicitly');
  }
});

test('canonical projection excludes MCP transport mirrors without dropping native or legacy calls', () => {
  const events = [
    {
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId: 'call-outlook',
        canonicalCallId: 'call-outlook',
        accounting: 'top_level',
      },
    },
    {
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId: 'call-outlook',
        accounting: 'transport_mirror',
      },
    },
    {
      type: 'tool_called',
      data: { tool: 'mcp__gong__GONG_GET_CALL_TRANSCRIPT', callId: 'call-native-legacy' },
    },
    {
      type: 'tool_returned',
      data: { tool: 'composio_execute_tool', callId: 'call-outlook', accounting: 'top_level', ok: true },
    },
    {
      type: 'tool_returned',
      data: { tool: 'composio_execute_tool', callId: 'call-outlook', accounting: 'transport_mirror', ok: true },
    },
    { type: 'heartbeat', data: {} },
  ];

  assert.equal(isCanonicalTopLevelToolEvent(events[0], 'tool_called'), true);
  assert.equal(isCanonicalTopLevelToolEvent(events[1], 'tool_called'), false);
  assert.equal(isCanonicalTopLevelToolEvent(events[2], 'tool_called'), true, 'legacy/native rows remain countable');
  assert.equal(isCanonicalTopLevelToolEvent(events[5]), false, 'non-tool telemetry is never projected');
  assert.deepEqual(
    projectCanonicalTopLevelToolEvents(events, 'tool_called').map((event) => event.data.callId),
    ['call-outlook', 'call-native-legacy'],
  );
  assert.equal(projectCanonicalTopLevelToolEvents(events, 'tool_returned').length, 1);
});

test('transport pairing normalizes production-shaped inputs and skips resolved identical calls', () => {
  const longBody = 'confidential-firm-brief '.repeat(30);
  assert.ok(longBody.length > 500);
  const args = { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: { title: 'Firm brief', content: longBody } };
  const correlationFingerprint = toolCallCorrelationFingerprint('composio_execute_tool', args);
  const events = [
    { type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-returned', accounting: 'top_level', arguments: JSON.stringify(args), correlationFingerprint } },
    { type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'toolu-live', accounting: 'top_level', arguments: JSON.stringify(args), correlationFingerprint } },
    {
      type: 'tool_called',
      data: {
        tool: 'composio_execute_tool',
        callId: 'mcp-live',
        accounting: 'transport_mirror',
        args: { tool_slug: args.tool_slug, arguments: { title: 'Firm brief', content: `${longBody.slice(0, 300)}…` }, optional: null },
        correlationFingerprint,
      },
    },
  ];
  const pairs = pairTransportMirrorToolCalls(events, new Set(['toolu-returned']));
  assert.equal(pairs.canonicalToMirrorCallId.get('toolu-live'), 'mcp-live');
  assert.equal(pairs.mirrorToCanonicalCallId.get('mcp-live'), 'toolu-live');
  assert.equal(pairs.canonicalToMirrorCallId.has('toolu-returned'), false);
  assert.doesNotMatch(correlationFingerprint, /confidential-firm-brief/, 'the durable key never stores payload text');
});

test('native MCP production names distinguish sends from reads', () => {
  const writes = [
    'outlook__send_mail',
    'outlook__outlook_send_email',
    'mcp__gmail__reply_to_thread',
    'mcp__googledocs__create_document',
    'mcp__hubspot__find_or_create_contact',
  ];
  const reads = [
    'outlook__list_messages',
    'mcp__gmail__get_thread',
    'mcp__googledocs__get_document',
    'mcp__gong__GONG_GET_CALL_TRANSCRIPT',
    'mcp__vapi__retrieve_call',
    'mcp__twilio__list_calls',
    'dataforseo__serp_organic_live_advanced',
  ];
  withCurrentExternalEffects([
    ...writes.map((name) => ({
      operationId: name.replace(/^mcp__/, ''),
      providerKind: 'native_mcp' as const,
      effect: 'external_write' as const,
    })),
    ...reads.map((name) => ({
      operationId: name.replace(/^mcp__/, ''),
      providerKind: 'native_mcp' as const,
      effect: 'read' as const,
    })),
  ], () => {
    for (const name of writes) {
      const effect = classifyRuntimeToolEffect(name, {});
      assert.equal(effect.effect, 'external_write', name);
      assert.equal(effect.dangerousWrite, true, name);
      assert.equal(effect.source, 'native_mcp', name);
    }
    for (const name of reads) {
      const effect = classifyRuntimeToolEffect(name, {});
      assert.equal(effect.effect, 'read', name);
      assert.equal(effect.dangerousWrite, false, name);
      assert.equal(effect.source, 'native_mcp', name);
    }
  });
});

test('unattested native MCP operations fail closed at the runtime effect boundary', () => {
  withCurrentExternalEffects([], () => {
    for (const name of [
      'mcp__stripe__refund_payment',
      'mcp__aws__reboot_instance',
      'mcp__cloudflare__purge_cache',
      'mcp__acme__transact',
      'mcp__github__merge_pull_request',
      'mcp__secrets__rotate_key',
      'mcp__billing__charge_customer',
      // Read-shaped provider names are also identities, never effect proof.
      'mcp__outlook__list_messages',
      'mcp__dataforseo__serp_organic_live_advanced',
      'mcp__firecrawl__scrape',
      // The SDK also emits this carrier-less namespace shape.
      'stripe__refund_payment',
    ]) {
      const effect = classifyRuntimeToolEffect(name, {});
      assert.equal(effect.effect, 'external_write', name);
      assert.equal(effect.mutating, true, name);
      assert.equal(effect.dangerousWrite, true, name);
      assert.equal(effect.source, 'native_mcp', name);
    }
    // Reads flow (open-clem-up 2026-08-29; census D1; live 2026-09-02): an
    // unattested PROVIDER-SHAPED Composio slug whose verb is unambiguously a
    // read (a read verb and NO send/dispatch/mutation verb) is a READ, not the
    // conservative write the absent-manifest default used to force. This
    // over-gated ordinary reads (a work_call carrying GOOGLESHEETS_BATCH_GET /
    // SLACK_FETCH_CONVERSATION_HISTORY was refused as plan-bound). Native MCP
    // names above are unchanged — a server slug is identity, never effect.
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'OUTLOOK_LIST_MESSAGES', arguments: '{}',
    }).effect, 'read');
    assert.equal(classifyRuntimeToolEffect('call_tool', {
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: '{}' }),
    }).effect, 'read');
    // The fail-closed floor still holds for every slug that is not an
    // unambiguous read: a mutation verb (even alongside a read verb), a
    // send, or a slug with no read verb at all stays external_write.
    for (const slug of [
      'OUTLOOK_SEND_EMAIL',
      'GONG_GET_CALL_AND_UPDATE_CONTACT',
      'GMAIL_MARK_AS_READ',
      'GOOGLESHEETS_BATCH_UPDATE',
      'ACME_DO_THING',
    ]) {
      assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
        tool_slug: slug, arguments: '{}',
      }).effect, 'external_write', slug);
    }
  });
});

test('native MCP provider read jobs stay reads but explicit mutations win', () => {
  const reads = [
    'mcp__dataforseo__serp_organic_live_advanced',
    'mcp__dataforseo__create_serp_google_organic_task_post',
    'mcp__dataforseo__DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST',
    'mcp__firecrawl__scrape',
    'mcp__firecrawl__batch_scrape',
    'mcp__firecrawl__FIRECRAWL_SCRAPE',
  ];
  const writes = [
    'mcp__dataforseo__delete_account',
    'mcp__dataforseo__publish_report',
    'mcp__firecrawl__scrape_and_publish',
    'mcp__firecrawl__crawl_and_delete',
  ];
  withCurrentExternalEffects([
    ...reads.map((name) => ({
      operationId: name.replace(/^mcp__/, ''),
      providerKind: 'native_mcp' as const,
      effect: 'read' as const,
    })),
    ...writes.map((name) => ({
      operationId: name.replace(/^mcp__/, ''),
      providerKind: 'native_mcp' as const,
      effect: 'external_write' as const,
    })),
  ], () => {
    for (const name of reads) {
      assert.equal(classifyRuntimeToolEffect(name, {}).effect, 'read', name);
    }
    for (const name of writes) {
      assert.equal(classifyRuntimeToolEffect(name, {}).effect, 'external_write', name);
    }
  });
});

test('Composio gateways classify the inner operation rather than the wrapper', () => {
  withCurrentExternalEffects([
    { operationId: 'OUTLOOK_SEND_EMAIL', providerKind: 'composio', effect: 'external_write' },
    { operationId: 'OUTLOOK_LIST_MESSAGES', providerKind: 'composio', effect: 'read' },
    { operationId: 'HUBSPOT_FIND_OR_CREATE_CONTACT', providerKind: 'composio', effect: 'external_write' },
    { operationId: 'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', providerKind: 'composio', effect: 'read' },
    { operationId: 'GONG_GET_CALL_TRANSCRIPT', providerKind: 'composio', effect: 'read' },
    { operationId: 'GONG_GET_CALL_AND_UPDATE_CONTACT', providerKind: 'composio', effect: 'external_write' },
    { operationId: 'FIRECRAWL_SCRAPE_AND_PUBLISH', providerKind: 'composio', effect: 'external_write' },
  ], () => {
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: '{}',
    }).dangerousWrite, true);
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'OUTLOOK_LIST_MESSAGES', arguments: '{}',
    }).effect, 'read');
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'HUBSPOT_FIND_OR_CREATE_CONTACT', arguments: '{}',
    }).effect, 'external_write', 'a read verb cannot hide a mixed-action write');
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST', arguments: '{}',
    }).effect, 'read');
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'GONG_GET_CALL_TRANSCRIPT', arguments: '{}',
    }).effect, 'read', 'CALL is the object of GET, not a telephony dispatch verb');
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'GONG_GET_CALL_AND_UPDATE_CONTACT', arguments: '{}',
    }).effect, 'external_write', 'a real mutation token still wins over the call-read shape');
    assert.equal(classifyRuntimeToolEffect('composio_execute_tool', {
      tool_slug: 'FIRECRAWL_SCRAPE_AND_PUBLISH', arguments: '{}',
    }).effect, 'external_write', 'a read-job prefix cannot hide an explicit publish');
  });
});

test('trusted carriers preserve the exact direct-call digest and keep ordinary inner carrier-shaped fields as data', () => {
  const slug = 'SCHEDULERCO_LIST_EVENTS';
  const inner = {
    timeMin: '2026-08-07',
    nested: {
      tool_slug: 'ordinary-business-data',
      arguments: 'also ordinary business data',
    },
  };
  const gateway = {
    tool_slug: slug,
    arguments: JSON.stringify(inner),
  };
  const nestedCarrier = {
    name: 'composio_execute_tool',
    args_json: JSON.stringify(gateway),
  };

  const directIdentity = unwrapRuntimeEffectiveToolIdentity(slug, inner);
  const gatewayIdentity = unwrapRuntimeEffectiveToolIdentity('composio_execute_tool', gateway);
  const nestedIdentity = unwrapRuntimeEffectiveToolIdentity('call_tool', nestedCarrier);
  assert.deepEqual(directIdentity, { toolName: slug, args: inner });
  assert.deepEqual(gatewayIdentity, { toolName: slug, args: inner, composioCarrier: true });
  assert.deepEqual(nestedIdentity, { toolName: slug, args: inner, composioCarrier: true });

  const directContract = durableLogicalCallContract('task:carrier-parity#1', slug, inner);
  assert.ok(directContract);
  assert.deepEqual(
    durableLogicalCallContract('task:carrier-parity#1', 'composio_execute_tool', gateway),
    directContract,
  );
  assert.deepEqual(
    durableLogicalCallContract('task:carrier-parity#1', 'call_tool', nestedCarrier),
    directContract,
  );
});

test('trusted provider carriers recover only exact registry read controls as local control calls', () => {
  const localControl = {
    tool_slug: 'tool_search',
    arguments: JSON.stringify({ query: 'OP_LOOKUP' }),
  };
  assert.deepEqual(
    resolveProviderCarrierLocalReadControl('composio_execute_tool', localControl),
    { toolName: 'tool_search', args: { query: 'OP_LOOKUP' } },
  );
  assert.deepEqual(classifyRuntimeToolEffect('composio_execute_tool', localControl), {
    effect: 'read',
    mutating: false,
    dangerousWrite: false,
    source: 'registry',
  });
  assert.equal(
    actionTopologyRoleForRuntimeCall('composio_execute_tool', localControl),
    'control',
  );

  for (const tool_slug of ['NOT_A_REGISTERED_CONTROL', 'read_file', 'memory_remember']) {
    const carrier = { tool_slug, arguments: '{}' };
    assert.equal(
      resolveProviderCarrierLocalReadControl('composio_execute_tool', carrier),
      null,
      `${tool_slug} must stay on the ordinary provider/business path`,
    );
    assert.notEqual(
      classifyRuntimeToolEffect('composio_execute_tool', carrier).source,
      'registry',
    );
    assert.equal(
      actionTopologyRoleForRuntimeCall('composio_execute_tool', carrier),
      'business',
    );
  }
});

test('trusted Composio carriers fail closed when their exact inner arguments are malformed', () => {
  for (const argumentsPayload of [undefined, 'not-json', '[]', 42, true]) {
    const args = { tool_slug: 'SCHEDULERCO_LIST_EVENTS', arguments: argumentsPayload };
    assert.deepEqual(
      unwrapRuntimeEffectiveToolIdentity('composio_execute_tool', args),
      {
        toolName: null,
        args: argumentsPayload === '[]' ? '[]' : argumentsPayload,
        composioCarrier: true,
      },
    );
    assert.equal(logicalCallArgumentsAreContractible('composio_execute_tool', args), false);
    assert.equal(durableLogicalCallContract('task:malformed-carrier#1', 'composio_execute_tool', args), null);
  }
});

test('trusted Composio explicit null is the exact zero-argument direct contract across carriers', () => {
  const slug = 'SCHEDULERCO_LIST_EVENTS';
  const gateway = { tool_slug: slug, arguments: null };
  const nested = {
    name: 'composio_execute_tool',
    args_json: JSON.stringify(gateway),
  };
  assert.deepEqual(
    unwrapRuntimeEffectiveToolIdentity('composio_execute_tool', gateway),
    { toolName: slug, args: {}, composioCarrier: true },
  );
  const direct = durableLogicalCallContract('task:null-carrier#1', slug, {});
  assert.ok(direct);
  assert.deepEqual(
    durableLogicalCallContract('task:null-carrier#1', 'composio_execute_tool', gateway),
    direct,
  );
  assert.deepEqual(
    durableLogicalCallContract('task:null-carrier#1', 'call_tool', nested),
    direct,
  );
});

test('only the exact host unreadable-arguments sentinel owns a durable outer refusal identity', () => {
  const tool = 'composio_execute_tool';
  const marker = { carrier: tool, malformed: true, version: 1 };
  assert.equal(logicalCallArgumentsAreContractible(tool, marker), true);
  const contract = durableLogicalCallContract('task:unreadable-host-refusal#1', tool, marker);
  assert.ok(contract);
  assert.equal(contract.toolName, tool);

  for (const nearMiss of [
    { ...marker, carrier: 'composio_execute_tool_like' },
    { ...marker, malformed: false },
    { ...marker, version: 2 },
    { ...marker, extra: true },
  ]) {
    assert.equal(logicalCallArgumentsAreContractible(tool, nearMiss), false);
    assert.equal(
      durableLogicalCallContract('task:unreadable-host-refusal#1', tool, nearMiss),
      null,
    );
  }
});

test('work_call wrapping a unique current catalog CLI read is a reviewed_cli read, not unknown', () => {
  const operationId = 'salesforce_sf_soql_query';
  const definitionFingerprint = digest(`definition:reviewed_cli:${operationId}`);
  const manifest = attachSemanticContract({
    version: 1,
    manifestId: `cap:tool-effect:${digest(`reviewed_cli:${operationId}`).slice(0, 24)}`,
    providerKind: 'reviewed_cli',
    operationId,
    providerIdentity: '/usr/local/bin/sf',
    providerVersion: digest('provider:reviewed_cli'),
    operationVersion: '1',
    definitionFingerprint,
    effect: 'read',
    accountId: 'reviewed_cli:host',
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    purpose: 'lookup',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['records'],
    applicableDeliverableKinds: ['records'],
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: {
      issuer: 'host:reviewed-cli-materializer:v1',
      issuedAt: '2026-08-27T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
    argumentCompiler: { id: 'compile:reviewed-cli-argv:v1', version: '1' },
    invokePortId: `host:reviewed-cli:${digest(`port:${operationId}`)}`,
  });
  const prior = peekHostCapabilityCatalogFactory();
  installHostCapabilityCatalogFactory(createHostCapabilityCatalogFactory([
    registeredCapability(manifest),
  ]));
  try {
    const decision = classifyRuntimeToolEffect('work_call', {
      name: 'salesforce_sf_soql_query',
      args_json: JSON.stringify({ query: 'SELECT Id FROM Opportunity' }),
    });
    assert.equal(decision.effect, 'read');
    assert.equal(decision.source, 'reviewed_cli');
  } finally {
    installHostCapabilityCatalogFactory(prior);
  }
});

test('call_tool accounting follows the inner tool and never labels a failed guessed read as a local write', () => {
  withCurrentExternalEffects([
    { operationId: 'GMAIL_SEND_EMAIL', providerKind: 'composio', effect: 'external_write' },
    { operationId: 'GOOGLESHEETS_BATCH_GET', providerKind: 'composio', effect: 'read' },
  ], () => {
    assert.equal(classifyRuntimeToolEffect('call_tool', {
      name: 'read_file',
      args_json: JSON.stringify({ path: '/tmp/report.txt' }),
    }).effect, 'read');
    assert.equal(classifyRuntimeToolEffect('call_tool', {
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: '{}' }),
    }).effect, 'external_write');
    assert.equal(classifyRuntimeToolEffect('call_tool', {
      name: 'http_fetch',
      args_json: JSON.stringify({ url: 'https://example.com/posts/1' }),
    }).effect, 'compute');
    assert.equal(classifyRuntimeToolEffect('call_tool', {
      name: 'made_up_reader',
      args_json: '{}',
    }).effect, 'unknown');
    assert.equal(runtimeToolAccountingMetadata(
      'call_tool',
      JSON.stringify({
        name: 'composio_execute_tool',
        args_json: JSON.stringify({ tool_slug: 'GOOGLESHEETS_BATCH_GET', arguments: '{}' }),
      }),
    ).effect, 'read');
  });
});

test('static Workspace runner inspection stays read-only through direct and deferred dispatch', () => {
  const expected = {
    effect: 'read',
    mutating: false,
    dangerousWrite: false,
    source: 'registry',
  };
  assert.deepEqual(classifyRuntimeToolEffect('space_try_runner', {
    slug: 'friday-team-dashboard',
    runner_path: 'pull.mjs',
    payload_json: null,
  }), expected);
  assert.deepEqual(classifyRuntimeToolEffect('call_tool', {
    name: 'space_try_runner',
    args_json: JSON.stringify({
      slug: 'friday-team-dashboard',
      runner_path: 'pull.mjs',
      payload_json: null,
    }),
  }), expected);
});

test('an inert automation proposal stays host-only through the deferred control carrier', () => {
  assert.deepEqual(classifyRuntimeToolEffect('call_tool', {
    name: 'automation_opportunity_propose',
    args_json: JSON.stringify({ proposal_key: 'review-only', opportunity: {} }),
  }), {
    effect: 'host_only',
    mutating: true,
    dangerousWrite: false,
    source: 'registry',
  });
});

test('pending-action staging stays host-only through call_tool while execution remains a mutation', () => {
  const expectedStaging = {
    effect: 'host_only' as const,
    mutating: true,
    dangerousWrite: false,
    source: 'registry' as const,
  };
  const exactPayload = {
    title: 'Review one exact outbound action',
    kind: 'external_send',
    toolName: 'composio_execute_tool',
    payloadJson: JSON.stringify({
      tool_slug: 'MAIL_SEND',
      arguments: { to: 'recipient@example.test', body: 'Exact body' },
    }),
    approvalIntent: 'request_now',
  };

  assert.deepEqual(
    classifyRuntimeToolEffect('pending_action_queue', exactPayload),
    expectedStaging,
  );
  assert.deepEqual(classifyRuntimeToolEffect('call_tool', {
    name: 'pending_action_queue',
    args_json: JSON.stringify(exactPayload),
  }), expectedStaging);

  assert.deepEqual(classifyRuntimeToolEffect('pending_action_execute', {
    id: 'pending-exact',
  }), {
    effect: 'local_write',
    mutating: true,
    dangerousWrite: false,
    source: 'registry',
  });
});

test('run_batch read proposals account as reads while mutating proposals remain local writes', () => {
  assert.equal(classifyRuntimeToolEffect('run_batch', {
    action: 'propose',
    plan: { sideEffect: 'read', tool: 'http_fetch', items: [] },
  }).effect, 'read');
  assert.equal(classifyRuntimeToolEffect('run_batch', {
    action: 'status',
    batch_id: 'batch-1',
  }).effect, 'read');
  assert.equal(classifyRuntimeToolEffect('run_batch', {
    action: 'propose',
    plan: { sideEffect: 'send', tool: 'composio_execute_tool', items: [] },
  }).effect, 'local_write');
});

test('shell effects are behavioral: compute stays safe, sends/deploys are external writes', () => {
  for (const command of [
    'rg TODO src',
    'npm test -- --runInBand',
    'npm run build',
    'npx tsc --noEmit',
    'ffmpeg -i a.mov b.mp4',
    'node scripts/render-preview.mjs',
    'sf data query --json --query "SELECT COUNT(Id) cnt FROM Opportunity" 2>/dev/null',
    'sf sobject describe --sobject Opportunity --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin))"',
    'sf data query --json --query "SELECT SUM(Net_MRR__c) mrr FROM Opportunity WHERE IsWon = true AND CloseDate = THIS_WEEK" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin))"',
    'echo ok 2>/dev/null',
  ]) {
    const effect = classifyRuntimeToolEffect('run_shell_command', { command });
    assert.equal(effect.effect, 'compute', command);
    assert.equal(effect.dangerousWrite, false, command);
  }
  for (const command of ['rm -rf dist', 'git commit -m "release"', 'mkdir generated']) {
    const effect = classifyRuntimeToolEffect('run_shell_command', { command });
    assert.equal(effect.effect, 'local_write', command);
    assert.equal(effect.dangerousWrite, false, command);
  }
  for (const command of [
    'curl -X POST https://api.example.com/send -d to=a@example.com',
    'netlify deploy --prod --site abc',
    'npx netlify-cli sites:create --name client-snapshot',
    'git push origin main',
    'npm publish',
    'sf data create record --sobject Account --values "Name=Acme"',
    'kubectl apply -f deployment.yaml',
  ]) {
    const effect = classifyRuntimeToolEffect('run_shell_command', { command });
    assert.equal(effect.effect, 'external_write', command);
    assert.equal(effect.dangerousWrite, true, command);
  }
});

test('shell effects inspect only literal sh/bash/zsh command payloads', () => {
  for (const command of [
    "bash -lc 'curl -X POST https://api.example.com/send -d x=1'",
    `sh -c "git push origin main"`,
    `zsh -lc "bash -c 'npm publish'"`,
    `env FOO=x bash -lc "curl -X POST https://api.example.com/send -d x=1"`,
    `/usr/bin/env -i sh -c "git push origin main"`,
    `exec bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `nohup bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `nice sh -c "git push origin main"`,
    `time bash -c "curl -X POST https://api.example.com/send -d x=1"`,
    `sudo bash -c "curl -X POST https://api.example.com/send -d x=1"`,
  ]) {
    assert.equal(classifyRuntimeToolEffect('run_shell_command', { command }).effect, 'external_write', command);
  }
  for (const command of [
    "bash -lc 'rm -rf dist'",
    `zsh -c "git commit -m release"`,
    `command bash -c "rm -rf dist"`,
    `timeout 30s bash -c "rm -rf dist"`,
    `env -S "bash -lc 'curl -X POST https://api.example.com/send -d x=1'"`,
  ]) {
    assert.equal(classifyRuntimeToolEffect('run_shell_command', { command }).effect, 'local_write', command);
  }
  for (const command of [
    "bash -lc 'npm test -- --runInBand'",
    `zsh -c "npx tsc --noEmit"`,
    `sh -lc "ffmpeg -i a.mov b.mp4"`,
    `env NODE_ENV=test bash -lc "npm test -- --runInBand"`,
    `command zsh -c "npx tsc --noEmit"`,
    `timeout 30s bash -c "npx tsc --noEmit"`,
    `time -p bash -c "npm test -- --runInBand"`,
    `nice bash -c "ffmpeg -i a.mov b.mp4"`,
    `echo "bash -lc 'curl -X POST https://example.com -d x=1'"`,
    `echo "env FOO=x bash -lc 'curl -X POST https://example.com -d x=1'"`,
  ]) {
    assert.equal(classifyRuntimeToolEffect('run_shell_command', { command }).effect, 'compute', command);
  }
  assert.equal(
    classifyRuntimeToolEffect('run_shell_command', { command: `bash -lc "$RUNTIME_COMMAND"` }).effect,
    'local_write',
    'dynamic shell code is opaque, not trusted compute',
  );
});

test('accounting metadata decodes hook arguments and exposes the inner provider action', () => {
  withCurrentExternalEffects([
    {
      operationId: 'HUBSPOT_FIND_OR_CREATE_CONTACT',
      providerKind: 'composio',
      effect: 'external_write',
      reversibility: 'reversible',
    },
    { operationId: 'DATAFORSEO_CREATE_SERP_TASK_POST', providerKind: 'composio', effect: 'read' },
  ], () => {
    assert.deepEqual(runtimeToolAccountingMetadata(
      'composio_execute_tool',
      JSON.stringify({ tool_slug: 'HUBSPOT_FIND_OR_CREATE_CONTACT', arguments: '{}' }),
    ), {
      effect: 'external_write',
      effectiveTool: 'HUBSPOT_FIND_OR_CREATE_CONTACT',
      toolSlug: 'HUBSPOT_FIND_OR_CREATE_CONTACT',
      reversibility: 'reversible',
      recoverySemantics: {
        version: 1,
        operationId: 'HUBSPOT_FIND_OR_CREATE_CONTACT',
        manifestDigest: capabilityManifestDigest(externalEffectManifest({
          operationId: 'HUBSPOT_FIND_OR_CREATE_CONTACT',
          providerKind: 'composio',
          effect: 'external_write',
          reversibility: 'reversible',
        })),
        basis: 'reversible_operation',
      },
    });
    assert.deepEqual(runtimeToolAccountingMetadata(
      'mcp__clementine-local__composio_execute_tool',
      { tool_slug: 'DATAFORSEO_CREATE_SERP_TASK_POST' },
    ), {
      effect: 'read',
      toolSlug: 'DATAFORSEO_CREATE_SERP_TASK_POST',
    }, 'a current manifest supplies effect, while missing inner arguments mint no execution identity');
  });
});

test('accounting durably captures exact-artifact repair authority from the current manifest', () => {
  withCurrentExternalEffects([{
    operationId: 'GOOGLESHEETS_BATCH_UPDATE',
    providerKind: 'composio',
    effect: 'external_write',
    // Matches the live proof-provisioned manifest: no general reversibility
    // declaration, but current exact-artifact reconciliation + idempotency and
    // an actual reconcile port are all present.
    exactArtifactRecovery: true,
  }], () => {
    const metadata = runtimeToolAccountingMetadata('composio_execute_tool', {
      tool_slug: 'GOOGLESHEETS_BATCH_UPDATE',
      arguments: JSON.stringify({
        spreadsheet_id: 'sheet-live-shape',
        sheet_name: 'Daily Digest',
        first_cell_location: 'H40',
        value_input_option: 'RAW',
        values: [['23:59']],
      }),
      connected_account_id: null,
    });
    assert.equal(metadata.reversibility, undefined, 'exact reconciliation is not mislabeled reversible');
    assert.deepEqual(metadata.recoverySemantics, {
      version: 1,
      operationId: 'GOOGLESHEETS_BATCH_UPDATE',
      manifestDigest: capabilityManifestDigest(
        externalEffectManifest({
          operationId: 'GOOGLESHEETS_BATCH_UPDATE',
          providerKind: 'composio',
          effect: 'external_write',
          exactArtifactRecovery: true,
        }),
      ),
      basis: 'exact_artifact_reconciliation',
    });
  });
});

test('accounting does not mint repair authority for irreversible or unreconciled mutations', () => {
  withCurrentExternalEffects([
    {
      operationId: 'GMAIL_SEND_EMAIL',
      providerKind: 'composio',
      effect: 'external_write',
      reversibility: 'irreversible',
      exactArtifactRecovery: true,
    },
    {
      operationId: 'CRM_MUTATE_UNKNOWN',
      providerKind: 'composio',
      effect: 'external_write',
    },
  ], () => {
    assert.equal(runtimeToolAccountingMetadata('composio_execute_tool', {
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: '{}',
    }).recoverySemantics, undefined);
    assert.equal(runtimeToolAccountingMetadata('composio_execute_tool', {
      tool_slug: 'CRM_MUTATE_UNKNOWN',
      arguments: '{}',
    }).recoverySemantics, undefined);
  });
});

test('effective lifecycle identity collapses only trusted local carriers', () => {
  assert.equal(
    runtimeToolAccountingMetadata('mcp__clementine-local__workflow_run', {}).effectiveTool,
    'workflow_run',
  );
  assert.equal(
    runtimeToolAccountingMetadata('mcp__server_a__workflow_run', {}).effectiveTool,
    'server_a__workflow_run',
  );
  assert.equal(
    runtimeToolAccountingMetadata('server_b__workflow_run', {}).effectiveTool,
    'server_b__workflow_run',
  );
  assert.equal(
    runtimeToolAccountingMetadata('call_tool', {
      name: 'mcp__server_a__workflow_run',
      args_json: '{}',
    }).effectiveTool,
    'server_a__workflow_run',
  );
  assert.equal(
    runtimeToolAccountingMetadata('mcp__server_a__call_tool', {
      name: 'workflow_run',
      args_json: '{}',
    }).effectiveTool,
    'server_a__call_tool',
    'a foreign wrapper cannot shed its namespace by impersonating call_tool',
  );
  assert.equal(
    runtimeToolAccountingMetadata('mcp__server_a__composio_execute_tool', {
      tool_slug: 'workflow_run',
    }).effectiveTool,
    'server_a__composio_execute_tool',
    'a foreign wrapper cannot shed its namespace by impersonating Composio',
  );
  for (const malformed of [
    'mcp__call_tool',
    'mcp__clementine-local__evil__call_tool',
  ]) {
    const metadata = runtimeToolAccountingMetadata(malformed, {
      name: 'workflow_run',
      args_json: '{}',
    });
    assert.equal(metadata.effect, 'external_write', malformed);
    assert.notEqual(metadata.effectiveTool, 'workflow_run', malformed);
  }
  assert.equal(
    runtimeToolAccountingMetadata('call_tool', {
      name: 'x'.repeat(257),
      args_json: '{}',
    }).effectiveTool,
    undefined,
    'model-supplied carrier names cannot create unbounded lifecycle metadata',
  );
});

test('the workflow step result channel is a registered read-effect host control, never effect_unknown', () => {
  // Live 2026-09-01 (platform-49 run 5b1e0b): every business write crossed,
  // then workflow_step_result was refused effect_unknown twice and the
  // finished step blocked on the no-progress governor.
  assert.deepEqual(classifyRuntimeToolEffect('workflow_step_result', { data: { rows: [] } }), {
    effect: 'read',
    mutating: false,
    dangerousWrite: false,
    source: 'registry',
  });
  assert.equal(actionTopologyRoleForRuntimeCall('workflow_step_result', { data: {} }), 'control');
});

test('a provider operation named in the composio:SLUG form classifies by its slug, never as unknown', () => {
  // Live 2026-09-08: work_call named composio:OUTLOOK_GET_CALENDAR_VIEW (a
  // documented read) was refused twice as effect_unknown.
  assert.equal(classifyRuntimeToolEffect('composio:OUTLOOK_GET_CALENDAR_VIEW', {}).effect, 'read');
  assert.equal(classifyRuntimeToolEffect('composio:OUTLOOK_GET_CALENDAR_VIEW', {}).source, 'composio');
  assert.equal(classifyRuntimeToolEffect('composio:OUTLOOK_SEND_EMAIL', {}).effect, 'external_write');
});
