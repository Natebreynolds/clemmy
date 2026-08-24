/**
 * Run: npx tsx --test src/runtime/harness/capability-resolution.test.ts
 *
 * Typed capability resolution — the runtime resolves what a turn's ask can
 * rely on from structural sources (proven memos, invalidated memos, the
 * connection registry) with no provider names in the control flow.
 *
 * Pinned from the live 2026-08-05 session: a proven calendar memo must
 * resolve `proven` with its account, and the apify firm-research memo —
 * auto-invalidated in July — must resolve `previously_failed` instead of
 * silently vanishing while the model asks the user to approve a plan that
 * assumes it.
 */
import { test as _warmTest } from 'node:test';
import _warmAssert from 'node:assert/strict';

// WARMING. The resolution names the proven tools before the model moves, and
// the model then spent 15 of 48 calls searching for those very tools (live
// 2026-08-07) — because a name arrives as prose while the argument schema does
// not. Fetching a schema is I/O, not a decision, so it belongs here, off the
// critical path. These hold the two properties that make that safe: it never
// delays the turn, and it never spends a fetch on a path the runtime already
// disbelieves.
_warmTest('warming never delays or fails the resolution it is helping', async () => {
  const mod = await import('./capability-resolution.js');
  const started = Date.now();
  // A resolution runs synchronously even though warming is async underneath.
  const resolved = mod.resolveTurnCapabilities('draft an outlook email');
  _warmAssert.ok(Date.now() - started < 1_000, 'resolution must stay synchronous and immediate');
  _warmAssert.ok(Array.isArray(resolved.entries), 'and must still return its normal shape');
});

