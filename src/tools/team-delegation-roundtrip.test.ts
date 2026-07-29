/**
 * Run: npx tsx --test src/tools/team-delegation-roundtrip.test.ts
 *
 * REGRESSION CLASS: delegated work must be able to finish.
 *
 * Found 2026-07-29 while validating the "Clementine replaces multiple
 * employees" claim for 3.0. The team layer had an asymmetry:
 *
 *   team_request  -> team_pending_requests -> team_reply        (round trip CLOSES)
 *   delegate_task -> (nothing discovers it) -> (nothing ends it) (DEAD END)
 *
 * Both `delegate_task` and the execution controller's `delegateExecutionStep`
 * wrote a delegation with status 'pending'. NOTHING in the codebase ever wrote
 * a delegation back as 'completed'. Meanwhile the execution controller polls
 * `readDelegationById` waiting for exactly that status before it marks the
 * bound plan step done. A delegated step therefore parked on
 * "Waiting on <agent>" forever — the multi-employee path could start work but
 * never finish it.
 *
 * These tests pin the closed loop and the authorization/exactly-once rules
 * that make it safe, mirroring the request/reply primitive rather than
 * inventing a second delegation mechanism.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-team-delegation-test-'));
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>;
const tools = new Map<string, Handler>();

/** Minimal MCP server stand-in: capture each registered tool's handler. */
const fakeServer = {
  tool(name: string, _desc: string, _schema: unknown, handler: Handler) {
    tools.set(name, handler);
  },
} as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const handler = tools.get(name);
  assert.ok(handler, `tool '${name}' is not registered`);
  const result = await handler(args);
  return result.content.map((part) => part.text ?? '').join('\n');
}

/** Act as a given team agent for the duration of one call. */
async function asAgent(slug: string | null, fn: () => Promise<string>): Promise<string> {
  const previous = process.env.CLEMENTINE_TEAM_AGENT;
  if (slug === null) delete process.env.CLEMENTINE_TEAM_AGENT;
  else process.env.CLEMENTINE_TEAM_AGENT = slug;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CLEMENTINE_TEAM_AGENT;
    else process.env.CLEMENTINE_TEAM_AGENT = previous;
  }
}

function readDelegation(id: string): Record<string, unknown> | null {
  const root = path.join(process.env.CLEMENTINE_HOME!, 'delegations');
  if (!existsSync(root)) return null;
  for (const slug of readdirSync(root)) {
    const filePath = path.join(root, slug, `${id}.json`);
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  }
  return null;
}

