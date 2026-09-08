import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

// Isolate CLEMENTINE_HOME BEFORE importing anything that resolves the hot-set
// state path, so the LRU never touches real state (memory: isolate CLEMENTINE_HOME).
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-hotset-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  catalogEntries,
  buildToolCatalog,
  buildCompactToolCatalog,
  allRegistryNames,
  resolveHotSet,
  rankCatalog,
  rankCatalogEntriesLexically,
  executionLaneToolSearchEnabled,
} = await import('./tool-catalog.js');
const { recordToolHit, getHotSet, _resetHotSetForTest } = await import('./tool-hotset.js');
const { TOOL_REGISTRY } = await import('../tools/tool-registry.js');
const { TOOL_SEARCH_ALWAYS_LOADED } = await import('./tool-catalog.js');

// ── catalog derives 1:1 from the registry ─────────────────────────────────────

test('catalog lists every registry tool (reachability invariant)', () => {
  const catalog = new Set(catalogEntries().map((e) => e.name));
  const registry = allRegistryNames();
  const missing = [...registry].filter((n) => !catalog.has(n)).sort();
  assert.deepEqual(missing, [], `registry tools missing from the catalog: ${missing.join(', ')}`);
  assert.equal(catalog.size, registry.size);
  assert.equal(catalog.size, TOOL_REGISTRY.length);
});

test('policy-allowed filter restricts the catalog to the lane surface', () => {
  const allowed = new Set(['read_file', 'run_batch', 'memory_recall']);
  const catalog = catalogEntries({ allowedNames: allowed });
  assert.deepEqual(new Set(catalog.map((e) => e.name)), allowed);
  // Reachability holds within the restricted surface too.
  for (const n of allowed) assert.ok(catalog.some((e) => e.name === n), `${n} missing`);
});

test('buildToolCatalog renders "name — one-liner" lines and is non-trivial', () => {
  const text = buildToolCatalog();
  const lines = text.split('\n');
  assert.equal(lines.length, TOOL_REGISTRY.length);
  const runBatch = lines.find((l) => l.startsWith('run_batch —'));
  assert.ok(runBatch && runBatch.length > 'run_batch — '.length, 'run_batch line should carry a summary');
});

test('compact catalog preserves every name without repeating descriptions', () => {
  const text = buildCompactToolCatalog();
  const tokens = new Set(text.split(/[^a-zA-Z0-9_]+/).filter(Boolean));
  for (const name of allRegistryNames()) assert.ok(tokens.has(name), `${name} missing from compact index`);
  assert.ok(text.length * 2 < buildToolCatalog().length, 'names-only index should materially reduce prompt bytes');
  assert.doesNotMatch(text, / — /, 'compact index carries names; tool_search supplies descriptions and schemas');
});

// ── hot-set resolution ────────────────────────────────────────────────────────

test('resolveHotSet seeds from the tiny schema kernel and includes session LRU', () => {
  _resetHotSetForTest();
  const sid = 'sess-hotset-1';
  recordToolHit(sid, 'workflow_schedule'); // a discoverable (non-core) registry tool
  const hot = resolveHotSet(sid, 'schedule a recurring workflow');

  const kernelInRegistry = [...TOOL_SEARCH_ALWAYS_LOADED].filter((n) => allRegistryNames().has(n));
  for (const n of kernelInRegistry) assert.ok(hot.has(n), `schema kernel ${n} should be first-class`);
  assert.ok(hot.has('workflow_schedule'), 'session LRU tool should be promoted');
});

test('resolveHotSet never promotes sibling discovery doors from recall or LRU', () => {
  _resetHotSetForTest();
  const sid = 'sess-sibling-doors';
  for (const name of ['composio_search_tools', 'tool_choice_recall', 'local_cli_list', 'skill_list']) {
    recordToolHit(sid, name);
  }
  const hot = resolveHotSet(sid, 'pull my open Salesforce tasks and email the list');
  for (const name of ['composio_search_tools', 'tool_choice_recall', 'local_cli_list', 'skill_list']) {
    assert.equal(hot.has(name), false, `${name} must stay behind tool_search unless the user named it`);
  }
  assert.ok(hot.has('tool_search'), 'the one broker stays first-class');
});