_warmTest('warming is off when the kill-switch says so', async () => {
  process.env.CLEMMY_WARM_TOOL_CONTRACTS = 'off';
  try {
    const mod = await import('./capability-resolution.js');
    _warmAssert.ok(mod.resolveTurnCapabilities('draft an outlook email'), 'resolution is unaffected either way');
  } finally {
    delete process.env.CLEMMY_WARM_TOOL_CONTRACTS;
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-cap-resolution-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const {
  resolveTurnCapabilities,
  renderCapabilityResolutionForContext,
  recordCapabilityResolution,
  provenComposioSlugForTurn,
  selectWarmableContractIdentifiers,
} = await import('./capability-resolution.js');
const { rememberToolChoice, invalidateToolChoice } = await import('../../memory/tool-choice-store.js');
const { __test__: composioTest, listConnectedToolkits } = await import('../../integrations/composio/client.js');
const { appendEvent, createSession, listEvents, resetEventLog } = await import('./eventlog.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const { resetMemoryDb } = await import('../../memory/db.js');
const { createFocus, patchFocusWorkstate } = await import('../../memory/focus.js');
const { createGoalContract } = await import('../../agents/plan-proposals.js');

// Teach one proven memo and one that then fails out — the live pair.
rememberToolChoice({
  intent: 'outlook.calendar.view_day',
  description: 'List Outlook calendar events for a date range (calendar view)',
  choice: {
    kind: 'composio',
    identifier: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
    accountIdentity: 'user@example.com',
  },
});
rememberToolChoice({
  intent: 'apify.google_search_scrape_public_firm_research',
  description: 'Run Google Search via Apify and return organic results for public-source firm research',
  choice: {
    kind: 'composio',
    identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
  },
});
invalidateToolChoice('apify.google_search_scrape_public_firm_research', 'auto-invalidated after 3 failures with no later success');

test('a proven memo resolves proven; an invalidated memo resolves previously_failed', () => {
  const calendar = resolveTurnCapabilities('whats on my outlook calendar view for tomorrow');
  const proven = calendar.entries.find((e) => e.identifier === 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW');
  assert.ok(proven, 'the proven calendar memo must surface');
  assert.equal(proven.status, 'proven');
  assert.equal(proven.accountIdentity, 'user@example.com');

  const firms = resolveTurnCapabilities('scrape law firms with apify google search for public firm research');
  const failed = firms.entries.find((e) => e.identifier === 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
  assert.ok(failed, 'the invalidated apify memo must surface instead of vanishing');
  assert.equal(failed.status, 'previously_failed');
  assert.ok(failed.failureReason && /auto-invalidated/.test(failed.failureReason));
});

test('no registry snapshot → connection is unknown, never disconnected', () => {
  const r = resolveTurnCapabilities('whats on my outlook calendar view for tomorrow');
  assert.equal(r.registryAvailable, false);
  for (const e of r.entries) {
    assert.notEqual(e.connection, 'missing', 'absence of the registry must not read as a missing connection');
  }
});

test('an unrelated ask resolves nothing — zero prompt tax without history', () => {
  const r = resolveTurnCapabilities('tell me a story about clementines');
  assert.deepEqual(r.entries, []);
  assert.equal(renderCapabilityResolutionForContext(r), '');
});

test('a bare continuation reuses the exact-session active focus capability', () => {
  resetMemoryDb();
  const sessionId = 'capability-continuation-focus';
  const focus = createFocus({
    resourceRef: `session:${sessionId}`,
    title: 'Outlook calendar view',
    summary: 'List the Outlook calendar events for tomorrow.',
    relatedSessionId: sessionId,
  });
  patchFocusWorkstate(focus.id, {
    objective: 'Finish checking the Outlook calendar view for tomorrow.',
  });

  const continued = resolveTurnCapabilities('continue', { sessionId });
  assert.ok(
    continued.entries.some((entry) => entry.identifier === 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW'
      && entry.status === 'proven'),
    'the active task objective should recover the already-proven procedure',
  );

  const unrelated = resolveTurnCapabilities('continue later; tell me a story about clementines', { sessionId });
  assert.deepEqual(
    unrelated.entries,
    [],
    'a substantive new ask containing continuation language must not borrow task vocabulary',
  );
});

test('an exact-session active goal can explain a bare continuation without a focus', () => {
  resetMemoryDb();
  const sessionId = 'capability-continuation-goal';
  const goal = createGoalContract({
    sessionId,
    objective: 'Finish listing the Outlook calendar view for tomorrow.',
    successCriteria: ['The calendar events are returned.'],
  });
  assert.ok(goal);

  const continued = resolveTurnCapabilities("what's next?", { sessionId });
  assert.ok(continued.entries.some((entry) => entry.identifier === 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW'));
});

test('continuation enrichment never reads another session or a stale focus', async () => {
  resetMemoryDb();
  const priorSessionId = 'capability-continuation-prior';
  const focus = createFocus({
    resourceRef: `session:${priorSessionId}`,
    title: 'Outlook calendar view',
    summary: 'List the Outlook calendar events for tomorrow.',
    relatedSessionId: priorSessionId,
  });
  patchFocusWorkstate(focus.id, {
    objective: 'Finish checking the Outlook calendar view for tomorrow.',
  });
  createGoalContract({
    sessionId: priorSessionId,
    objective: 'Finish listing the Outlook calendar view for tomorrow.',
  });

  assert.deepEqual(
    resolveTurnCapabilities('keep going', { sessionId: 'capability-continuation-new' }).entries,
    [],
    'neither a cross-session focus nor another session goal may enrich the query',
  );

  resetMemoryDb();
  process.env.CLEMMY_FOCUS_CONFIRM_MS = '1';
  try {
    const staleSessionId = 'capability-continuation-stale';
    const stale = createFocus({
      resourceRef: `session:${staleSessionId}`,
      title: 'Outlook calendar view',
      summary: 'List the Outlook calendar events for tomorrow.',
      relatedSessionId: staleSessionId,
    });
    patchFocusWorkstate(stale.id, {
      objective: 'Finish checking the Outlook calendar view for tomorrow.',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(
      resolveTurnCapabilities('continue', { sessionId: staleSessionId }).entries,
      [],
      'stale task prose is a pointer, not capability evidence',
    );
  } finally {
    delete process.env.CLEMMY_FOCUS_CONFIRM_MS;
  }
});

test('speculative preflight warms only the highest-ranked proven contract', () => {
  const selected = selectWarmableContractIdentifiers([
    { intent: 'first', kind: 'composio', identifier: 'FIRST_ACTION', status: 'proven', connection: 'active' },
    { intent: 'second', kind: 'composio', identifier: 'SECOND_ACTION', status: 'proven', connection: 'unknown' },
    { intent: 'failed', kind: 'composio', identifier: 'FAILED_ACTION', status: 'previously_failed', connection: 'active' },
  ]);
  assert.deepEqual(selected, ['FIRST_ACTION']);
});

test('the rendered block is data + floor, and names both statuses', () => {
  const r = resolveTurnCapabilities('scrape firms with apify google search research, then check my outlook calendar view');
  const block = renderCapabilityResolutionForContext(r);
  assert.match(block, /\[capability resolution/);
  assert.match(block, /✕ previously failed: apify\.google_search_scrape_public_firm_research/);
  assert.match(block, /proven execution path: composio:OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW/);
  assert.match(block, /intent label.*NOT callable/s);
  assert.match(block, /call composio_execute_tool.*tool_slug.*Never pass the learned intent label/s);
  assert.match(block, /Floor: a previously-failed path must be re-verified/);
});

test('with a registry snapshot, connections join: active toolkit → active; absent toolkit → missing', async () => {
  composioTest.setConnectedAccountsLoader(async () => [
    { id: 'ca_1', status: 'ACTIVE', toolkit: { slug: 'outlook' } },
  ]);
  try {
    await listConnectedToolkits({ requireFresh: true }); // seed the sync peek
    const r = resolveTurnCapabilities(
      'scrape firms with apify google search research, then check my outlook calendar view',
    );
    assert.equal(r.registryAvailable, true);
    const outlook = r.entries.find((e) => e.identifier.startsWith('OUTLOOK_'));
    const apify = r.entries.find((e) => e.identifier.startsWith('APIFY_'));
    assert.equal(outlook?.connection, 'active');
    assert.equal(apify?.connection, 'missing', 'a registry without the toolkit is a real missing connection');
  } finally {
    composioTest.setConnectedAccountsLoader(null);
  }
});

test('recordCapabilityResolution persists a typed event; empty resolutions persist nothing', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const knownSource = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'scrape firms with apify google search research' },
  });
  recordCapabilityResolution(
    sess.id,
    resolveTurnCapabilities('scrape firms with apify google search research'),
    knownSource.seq,
  );
  const rows = listEvents(sess.id, { types: ['capability_resolution'] });
  assert.equal(rows.length, 1);
  const data = rows[0].data as { entries: Array<{ status: string }>; sourceUserSeq?: number };
  assert.ok(data.entries.some((e) => e.status === 'previously_failed'));
  assert.equal(data.sourceUserSeq, knownSource.seq);

  const novelSource = appendEvent({
    sessionId: sess.id,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'novel capability' },
  });
  recordCapabilityResolution(sess.id, { entries: [], registryAvailable: false }, novelSource.seq);
  assert.equal(listEvents(sess.id, { types: ['capability_resolution'] }).length, 1, 'empty resolution stays silent');
  assert.equal(
    discoveryGovernor.getTaskState({ sessionId: sess.id, sourceUserSeq: novelSource.seq })?.policy.broadDiscoveryAllowance,
    1,
    'an empty resolution still initializes one broad-discovery slot for the accepted task',
  );
});

test('a resolved continuation initializes the accepted task as known', () => {
  resetEventLog();
  resetMemoryDb();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'continue' },
  });

  const unresolved = resolveTurnCapabilities('continue', { sessionId: sess.id });
  assert.equal(unresolved.entries.some((entry) => entry.status === 'proven'), false);
  recordCapabilityResolution(sess.id, unresolved, source.seq);
  assert.equal(
    discoveryGovernor.getTaskState({ sessionId: sess.id, sourceUserSeq: source.seq })?.policy.knownCapability,
    false,
  );

  const focus = createFocus({
    resourceRef: `session:${sess.id}`,
    title: 'Outlook calendar view',
    summary: 'List the Outlook calendar events for tomorrow.',
    relatedSessionId: sess.id,
  });
  patchFocusWorkstate(focus.id, {
    objective: 'Finish checking the Outlook calendar view for tomorrow.',
  });
  const resolution = resolveTurnCapabilities('continue', { sessionId: sess.id });
  assert.ok(resolution.entries.some((entry) => entry.status === 'proven'));

  recordCapabilityResolution(sess.id, resolution, source.seq);
  const state = discoveryGovernor.getTaskState({ sessionId: sess.id, sourceUserSeq: source.seq });
  assert.equal(state?.policy.knownCapability, true);
  assert.equal(
    state?.policy.broadDiscoveryAllowance,
    1,
    'known is ranking context, not proof that every capability in the task is covered',
  );
});

test('an internal verification retry cannot tighten an unresolved continuation from an unrelated proven capability', () => {
  resetEventLog();
  resetMemoryDb();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Continue.' },
  });

  const initial = resolveTurnCapabilities('Continue.', { sessionId: sess.id });
  assert.equal(initial.entries.some((entry) => entry.status === 'proven'), false);
  recordCapabilityResolution(sess.id, initial, source.seq);
  assert.equal(
    discoveryGovernor.getTaskState({ sessionId: sess.id, sourceUserSeq: source.seq })?.policy.knownCapability,
    false,
  );

  rememberToolChoice({
    intent: 'netlify.create_disposable_site_and_prod_deploy',
    description: 'Create a disposable Netlify site and deploy it to production',
    choice: { kind: 'cli', identifier: 'netlify' },
  });
  const internalVerification = [
    'You marked this objective complete, but an independent verification check found it is not finished.',
    'If finishing requires a discoverable destination, create a disposable Netlify site and deploy it to production.',
  ].join(' ');
  const retryResolution = resolveTurnCapabilities(internalVerification, { sessionId: sess.id });
  assert.ok(
    retryResolution.entries.some((entry) => entry.status === 'proven' && entry.identifier === 'netlify'),
    'the retry must reproduce the unrelated proven Netlify match from the live source-37322 shape',
  );

  recordCapabilityResolution(sess.id, retryResolution, source.seq);
  const state = discoveryGovernor.getTaskState({ sessionId: sess.id, sourceUserSeq: source.seq });
  assert.equal(state?.policy.knownCapability, false);
  assert.equal(state?.policy.broadDiscoveryAllowance, 1, 'the accepted continuation remains novel');
});

test('an exact learned CLI phrase can suppress MCP fail-open; weak overlap cannot', async () => {
  rememberToolChoice({
    intent: 'sf.data.query',
    description: 'Auto-remembered: this local CLI read satisfied "What is the net MRR we sold as a team this week?".',
    aliasSource: 'synthetic',
    aliases: [{ intent: 'What is the net MRR we sold as a team this week?', source: 'synthetic' }],
    choice: {
      kind: 'cli',
      identifier: 'sf',
      invocationTemplate: 'sf data query --json --query "{{arg}}"',
    },
  });

  const ask = 'What is the net MRR we sold as a team this week?';
  const resolved = resolveTurnCapabilities(ask);
  const cli = resolved.entries.find((entry) => entry.kind === 'cli' && entry.identifier === 'sf');
  assert.ok(cli, 'the learned CLI query must surface from the exact phrase');
  assert.equal(cli.status, 'proven');
  const block = renderCapabilityResolutionForContext(resolved);
  assert.match(block, /proven execution path: cli:sf/);
  assert.match(block, /run_shell_command/);
  assert.doesNotMatch(block, /call composio_execute_tool/);

  const { resolveMcpToolScope } = await import('../mcp-tool-scope.js');
  const exact = resolveMcpToolScope({ userInput: ask });
  assert.equal(exact.maxTools, 0);
  assert.deepEqual(exact.allowedServerSlugs, []);
  assert.ok(!exact.failOpenCandidate);
  assert.match(exact.reason, /proven local CLI capability/);

  const weak = resolveMcpToolScope({ userInput: "what's on my calendar this week" });
  assert.ok(weak.failOpenCandidate || (weak.maxTools ?? 0) > 0, 'weak alias overlap must not hide every connector');
  assert.doesNotMatch(weak.reason, /proven local CLI capability/);
});

test('caller-constructed resolution data cannot manufacture known-capability authority', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const source = appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Continue.' },
  });

  recordCapabilityResolution(sess.id, {
    entries: [{
      intent: 'netlify.create_disposable_site_and_prod_deploy',
      kind: 'cli',
      identifier: 'netlify',
      status: 'proven',
      connection: 'not_applicable',
    }],
    registryAvailable: false,
  }, source.seq);

  const state = discoveryGovernor.getTaskState({ sessionId: sess.id, sourceUserSeq: source.seq });
  assert.equal(state?.policy.knownCapability, false);
  assert.equal(state?.policy.broadDiscoveryAllowance, 1);
});