function readComms(): Array<Record<string, unknown>> {
  const filePath = path.join(process.env.CLEMENTINE_HOME!, 'logs', 'team-comms.jsonl');
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Mirrors the execution controller's completion condition verbatim. */
function controllerSeesCompletion(id: string): boolean {
  const record = readDelegation(id);
  return record?.status === 'completed';
}

let delegationId = '';

before(async () => {
  const { registerTeamTools } = await import('./team-tools.js');
  registerTeamTools(fakeServer);

  // Two durable specialists, reciprocal permissions — the smallest real team.
  await call('create_agent', {
    name: 'Test Builder',
    description: 'Durable implementation specialist.',
    role: 'implementation specialist',
    can_message: ['clementine', 'test-researcher'],
  });
  await call('create_agent', {
    name: 'Test Researcher',
    description: 'Durable research specialist.',
    role: 'research specialist',
    can_message: ['clementine', 'test-builder'],
  });
});

test('delegate_task queues durable work for another agent', async () => {
  const out = await call('delegate_task', {
    to_agent: 'test-builder',
    task: 'Draft the migration checklist',
    expected_output: 'A numbered checklist',
  });
  const match = /Delegation ID: ([a-f0-9]+)/.exec(out);
  assert.ok(match, `expected a delegation id in: ${out}`);
  delegationId = match[1];
  assert.equal(readDelegation(delegationId)?.status, 'pending');
});

test('THE DEAD END: the assignee can discover work assigned to it', async () => {
  // Counterpart of team_pending_requests. Without this an agent cannot find
  // its own queue without already knowing the delegation id.
  const inbox = await asAgent('test-builder', () => call('delegation_inbox'));
  assert.match(inbox, new RegExp(delegationId), 'assignee must see its own delegation');
  assert.match(inbox, /migration checklist/i);

  const otherInbox = await asAgent('test-researcher', () => call('delegation_inbox'));
  assert.doesNotMatch(otherInbox, new RegExp(delegationId), 'an agent must not see another agent-s queue');
});

test('THE DEAD END: delegated work can actually be completed with a result', async () => {
  assert.equal(controllerSeesCompletion(delegationId), false, 'precondition: not yet complete');

  await asAgent('test-builder', () => call('complete_delegation', {
    delegation_id: delegationId,
    result: '1. Freeze writes 2. Backfill 3. Cut over',
  }));

  const record = readDelegation(delegationId);
  assert.equal(record?.status, 'completed');
  assert.equal(record?.result, '1. Freeze writes 2. Backfill 3. Cut over');

  // The property that actually unblocks the product: the execution
  // controller's poll condition is now satisfiable, so a delegated plan step
  // can reach done instead of parking on "Waiting on <agent>" forever.
  assert.equal(controllerSeesCompletion(delegationId), true);
});

test('completion is auditable in the team comms log', async () => {
  const record = readComms().find((item) => item.delegationId === delegationId && item.protocol === 'delegation_result');
  assert.ok(record, 'completing a delegation must leave an audit trail like team_reply does');
  assert.equal(record.fromAgent, 'test-builder');
  assert.equal(record.toAgent, 'clementine', 'the result routes back to the delegator');
});

test('authorization: only the assignee may complete its delegation', async () => {
  const second = await call('delegate_task', {
    to_agent: 'test-builder',
    task: 'Second task',
    expected_output: 'Something',
  });
  const id = /Delegation ID: ([a-f0-9]+)/.exec(second)![1];

  const refused = await asAgent('test-researcher', () => call('complete_delegation', {
    delegation_id: id,
    result: 'I am not the assignee',
  }));
  assert.match(refused, /not assigned/i, 'a peer must not be able to close work it was not given');
  assert.equal(readDelegation(id)?.status, 'pending', 'the refusal must not mutate state');
});

test('exactly-once: a completed delegation is not silently overwritten', async () => {
  const out = await asAgent('test-builder', () => call('complete_delegation', {
    delegation_id: delegationId,
    result: 'A DIFFERENT, LATER RESULT',
  }));
  assert.match(out, /already completed/i);
  assert.equal(
    readDelegation(delegationId)?.result,
    '1. Freeze writes 2. Backfill 3. Cut over',
    'the first result is authoritative — re-completion must not rewrite history',
  );
});

test('the delegator may close work itself — but the record says who actually did it', async () => {
  // Today the shared daemon runs every agent in one process, so a delegated
  // agent cannot always assert its own identity (see agent-comms.ts). The
  // primary agent must therefore be able to close out delegated work, or the
  // execution controller stalls forever. What must NOT happen is the ledger
  // claiming the assignee did work the primary did.
  const queued = await call('delegate_task', {
    to_agent: 'test-builder',
    task: 'Third task',
    expected_output: 'Something',
  });
  const id = /Delegation ID: ([a-f0-9]+)/.exec(queued)![1];

  await asAgent(null, () => call('complete_delegation', {
    delegation_id: id,
    result: 'Clementine gathered this herself.',
  }));

  const record = readDelegation(id);
  assert.equal(record?.status, 'completed');
  assert.equal(record?.completedBy, 'clementine', 'provenance must name the actual actor');
  assert.equal(record?.onBehalfOf, 'test-builder', 'and record whose queue it came from');

  const audit = readComms().find((item) => item.delegationId === id);
  assert.ok(audit, 'on-behalf-of completion is still auditable');
  assert.equal(audit.onBehalfOf, 'test-builder');
});

test('assignee completion records the assignee as the actor', async () => {
  const record = readDelegation(delegationId);
  assert.equal(record?.completedBy, 'test-builder');
  assert.equal(record?.onBehalfOf, undefined, 'no on-behalf-of marker when the assignee did the work');
});

test('check_delegation reports the result AND its author', async () => {
  // Clementine reads this back in later turns. If it showed a result without
  // an author she could report a teammate as having done her own work.
  const out = await call('check_delegation', { id: delegationId });
  assert.match(out, /Status: completed/i);
  assert.match(out, /Freeze writes/, 'the result itself is shown');
  assert.match(out, /Completed by: test-builder/, 'and who produced it');
});

test('a delegation that cannot be found is reported, not silently dropped', async () => {
  const out = await asAgent('test-builder', () => call('complete_delegation', {
    delegation_id: 'deadbeef',
    result: 'x',
  }));
  assert.match(out, /not found/i);
});
