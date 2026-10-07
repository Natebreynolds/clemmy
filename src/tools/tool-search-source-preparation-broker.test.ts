import assert from 'node:assert/strict';
import test from 'node:test';
import { registerToolSearchTool, type ToolSearchBrokerCandidate } from './tool-search-tool.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const MCP_NAME = 'fixture__alpha';
const COMPOSIO_NAME = 'SLACK_FIXTURE_BETA';
const QUERY = `Read ${MCP_NAME} and ${COMPOSIO_NAME}`;
const SCHEMA = { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] };

function candidate(name: string): ToolSearchBrokerCandidate {
  return { name, summary: `Read ${name} records`, carrier: 'work_call', schema: SCHEMA };
}

test('broker prepares both selected sources together, then discloses the same exact page in ordered groups', { timeout: 5_000 }, async () => {
  let handler!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  const releaseMcp = deferred();
  const composioStarted = deferred();
  const firstDisclosureStarted = deferred();
  const releaseFirstDisclosure = deferred();
  const preparedInputs: string[] = [];
  const disclosed: string[][] = [];
  let searches = 0;
  let firstDisclosureEnded = false;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(),
    async discloseForPlanning(rows) {
      disclosed.push(rows.map(row => row.name));
      for (const row of rows) assert.deepEqual(row.schema, SCHEMA);
      if (rows[0]!.name === MCP_NAME) {
        firstDisclosureStarted.resolve();
        await releaseFirstDisclosure.promise;
        firstDisclosureEnded = true;
      } else assert.equal(firstDisclosureEnded, true, 'catalog disclosure still has one sequential owner');
      return { version: 1, refs: Object.fromEntries(rows.map(row => [row.name, `cap:fixture:${row.name}`])), blockers: {} };
    },
    candidateSources: [
      { kind: 'authorized_external_mcp', search: async () => { searches++; return [candidate(MCP_NAME)]; },
        prepareCandidates: async ({ candidates, query, reuseSearchPreparation }) => {
          assert.equal(query, QUERY);
          assert.equal(reuseSearchPreparation, true);
          preparedInputs.push(candidates[0]!.name);
          await releaseMcp.promise;
          return [{ ...candidates[0]!, invocation: { name: MCP_NAME, payloadField: null } }];
        } },
      { kind: 'authorized_composio', search: async () => { searches++; return [candidate(COMPOSIO_NAME)]; },
        prepareCandidates: async ({ candidates, query, reuseSearchPreparation }) => {
          assert.equal(query, QUERY);
          assert.equal(reuseSearchPreparation, true);
          preparedInputs.push(candidates[0]!.name);
          composioStarted.resolve();
          return [{ ...candidates[0]!, invocation: { name: 'composio_execute_tool',
            fixedArgs: { tool_slug: COMPOSIO_NAME }, payloadField: 'arguments' } }];
        } },
    ],
  });
  const pending = handler({ query: QUERY, limit: 2, cursor: null, role_key: null, account_selection: null });
  try {
    await composioStarted.promise;
    assert.deepEqual(preparedInputs, [MCP_NAME, COMPOSIO_NAME]);
    assert.deepEqual(disclosed, [], 'no disclosure races an unfinished preparation stage');
    releaseMcp.resolve();
    await firstDisclosureStarted.promise;
    assert.deepEqual(disclosed, [[MCP_NAME]], 'Composio disclosure waits for the catalog owner');
  } finally { releaseMcp.resolve(); releaseFirstDisclosure.resolve(); }
  const page = JSON.parse((await pending).content[0]!.text);
  assert.deepEqual(disclosed, [[MCP_NAME], [COMPOSIO_NAME]]);
  assert.equal(searches, 2, 'each source is discovered once');
  assert.deepEqual(page.results.map((row: { name: string }) => row.name), [COMPOSIO_NAME, MCP_NAME]);
  assert.deepEqual(page.schemas, { [COMPOSIO_NAME]: SCHEMA, [MCP_NAME]: SCHEMA });
  assert.deepEqual(page.results.map((row: { capabilityRef: string }) => row.capabilityRef), [
    `cap:fixture:${COMPOSIO_NAME}`, `cap:fixture:${MCP_NAME}`,
  ]);
  assert.deepEqual(page.results[0].invocation, { name: 'composio_execute_tool', fixedArgs: { tool_slug: COMPOSIO_NAME }, payloadField: 'arguments' });
  assert.deepEqual(page.results[1].invocation, { name: MCP_NAME, payloadField: null });
});