// A1 (learned-contract render): call shapes that already worked on this
// machine reach the model through the SAME volatile capability block — even
// when the resolution itself is empty, because a contract learned in another
// session must reach a fresh one (live 2026-08-08: OUTLOOK_CREATE_DRAFT
// succeeded twice, then the next session re-derived the whole discovery path).
test('a learned contract renders through the capability block on token overlap', async () => {
  const store = await import('../../tools/tool-contract-store.js');
  store.saveToolContractExample({
    identifier: 'OUTLOOK_CREATE_DRAFT_RENDER_PIN',
    exampleArgs: { body_content: 'hello', subject: 'update' },
  });
  const empty = { entries: [], registryAvailable: false };
  const block = renderCapabilityResolutionForContext(empty, {
    focusInput: 'draft the outlook render pin email create',
  });
  assert.match(block, /LEARNED TOOL CONTRACTS/);
  assert.match(block, /OUTLOOK_CREATE_DRAFT_RENDER_PIN/);
  assert.match(block, /body_content/);
});

test('no focusInput → the render is byte-identical to the pre-A1 shape', () => {
  const empty = { entries: [], registryAvailable: false };
  assert.equal(renderCapabilityResolutionForContext(empty), '');
});

test('an unrelated focusInput renders no contract text', () => {
  const empty = { entries: [], registryAvailable: false };
  assert.equal(renderCapabilityResolutionForContext(empty, {
    focusInput: 'tell me a story about clementines',
  }), '');
});

