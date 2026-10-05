import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // The approval is not the chat's: a pending approval a chat owns holds it.
  assert.notEqual(row.sessionId, session.id);
  assert.deepEqual(approvals.listPending({ sessionId: session.id, status: 'pending' }), []);
  assert.deepEqual(row.args, {
    'looks things up': 'list sites',
    'sends (asks you each time)': 'create site',
    'not fully checked (asks you each time)': 'delete site',
  });
  const cardEvents = eventlog.listEvents(session.id, { types: ['approval_requested'] });
  assert.equal(cardEvents.length, 1);
  const preview = (cardEvents[0]!.data as { preview?: { ask?: string; why?: string } }).preview;
  assert.match(preview?.ask ?? '', /hosting/);
  assert.match(preview?.why ?? '', /still asks you each time/);

  // Nothing is callable while the card waits.
  const [waiting] = list('hosting', [listSites]);
  assert.equal(waiting?.annotations, undefined);

  // Asked again from another conversation: the same card, shown there too, once.
  const elsewhere = eventlog.createSession({ kind: 'chat' });
  for (let i = 0; i < 2; i += 1) {
    const again = await proposals.proposeMcpToolEffectLabels({ serverSlug: 'hosting', sessionId: elsewhere.id });
    assert.deepEqual(again, { status: 'already_pending', approvalId, tools: 3 });
  }
  const shownElsewhere = eventlog.listEvents(elsewhere.id, { types: ['approval_requested'] });
  assert.equal(shownElsewhere.length, 1);
  assert.equal((shownElsewhere[0]!.data as { approvalId?: string }).approvalId, approvalId);

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

for (const defect of ['failed', 'malformed', 'missing'] as const) {
  test(`one ${defect} reader cannot admit a relaxed label`, async () => {
    reset();
    const server = `partial-${defect}`;
    list(server, [listSites, createSite]);
    proposals._setMcpToolEffectLabelReaderForTests(async ({ purpose, user }) => {
      const ids = idsByName(user);
      if (purpose === 'mcp_tool_effect_labels_second') {
        if (defect === 'failed') throw new Error('reader unavailable');
        if (defect === 'malformed') return { nope: true };
        return { labels: [{ id: ids.get('create_site'), effect: 'change' }] };
      }
      return { labels: [{ id: ids.get('list_sites'), effect: 'read' }, { id: ids.get('create_site'), effect: 'change' }] };
    });
    const result = await proposals.proposeMcpToolEffectLabels({ serverSlug: server, sessionId: eventlog.createSession({ kind: 'chat' }).id });
    assert.equal(result.status, 'proposed');
    const pending = labels.readMcpToolEffectLabelFile().pending[(result as { approvalId: string }).approvalId]!;
    assert.equal(pending.labels.find((entry) => entry.tool === 'list_sites')!.label, 'send');
    assert.equal(pending.labels.find((entry) => entry.tool === 'create_site')!.label, defect === 'missing' ? 'change' : 'send');
    assert.match(pending.preview!.why, new RegExp(`${defect === 'missing' ? 1 : 2} of 2 tools could not be fully checked`));
    assert.match(pending.preview!.why, /still asks you each time/);
    const args = approvals.get(pending.approvalId)!.args!;
    assert.equal(args['sends (asks you each time)'], undefined, 'uncertainty is not presented as known sending');
    assert.match(String(args['not fully checked (asks you each time)']), /list sites/);
  });
}

for (const clippedField of ['description', 'inputSchema'] as const) {
  test(`a clipped ${clippedField} cannot receive a relaxed label even when readers agree`, async () => {
    reset();
    const server = `clipped-${clippedField}`;
    list(server, [{ ...listSites, ...(clippedField === 'description'
      ? { description: `${'Reads a value. '.repeat(60)} Also sends an email.` }
      : { inputSchema: { type: 'object', properties: {}, description: 'x'.repeat(1600) } }) }]);
    proposals._setMcpToolEffectLabelReaderForTests(async ({ user }) => ({ labels: [{ id: idsByName(user).get('list_sites'), effect: 'read' }] }));
    const result = await proposals.proposeMcpToolEffectLabels({ serverSlug: server, sessionId: eventlog.createSession({ kind: 'chat' }).id });
    assert.equal(result.status, 'proposed');
    const pending = labels.readMcpToolEffectLabelFile().pending[(result as { approvalId: string }).approvalId]!;
    assert.equal(pending.labels[0]!.label, 'send');
    assert.match(pending.preview!.why, /1 of 1 tools could not be fully checked/);
    assert.match(pending.preview!.why, /still asks you each time/);
    const args = approvals.get(pending.approvalId)!.args!;
    assert.equal(args['sends (asks you each time)'], undefined);
    assert.equal(args['not fully checked (asks you each time)'], 'list sites');
  });
}

