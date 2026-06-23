/**
 * Run: npx tsx --test src/agents/agent-comms.test.ts
 *
 * Slice-3 peer-comms unit smoke. Per-test temp home so the comms log,
 * request files, and inboxes are isolated. Covers: slug-bound identity +
 * canMessage enforcement, the per-cycle send budget, request/reply, and
 * inbox delivery (dedup + recipient routing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Tool } from '@openai/agents';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-agent-comms-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_V2_PEER_COMMS = 'on';
process.env.CLEMMY_V2_PEER_COMMS_BUDGET = '2';

const AGENTS_DIR = path.join(TMP_HOME, 'vault', '00-System', 'agents');
function writeAgent(slug: string, frontmatter: string): void {
  const dir = path.join(AGENTS_DIR, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'agent.md'), `---\n${frontmatter}\n---\nYou are ${slug}.\n`, 'utf-8');
}
writeAgent('clementine', 'name: Clementine\ndescription: primary');
writeAgent('researcher', 'name: Researcher\ndescription: facts\ncanMessage:\n  - clementine');
writeAgent('writer', 'name: Writer\ndescription: drafts'); // canMessage empty

const comms = await import('./agent-comms.js');
const { AGENT_INBOX_DIR, TEAM_COMMS_LOG } = await import('../tools/shared.js');

test.after(() => { try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// invoke an SDK tool the way the Runner does: invoke(runContext, jsonArgs).
async function invoke(tool: Tool<unknown>, args: Record<string, unknown>): Promise<string> {
  const fn = (tool as unknown as { invoke: (ctx: unknown, input: string) => Promise<string> }).invoke;
  const r = await fn({ context: {} }, JSON.stringify(args));
  return typeof r === 'string' ? r : JSON.stringify(r);
}
function tools(slug: string) {
  const [message, request, reply] = comms.buildAgentCommsTools(slug) as Tool<unknown>[];
  return { message, request, reply };
}
function inbox(slug: string): Array<{ fromAgent?: string; content: string; type: string; status: string }> {
  const fp = path.join(AGENT_INBOX_DIR, `${slug}.json`);
  return existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf-8')) : [];
}

test('flag reads on; canMessage is enforced with the bound slug (not env)', async () => {
  assert.equal(comms.peerCommsEnabled(), true);

  // researcher → clementine is allowed (in canMessage).
  comms.resetCommsCycle('researcher');
  assert.match(await invoke(tools('researcher').message, { to_agent: 'clementine', message: 'hi' }), /queued/i);

  // writer → clementine is NOT allowed (empty canMessage, not primary).
  comms.resetCommsCycle('writer');
  assert.match(await invoke(tools('writer').message, { to_agent: 'clementine', message: 'hey' }), /not authorized/i);

  // primary may message anyone.
  comms.resetCommsCycle('clementine');
  assert.match(await invoke(tools('clementine').message, { to_agent: 'writer', message: 'go' }), /queued/i);

  // cannot message yourself / unknown target.
  comms.resetCommsCycle('researcher');
  assert.match(await invoke(tools('researcher').message, { to_agent: 'researcher', message: 'x' }), /yourself/i);
  assert.match(await invoke(tools('researcher').message, { to_agent: 'ghost', message: 'x' }), /not found/i);
});

test('per-cycle send budget caps chatter; reset refreshes it', async () => {
  comms.resetCommsCycle('clementine');
  // budget=2 → first two sends ok, third blocked.
  assert.match(await invoke(tools('clementine').message, { to_agent: 'writer', message: '1' }), /queued/i);
  assert.match(await invoke(tools('clementine').message, { to_agent: 'writer', message: '2' }), /queued/i);
  assert.match(await invoke(tools('clementine').message, { to_agent: 'writer', message: '3' }), /budget reached/i);
  comms.resetCommsCycle('clementine');
  assert.match(await invoke(tools('clementine').message, { to_agent: 'writer', message: '4' }), /queued/i);
});

test('request + reply round-trips with correct identity', async () => {
  comms.resetCommsCycle('clementine');
  const res = await invoke(tools('clementine').request, { to_agent: 'researcher', request: 'pull metrics' });
  const id = res.match(/Request (\w+) queued/)?.[1];
  assert.ok(id, 'request id returned');

  // The wrong agent cannot reply.
  comms.resetCommsCycle('writer');
  assert.match(await invoke(tools('writer').reply, { request_id: id!, response: 'nope' }), /not assigned to you/i);

  // The assignee can reply.
  comms.resetCommsCycle('researcher');
  assert.match(await invoke(tools('researcher').reply, { request_id: id!, response: 'done' }), /replied/i);
});

test('delivery routes comms-log entries into recipient inboxes and dedups', async () => {
  assert.ok(existsSync(TEAM_COMMS_LOG), 'comms log was written by the sends above');

  const first = comms.deliverTeamCommsToInboxes();
  assert.ok(first > 0, 'delivered fresh items');

  // clementine got the researcher message + the reply (both addressed to it).
  const clemInbox = inbox('clementine');
  assert.ok(clemInbox.some((i) => i.fromAgent === 'researcher'), 'clementine has a message from researcher');
  // researcher got the request addressed to it.
  assert.ok(inbox('researcher').some((i) => i.type === 'request' && i.fromAgent === 'clementine'), 'researcher has the request');

  // Idempotent: a second delivery adds nothing (dedup by comms id).
  assert.equal(comms.deliverTeamCommsToInboxes(), 0, 'second delivery is a no-op');
});