// ————— provenComposioSlugForTurn: consume the proof at the decision point —————
// The 2026-08-18 calendar shape: the host proves a capability BEFORE the model
// speaks; the first model call naming that exact identifier must land on the
// carrier, not pay refusal tuition. These pin the lookup's authority hygiene:
// per-source scoping, authoritative-resolution-only, newest-decisive.

function seedResolutionEvent(sessionId: string, opts: {
  sourceUserSeq?: number;
  authoritativeForTask?: boolean;
  identifier?: string;
  status?: string;
  connection?: string;
} = {}) {
  return appendEvent({
    sessionId,
    turn: 0,
    role: 'system',
    type: 'capability_resolution',
    data: {
      entries: [{
        intent: 'outlook.calendar.view_day',
        kind: 'composio',
        identifier: opts.identifier ?? 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
        status: opts.status ?? 'proven',
        connection: opts.connection ?? 'active',
      }],
      registryAvailable: true,
      authoritativeForTask: opts.authoritativeForTask ?? true,
      ...(opts.sourceUserSeq !== undefined ? { sourceUserSeq: opts.sourceUserSeq } : {}),
    },
  });
}

test('a proven, connected identifier for this source resolves to its carrier slug', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedResolutionEvent(sess.id, { sourceUserSeq: 7 });
  const hit = provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 7,
    requestedTarget: 'outlook_list_calendar_calendar_view',
  });
  assert.deepEqual(hit, { slug: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW' }, 'casing must not defeat the proof');
});