async function recoveryFixture(server: string) {
  list(server, [listSites]);
  let reads = 0;
  proposals._setMcpToolEffectLabelReaderForTests(async ({ user }) => {
    reads++;
    return { labels: [{ id: idsByName(user).get('list_sites'), effect: 'read' }] };
  });
  const sessionId = eventlog.createSession({ kind: 'chat' }).id;
  return { serverSlug: server, sessionId, reads: () => reads };
}

for (const boundary of ['before_projection', 'after_projection'] as const) {
  test(`approval survives an interruption ${boundary} and applies once after reopening the store`, async () => {
    reset();
    const fixture = await recoveryFixture(`recovery-${boundary}`);
    const result = await proposals.proposeMcpToolEffectLabels(fixture);
    const id = (result as { approvalId: string }).approvalId;
    assert.ok(id);
    proposals.initMcpToolEffectLabelApprovals();
    proposals._setMcpToolEffectLabelWriterForTests((value) => {
      if (boundary === 'after_projection') labels.writeMcpToolEffectLabelFile(value);
      throw new Error('simulated interrupted projection');
    });
    assert.equal(approvals.resolve(id, 'approved', 'desktop-chat-card').ok, true);
    assert.equal(approvals.get(id)!.consumedAt, null, 'application is not consumed before the file write and receipt succeed');
    if (boundary === 'before_projection') assert.equal(labels.readMcpToolEffectLabelFile().servers[fixture.serverSlug], undefined);
    else assert.equal(labels.readMcpToolEffectLabelFile().pending[id], undefined, 'recovery cannot depend on the pending file entry');
    proposals._setMcpToolEffectLabelWriterForTests(null);
    labels._resetMcpToolEffectLabelsForTests();
    eventlog.closeEventLog();
    proposals.reconcileMcpToolEffectLabelApprovals();
    const stored = labels.readMcpToolEffectLabelFile().servers[fixture.serverSlug]!.list_sites!;
    assert.equal(stored.approvalId, id);
    assert.equal(stored.label, 'read');
    assert.ok(approvals.get(id)!.consumedAt);
    assert.equal(proposals.settleMcpToolEffectLabelDecision(approvals.get(id)!), false, 'a completed projection is not applied again');
    assert.equal(fixture.reads(), 2, 'recovery never asks the models again');
  });
}

test('an atomic card retains its proposal when the initial pending projection fails', async () => {
  reset();
  const fixture = await recoveryFixture('registration-gap');
  proposals._setMcpToolEffectLabelWriterForTests(() => { throw new Error('disk unavailable'); });
  const result = await proposals.proposeMcpToolEffectLabels(fixture);
  assert.equal(result.status, 'unread');
  const event = eventlog.listEvents(fixture.sessionId, { types: ['approval_requested'] })[0]!;
  const id = event.data.approvalId as string;
  assert.ok(id);
  assert.equal(labels.readMcpToolEffectLabelFile().pending[id], undefined);
  proposals._setMcpToolEffectLabelWriterForTests(null);
  eventlog.closeEventLog();
  proposals.reconcileMcpToolEffectLabelApprovals();
  assert.equal(labels.readMcpToolEffectLabelFile().pending[id]!.labels[0]!.label, 'read');
  const again = await proposals.proposeMcpToolEffectLabels(fixture);
  assert.equal((again as { approvalId: string }).approvalId, id);
  assert.equal(fixture.reads(), 2, 'the original two readings are enough');
  proposals.initMcpToolEffectLabelApprovals();
  assert.equal(approvals.resolve(id, 'approved', 'desktop-chat-card').ok, true);
  assert.equal(labels.readMcpToolEffectLabelFile().servers[fixture.serverSlug]!.list_sites!.approvalId, id);
});

test('a legacy consumed-before-write approval with its pending file still recovers', async () => {
  reset();
  const fixture = await recoveryFixture('legacy-consumed-gap');
  const result = await proposals.proposeMcpToolEffectLabels(fixture);
  const id = (result as { approvalId: string }).approvalId;
  const pending = labels.readMcpToolEffectLabelFile().pending[id]!;
  // Recreate the old format and the exact old interruption state. No listener
  // can apply during resolution because its file projection is unavailable.
  eventlog.openEventLog().prepare(`UPDATE events SET data_json = json_remove(data_json, '$.mcpToolEffectProposal')
    WHERE type = 'approval_requested' AND json_extract(data_json, '$.approvalId') = ?`).run(id);
  proposals._setMcpToolEffectLabelWriterForTests(() => { throw new Error('disk unavailable'); });
  approvals.resolve(id, 'approved', 'desktop-chat-card');
  assert.equal(approvals.claimResumableApproval(pending.resumeKey, id).state, 'approved');
  proposals._setMcpToolEffectLabelWriterForTests(null);
  eventlog.closeEventLog();
  proposals.reconcileMcpToolEffectLabelApprovals();
  assert.equal(labels.readMcpToolEffectLabelFile().servers[fixture.serverSlug]!.list_sites!.approvalId, id);
  assert.equal(labels.readMcpToolEffectLabelFile().pending[id], undefined);
});


