import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ToolSearchBrokerCandidate } from './tool-search-tool.js';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-relevance-'));
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const { deriveOrchestratorDiscoveryNames } = await import('./tool-registry.js');
const { inspectAuthorizedLocalPlanningDisclosureCandidates } = await import('../runtime/harness/local-planning-capability.js');
const frozen = JSON.parse(readFileSync(new URL('./fixtures/native-space-discovery-c8.json', import.meta.url), 'utf8')) as {
  query: string;
  providerCandidates: Array<{ name: string; summary: string }>;
};
const frozenCandidates: ToolSearchBrokerCandidate[] = frozen.providerCandidates.map((candidate, index, all) => ({
  ...candidate, carrier: 'work_call', score: 1 - index / all.length,
}));
const c9 = JSON.parse(readFileSync(new URL('./fixtures/native-space-discovery-c9.json', import.meta.url), 'utf8')) as {
  cases: Array<{ query: string; providerCandidates: Array<{ name: string; summary: string }> }>;
};

async function search(query: string, candidates = frozenCandidates) {
  let handler!: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: deriveOrchestratorDiscoveryNames(),
    dispatchCarrierForName: () => 'work_call',
    candidateSources: [{ kind: 'authorized_composio', search: async () => candidates }],
    async discloseForPlanning(disclosures) {
      return Object.fromEntries(disclosures.flatMap((candidate) => {
        const definitions = inspectAuthorizedLocalPlanningDisclosureCandidates(candidate);
        return definitions?.length ? [[candidate.name, definitions[0]!.capabilityRef]] : [];
      }));
    },
  });
  return JSON.parse((await handler({ query, role_key: 'clause-0:write', limit: 8, account_selection: null, cursor: null })).content[0]!.text);
}

test('the failed live Space query leads with the executable native operation against the frozen provider page', async () => {
  const body = await search(frozen.query);
  assert.equal(body.results[0].name, 'space_save');
  assert.equal(body.results[0].capabilityRef, 'cap:local:space_save:reversible');
  assert.equal(body.results[0].effect, 'local_write');
  assert.deepEqual(body.results[0].invocation, { name: 'space_save', payloadField: null });
  assert.ok(body.schemas.space_save, 'the first page must include the exact native argument schema');
});

