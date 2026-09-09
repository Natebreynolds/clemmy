import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { RunContext } from '@openai/agents';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-native-read-catalog-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.CLEMMY_TEST_DISABLE_LIVE_MODELS = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.CLEMMY_CODEX_TOOL_SEARCH = 'on';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
mkdirSync(path.join(home, 'state'), { recursive: true });

const log = await import('../runtime/harness/eventlog.js');
const { buildOrchestratorAgent } = await import('./orchestrator.js');
const { primePrimaryModelPlanningCatalog } = await import('../runtime/semantic-boundary/admit-and-compile-accepted-source.js');
const { boundAgentCapabilityEnvelope, boundAgentCapabilityRevision, toolSchemaFingerprint } = await import('./capability-envelope.js');
const { isRegistryDeclaredRead } = await import('../tools/tool-registry.js');
const { buildScopedLocalToolSearch } = await import('../tools/local-runtime-tools.js');

after(() => { log.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

async function fixture(mode: 'normal' | 'plan', options: {
  userInput?: string;
  excludeToolNames?: string[];
  allowedToolNames?: string[];
} = {}) {
  const session = log.createSession({ kind: 'chat', userId: 'native-reader-owner' });
  const text = options.userInput ?? 'Prepare a new manual workflow from my supplied text and inspect its definition.';
  const source = log.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text, taskMode: { version: 1, kind: mode } } });
  const primed = await primePrimaryModelPlanningCatalog({ sessionId: session.id, sourceUserSeq: source.seq, turn: 1 });
  assert.ok(primed.ok);
  if (!primed.ok) throw new Error('planning fixture unavailable');
  const agent = await buildOrchestratorAgent({ sessionId: session.id, sourceUserSeq: source.seq,
    userInput: text, acceptedRoute: 'act', allowToolJit: true, hostFreshPlanning: primed.planning,
    ...(options.excludeToolNames ? { excludeToolNames: options.excludeToolNames } : {}),
    ...(options.allowedToolNames ? { allowedToolNames: options.allowedToolNames } : {}) });
  const before = { envelope: JSON.stringify(boundAgentCapabilityEnvelope(agent)),
    revision: JSON.stringify(boundAgentCapabilityRevision(agent)),
    schemas: agent.tools.map(toolSchemaFingerprint) };
  const instructions = typeof agent.instructions === 'function'
    ? String(await agent.instructions(new RunContext({}), agent)) : String(agent.instructions);
  const match = instructions.match(/\[native-read-catalog\][^\n]*\n(?:- [^\n]+(?:\n|$))+/);
  const block = match?.[0].trimEnd() ?? '';
  const names = block.split('\n').slice(1).flatMap(line => line.slice(2).split(', '));
  const authoringBlock = instructions.match(/\[native-authoring-catalog\][^\n]*\n(?:- [^\n]+(?:\n|$))+/)?.[0].trimEnd() ?? '';
  const authoringNames = authoringBlock.split('\n').slice(1).flatMap(line => line.slice(2).split(', '));
  const entireCatalog = [block, authoringBlock].filter(Boolean).join('\n');
  assert.deepEqual({ envelope: JSON.stringify(boundAgentCapabilityEnvelope(agent)),
    revision: JSON.stringify(boundAgentCapabilityRevision(agent)),
    schemas: agent.tools.map(toolSchemaFingerprint) }, before, 'rendering the index cannot acquire tools or change authority/schema bytes');
  const scope = log.listEvents(session.id, { types: ['tool_search_scope'] }).at(-1)!.data;
  assert.equal(scope.catalogCount, names.length + authoringNames.length);
  assert.equal(scope.catalogBytes, Buffer.byteLength(entireCatalog));
  assert.equal(scope.estCatalogTokens, Math.round(entireCatalog.length / 4));
  return { agent, block, names, instructions, authoringNames };
}