test('an unreadable projection is not overwritten or consumed, and recovery retains unrelated labels', async () => {
  reset();
  const fixture = await recoveryFixture('unreadable-projection');
  const result = await proposals.proposeMcpToolEffectLabels(fixture);
  const id = (result as { approvalId: string }).approvalId;
  const saved = labels.readMcpToolEffectLabelFile();
  saved.servers.unrelated = { list_sites: { label: 'read',
    rawDefinitionDigest: labels.rawMcpToolDefinitionDigest(listSites), approvalId: 'unrelated-approved', decidedAt: '2026-01-01T00:00:00.000Z' } };
  labels.writeMcpToolEffectLabelFile(saved);
  const file = path.join(TEST_HOME, 'state', 'mcp-tool-effect-labels.json');
  writeFileSync(file, '{ incomplete');
  proposals.initMcpToolEffectLabelApprovals();
  approvals.resolve(id, 'approved', 'desktop-chat-card');
  assert.equal(approvals.get(id)!.consumedAt, null);
  assert.equal(readFileSync(file, 'utf8'), '{ incomplete');
  labels.writeMcpToolEffectLabelFile(saved);
  eventlog.closeEventLog();
  proposals.reconcileMcpToolEffectLabelApprovals();
  const recovered = labels.readMcpToolEffectLabelFile();
  assert.equal(recovered.servers[fixture.serverSlug]!.list_sites!.approvalId, id);
  assert.equal(recovered.servers.unrelated!.list_sites!.approvalId, 'unrelated-approved');
});

test('retry after an approved projection failure reuses the decision without new model reads or cards', async () => {
  reset();
  const fixture = await recoveryFixture('same-request-retry');
  const result = await proposals.proposeMcpToolEffectLabels(fixture);
  const id = (result as { approvalId: string }).approvalId;
  proposals.initMcpToolEffectLabelApprovals();
  proposals._setMcpToolEffectLabelWriterForTests(() => { throw new Error('disk unavailable'); });
  approvals.resolve(id, 'approved', 'desktop-chat-card');
  proposals._setMcpToolEffectLabelWriterForTests(null);
  const retried = await proposals.proposeMcpToolEffectLabels(fixture);
  assert.equal(retried.status, 'nothing_to_propose');
  assert.equal(fixture.reads(), 2);
  assert.equal(eventlog.listEvents(fixture.sessionId, { types: ['approval_requested'] }).length, 1);
  assert.equal(labels.readMcpToolEffectLabelFile().servers[fixture.serverSlug]!.list_sites!.approvalId, id);
});


test('recovery of an older approved definition cannot overwrite a newer applied decision', async () => {
  reset();
  const fixture = await recoveryFixture('newer-definition');
  const first = await proposals.proposeMcpToolEffectLabels(fixture);
  const oldId = (first as { approvalId: string }).approvalId;
  proposals.initMcpToolEffectLabelApprovals();
  proposals._setMcpToolEffectLabelWriterForTests(() => { throw new Error('disk unavailable'); });
  approvals.resolve(oldId, 'approved', 'desktop-chat-card');
  proposals._setMcpToolEffectLabelWriterForTests(null);
  const changed = { ...listSites, description: 'List current hosted sites and their status.' };
  list(fixture.serverSlug, [changed]);
  const second = await proposals.proposeMcpToolEffectLabels(fixture);
  const newId = (second as { approvalId: string }).approvalId;
  assert.notEqual(newId, oldId);
  approvals.resolve(newId, 'approved', 'desktop-chat-card');
  assert.equal(labels.readMcpToolEffectLabelFile().servers[fixture.serverSlug]!.list_sites!.approvalId, newId);
  proposals.reconcileMcpToolEffectLabelApprovals();
  const stored = labels.readMcpToolEffectLabelFile().servers[fixture.serverSlug]!.list_sites!;
  assert.equal(stored.approvalId, newId);
  assert.equal(stored.rawDefinitionDigest, labels.rawMcpToolDefinitionDigest(changed));
  assert.ok(approvals.get(oldId)!.consumedAt, 'the old application is settled without replacing the new one');
});


test('the durable recovery payload stays out of the public approval card', async () => {
  reset();
  const fixture = await recoveryFixture('private-recovery-record');
  const result = await proposals.proposeMcpToolEffectLabels(fixture);
  const id = (result as { approvalId: string }).approvalId;
  const owner = approvals.get(id)!;
  const event = eventlog.listEvents(owner.sessionId, { types: ['approval_requested'] })[0]!;
  assert.ok(event.data.mcpToolEffectProposal);
  const { projectHarnessEventForPublic } = await import('./harness/public-presentation.js');
  const projected = projectHarnessEventForPublic(event)!;
  assert.equal(projected.data.mcpToolEffectProposal, undefined);
  assert.equal(projected.data.approvalId, id);
  assert.ok(projected.data.preview);
});
