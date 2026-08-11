/**
 * Run: npx tsx --test src/tools/composio-cli-search.test.ts
 *
 * Product seam: a CLI-only install can perform the same schema-grounded
 * composio_search_tools discovery as an SDK/API-key install.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-composio-cli-search-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.COMPOSIO_BACKEND = 'cli';
delete process.env.COMPOSIO_API_KEY;
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'proof-cli-search-machine\n', 'utf8');

const { createProofComposioShim } = await import('../../scripts/proof/provision.js');
const shim = createProofComposioShim(HOME);
process.env.COMPOSIO_CLI_PATH = shim;
writeFileSync(path.join(HOME, 'proof-composio-connected'), 'connected\n', 'utf8');
writeFileSync(path.join(HOME, 'proof-task-feed-state.json'), `${JSON.stringify({
  revision: 1,
  id: 'proof-release-1',
  title: 'Review the Clementine 4 release proof',
  status: 'open',
})}\n`, 'utf8');

const { invalidateComposioCliStatusCache } = await import('../integrations/composio/cli.js');
const { getCachedToolSchema } = await import('./composio-schema-cache.js');
const { getComposioRuntimeTools } = await import('./composio-tools.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');

test.after(() => {
  invalidateComposioCliStatusCache();
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

test('CLI-only composio_search_tools returns the live slug and deposits its schema', async () => {
  invalidateComposioCliStatusCache();
  const runtimeTools = getComposioRuntimeTools();
  const search = runtimeTools.find((candidate) => (
    candidate as { name?: string }
  ).name === 'composio_search_tools') as unknown as {
    invoke(context: unknown, input: string, details: unknown): Promise<unknown>;
  };
  const execute = runtimeTools.find((candidate) => (
    candidate as { name?: string }
  ).name === 'composio_execute_tool') as unknown as {
    invoke(context: unknown, input: string, details: unknown): Promise<unknown>;
  };

  const session = eventlog.createSession({ id: 'proof-cli-search-session', kind: 'chat' });
  const attempt = eventlog.beginRunAttempt(session.id, { runId: 'proof-cli-search-attribution' });
  const source = eventlog.recordRunAttemptUserInput(attempt, {
    turn: 1,
    role: 'user',
    data: { text: 'proof release queue current items' },
  });
  const result = await withHarnessRunContext({
    sessionId: session.id,
    turn: source.turn,
    sourceUserSeq: source.seq,
    runAttemptId: attempt.attemptId,
    counter: new ToolCallsCounter(10),
  }, () => search.invoke(
    { context: { sessionId: session.id } },
    JSON.stringify({ query: 'proof release queue current items', toolkit_slug: null, limit: 5 }),
    { toolCall: { callId: 'proof-cli-search-call' } },
  ));
  const text = typeof result === 'string'
    ? result
    : (result as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text ?? JSON.stringify(result);

  assert.match(text, /"discoveryBackend": "cli"/);
  assert.match(text, /PROOF_LIST_TASKS/);
  assert.deepEqual(getCachedToolSchema('PROOF_LIST_TASKS'), {
    type: 'object', properties: {}, additionalProperties: false,
  });
  const discovered = eventlog.listEvents(session.id, { types: ['capability_discovered'] }).at(-1);
  assert.equal(discovered?.turn, source.turn);
  assert.equal(discovered?.data.sourceUserSeq, source.seq);
  assert.equal(discovered?.data.attemptId, attempt.attemptId);
  const searches = readFileSync(path.join(HOME, 'proof-composio-searches.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { query?: string });
  assert.deepEqual(searches.map((row) => row.query), ['proof release queue current items']);

  const stringNullResult = await search.invoke(
    { context: { sessionId: 'proof-cli-search-string-null-session' } },
    JSON.stringify({ query: 'proof release queue current items', toolkit_slug: 'null', limit: 10 }),
    { toolCall: { callId: 'proof-cli-search-string-null-call' } },
  );
  const stringNullText = typeof stringNullResult === 'string'
    ? stringNullResult
    : (stringNullResult as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text ?? JSON.stringify(stringNullResult);
  assert.match(stringNullText, /PROOF_LIST_TASKS/);
  const stringNullSearch = readFileSync(path.join(HOME, 'proof-composio-searches.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { toolkitSlug?: unknown })
    .at(-1);
  assert.equal(stringNullSearch?.toolkitSlug, null,
    'a provider stringified null is absence, never a literal --toolkits null constraint');

  const emptyToolkitResult = await search.invoke(
    { context: { sessionId: 'proof-cli-search-empty-toolkit-session' } },
    JSON.stringify({ query: 'proof release queue current items', toolkit_slug: '', limit: 10 }),
    { toolCall: { callId: 'proof-cli-search-empty-toolkit-call' } },
  );
  const emptyToolkitText = typeof emptyToolkitResult === 'string'
    ? emptyToolkitResult
    : (emptyToolkitResult as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text ?? JSON.stringify(emptyToolkitResult);
  assert.match(emptyToolkitText, /PROOF_LIST_TASKS/);
  const emptyToolkitSearch = readFileSync(path.join(HOME, 'proof-composio-searches.log'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { toolkitSlug?: unknown })
    .at(-1);
  assert.equal(emptyToolkitSearch?.toolkitSlug, null,
    'an empty optional toolkit from an OpenAI-compatible provider remains a broad search');

  const executed = await execute.invoke(
    { context: { sessionId: 'proof-cli-execute-string-null-session' } },
    JSON.stringify({
      tool_slug: 'PROOF_LIST_TASKS',
      arguments: '{}',
      connected_account_id: 'null',
    }),
    { toolCall: { callId: 'proof-cli-execute-string-null-call' } },
  );
  const executedText = typeof executed === 'string'
    ? executed
    : (executed as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text ?? JSON.stringify(executed);
  assert.match(executedText, /PROOF_RELEASE_QUEUE:LOCAL_ONLY/);
  assert.deepEqual(
    readFileSync(path.join(HOME, 'proof-composio-dispatches.log'), 'utf8').trim().split('\n'),
    ['PROOF_LIST_TASKS'],
    'a stringified absent account reaches one CLI default-account dispatch',
  );

  // The CLI may recommend related slugs while only materializing schemas for
  // primary results. Those recommendations stay visible as non-executable
  // hints, but can never enter the match list used to build args or memory.
  writeFileSync(shim, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const command = process.argv[2];",
    "if (command === '--version') { console.log('composio-proof 1.0'); process.exit(0); }",
    "if (command === 'whoami') { console.log('proof-user'); process.exit(0); }",
    "if (command === 'search') { console.log(JSON.stringify({ results: [{ primary_tool_slugs: ['PROOF_LIST_TASKS'], related_tool_slugs: ['PROOF_DELETE_TASKS'] }], tool_schemas: { primary: { PROOF_LIST_TASKS: '~/.composio/tool_definitions/PROOF_LIST_TASKS.json' } } })); process.exit(0); }",
    "console.error('unsupported'); process.exit(1);",
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o755 });
  invalidateComposioCliStatusCache();
  const withRelated = await search.invoke(
    { context: { sessionId: 'proof-cli-related-session' } },
    JSON.stringify({ query: 'proof release queue current items', toolkit_slug: null, limit: 5 }),
    { toolCall: { callId: 'proof-cli-related-call' } },
  );
  const withRelatedText = typeof withRelated === 'string'
    ? withRelated
    : (withRelated as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text ?? JSON.stringify(withRelated);
  const parsed = JSON.parse(withRelatedText) as {
    matches?: Array<{ slug?: string }>;
    schemaLessCandidates?: Array<{
      toolkit?: string;
      slug?: string;
      name?: string;
      score?: number;
      status?: string;
    }>;
  };
  assert.deepEqual(parsed.matches?.map((match) => match.slug), ['PROOF_LIST_TASKS']);
  assert.deepEqual(parsed.schemaLessCandidates, [{
    toolkit: 'proof',
    slug: 'PROOF_DELETE_TASKS',
    name: 'PROOF_DELETE_TASKS',
    score: parsed.schemaLessCandidates?.[0]?.score,
    status: 'schema_unavailable',
  }]);
});
