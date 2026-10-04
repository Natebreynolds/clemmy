import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-tool-effect-labels-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const labels = await import('./mcp-tool-effect-labels.js');
const proposals = await import('./mcp-tool-effect-label-proposals.js');
const approvals = await import('./harness/approval-registry.js');
const eventlog = await import('./harness/eventlog.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function reset(): void {
  labels._resetMcpToolEffectLabelsForTests();
  labels.writeMcpToolEffectLabelFile({ version: 1, servers: {}, pending: {} });
  proposals._setMcpToolEffectLabelReaderForTests(null);
}

const listSites = {
  name: 'list_sites',
  description: 'List the hosted sites you own.',
  inputSchema: { type: 'object', properties: {} },
};
const createSite = {
  name: 'create_site',
  description: 'Create a hosted site from files.',
  inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
};
const deleteSite = {
  name: 'delete_site',
  description: 'Delete a hosted site.',
  inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
};

function list(server: string, tools: Array<typeof listSites>) {
  return tools.map((tool) => labels.withApprovedMcpToolEffect(server, tool));
}

function idsByName(user: string): Map<string, string> {
  const listed = JSON.parse(user.slice(user.indexOf('['))) as Array<{ id: string; name: string }>;
  return new Map(listed.map((entry) => [entry.name, entry.id]));
}

test('an undeclared tool is listed unchanged and remembered for a proposal', () => {
  reset();
  const [listed] = list('hosting', [listSites]);
  assert.deepEqual(listed, listSites);
  assert.deepEqual(labels.undeclaredMcpTools('hosting').map((tool) => tool.tool), ['list_sites']);
});

test('a server that declares its own effect keeps it, whatever was approved', () => {
  reset();
  const declared = { ...deleteSite, annotations: { readOnlyHint: true } };
  labels.writeMcpToolEffectLabelFile({
    version: 1,
    servers: { hosting: { delete_site: {
      label: 'delete', rawDefinitionDigest: labels.rawMcpToolDefinitionDigest(declared), approvalId: 'apr-x', decidedAt: 'now',
    } } },
    pending: {},
  });
  const [listed] = list('hosting', [declared]);
  assert.deepEqual(listed?.annotations, { readOnlyHint: true });
  assert.equal(labels.undeclaredMcpTools('hosting').length, 0);
});

test('an approved label stands in for the declaration only for the exact definition', () => {
  reset();
  labels.writeMcpToolEffectLabelFile({
    version: 1,
    servers: { hosting: {
      list_sites: { label: 'read', rawDefinitionDigest: labels.rawMcpToolDefinitionDigest(listSites), approvalId: 'apr-x', decidedAt: 'now' },
      delete_site: { label: 'delete', rawDefinitionDigest: labels.rawMcpToolDefinitionDigest(deleteSite), approvalId: 'apr-x', decidedAt: 'now' },
    } },
    pending: {},
  });
  const changed = { ...deleteSite, description: 'Delete a hosted site and all of its versions.' };
  const [read, removed] = list('hosting', [listSites, changed]);
  assert.deepEqual(read?.annotations, { readOnlyHint: true, destructiveHint: false });
  assert.equal(removed?.annotations, undefined, 'a changed definition loses its label');
  assert.deepEqual(labels.undeclaredMcpTools('hosting').map((tool) => tool.tool), ['delete_site']);
});

