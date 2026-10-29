/** Run: node scripts/run-tests-isolated.mjs src/cli/mcp.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-cli-mcp-'));
process.env.CLEMENTINE_HOME = home;
const mcp = await import('./mcp.js');

async function connect(fake: typeof fetch) {
  const server = mcp.createClementineMcpServer(fake);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '1' });
  await client.connect(clientSide);
  return client;
}

const done = (frame: Record<string, unknown>) => new Response(`${JSON.stringify({ type: 'done', ...frame })}\n`, { status: 200 });
const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as Array<{ text: string }>)[0]!.text;

test('another app sees two bounded tools: hand over a task, check on it; nothing approves for the owner', async () => {
  const client = await connect((async () => { throw new Error('no call expected'); }) as unknown as typeof fetch);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['clem_task', 'clem_task_status']);
});

test('a task goes through the running app\'s chat route in a conversation of its own, and her answer comes back', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = await connect((async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return done({ sessionId: calls[0]!.body.sessionId, text: 'Three unread, none urgent.', pendingApprovalId: null, stoppedReason: 'success' });
  }) as unknown as typeof fetch);
  const answer = await client.callTool({ name: 'clem_task', arguments: { task: 'What is in my inbox?' } });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/console\/home\/chat\/stream$/);
  const conversation = String(calls[0]!.body.sessionId);
  assert.ok(mcp.isOwnConversation(conversation), conversation);
  assert.match(String(calls[0]!.body.clientRequestId), /^mcp:/);
  assert.equal((answer.structuredContent as { status: string }).status, 'answered');
  assert.match(text(answer), /Three unread, none urgent\./);
  assert.ok(text(answer).includes(conversation));
  // A follow-up stays in that conversation.
  await client.callTool({ name: 'clem_task', arguments: { task: 'And yesterday?', conversation } });
  assert.equal(calls[1]!.body.sessionId, conversation);
});

test('what needs the owner waits for the owner in the app, and the calling app is told so', async () => {
  const client = await connect((async () => done({ sessionId: 'console:mcp-000000000001', text: 'Ready to send the note to the team.',
    pendingApprovalId: 'apr-ab12', stoppedReason: 'pending-approval' })) as unknown as typeof fetch);
  const waiting = await client.callTool({ name: 'clem_task', arguments: { task: 'Email the team the update' } });
  assert.deepEqual({ ...(waiting.structuredContent as object), conversation: 'x' },
    { status: 'needs_owner', conversation: 'x', reply: 'Ready to send the note to the team.', waitingOn: 'approval' });
  assert.match(text(waiting), /owner answers in the Clementine app; this connection cannot answer for them/);
  assert.doesNotMatch(text(waiting), /apr-ab12/, 'the card id is the owner\'s, not the caller\'s');
});

test('a conversation this entry did not start is never read or written', async () => {
  let calls = 0;
  const client = await connect((async () => { calls += 1; return done({ text: 'x' }); }) as unknown as typeof fetch);
  for (const conversation of ['console:home', 'console:run-0123456789ab', 'sess-noticing-abc', 'console:mcp-../../x']) {
    const sent = await client.callTool({ name: 'clem_task', arguments: { task: 'Read me the last reply', conversation } });
    assert.equal(sent.isError, true);
    const read = await client.callTool({ name: 'clem_task_status', arguments: { conversation } });
    assert.equal(read.isError, true);
  }
  assert.equal(calls, 0);
});

test('checking on a task reads where it stands from the app\'s own conversation record', () => {
  const id = 'console:mcp-0123456789ab';
  const user = { role: 'user', text: 'Do the thing' };
  assert.equal(mcp.reportFromDetail({ session: { running: true }, turns: [user] }, id).status, 'working');
  assert.equal(mcp.reportFromDetail({ session: { running: false }, turns: [user] }, id).status, 'working', 'accepted, no reply yet');
  assert.deepEqual(mcp.reportFromDetail({ session: { running: false }, turns: [user,
    { role: 'assistant', text: 'Can I send it?', pausedOnApprovalId: 'apr-1', terminal: { presentation: { status: 'needs_input', kind: 'approval' } } }] }, id),
  { status: 'needs_owner', conversation: id, reply: 'Can I send it?', waitingOn: 'approval' });
  assert.equal(mcp.reportFromDetail({ session: {}, turns: [user,
    { role: 'assistant', text: 'Which account?', terminal: { presentation: { status: 'needs_input', kind: 'question' } } }] }, id).waitingOn, 'answer');
  assert.deepEqual(mcp.reportFromDetail({ session: {}, turns: [user,
    { role: 'assistant', text: 'Done: two rows added.', terminal: { presentation: { status: 'done' } } }] }, id),
  { status: 'answered', conversation: id, reply: 'Done: two rows added.' });
  assert.equal(mcp.reportFromDetail({ session: {}, turns: [user, { role: 'assistant', text: 'x', terminal: { presentation: { status: 'cancelled' } } }] }, id).status, 'stopped');
  assert.equal(mcp.reportFromDetail({ session: { running: true }, turns: [user, { role: 'assistant', text: 'mcp ok', terminal: { presentation: { status: 'done' } } }] }, id).status,
    'answered', 'a final reply is the answer while after-turn bookkeeping still runs');
  assert.equal(mcp.reportFromDetail({ session: { running: true }, turns: [user, { role: 'assistant', text: 'Looking…' }] }, id).status, 'working', 'a reply still streaming');
  // An older answer before a newer request is not the newer request's answer.
  assert.equal(mcp.reportFromDetail({ session: {}, turns: [user, { role: 'assistant', text: 'old', terminal: { presentation: { status: 'done' } } }, user] }, id).status, 'working');
});

test('a wait that runs out leaves the task running and says how to check; a closed app says to open it', async () => {
  const slow = await connect((async (_url: string | URL, init?: RequestInit) => new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch);
  const pending = await slow.callTool({ name: 'clem_task', arguments: { task: 'Long job', wait_seconds: 5 } });
  assert.equal((pending.structuredContent as { status: string }).status, 'working');
  assert.match(text(pending), /still working on it after 5 s\. Check back with clem_task_status/);
  const closed = await connect((async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
  const refused = await closed.callTool({ name: 'clem_task', arguments: { task: 'Anything' } });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /Open the Clementine app/);
});

test('over stdio the entry speaks only the protocol on stdout', async () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { env: { ...process.env, CLEMENTINE_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const deadline = Date.now() + 30_000;
  while (!out.includes('"id":2') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill();
  const lines = out.trim().split('\n');
  assert.ok(lines.length >= 2, out);
  for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0', `not protocol: ${line.slice(0, 120)}`);
  const listed = lines.map((line) => JSON.parse(line)).find((message) => message.id === 2);
  assert.deepEqual(listed.result.tools.map((tool: { name: string }) => tool.name).sort(), ['clem_task', 'clem_task_status']);
});
