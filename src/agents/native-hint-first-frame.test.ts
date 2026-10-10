import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-native-first-frame-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(home, 'state'), { recursive: true });
writeFileSync(path.join(home, 'state', 'machine-id'), 'machine-native-first-frame\n');

const log = await import('../runtime/harness/eventlog.js');
const semantic = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const local = await import('../runtime/harness/local-planning-capability.js');
const envelopes = await import('./capability-envelope.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifests = await import('../runtime/harness/capability-manifest-store.js');
const brackets = await import('../runtime/harness/brackets.js');
const expectedWork = await import('../runtime/harness/expected-work-contract.js');
const { inlineResultBudgetForModel } = await import('../runtime/harness/tool-output-format.js');
const { buildScopedLocalToolSearch } = await import('../tools/local-runtime-tools.js');
const { buildWorkCall } = await import('../tools/work-call.js');
const { hostRunRunner } = await import('../runtime/harness/host-turn-runner.js');
const { buildOrchestratorAgent, projectNativeHintPresentation } = await import('./orchestrator.js');

after(() => {
  local._setConfiguredLocalPlanningToolObserverForTests(null);
  catalogs.installHostCapabilityCatalogFactory(null);
  manifests.installCapabilityManifestStore(null);
  log.closeEventLog();
  rmSync(home, { recursive: true, force: true });
});

async function fixture(options: {
  hint?: boolean; oldSourceHint?: boolean; exclude?: string[]; allow?: string[];
  hintName?: string; removedSchema?: boolean; forgedAuthority?: boolean; frozen?: boolean;
  hintNames?: string[]; mode?: 'normal' | 'plan'; objective?: string; model?: string;
  preDisclosed?: string[];
} = {}) {
  const objective = options.objective ?? 'Use the native shell for this controlled local check.';
  const session = log.createSession({ kind: 'chat' });
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user',
    type: 'user_input_received', data: { text: objective, taskMode: { version: 1, kind: options.mode ?? 'normal' } } });
  const identity = { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
  const primed = await semantic.primePrimaryModelPlanningCatalog(identity);
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error(primed.reason);
  for (const preDisclosedName of options.preDisclosed ?? []) {
    const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({
      name: preDisclosedName, carrier: 'work_call', configuredNames: new Set([preDisclosedName]),
    });
    assert.ok(candidate && !('refused' in candidate));
    if (!candidate || 'refused' in candidate) throw new Error('The fixture requires a configured current definition.');
    const published = await semantic.disclosePrimaryModelPlanningCapabilities({
      authority: primed.planning.authority, candidates: [candidate],
    });
    assert.ok(published[preDisclosedName]);
  }
  const name = options.hintName ?? 'run_shell_command';
  const names = options.hintNames ?? [name];
  if (options.hint !== false) log.appendEvent({ sessionId: session.id, turn: 0, role: 'system',
    type: 'proven_operation_selected', data: {
      sourceUserSeq: options.oldSourceHint ? source.seq - 1 : source.seq,
      tools: names, nativeTools: names, skipDiscoverySearch: false, descriptors: [],
    } });
  if (options.frozen) log.appendTurnGraphEventOnce({ ...identity,
    data: { version: 1, sourceUserSeq: source.seq } });
  if (options.removedSchema) local._setConfiguredLocalPlanningToolObserverForTests(() => null);
  let agent;
  try {
    agent = await buildOrchestratorAgent({ ...identity, userInput: objective, allowToolJit: true,
      ...(options.model ? { model: options.model } : {}),
      hostFreshPlanning: options.forgedAuthority
        ? { ...primed.planning, authority: { ...primed.planning.authority } }
        : options.preDisclosed?.length ? semantic.snapshotPrimaryModelPlanningContext(primed.planning.authority)! : primed.planning,
      allowedToolNames: options.allow ?? [name, 'tool_search'], excludeToolNames: options.exclude,
      mcpToolScope: { authority: 'none', reason: 'Controlled native surface',
        allowedServerSlugs: [], toolPatterns: [], maxTools: 0 } });
  } finally { local._setConfiguredLocalPlanningToolObserverForTests(null); }
  return { agent, identity, planning: primed.planning, objective };
}

const contracts = async (agent: Awaited<ReturnType<typeof buildOrchestratorAgent>>) => {
  const instructions = await agent.getSystemPrompt(new RunContext({}));
  const line = String(instructions).split('\n').find(row => row.startsWith('[current-native-contracts]'));
  if (!line) return [];
  const lines = String(instructions).split('\n');
  return JSON.parse(lines[lines.indexOf(line) + 1]!) as Array<{
    name: string; carrier: string; capabilityVariants: Array<{ capabilityRef: string; [key: string]: unknown }>;
    argumentSchema: { properties: Record<string, unknown> };
  }>;
};