test('failed source preparation preserves its live schema but withholds its authority', async () => {
  let handler!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  let searches = 0;
  const disclosed: string[][] = [];
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(),
    async discloseForPlanning(rows) {
      disclosed.push(rows.map(row => row.name));
      return { version: 1, refs: Object.fromEntries(rows.map(row => [row.name, `cap:fixture:${row.name}`])), blockers: {} };
    },
    candidateSources: [
      { kind: 'authorized_external_mcp', search: async () => { searches++; return [candidate(MCP_NAME)]; },
        prepareCandidates: async () => { throw new Error('exact definition unavailable'); } },
      { kind: 'authorized_composio', search: async () => { searches++; return [candidate(COMPOSIO_NAME)]; },
        prepareCandidates: async ({ candidates }) => [...candidates] },
    ],
  });
  const page = JSON.parse((await handler({ query: QUERY, limit: 2, cursor: null, role_key: null, account_selection: null })).content[0]!.text);
  assert.equal(searches, 2);
  assert.deepEqual(disclosed, [[COMPOSIO_NAME]], 'failed materialization never enters planning disclosure');
  assert.deepEqual(page.schemas[MCP_NAME], SCHEMA, 'the provider observation remains usable as metadata');
  const failed = page.results.find((row: { name: string }) => row.name === MCP_NAME);
  const healthy = page.results.find((row: { name: string }) => row.name === COMPOSIO_NAME);
  assert.equal(failed.capabilityRef, undefined);
  assert.equal(failed.planningRefStatus, 'materialization_unavailable');
  assert.equal(failed.materializationReason, 'exact_definition_unavailable');
  assert.equal(healthy.capabilityRef, `cap:fixture:${COMPOSIO_NAME}`);
});

test('same-kind adapters receive their predecessor\'s merged exact candidate before preparing the page', async () => {
  let handler!: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  const secondName = 'fixture__gamma';
  const query = `Read ${MCP_NAME} and ${secondName}`;
  const firstSchema = { ...SCHEMA, properties: { ...SCHEMA.properties, first: { const: 'prepared-first' } } };
  const finalSchema = { ...firstSchema, properties: { ...firstSchema.properties, second: { const: 'prepared-second' } } };
  const received: string[][] = [];
  let searches = 0;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) {
    handler = callback;
  } } as never, {
    allowedNames: new Set(),
    async discloseForPlanning(rows) {
      assert.equal(rows.length, 2);
      for (const row of rows) assert.deepEqual(row.schema, finalSchema);
      return { version: 1, refs: Object.fromEntries(rows.map(row => [row.name, `cap:fixture:${row.name}`])), blockers: {} };
    },
    candidateSources: [
      { kind: 'authorized_external_mcp', search: async () => { searches++; return [candidate(MCP_NAME)]; },
        prepareCandidates: async ({ candidates }) => {
          received.push(candidates.map(row => row.summary));
          for (const row of candidates) assert.deepEqual(row.schema, SCHEMA);
          return candidates.map(row => ({ ...row, schema: firstSchema, summary: `prepared-first:${row.name}` }));
        } },
      { kind: 'authorized_external_mcp', search: async () => { searches++; return [candidate(secondName)]; },
        prepareCandidates: async ({ candidates }) => {
          received.push(candidates.map(row => row.summary));
          for (const row of candidates) {
            assert.deepEqual(row.schema, firstSchema, 'the first adapter\'s exact schema was merged before the next preparation');
            assert.equal(row.summary, `prepared-first:${row.name}`, 'the second adapter receives the prepared marker');
          }
          return candidates.map(row => ({ ...row, schema: finalSchema,
            invocation: { name: row.name, payloadField: null } }));
        } },
    ],
  });
  const page = JSON.parse((await handler({ query, limit: 2, cursor: null, role_key: null, account_selection: null })).content[0]!.text);
  assert.equal(searches, 2, 'fallback adds no discovery calls');
  assert.deepEqual(received, [
    [`Read ${MCP_NAME} records`, `Read ${secondName} records`],
    [`prepared-first:${MCP_NAME}`, `prepared-first:${secondName}`],
  ]);
  assert.deepEqual(page.results.map((row: { name: string }) => row.name), [MCP_NAME, secondName]);
  assert.deepEqual(page.schemas, { [MCP_NAME]: finalSchema, [secondName]: finalSchema });
  for (const row of page.results) {
    assert.equal(row.capabilityRef, `cap:fixture:${row.name}`);
    assert.deepEqual(row.invocation, { name: row.name, payloadField: null });
  }
});