test('resolveHotSet still promotes a sibling door the user named', () => {
  _resetHotSetForTest();
  const hot = resolveHotSet('sess-named-door', 'call composio_search_tools for the Salesforce slug');
  assert.ok(hot.has('composio_search_tools'), 'an explicit name is still a first-class request');
});

test('resolveHotSet does not inherit the broad legacy JIT core', () => {
  const hot = resolveHotSet('sess-lean-kernel', 'hello there');
  assert.deepEqual(
    [...hot].sort(),
    [...TOOL_SEARCH_ALWAYS_LOADED].sort(),
    'a benign turn should load only the acquisition/recovery kernel',
  );
  for (const formerlyBroadCore of ['browser_harness_run', 'composio_execute_tool', 'run_shell_command', 'write_file']) {
    assert.equal(hot.has(formerlyBroadCore), false, `${formerlyBroadCore} must remain deferred but reachable`);
  }
});

// THE ASKING AFFORDANCE (live 2026-08-07). On the schema-on-demand lane the
// tool for asking the user a question had no schema at turn start, so the model
// would have had to search for the ability to ask while every tool needed to
// just start working was already loaded. It never asked. These pins fail if
// asking is ever pushed back behind discovery on any lane, for any wording.
test('the ask tool is first-class on a bare turn — asking is never behind a search', () => {
  _resetHotSetForTest();
  const hot = resolveHotSet('sess-ask-affordance', 'hello there');
  assert.ok(hot.has('ask_user_question'), 'ask_user_question must be schema-loaded with no prompting');
});

test('the ask tool stays first-class for a request that never names a tool', () => {
  _resetHotSetForTest();
  // The owner's real message that produced zero questions and went straight to work.
  const hot = resolveHotSet(
    'sess-ask-live-fixture',
    'we started pulling the data for arizona criminal defense firms but still havnt gotten them into a new airtable base can we finalize that',
  );
  assert.ok(hot.has('ask_user_question'), 'a consequential ask must not have to earn the right to ask back');
});

test('the ask tool description teaches WHEN to ask, not just the mechanics', async () => {
  const { TOOL_REGISTRY: registry } = await import('../tools/tool-registry.js');
  const entry = registry.find((d) => d.name === 'ask_user_question');
  assert.ok(entry, 'ask_user_question must stay in the registry');
  // A one-liner about pausing taught the model nothing about judgment; the
  // description has to name the trigger, or the affordance goes unused again.
  assert.match(entry!.description ?? '', /would change what you do|materially/i);
});

test('resolveHotSet drops LRU names that are not real registry tools', () => {
  _resetHotSetForTest();
  const sid = 'sess-hotset-2';
  recordToolHit(sid, 'not_a_real_tool');
  const hot = resolveHotSet(sid, 'do something');
  assert.ok(!hot.has('not_a_real_tool'), 'ghost tool must never enter the hot-set');
});

test('resolveHotSet respects an allowedNames policy', () => {
  _resetHotSetForTest();
  const sid = 'sess-hotset-3';
  recordToolHit(sid, 'read_file');
  const allowed = new Set(['read_file']);
  const hot = resolveHotSet(sid, 'read a file', { allowedNames: allowed });
  assert.deepEqual([...hot], ['read_file']); // mandated tools excluded by policy
});