/** The turn context's ready list for work_call. */
const readyLine = (system: string) => system.split('\n').find(row => row.startsWith('[work_call ready]')) ?? '';

test('a native first frame preserves an opaque selected model adapter without borrowing the saved brain window', async () => {
  const model = {
    async getResponse() { throw new Error('Preparation must not invoke the model'); },
    async *getStreamedResponse() { throw new Error('Preparation must not invoke the model'); yield {} as never; },
  };
  const f = await fixture({ model: model as never });
  assert.equal(f.agent.model, model);
  const supplied = await contracts(f.agent);
  assert.equal(supplied.length, 1);
  assert.equal(supplied[0]!.name, 'run_shell_command');
  const instructions = String(await f.agent.getSystemPrompt(new RunContext({})));
  const envelope = instructions.slice(instructions.indexOf('[current-native-contracts]')).split('\n').slice(0, 2).join('\n');
  assert.ok(envelope.length <= inlineResultBudgetForModel(undefined));
});

async function currentSchemaWithDescription(name: string, chars: number) {
  const observed = await local.observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
  assert.ok(observed.ok, JSON.stringify(observed));
  if (!observed.ok) throw new Error(observed.reason);
  return { ...observed.schema, description: 'x'.repeat(chars) };
}

const schemaObserver = (schemas: Record<string, Record<string, unknown>>) => (name: string) => (
  schemas[name] ? { name, parameters: schemas[name], workCallLocalDispatch: true } : null
);

async function exactDiscoveryAfterBudget(f: Awaited<ReturnType<typeof fixture>>, name: string) {
  const search = buildScopedLocalToolSearch(new Set([name]), 'work_call', undefined, undefined,
    candidates => semantic.disclosePrimaryModelPlanningCapabilities({ authority: f.planning.authority, candidates }));
  const context = new RunContext({ sessionId: f.identity.sessionId });
  const invoke = async (cursor: string | null) => JSON.parse(String(await search.invoke(context,
    JSON.stringify({ query: name, role_key: null, limit: 8, account_selection: null, cursor }))));
  const result = await invoke(null);
  const row = result.results.find((entry: { name: string }) => entry.name === name);
  const ref = row?.capabilityRef ?? row?.capabilityVariants?.[0]?.capabilityRef;
  assert.ok(ref, `exact discovery must return a selectable current ref for ${name}`);
  // Normal discovery may retain a compact inline preview. Its explicit read
  // requirement means reopen the authenticated lossless handle before use.
  let schema = result.schema_read_required?.includes(name) ? undefined : result.schemas[name];
  if (!schema) {
    let cursor = result.schema_handles[name].cursor;
    let text = '';
    for (let chunks = 0; cursor && chunks < 8; chunks++) {
      const page = await invoke(cursor);
      if (page.schema) { schema = page.schema; break; }
      text += page.chunk;
      cursor = page.next_cursor;
      if (page.complete) schema = JSON.parse(text);
    }
  }
  assert.ok(schema, 'normal discovery must retain a complete lossless schema');
  return { ref: ref as string, schema };
}