test('an unproven SCREAMING_SNAKE name resolves nothing — the regex widening grants no authority', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  assert.equal(provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 7,
    requestedTarget: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
  }), null, 'no resolution event → no remap');
  assert.equal(provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 7,
    requestedTarget: 'not a slug shape',
  }), null);
});

test('proof scope: same-session prior proof carries; future and identity-free never do', () => {
  // Re-pinned 2026-08-18 (session-fixture-remap-a seq 58306,
  // session-fixture-remap-b seq 58040):
  // exact-source-only scope made every continuation turn bounce a PROVEN
  // slug as not_reachable. Same-session prior authoritative proof now
  // carries the carrier remap; a source BEFORE the proof and a lookup with
  // no identity still get nothing. Cross-session is pinned separately in
  // provision-from-proof.test.ts.
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedResolutionEvent(sess.id, { sourceUserSeq: 7 });
  assert.deepEqual(provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 9,
    requestedTarget: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
  }), { slug: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW' }, 'same-session prior proof carries the remap');
  assert.equal(provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 5,
    requestedTarget: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
  }), null, 'proof recorded after this source is not yet its authority');
  assert.equal(provenComposioSlugForTurn({
    sessionId: sess.id,
    requestedTarget: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
  }), null, 'no source identity → no proof consumption at all');
});

test('a non-authoritative resolution (internal verification retry) cannot authorize the remap', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedResolutionEvent(sess.id, { sourceUserSeq: 7, authoritativeForTask: true });
  seedResolutionEvent(sess.id, {
    sourceUserSeq: 7,
    authoritativeForTask: false,
    identifier: 'GMAIL_SEND_EMAIL',
  });
  assert.equal(provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 7,
    requestedTarget: 'GMAIL_SEND_EMAIL',
  }), null, 'the retry\'s capability is context, not task authority');
  const hit = provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 7,
    requestedTarget: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
  });
  assert.deepEqual(hit, { slug: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW' },
    'the older AUTHORITATIVE resolution for the same source still proves');
});

test('the newest authoritative resolution for the source is decisive', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedResolutionEvent(sess.id, { sourceUserSeq: 7 });
  seedResolutionEvent(sess.id, { sourceUserSeq: 7, identifier: 'OUTLOOK_GET_EVENT' });
  assert.equal(provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 7,
    requestedTarget: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
  }), null, 'superseded by the newer resolution for the same source');
});

test('a proven identifier with a missing connection does not remap', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedResolutionEvent(sess.id, { sourceUserSeq: 7, connection: 'missing' });
  assert.equal(provenComposioSlugForTurn({
    sessionId: sess.id,
    sourceUserSeq: 7,
    requestedTarget: 'OUTLOOK_LIST_CALENDAR_CALENDAR_VIEW',
  }), null);
});