for (const mode of ['normal', 'plan'] as const) {
  test(`${mode}: real fresh-host instructions expose deferred native readers without adding schemas or authority`, async () => {
    const f = await fixture(mode);
    assert.ok(f.authoringNames.includes('workflow_create'));
    assert.ok(f.authoringNames.includes('write_file'));
    assert.equal(f.agent.tools.some(tool => tool.name === 'write_file'), false, 'native authoring stays behind its existing carrier');
    assert.ok(f.names.includes('workflow_get'));
    assert.ok(f.names.includes('space_get_view'));
    assert.match(f.block, /call_tool/);
    assert.match(f.block, /tool_search with that exact name/);
    assert.doesNotMatch(f.block, /cap:|\b(?:workflow_create|workflow_update|workflow_run|space_save)\b/);
    for (const omitted of ['notify_user', 'dispatch_background_task', 'hold_task_for_later',
      'composio_search_tools', 'composio_list_tools', 'mcp_list_tools']) {
      assert.equal(f.names.includes(omitted), false, `${omitted} must not be presented as a native lookup`);
    }
    const envelope = boundAgentCapabilityEnvelope(f.agent)!;
    const revision = boundAgentCapabilityRevision(f.agent)!;
    for (const name of f.names) {
      assert.ok(isRegistryDeclaredRead(name), `${name} is not a registered read`);
      assert.ok(envelope.capabilities.some(capability => capability.name === name), `${name} is not reachable`);
      assert.equal(f.agent.tools.some(tool => tool.name === name), false, `${name} was promoted to a schema`);
      assert.equal(revision.bound.includes(name), false, `${name} was acquired by presentation`);
    }
    if (mode === 'plan') {
      assert.match(f.instructions, /\[explicit-plan-mode\]/);
      assert.equal(f.agent.tools.some(tool => tool.name === 'plan_task'), false);
      assert.ok(f.agent.tools.some(tool => tool.name === 'publish_plan'));
    }
  });
}

test('denied readers and already-first-class readers are absent from the native index', async () => {
  const f = await fixture('normal', {
    userInput: 'Inspect using workflow_get, then continue the requested manual work.',
    excludeToolNames: ['space_get_view'],
  });
  assert.equal(f.names.includes('workflow_get'), false);
  assert.ok(f.agent.tools.some(tool => tool.name === 'workflow_get'));
  assert.equal(f.names.includes('space_get_view'), false);
  assert.equal(f.agent.tools.some(tool => tool.name === 'space_get_view'), false);
});

test('an explicit allowlist cannot advertise denied or phantom deferred readers', async () => {
  const f = await fixture('normal', { allowedToolNames: ['tool_search', 'workflow_get', 'workflow_create'] });
  assert.equal(f.block, '', 'the only allowed read is already first-class');
  assert.deepEqual(f.names, []);
  assert.deepEqual(f.authoringNames, ['workflow_create'], 'the authoring index obeys the same explicit allowlist');
  assert.ok(f.agent.tools.some(tool => tool.name === 'workflow_get'));
  assert.equal(f.agent.tools.some(tool => tool.name === 'space_get_view'), false);
});

test('the advertised exact native schema lookup reaches no connector candidate source', async () => {
  let providerSearches = 0;
  const search = buildScopedLocalToolSearch(new Set(['workflow_get']), 'call_tool', undefined, [{
    kind: 'authorized_composio',
    search: async () => { providerSearches += 1; throw new Error('exact native lookup queried a provider'); },
  }]);
  const result = JSON.parse(String(await search.invoke(new RunContext({}), JSON.stringify({
    query: 'workflow_get', role_key: null, account_selection: null, limit: 8, cursor: null,
  }))));
  assert.equal(providerSearches, 0);
  assert.deepEqual(result.results.map((row: { name: string }) => row.name), ['workflow_get']);
  assert.equal(result.results[0].carrier, 'call_tool');
  assert.deepEqual(result.schemas.workflow_get.required, ['name']);
  assert.equal(result.schemas.workflow_get.additionalProperties, false);
  assert.ok(result.schemas.workflow_get.properties.section);
});