test('hinted native business contract is complete and source-owned before the first model frame', async () => {
  const f = await fixture();
  assert.ok(!f.agent.tools.some(tool => tool.name === 'run_shell_command'), 'business stays deferred');
  const rows = await contracts(f.agent);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, 'run_shell_command');
  assert.equal(rows[0]!.carrier, 'work_call');
  assert.deepEqual(Object.keys(rows[0]!.argumentSchema.properties).sort(), ['command', 'cwd', 'timeout_ms']);
  const ref = 'cap:local:run_shell_command:ordinary';
  assert.equal(rows[0]!.capabilityVariants[0]!.capabilityRef, ref);
  const instructions = String(await f.agent.getSystemPrompt(new RunContext({})));
  const line = instructions.split('\n').find(row => row.startsWith('[current-native-contracts]'))!;
  assert.match(line, /For a direct call without a frozen requirement, use the matching capabilityRef as requirement_id/);
  assert.match(line, /After plan_task activates a plan, use that plan's exact requirement id for required steps/);
  assert.match(line, /capabilityRef remains the schema\/definition reference/);
  assert.match(line, /Supplemental contextual reads may use their capabilityRef without claiming completion of a required step/);
  assert.doesNotMatch(f.agent.tools.find(tool => tool.name === 'work_call')!.description, new RegExp(ref),
    'the exact eager ref is not repeated in carrier READY prose');
  assert.doesNotMatch(readyLine(instructions), new RegExp(ref), 'nor in the turn\'s ready list');
  assert.equal(rows[0]!.capabilityVariants[0]!.effect, 'local_write');
  assert.equal(rows[0]!.capabilityVariants[0]!.purpose, 'run_local_command');
  assert.equal(rows[0]!.capabilityVariants[0]!.deliverableKind, 'local_command');
  assert.deepEqual(rows[0]!.capabilityVariants[0]!.destinationPostures, []);
  const current = await local.loadDurableAuthorizedLocalPlanningDefinition({ ...f.identity, capabilityRef: ref });
  assert.ok(current.ok, JSON.stringify(current));
  if (!current.ok) throw new Error(current.reason);
  assert.ok(local.nominateDisclosedLocalPlanningDefinition({ ...f.identity, capabilityRef: ref,
    operationId: 'run_shell_command', effect: 'local_write', args: { command: 'printf 7', cwd: null, timeout_ms: null } }));
  assert.equal(log.getTurnGraphEventForSource(f.identity.sessionId, f.identity.sourceUserSeq), null);
  for (const table of ['physical_dispatches', 'host_call_capability_bindings', 'pending_approvals']) {
    assert.equal((log.openEventLog().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`)
      .get(f.identity.sessionId) as { n: number }).n, 0, `${table}: disclosure is not dispatch/consent`);
  }
  const before = envelopes.boundAgentCapabilityEnvelope(f.agent)!;
  const rebuilt = await buildOrchestratorAgent({ ...f.identity, userInput: f.objective, allowToolJit: true,
    hostFreshPlanning: semantic.snapshotPrimaryModelPlanningContext(f.planning.authority)!,
    allowedToolNames: ['run_shell_command', 'tool_search'],
    mcpToolScope: { authority: 'none', reason: 'Controlled native surface',
      allowedServerSlugs: [], toolPatterns: [], maxTools: 0 } });
  assert.equal(envelopes.boundAgentCapabilityEnvelope(rebuilt)?.envelopeDigest, before.envelopeDigest,
    'publication state does not alter the immutable callable universe');
  assert.doesNotMatch(rebuilt.tools.find(tool => tool.name === 'work_call')!.description, new RegExp(ref),
    'same-source rebuild also filters the original staged disclosure');
  assert.doesNotMatch(readyLine(String(await rebuilt.getSystemPrompt(new RunContext({})))), new RegExp(ref));
  assert.equal((await contracts(rebuilt))[0]!.capabilityVariants[0]!.purpose, 'run_local_command');
});

for (const [label, options] of [
  ['absent hint', { hint: false }],
  ['another accepted source', { oldSourceHint: true }],
  ['outside allowlist', { allow: ['read_file', 'tool_search'] }],
  ['excluded native name', { exclude: ['run_shell_command'] }],
  ['padded native exclusion', { exclude: [' run_shell_command '] }],
  ['excluded carrier', { exclude: ['work_call'] }],
  ['padded carrier exclusion', { exclude: [' work_call '] }],
  ['padded allowlist cannot widen the actual dispatcher', { allow: [' run_shell_command ', 'tool_search'] }],
  ['missing current schema', { removedSchema: true }],
  ['forged authority', { forgedAuthority: true }],
  ['already frozen graph', { frozen: true }],
  ['admin declaration', { hintName: 'mcp_configure' }],
  ['unregistered hint', { hintName: 'forged_native_body' }],
] as const) test(`${label} cannot manufacture a ready native contract`, async () => {
  const f = await fixture(options);
  assert.deepEqual(await contracts(f.agent), []);
  assert.equal(log.listEvents(f.identity.sessionId, { types: ['capability_discovered'] }).length, 0);
});

test('explicit Plan retains the schema and ref for publish_plan without an execution instruction', async () => {
  const f = await fixture({ mode: 'plan' });
  const rows = await contracts(f.agent);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, 'run_shell_command');
  assert.deepEqual(Object.keys(rows[0]!.argumentSchema.properties).sort(), ['command', 'cwd', 'timeout_ms']);
  const instructions = await f.agent.getSystemPrompt(new RunContext({}));
  const line = String(instructions).split('\n').find(row => row.startsWith('[current-native-contracts]'))!;
  assert.match(line, /prepare publish_plan/);
  assert.match(line, /Do not execute these business operations during Plan/);
  assert.doesNotMatch(line, /Invoke the selected operation|as requirement_id/);
  assert.doesNotMatch(f.agent.tools.find(tool => tool.name === 'work_call')?.description ?? '',
    /cap:local:run_shell_command:ordinary/, 'new Plan disclosure is not described as ordinary ready execution');
  assert.doesNotMatch(readyLine(String(instructions)), /cap:local:run_shell_command:ordinary/);
  assert.equal(rows[0]!.capabilityVariants[0]!.effect, undefined,
    'Plan keeps its preparation-only presentation unchanged');
  assert.ok(f.agent.tools.some(tool => tool.name === 'publish_plan'));
  assert.equal(log.getTurnGraphEventForSource(f.identity.sessionId, f.identity.sourceUserSeq), null);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(f.identity.sessionId) as { n: number }).n, 0);
});

test('unhinted same-source READY refs remain while a complete eager ref is presented once', async () => {
  const f = await fixture({ preDisclosed: ['write_file', 'run_shell_command'],
    allow: ['write_file', 'run_shell_command', 'tool_search'] });
  const rows = await contracts(f.agent);
  assert.deepEqual(rows.map(row => row.name), ['run_shell_command']);
  const ready = readyLine(String(await f.agent.getSystemPrompt(new RunContext({}))));
  assert.doesNotMatch(ready, /cap:local:run_shell_command:ordinary/);
  for (const variant of ['create', 'append', 'overwrite', 'replace']) {
    assert.match(ready, new RegExp(`cap:local:write_file:${variant}`));
  }
  assert.doesNotMatch(f.agent.tools.find(tool => tool.name === 'work_call')!.description, /cap:local:/,
    'the ready list rides the turn context, never work_call\'s definition');
});

test('an oversized already-disclosed hint retains its exact carrier presentation', async () => {
  const model = 'gpt-6.1-sol';
  const schema = await currentSchemaWithDescription('run_shell_command', inlineResultBudgetForModel(model));
  local._setConfiguredLocalPlanningToolObserverForTests(schemaObserver({ run_shell_command: schema }));
  const f = await fixture({ model, preDisclosed: ['run_shell_command'] });
  assert.deepEqual(await contracts(f.agent), []);
  assert.match(readyLine(String(await f.agent.getSystemPrompt(new RunContext({})))),
    /cap:local:run_shell_command:ordinary/, 'only a fully emitted contract can replace an existing READY row');
});

test('partially owned multi-variant presentation omits only visible exact refs', async () => {
  const f = await fixture({ hintName: 'write_file' });
  const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({
    name: 'write_file', carrier: 'work_call', configuredNames: new Set(['write_file']),
  });
  assert.ok(candidate && !('refused' in candidate));
  if (!candidate || 'refused' in candidate) throw new Error('The fixture needs the exact write definition.');
  const refs = new Set(candidate.capabilityVariants.map(variant => variant.capabilityRef));
  const owned = semantic.snapshotPrimaryModelSelectedStagedPlanningDescriptors({
    authority: f.planning.authority, identity: f.identity, selectedRefs: refs,
  });
  assert.equal(owned.length, 4);
  const subset = owned.filter(descriptor => /:(create|append)$/.test(descriptor.id));
  const presentation = projectNativeHintPresentation({ instructions: '[current-native-contracts]\n',
    candidates: [candidate], owned: subset, disclosedOperations: owned,
    budget: inlineResultBudgetForModel('gpt-6.1-sol'), planMode: false });
  const row = JSON.parse(presentation.contracts!.split('\n')[1]!)[0];
  assert.deepEqual(row.capabilityVariants.map((variant: { capabilityRef: string }) => variant.capabilityRef).sort(),
    ['cap:local:write_file:append', 'cap:local:write_file:create']);
  assert.deepEqual(row.argumentSchema, candidate.schema);
  assert.ok(row.capabilityVariants.every((variant: { effect: string; purpose: string }) =>
    variant.effect === 'local_write' && Boolean(variant.purpose)));
  assert.deepEqual(presentation.disclosedOperations.map(descriptor => descriptor.id).sort(),
    ['cap:local:write_file:overwrite', 'cap:local:write_file:replace']);
  const plan = projectNativeHintPresentation({ instructions: '[current-native-contracts]\n',
    candidates: [candidate], owned: subset, disclosedOperations: owned,
    budget: inlineResultBudgetForModel('gpt-6.1-sol'), planMode: true });
  assert.deepEqual(plan.disclosedOperations, owned, 'Plan does not suppress or advertise new execution READY refs');
});

test('semantic facts keep their READY row when they do not fit beside the complete schema', async () => {
  const f = await fixture();
  const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({
    name: 'run_shell_command', carrier: 'work_call', configuredNames: new Set(['run_shell_command']),
  });
  assert.ok(candidate && !('refused' in candidate));
  if (!candidate || 'refused' in candidate) throw new Error('The fixture needs the exact shell definition.');
  const owned = semantic.snapshotPrimaryModelSelectedStagedPlanningDescriptors({
    authority: f.planning.authority, identity: f.identity,
    selectedRefs: new Set(candidate.capabilityVariants.map(variant => variant.capabilityRef)),
  });
  const instructions = '[current-native-contracts]\n';
  const base = [{ name: candidate.name, carrier: candidate.carrier,
    capabilityVariants: candidate.capabilityVariants, argumentSchema: candidate.schema }];
  const budget = instructions.length + JSON.stringify(base).length;
  const presentation = projectNativeHintPresentation({ instructions, candidates: [candidate], owned,
    disclosedOperations: owned, budget, planMode: false });
  assert.equal(presentation.contracts, instructions + JSON.stringify(base));
  assert.deepEqual(presentation.disclosedOperations, owned, 'purpose/effect cannot disappear to save bytes');
});

test('deduplication reduces serialized presentation while keeping the exact callable schema', async () => {
  const f = await fixture();
  const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({
    name: 'run_shell_command', carrier: 'work_call', configuredNames: new Set(['run_shell_command']),
  });
  assert.ok(candidate && !('refused' in candidate));
  if (!candidate || 'refused' in candidate) throw new Error('The fixture needs the exact shell definition.');
  const owned = semantic.snapshotPrimaryModelSelectedStagedPlanningDescriptors({
    authority: f.planning.authority, identity: f.identity,
    selectedRefs: new Set(candidate.capabilityVariants.map(variant => variant.capabilityRef)),
  });
  const actual = f.agent.tools.find(tool => tool.name === 'work_call')!;
  // Reconstruct only the prior 049 presentation on this same fixture: it
  // listed these exact owned descriptors in READY and emitted the base row.
  // This is a serialized definition comparison, not a provider/latency run.
  const prior = buildWorkCall({ requireHostPlan: true, disclosedOperations: owned });
  assert.deepEqual(actual.parameters, prior.parameters, 'the callable carrier contract is byte-equivalent');
  const system = String(await f.agent.getSystemPrompt(new RunContext({})));
  const lines = system.split('\n');
  const index = lines.findIndex(line => line.startsWith('[current-native-contracts]'));
  assert.ok(index >= 0);
  const afterBlock = `${lines[index]}\n${lines[index + 1]}`;
  const beforeBlock = `${lines[index]}\n${JSON.stringify([{ name: candidate.name,
    carrier: candidate.carrier, capabilityVariants: candidate.capabilityVariants, argumentSchema: candidate.schema }])}`;
  const beforeSystem = system.replace(afterBlock, beforeBlock);
  const projectedTools = (priorDescription: boolean) => f.agent.tools.map(tool => ({
    type: tool.type, name: tool.name,
    description: priorDescription && tool.name === 'work_call' ? prior.description : tool.description,
    parameters: tool.type === 'function' ? tool.parameters : undefined,
  }));
  const beforePrompt = JSON.stringify({ system: beforeSystem, tools: projectedTools(true), input: f.objective });
  const afterPrompt = JSON.stringify({ system, tools: projectedTools(false), input: f.objective });
  const evidence = (description: string, block: string, prompt: string) => ({
    workCallDescription: description,
    workCallDescriptionBytes: Buffer.byteLength(description, 'utf8'),
    eagerContractBlock: block,
    eagerContractBlockBytes: Buffer.byteLength(block, 'utf8'),
    serializedPromptBytes: Buffer.byteLength(prompt, 'utf8'),
    serializedPromptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
  });
  const before = evidence(prior.description, beforeBlock, beforePrompt);
  const after = evidence(actual.description, afterBlock, afterPrompt);
  assert.ok(after.workCallDescriptionBytes < before.workCallDescriptionBytes);
  assert.ok(after.serializedPromptBytes < before.serializedPromptBytes,
    'moving semantic facts once must save aggregate presentation bytes');
  const output = path.resolve('output/harness-latency/native-hint-dedup-presentation.json');
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({
    kind: 'same_fixture_serialized_presentation_comparison',
    prior: 'Reconstructed installed-049 READY and eager-base-row presentation on this exact current fixture.',
    candidate: 'Actual built Agent definition and system prompt after presentation-only deduplication.',
    source: f.identity, envelopeDigest: envelopes.boundAgentCapabilityEnvelope(f.agent)!.envelopeDigest,
    parameterSchemaSha256: createHash('sha256').update(JSON.stringify(actual.parameters)).digest('hex'),
    before, after, savedSerializedPromptBytes: before.serializedPromptBytes - after.serializedPromptBytes,
    limits: 'No model/provider calls or timing measurement. The prompt projection is system plus Agent tool definitions plus input, not an exact provider wire transcript.',
  }, null, 2) + '\n');
});

for (const mode of ['normal', 'plan'] as const) test(`${mode} omits an oversized eager schema and retains exact discovery`, async () => {
  const model = 'gpt-6.1-sol';
  const budget = inlineResultBudgetForModel(model);
  const schema = await currentSchemaWithDescription('run_shell_command', budget);
  const observe = schemaObserver({ run_shell_command: schema });
  local._setConfiguredLocalPlanningToolObserverForTests(observe);
  const f = await fixture({ mode, model });
  assert.deepEqual(await contracts(f.agent), [], 'an oversized schema is neither clipped nor advertised');
  assert.equal(log.listEvents(f.identity.sessionId, { types: ['capability_discovered'] }).length, 0,
    'budget selection precedes authority publication');
  assert.doesNotMatch(f.agent.tools.find(tool => tool.name === 'work_call')?.description ?? '',
    /cap:local:run_shell_command:ordinary/, 'an omitted schema cannot masquerade as ready');
  assert.ok(f.agent.tools.some(tool => tool.name === 'tool_search'));
  local._setConfiguredLocalPlanningToolObserverForTests(observe);
  try {
    const discovered = await exactDiscoveryAfterBudget(f, 'run_shell_command');
    assert.equal(discovered.ref, 'cap:local:run_shell_command:ordinary');
    assert.deepEqual(discovered.schema, schema);
    assert.ok((await local.loadDurableAuthorizedLocalPlanningDefinition({ ...f.identity,
      capabilityRef: discovered.ref })).ok, 'exact discovery still publishes this current source\'s definition');
  } finally { local._setConfiguredLocalPlanningToolObserverForTests(null); }
  assert.equal(log.getTurnGraphEventForSource(f.identity.sessionId, f.identity.sourceUserSeq), null);
  assert.equal((log.openEventLog().prepare('SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ?')
    .get(f.identity.sessionId) as { n: number }).n, 0, 'discovery does not grant execution');
});

test('multiple complete eager contracts share one presentation budget', async () => {
  const model = 'gpt-6.1-sol';
  const budget = inlineResultBudgetForModel(model);
  const shell = await currentSchemaWithDescription('run_shell_command', Math.floor(budget * 0.55));
  const file = await currentSchemaWithDescription('write_file', Math.floor(budget * 0.55));
  const observe = schemaObserver({ run_shell_command: shell, write_file: file });
  local._setConfiguredLocalPlanningToolObserverForTests(observe);
  const f = await fixture({ model, hintNames: ['run_shell_command', 'write_file'],
    allow: ['run_shell_command', 'write_file', 'tool_search'] });
  const rows = await contracts(f.agent);
  assert.deepEqual(rows.map(row => row.name), ['run_shell_command']);
  assert.deepEqual(rows[0]!.argumentSchema, shell, 'the admitted schema stays complete');
  const instructions = String(await f.agent.getSystemPrompt(new RunContext({})));
  const lines = instructions.split('\n');
  const index = lines.findIndex(line => line.startsWith('[current-native-contracts]'));
  assert.ok(`${lines[index]}\n${lines[index + 1]}`.length <= budget,
    'the bound includes guidance and the cumulative serialized envelope');
  assert.doesNotMatch(f.agent.tools.find(tool => tool.name === 'work_call')!.description,
    /cap:local:write_file:/, 'the omitted operation is not added to ready execution descriptors');
  const published = log.listEvents(f.identity.sessionId, { types: ['capability_discovered'] })
    .flatMap(row => row.data.capabilities as Array<{ identifier: string }>);
  assert.ok(published.length > 0);
  assert.ok(published.every(row => row.identifier === 'run_shell_command'));
  local._setConfiguredLocalPlanningToolObserverForTests(observe);
  try {
    const discovered = await exactDiscoveryAfterBudget(f, 'write_file');
    assert.match(discovered.ref, /^cap:local:write_file:/);
    assert.deepEqual(discovered.schema, file, 'the omitted complete schema remains discoverable');
  } finally { local._setConfiguredLocalPlanningToolObserverForTests(null); }
});

test('an oversized earlier hint does not prevent a later fitting contract', async () => {
  const model = 'gpt-6.1-sol';
  const budget = inlineResultBudgetForModel(model);
  const shell = await currentSchemaWithDescription('run_shell_command', budget);
  const file = await currentSchemaWithDescription('write_file', 10);
  local._setConfiguredLocalPlanningToolObserverForTests(schemaObserver({ run_shell_command: shell, write_file: file }));
  const f = await fixture({ model, hintNames: ['run_shell_command', 'write_file'],
    allow: ['run_shell_command', 'write_file', 'tool_search'] });
  const rows = await contracts(f.agent);
  assert.deepEqual(rows.map(row => row.name), ['write_file']);
  assert.deepEqual(rows[0]!.argumentSchema, file);
  const published = log.listEvents(f.identity.sessionId, { types: ['capability_discovered'] })
    .flatMap(row => row.data.capabilities as Array<{ identifier: string }>);
  assert.ok(published.length > 0);
  assert.ok(published.every(row => row.identifier === 'write_file'));
});

test('first-frame publication cannot authorize a stale schema or another source', async () => {
  const f = await fixture();
  const ref = 'cap:local:run_shell_command:ordinary';
  const call = { ...f.identity, capabilityRef: ref, operationId: 'run_shell_command', effect: 'local_write' as const,
    args: { command: 'printf 7', cwd: null, timeout_ms: null } };
  const later = log.appendEvent({ sessionId: f.identity.sessionId, turn: 2, role: 'user',
    type: 'user_input_received', data: { text: 'Another task.' } });
  assert.equal(local.nominateDisclosedLocalPlanningDefinition({ ...call, sourceUserSeq: later.seq }), null);
  local._setConfiguredLocalPlanningToolObserverForTests(() => null);
  try {
    assert.equal((await local.loadDurableAuthorizedLocalPlanningDefinition(call)).ok, false,
      'an earlier descriptor cannot survive a removed current schema');
  } finally { local._setConfiguredLocalPlanningToolObserverForTests(null); }
});

test('plan activation separates a supplemental capability read from its required graph node', async () => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const f = await fixture({
    objective: 'Read my current user profile, then create a workflow from it, but show me what you found before writing anything.',
    allow: ['run_shell_command', 'user_profile_read', 'tool_search', 'work_call'],
  });
  const candidate = await local.issueAuthorizedLocalPlanningDisclosureCandidate({
    name: 'user_profile_read', carrier: 'work_call', configuredNames: new Set(['user_profile_read']),
  });
  assert.ok(candidate && !('refused' in candidate), JSON.stringify(candidate));
  if (!candidate || 'refused' in candidate) throw new Error('The fixture needs the exact current reader.');
  const refs = await semantic.disclosePrimaryModelPlanningCapabilities({
    authority: f.planning.authority, candidates: [candidate],
  });
  const ref = refs.user_profile_read!;
  assert.equal(ref, 'cap:local:user_profile_read:read');
  const bindings = () => log.openEventLog().prepare(
    'SELECT requirement_id FROM expected_work_call_bindings WHERE session_id = ?',
  ).all(f.identity.sessionId);
  let calls = 0;
  const model = {
    async getResponse(request: unknown) {
      calls++;
      assert.ok(calls <= 3, 'the synthetic model stops after the exact planned read');
      const prompt = JSON.stringify(request);
      assert.match(prompt, /current-native-contracts/);
      assert.match(prompt, /After plan_task activates a plan/,
        'the same activation retains guidance valid both before and after planning');
      if (calls === 1) return { responseId: 'native-hint-plan-activation', output: [{
        type: 'function_call', callId: 'native-hint-read-plan', name: 'plan_task',
        arguments: JSON.stringify({
          preamble: 'I’ll read your current profile and show you what I find before writing anything.',
          draft: {
            criteria: ['Read the current profile and present it for validation before any write.'],
            cardinality: null, destination: null,
            topology: { version: 1, operations: [{ id: 'read_profile', effect: 'read', coverage: 'single',
              dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } }], universes: [] },
            bindings: [{ operationId: 'read_profile', role: 'source', capabilityRef: ref, evidence: ['tool_result'] }],
            deliverables: [{ id: 'profile_evidence', kind: 'evidence' }], evidenceRequirements: ['tool_result'],
          },
        }),
      }] };
      const contract = expectedWork.loadExpectedWorkContract(f.identity.sessionId, f.identity.sourceUserSeq);
      assert.equal(contract.status, 'ok', prompt);
      if (contract.status !== 'ok') throw new Error('The real settled plan must activate first.');
      assert.deepEqual(contract.contract.operations.map(operation => operation.id), ['read_profile']);
      if (calls === 3) {
        assert.deepEqual(bindings(), [], 'the capability selector read must not claim the required graph node');
        const supplemental = log.openEventLog().prepare(
          'SELECT tool_name, state FROM physical_dispatches WHERE session_id = ? AND tool_name = ?',
        ).all(f.identity.sessionId, 'user_profile_read');
        assert.deepEqual(supplemental, [{ tool_name: 'user_profile_read', state: 'returned' }],
          'the prior call produced supplemental read evidence, not a refusal');
      }
      return { responseId: `native-hint-read-${calls}`, output: [{ type: 'function_call',
        callId: calls === 2 ? 'native-hint-supplemental-read' : 'native-hint-required-read', name: 'work_call',
        arguments: JSON.stringify({ requirement_id: calls === 2 ? ref : 'read_profile',
          name: 'user_profile_read', args_json: '{}', source_call_ids: null, source_record_ids: null,
          universe_item_id: null, universe_selector: null, seal_amendment: null }),
      }] };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: 'tool_calls' } } as never;
      yield { type: 'response_done', response: { id: response.responseId, output: response.output,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
          inputTokensDetails: [], outputTokensDetails: [] } } } as never;
    },
  };
  f.agent.model = model as never;
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('SDK runner is not the owner'); } });
  const outcome = await brackets.withHarnessRunContext({ ...f.identity, counter: new brackets.ToolCallsCounter(4),
    behaviorScopeId: `${f.identity.sessionId}::source:${f.identity.sourceUserSeq}` }, () => hostRunRunner(runner as never,
    f.agent as never, [{ type: 'message', role: 'user', content: f.objective }] as never,
    { maxTurns: 3, hostTurnEngine: 'host_v1', hostJudgeCompletion: false, context: f.identity } as never));
  assert.equal(calls, 3, JSON.stringify(outcome));
  assert.deepEqual(bindings(), [{ requirement_id: 'read_profile' }],
    'only the exact plan ID binds its required operation');
  const requiredSettlement = log.openEventLog().prepare(
    'SELECT outcome_kind, host_crossing_count FROM logical_call_settlements WHERE session_id = ? AND logical_tool_call_id = ?',
  ).get(f.identity.sessionId, 'native-hint-required-read');
  assert.deepEqual(requiredSettlement, { outcome_kind: 'succeeded', host_crossing_count: 1 },
    'the exact plan ID succeeds through the actual host/tool settlement boundary');
  const physical = log.openEventLog().prepare(
    'SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND tool_name = ?',
  ).get(f.identity.sessionId, 'user_profile_read') as { n: number };
  assert.equal(physical.n, 2, 'supplemental and required reads remain distinct physical calls');
});

for (const [label, name, args, expectedCrossings] of [
  ['compute invokes once without a search or hidden graph', 'run_shell_command', { command: 'printf native-first-frame', cwd: null, timeout_ms: null }, 1],
  ['external-effect command retains the graph/consent barrier', 'run_shell_command', { command: 'git push --dry-run', cwd: null, timeout_ms: null }, 0],
  ['admin operation retains the graph/consent barrier', 'mcp_configure', { server_name: 'absent-controlled-peer', description: 'controlled description' }, 0],
] as const) test(`a first-frame native ${label}`, async () => {
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  manifests.installCapabilityManifestStore(manifests.createCapabilityManifestStore());
  const f = await fixture({ hintName: name });
  let calls = 0;
  const requestBodies: unknown[] = [];
  const model = {
    async getResponse(request: unknown) {
      calls++; requestBodies.push(request);
      return { responseId: 'native-first-frame-compute', usage: {
        inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1,
        inputTokensDetails: [], outputTokensDetails: [],
      }, output: [{ type: 'function_call', callId: 'native-first-frame-call', name: 'work_call',
        arguments: JSON.stringify({ requirement_id: `cap:local:${name}:ordinary`,
          name, args_json: JSON.stringify(args),
          source_call_ids: null, source_record_ids: null, universe_item_id: null, universe_selector: null, seal_amendment: null }) }] };
    },
    async *getStreamedResponse(request: unknown) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'model', event: { type: 'finish', finishReason: 'tool_calls' } } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };
  f.agent.model = model as never;
  const runner = Object.assign(new EventEmitter(), { run() { throw new Error('SDK runner is not the owner'); } });
  const outcome = await brackets.withHarnessRunContext({ ...f.identity, counter: new brackets.ToolCallsCounter(2),
    behaviorScopeId: `${f.identity.sessionId}::source:${f.identity.sourceUserSeq}` }, () => hostRunRunner(runner as never,
    f.agent as never, [{ type: 'message', role: 'user', content: f.objective }] as never,
    { maxTurns: 1, hostTurnEngine: 'host_v1', context: f.identity } as never));
  assert.equal(calls, 1, JSON.stringify(outcome));
  if (name === 'run_shell_command') assert.match(JSON.stringify(requestBodies[0]), /current-native-contracts/);
  else assert.doesNotMatch(JSON.stringify(requestBodies[0]), /current-native-contracts/,
    'an admin hint is not announced as an ordinary ready operation');
  const physical = log.openEventLog().prepare(`SELECT tool_name, state FROM physical_dispatches WHERE session_id = ?`)
    .all(f.identity.sessionId);
  assert.deepEqual(physical, expectedCrossings ? [{ tool_name: 'run_shell_command', state: 'returned' }] : [], JSON.stringify(outcome.history));
  const settlements = log.openEventLog().prepare(`SELECT outcome_kind, host_crossing_count FROM logical_call_settlements WHERE session_id = ?`)
    .all(f.identity.sessionId);
  if (expectedCrossings) assert.deepEqual(settlements, [{ outcome_kind: 'succeeded', host_crossing_count: 1 }]);
  else {
    assert.ok(settlements.every(row => (row as { host_crossing_count: number }).host_crossing_count === 0));
    assert.match(JSON.stringify(outcome.history), /plan|work_contract|coverage|scope/i,
      'the native label cannot waive an external effect\'s accepted work authority');
  }
  assert.equal(log.listEvents(f.identity.sessionId, { types: ['tool_called'] }).some(row => row.data.tool === 'tool_search'), false);
  assert.equal(log.getTurnGraphEventForSource(f.identity.sessionId, f.identity.sourceUserSeq), null);
});