test('resolveHotSet pins bounded workflow controls when the user uniquely names an enabled workflow', async () => {
  _resetHotSetForTest();
  const { writeWorkflow } = await import('../memory/workflow-store.js');
  const { WORKFLOWS_DIR } = await import('../memory/vault.js');
  const { rmSync } = await import('node:fs');
  writeWorkflow('platform-49-slack-channel-review', {
    name: 'Platform 49 Slack Channel Review',
    description: 'Business-hours channel review',
    enabled: true,
    trigger: { schedule: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    steps: [{ id: 'post', prompt: 'Post the team update.' }],
  });
  try {
    const runHot = resolveHotSet(
      'sess-named-workflow',
      'run my platform 49 slack channel review early and skip the 9am one',
    );
    assert.ok(runHot.has('workflow_run'), 'a uniquely named catalog workflow must advertise workflow_run');
    assert.ok(runHot.has('workflow_get'), 'the same proven workflow match keeps its bounded reader hot');

    const spoken = resolveHotSet(
      'sess-named-workflow-spoken',
      'Can you run my platform 49 workflow',
    );
    assert.ok(spoken.has('workflow_run'), 'spoken "platform 49 workflow" must still advertise workflow_run');

    const fire = resolveHotSet(
      'sess-named-workflow-fire',
      'fire off my platform 49 workflow',
    );
    assert.ok(fire.has('workflow_run'), 'fire-off is affirmative execution text');

    const readHot = resolveHotSet(
      'canary-claude-workflow-get-20260820-0148',
      'CANARY-CLAUDE-WORKFLOW-20260820-0148: Read only the frontmatter for workflow platform-49-slack-channel-review using the workflow read capability. Do not run or update it, do not use external apps, and return only the schedule cron and timezone.',
      { allowedNames: new Set(['workflow_get', 'workflow_run']) },
    );
    assert.ok(readHot.has('workflow_get'), 'an exact canary-shaped workflow read gets the reader schema first-class');
    assert.equal(readHot.has('workflow_run'), false, 'an explicit no-run workflow read does not expose the immediate queue control');

    const unrelated = resolveHotSet(
      'sess-named-workflow-bare',
      'hello there',
      { allowedNames: new Set(['workflow_get', 'workflow_run']) },
    );
    assert.equal(unrelated.has('workflow_get'), false, 'an unrelated turn must not pin workflow_get');
    assert.equal(unrelated.has('workflow_run'), false, 'an unrelated turn must not pin workflow_run');
  } finally {
    rmSync(WORKFLOWS_DIR, { recursive: true, force: true });
  }
});

test('resolveHotSet makes an explicitly named tool first-class without prior LRU state', () => {
  _resetHotSetForTest();
  const hot = resolveHotSet('sess-hotset-literal', 'Call task_hygiene now and report its exact result.');
  assert.ok(hot.has('task_hygiene'));
  assert.ok(!getHotSet('sess-hotset-literal').includes('task_hygiene'), 'literal promotion is turn-scoped, not persisted');
});

// ── ranking (lexical fallback path, embeddings off in tests) ───────────────────

test('rankCatalog ranks an on-topic tool above an unrelated one', async () => {
  const ranked = await rankCatalog('schedule a recurring workflow');
  const idx = (name: string) => ranked.findIndex((r) => r.name === name);
  const sched = idx('workflow_schedule');
  const readFile = idx('read_file');
  assert.ok(sched >= 0 && readFile >= 0);
  assert.ok(sched < readFile, 'workflow_schedule should outrank read_file for this query');
});

test('rankCatalog returns all entries and never throws on empty query', async () => {
  const ranked = await rankCatalog('');
  assert.equal(ranked.length, TOOL_REGISTRY.length);
});

// ── execution-lane schema-on-demand admission ─────────────────────────────────

test('execution lanes get the deferred surface only while global tool-search is ON', () => {
  const priorExec = process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
  const priorGlobal = process.env.CLEMMY_CODEX_TOOL_SEARCH;
  try {
    // Default: both on → execution lanes admitted to schema-on-demand.
    delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    assert.equal(executionLaneToolSearchEnabled(), true, 'default admits execution lanes');

    // Execution kill-switch: full surface on execution lanes, chat untouched.
    process.env.CLEMMY_EXECUTION_TOOL_SEARCH = 'off';
    assert.equal(executionLaneToolSearchEnabled(), false, 'execution kill-switch stands the lane down');

    // Global tool-search off ⇒ execution lanes MUST fall back to the full
    // surface (never the legacy JIT pruner — pruning without catalog recovery
    // would strand a dropped tool on an unattended run).
    delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    process.env.CLEMMY_CODEX_TOOL_SEARCH = 'off';
    assert.equal(executionLaneToolSearchEnabled(), false, 'no catalog ⇒ no admission ⇒ full surface');
  } finally {
    if (priorExec === undefined) delete process.env.CLEMMY_EXECUTION_TOOL_SEARCH;
    else process.env.CLEMMY_EXECUTION_TOOL_SEARCH = priorExec;
    if (priorGlobal === undefined) delete process.env.CLEMMY_CODEX_TOOL_SEARCH;
    else process.env.CLEMMY_CODEX_TOOL_SEARCH = priorGlobal;
  }
});


test('complete query coverage beats a partial tool-name match across create, read, and update families', () => {
  for (const fixture of [
    { query: 'create client record', verb: 'create', target: 'ENTITY_INSERT',
      targetText: 'Create a client record.', neighbor: 'CLIENT_RECORD_EXPORT', neighborText: 'Export archived client record snapshots.' },
    { query: 'read delivery status', verb: 'read', target: 'ENTRY_LOOKUP',
      targetText: 'Read delivery status.', neighbor: 'DELIVERY_STATUS_REPAIR', neighborText: 'Modify delivery status retry configuration.' },
    { query: 'update billing address', verb: 'update', target: 'CONTACT_PATCH',
      targetText: 'Update the billing address.', neighbor: 'BILLING_ADDRESS_EXPORT', neighborText: 'Export archived billing address data.' },
  ]) {
    const ranked = rankCatalogEntriesLexically(fixture.query, [
      { name: fixture.target, oneLiner: fixture.targetText },
      { name: fixture.neighbor, oneLiner: fixture.neighborText },
      // Generic verbs are naturally common in a mixed catalog. Their smaller
      // IDF must not let matching object words in the wrong operation name win.
      ...Array.from({ length: 12 }, (_, i) => ({ name: `UNRELATED_OPERATION_${i}`,
        oneLiner: `${fixture.verb} unrelated scheduled payload ${i}.` })),
    ]);
    const target = ranked.find((row) => row.name === fixture.target)!;
    const neighbor = ranked.find((row) => row.name === fixture.neighbor)!;
    assert.equal(ranked[0].name, fixture.target, fixture.query);
    assert.equal(target.fullLexicalCoverage, true);
    assert.equal(neighbor.fullLexicalCoverage, false);
    assert.ok(neighbor.score > target.score, 'the old averaged score would pick the partial-name neighbor');
  }
});

test('fully covered base and reply operations retain the existing name-specificity tie-break', () => {
  const entries = [
    { name: 'MAIL_CREATE_DRAFT', oneLiner: 'Create a draft email message.' },
    { name: 'MAIL_CREATE_REPLY_DRAFT', oneLiner: 'Create a reply draft email message.' },
  ];
  const base = rankCatalogEntriesLexically('create draft email message', entries);
  assert.ok(base.every((row) => row.fullLexicalCoverage));
  assert.equal(base[0].name, 'MAIL_CREATE_DRAFT');
  assert.equal(rankCatalogEntriesLexically('create reply draft email message', entries)[0].name, 'MAIL_CREATE_REPLY_DRAFT');
});

test('lexical coverage remains advisory and cannot distinguish cross-tool prose that covers the same query', () => {
  const ranked = rankCatalogEntriesLexically('create client record', [
    { name: 'ENTITY_INSERT', oneLiner: 'Create client record.' },
    { name: 'CLIENT_RECORD_EXPORT', oneLiner: 'Export snapshots; to create client record use ENTITY_INSERT instead.' },
  ]);
  assert.ok(ranked.every((row) => row.fullLexicalCoverage),
    'this metric does not claim to understand which clause describes the operation');
  assert.equal(ranked.length, 2, 'ranking never removes a capability from discovery');
});


test('a complete compound operation name in ordinary word order precedes incidental description coverage', () => {
  for (const fixture of [
    { query: 'create a container in Orbit', target: 'ORBIT_CREATE_CONTAINER',
      targetText: 'Create a container within Orbit.', neighbor: 'ORBIT_CREATE_ITEMS',
      neighborText: 'Create items in a container within Orbit.' },
    { query: 'read status in Harbor', target: 'HARBOR_READ_STATUS',
      targetText: 'Read status within Harbor.', neighbor: 'HARBOR_READ_HISTORY',
      neighborText: 'Read status history in Harbor.' },
    { query: 'update address in Atlas', target: 'ATLAS_UPDATE_ADDRESS',
      targetText: 'Update address within Atlas.', neighbor: 'ATLAS_UPDATE_RECORD',
      neighborText: 'Update a record and address in Atlas.' },
  ]) {
    const entries = [
      { name: fixture.target, oneLiner: fixture.targetText },
      { name: fixture.neighbor, oneLiner: fixture.neighborText },
    ];
    for (const ordered of [entries, [...entries].reverse()]) {
      const ranked = rankCatalogEntriesLexically(fixture.query, ordered);
      const target = ranked.find((row) => row.name === fixture.target)!;
      const neighbor = ranked.find((row) => row.name === fixture.neighbor)!;
      assert.equal(ranked[0].name, fixture.target, fixture.query);
      assert.equal(target.completeCompoundNameMatch, true);
      assert.equal(neighbor.completeCompoundNameMatch, false);
      assert.equal(target.fullLexicalCoverage, false, 'the target deliberately does not contain the incidental preposition');
      assert.equal(neighbor.fullLexicalCoverage, true, 'the old categorical coverage key incorrectly preferred this row');
    }
  }
});

test('single-token and repeated generic names do not receive compound-identifier priority', () => {
  for (const fixture of [
    { query: 'create client record', generic: 'CREATE', genericText: 'Create entries.',
      target: 'ENTITY_INSERT', targetText: 'Create client record.' },
    { query: 'search shipment history', generic: 'SEARCH_SEARCH', genericText: 'Search entries.',
      target: 'ARCHIVE_LOOKUP', targetText: 'Search shipment history.' },
  ]) {
    const ranked = rankCatalogEntriesLexically(fixture.query, [
      { name: fixture.generic, oneLiner: fixture.genericText },
      { name: fixture.target, oneLiner: fixture.targetText },
    ]);
    assert.ok(ranked.every((row) => !row.completeCompoundNameMatch));
    assert.equal(ranked[0].name, fixture.target);
  }
  const empty = rankCatalogEntriesLexically('', [{ name: 'ARCHIVE_GET_DATA', oneLiner: 'Get data.' }]);
  assert.equal(empty[0]!.completeCompoundNameMatch, false);
  assert.equal(empty[0]!.fullLexicalCoverage, false);
});

test('complete generic and specific names retain the existing score and base-versus-reply specificity', () => {
  const generic = rankCatalogEntriesLexically('get data in Archive', [
    { name: 'GET_DATA', oneLiner: 'Get data in Archive.' },
    { name: 'ARCHIVE_GET_DATA', oneLiner: 'Get data in Archive.' },
  ]);
  assert.ok(generic.every((row) => row.completeCompoundNameMatch && row.fullLexicalCoverage));
  assert.equal(generic[0]!.name, 'ARCHIVE_GET_DATA');
  assert.ok(generic[0]!.score > generic[1]!.score, 'the existing score distinguishes a generic subset from the complete specific name');

  const entries = [
    { name: 'MAIL_CREATE_DRAFT', oneLiner: 'Create a draft email message for a new conversation or reply.' },
    { name: 'MAIL_CREATE_REPLY_DRAFT', oneLiner: 'Create a reply draft email message.' },
  ];
  const base = rankCatalogEntriesLexically('mail create draft', entries);
  assert.equal(base[0]!.name, 'MAIL_CREATE_DRAFT');
  assert.equal(base[0]!.completeCompoundNameMatch, true);
  assert.equal(base[1]!.completeCompoundNameMatch, false, 'an unrequested reply qualifier is not a complete name match');
  const reply = rankCatalogEntriesLexically('mail create reply draft', entries);
  assert.ok(reply.every((row) => row.completeCompoundNameMatch && row.fullLexicalCoverage));
  assert.equal(reply[0]!.name, 'MAIL_CREATE_REPLY_DRAFT');
  assert.ok(reply[0]!.score > reply[1]!.score);
});