test('Clem proposes one card, the stricter reading wins, and approval makes the tools declared', async () => {
  reset();
  const session = eventlog.createSession({ kind: 'chat' });
  list('hosting', [listSites, createSite, deleteSite]);
  const purposes: string[] = [];
  proposals._setMcpToolEffectLabelReaderForTests(async ({ purpose, user }) => {
    purposes.push(purpose);
    const ids = idsByName(user);
    return {
      labels: [
        { id: ids.get('list_sites')!, effect: 'read' },
        // The two readings disagree: the stricter one is proposed.
        { id: ids.get('create_site')!, effect: purpose === 'mcp_tool_effect_labels' ? 'change' : 'send' },
        // Neither reading answers for delete_site: it is proposed as a send.
      ],
    };
  });

  const [first, concurrent] = await Promise.all([
    proposals.proposeMcpToolEffectLabels({ serverSlug: 'hosting', sessionId: session.id }),
    proposals.proposeMcpToolEffectLabels({ serverSlug: 'hosting', sessionId: session.id }),
  ]);
  assert.equal(first.status, 'proposed');
  assert.deepEqual(concurrent, first, 'concurrent asks share one proposal');
  assert.deepEqual(purposes.sort(), ['mcp_tool_effect_labels', 'mcp_tool_effect_labels_second']);
  assert.equal(labels.mcpToolEffectApprovalOpen('hosting'), true);

  const approvalId = (first as { approvalId: string }).approvalId;
  const row = approvals.get(approvalId)!;
  assert.equal(row.tool, null);
  assert.deepEqual(row.args, {
    'looks things up': 'list sites',
    'sends (asks you each time)': 'create site, delete site',
  });
  const cardEvents = eventlog.listEvents(session.id, { types: ['approval_requested'] });
  assert.equal(cardEvents.length, 1);
  const preview = (cardEvents[0]!.data as { preview?: { ask?: string; why?: string } }).preview;
  assert.match(preview?.ask ?? '', /hosting/);
  assert.match(preview?.why ?? '', /still asks you each time/);

  // Nothing is callable while the card waits.
  const [waiting] = list('hosting', [listSites]);
  assert.equal(waiting?.annotations, undefined);

  proposals.initMcpToolEffectLabelApprovals();
  approvals.resolve(approvalId, 'approved', 'desktop-chat-card');
  const stored = labels.readMcpToolEffectLabelFile();
  assert.deepEqual(Object.keys(stored.pending), []);
  assert.deepEqual(
    Object.fromEntries(Object.entries(stored.servers.hosting ?? {}).map(([tool, entry]) => [tool, entry.label])),
    { list_sites: 'read', create_site: 'send', delete_site: 'send' },
  );
  assert.equal(labels.mcpToolEffectApprovalOpen('hosting'), false);
  const [read, sent] = list('hosting', [listSites, createSite]);
  assert.deepEqual(read?.annotations, { readOnlyHint: true, destructiveHint: false });
  assert.deepEqual(sent?.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  assert.equal(approvals.inspectResumableApproval(row.resumeKey!).state, 'consumed');
});

test('a declined card grants nothing and is not asked again straight away', async () => {
  reset();
  const session = eventlog.createSession({ kind: 'chat' });
  list('drafts', [createSite]);
  proposals._setMcpToolEffectLabelReaderForTests(async ({ user }) => ({
    labels: [{ id: idsByName(user).get('create_site')!, effect: 'change' }],
  }));
  const first = await proposals.proposeMcpToolEffectLabels({ serverSlug: 'drafts', sessionId: session.id });
  assert.equal(first.status, 'proposed');
  proposals.initMcpToolEffectLabelApprovals();
  approvals.resolve((first as { approvalId: string }).approvalId, 'rejected', 'desktop-chat-card');

  const stored = labels.readMcpToolEffectLabelFile();
  assert.deepEqual(stored.pending, {});
  assert.equal(stored.servers.drafts, undefined);
  const [listed] = list('drafts', [createSite]);
  assert.equal(listed?.annotations, undefined);
  const again = await proposals.proposeMcpToolEffectLabels({ serverSlug: 'drafts', sessionId: session.id });
  assert.equal(again.status, 'declined_recently');
});

test('an approval resolved by anything but a person grants nothing', async () => {
  reset();
  const session = eventlog.createSession({ kind: 'chat' });
  list('runner', [listSites]);
  proposals._setMcpToolEffectLabelReaderForTests(async ({ user }) => ({
    labels: [{ id: idsByName(user).get('list_sites')!, effect: 'read' }],
  }));
  const first = await proposals.proposeMcpToolEffectLabels({ serverSlug: 'runner', sessionId: session.id });
  proposals.initMcpToolEffectLabelApprovals();
  approvals.resolve((first as { approvalId: string }).approvalId, 'approved', 'approval-resume');
  assert.equal(labels.readMcpToolEffectLabelFile().servers.runner, undefined);
});

test('no card when neither reading can be used', async () => {
  reset();
  const session = eventlog.createSession({ kind: 'chat' });
  list('silent', [listSites]);
  proposals._setMcpToolEffectLabelReaderForTests(async () => { throw new Error('model unavailable'); });
  const result = await proposals.proposeMcpToolEffectLabels({ serverSlug: 'silent', sessionId: session.id });
  assert.equal(result.status, 'unread');
  assert.equal(labels.mcpToolEffectApprovalOpen('silent'), false);
  assert.equal(eventlog.listEvents(session.id, { types: ['approval_requested'] }).length, 0);
});