test('actual C9 Space creation queries retrieve the native writer using its complete registered metadata', async () => {
  for (const fixture of c9.cases) {
    const candidates: ToolSearchBrokerCandidate[] = fixture.providerCandidates.map((candidate, index, all) => ({
      ...candidate, carrier: 'work_call', score: 1 - index / all.length,
    }));
    const body = await search(fixture.query, candidates);
    assert.equal(body.results[0].name, 'space_save', `${fixture.query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
    assert.equal(body.results[0].capabilityRef, 'cap:local:space_save:reversible');
    assert.ok(body.schemas.space_save);
  }
});

test('native creation remains discoverable across ordinary descriptions of view, title, and phone content', async () => {
  const candidates: ToolSearchBrokerCandidate[] = c9.cases.flatMap(fixture => fixture.providerCandidates)
    .map(candidate => ({ ...candidate, carrier: 'work_call', score: 1 }));
  for (const query of [
    'Create a Workspace with a title and a static HTML view',
    'Build a Space that displays my content on desktop and phone',
    'Save a new workspace with a slug and initial mobile data',
    'Create a native workflow with manual trigger and transform steps',
  ]) {
    const body = await search(query, candidates);
    const expected = query.includes('workflow') ? 'workflow_create' : 'space_save';
    assert.equal(body.results[0].name, expected, `${query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
  }
});

test('ordinary native authoring queries use the same relevance scale as connected operations', async () => {
  for (const [query, expected] of [
    ['create a native workflow definition', 'workflow_create'],
    ['create a Space', 'space_save'],
  ]) {
    const body = await search(query!);
    assert.equal(body.results[0].name, expected, query);
    assert.ok(body.results[0].capabilityRef, query);
  }
});

test('the live Space source-read query exposes the native exact HTML reader', async () => {
  const body = await search('get workspace view html content raw source');
  assert.equal(body.results[0].name, 'space_get_view');
  assert.ok(body.schemas.space_get_view, 'the visible reader must include its exact input schema');
});

test('ordinary provider queries remain relevant without native or provider brand boosts', async () => {
  const candidates: ToolSearchBrokerCandidate[] = [...frozenCandidates, {
    name: 'OUTLOOK_CREATE_DRAFT', summary: 'Create a draft email message in Outlook.',
    carrier: 'work_call', score: 0,
  }];
  for (const [query, expected] of [
    ['create a draft email message in Outlook', 'OUTLOOK_CREATE_DRAFT'],
    ['create a base in Airtable', 'AIRTABLE_CREATE_BASE'],
  ]) {
    const body = await search(query!, candidates);
    assert.equal(body.results[0].name, expected, query);
    assert.equal(body.results[0].capabilityRef, undefined, 'ranking cannot mint provider authority');
  }
});

test('a source rank cannot overcome stronger query relevance or promote a substring match', async () => {
  const body = await search(frozen.query, [...frozenCandidates, {
    name: 'UNRELATED_STATIC_ANALYSIS', summary: 'Analyze a statistic without creating a space.',
    carrier: 'work_call', score: 1_000_000,
  }]);
  assert.equal(body.results[0].name, 'space_save');
});

test('looking at a Workspace finds the preview, and authoring queries still find the authoring tools first', async () => {
  for (const query of ['preview my workspace screenshot', 'render a screenshot of the space view']) {
    const body = await search(query);
    assert.equal(body.results[0].name, 'space_preview', `${query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
  }
  for (const [query, expected] of [
    ['create a Space', 'space_save'],
    ['get workspace view html content raw source', 'space_get_view'],
  ]) {
    const body = await search(query!);
    assert.equal(body.results[0].name, expected, `${query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
  }
});

test('looking at a local page finds the page preview with a reference a turn can use', async () => {
  for (const query of ['screenshot of the local html page I wrote', 'render my html file and look at it', 'preview the html page at phone width']) {
    const body = await search(query);
    assert.equal(body.results[0].name, 'page_preview', `${query}: ${body.results.map((row: { name: string }) => row.name).join(', ')}`);
    assert.equal(body.results[0].capabilityRef, 'cap:local:page_preview:read');
    assert.equal(body.results[0].planningRefStatus, undefined, 'a row with a reference carries no refusal status');
  }
  // The words of the live turn that went looking for a browser (2026-09-29):
  // the browser tool still leads and still has no door, so the preview must be
  // on the same page with one.
  const live = await search('browser screenshot page render open url playwright');
  const rows = live.results as Array<{ name: string; capabilityRef?: string; planningRefStatus?: string }>;
  assert.equal(rows.find((row) => row.name === 'browser_harness_run')?.planningRefStatus, 'unsupported_unmaterialized');
  assert.equal(rows.find((row) => row.name === 'page_preview')?.capabilityRef, 'cap:local:page_preview:read');
  assert.ok(live.schemas.page_preview, 'the page carries the preview\'s argument schema');
  // A Workspace is still looked at with its own preview.
  const workspace = await search('preview my workspace screenshot');
  assert.equal(workspace.results[0].name, 'space_preview');
});

test('the shell is disclosed as callable now for reads and computation, with the carrier and the call that take it', async () => {
  const { TOOL_REGISTRY, isEffectDecidedPerCall } = await import('./tool-registry.js');
  const { classifyRuntimeToolEffect } = await import('../runtime/harness/tool-effect.js');
  const { PER_CALL_EFFECT_DISPATCH_NOTE } = await import('./tool-search-tool.js');
  // The words of the two live turns that were sent away from the shell.
  for (const query of ['run shell command bash execute local script', 'run_shell_command']) {
    const body = await search(query);
    const row = (body.results as Array<Record<string, any>>).find((candidate) => candidate.name === 'run_shell_command');
    assert.ok(row, `${query}: ${body.results.map((candidate: { name: string }) => candidate.name).join(', ')}`);
    assert.equal(row.planningRefStatus, 'dispatch_now');
    assert.equal(row.dispatchScope, 'reads_and_computation');
    assert.equal(row.dispatchNote, PER_CALL_EFFECT_DISPATCH_NOTE);
    assert.equal(row.carrier, 'work_call');
    assert.equal(row.capabilityRef, undefined, 'no capability is claimed for it');
    assert.deepEqual(row.example, {
      tool: 'work_call',
      args: { requirement_id: 'run_shell_command', name: 'run_shell_command', args_json: '{"<argument>":"<value>"}' },
    });
    assert.match(body.hint, /run_shell_command/);
    assert.match(body.hint, /through work_call for a call that only reads or computes/);
    assert.doesNotMatch(body.hint, /call_tool\(name, args_json\): [^.]*run_shell_command/, 'the shell is never said to go through call_tool');
  }
  // A write with no declaration and no per-call effect still has no door.
  const browser = await search('browser_harness_run');
  assert.equal(browser.results[0].planningRefStatus, 'unsupported_unmaterialized');
  assert.equal(browser.results[0].example, undefined);

  // The declaration is a statement about the effect classifier, so it is held to it.
  const declared = TOOL_REGISTRY.filter((row) => row.effectDecidedPerCall === true).map((row) => row.name);
  assert.deepEqual(declared, ['run_shell_command']);
  assert.equal(isEffectDecidedPerCall('run_shell_command'), true);
  assert.equal(isEffectDecidedPerCall('write_file'), false);
  assert.equal(isEffectDecidedPerCall('not_a_tool'), false);
  assert.equal(classifyRuntimeToolEffect('run_shell_command', { command: 'ls -lt /srv/work | head -20' }).effect, 'compute');
  assert.equal(classifyRuntimeToolEffect('run_shell_command', { command: 'cp /srv/work/a.css /srv/work/out/a.css' }).effect, 'local_write');
  assert.equal(classifyRuntimeToolEffect('run_shell_command', { command: 'curl -X POST https://example.com/hook -d x=1' }).effect, 'external_write');
});

test('connection metadata is discoverable from an instance URL question without a shell command', async () => {
  const body = await search('salesforce sf cli org display instance url', [
    {name:'OUTLOOK_LIST_EVENT_INSTANCES',summary:'List recurring event instances in Outlook calendar.',carrier:'work_call',score:1},
    {name:'SALESFORCE_GET_ORG_LIMITS',summary:'Read Salesforce organization API and storage usage limits.',carrier:'work_call',score:1},
  ]);
  assert.ok(body.results.some((row: {name:string}) => row.name === 'cli_inspect'),
    `the first discovery page must expose the safe connection reader: ${body.results.map((row: {name:string})=>row.name).join(', ')}`);
});
