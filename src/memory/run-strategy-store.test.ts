import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolation: this store writes under BASE_DIR — pin a temp CLEMENTINE_HOME
// BEFORE importing anything that reads BASE_DIR (test-hygiene rule 2026-07-22).
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-strategy-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  getRunStrategyLearningStats,
  listMatchingRunStrategies,
  recordRunStrategy,
  renderRunStrategiesForContext,
  strategyKeywords,
} = await import('./run-strategy-store.js');
const { evaluateLearningCandidate } = await import('./learning-receipt.js');

function receipt(sourceId: string) {
  return evaluateLearningCandidate({
    target: 'strategy',
    authority: 'background_delivery_verifier',
    sessionId: `background:${sourceId}`,
    sourceId,
    terminalSuccess: true,
    controllerValidation: true,
  }).receipt!;
}

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('keywords: content words survive, stopwords and short tokens do not', () => {
  const kw = strategyKeywords('Research these 4 personal injury law firms and build a comparison table');
  assert.ok(kw.includes('research') && kw.includes('injury') && kw.includes('comparison'));
  assert.ok(!kw.includes('the') && !kw.includes('and') && !kw.includes('a'));
});

test('record + recall: a similar objective recalls the proven shape, unrelated does not', () => {
  const rec = recordRunStrategy({
    objective: 'Research 6 personal injury law firm websites and build a comparison table',
    toolsUsed: ['composio_execute_tool', 'run_worker', 'write_file'],
    workerCount: 6,
    durationMs: 11 * 60_000,
    learningReceipt: receipt('run-1'),
  });
  assert.ok(rec, 'record persists');
  const hit = renderRunStrategiesForContext('research personal injury law firms comparison');
  assert.match(hit, /run_worker/);
  assert.match(hit, /fan-out 6 workers/);
  assert.match(hit, /~11 min/);
  assert.equal(renderRunStrategiesForContext('compose a birthday song for grandma'), '', 'unrelated objective renders nothing');
  assert.equal(renderRunStrategiesForContext(''), '', 'empty objective renders nothing');
  const listed = listMatchingRunStrategies('research personal injury law firms comparison');
  assert.ok(listed.length >= 1);
  assert.ok(listed[0]!.strategy.toolsUsed.includes('run_worker'));
});

test('near-duplicate objectives accumulate evidence instead of new rows', () => {
  const again = recordRunStrategy({
    objective: 'Research 8 personal injury law firm websites and build a comparison table',
    toolsUsed: ['composio_execute_tool', 'run_worker'],
    workerCount: 8,
    durationMs: 9 * 60_000,
    learningReceipt: receipt('run-2'),
  });
  assert.ok(again);
  assert.equal(again.uses, 2, 'evidence accumulated on the existing record');
  assert.match(renderRunStrategiesForContext('personal injury firm research comparison'), /proven 2×/);
});

test('runs that used no real tools teach nothing', () => {
  assert.equal(recordRunStrategy({
    objective: 'idle chat about weather',
    toolsUsed: [],
    workerCount: 0,
    durationMs: 1000,
    learningReceipt: receipt('idle'),
  }), null);
});

test('a hint carries the tools and argument roles of a proven run, never that run\'s request text, values or handle', async () => {
  const rec = recordRunStrategy({
    objective: 'Write 30 personalized AI-search emails for the market leader accounts at https://first-target.example',
    toolsUsed: ['composio_execute_tool', 'write_file'],
    workerCount: 0,
    durationMs: 8 * 60_000,
    deliverable: '/Users/example/Desktop/ML-30-AI-Search-Drafts.md',
    provenShapes: [{ tool: 'write_file', shape: '{"path":"string","content":"string"}' }],
    learningReceipt: receipt('run-3'),
  });
  assert.ok(rec);
  assert.equal(rec.deliverable, '/Users/example/Desktop/ML-30-AI-Search-Drafts.md', 'the record keeps what the run produced, for audit');
  const hit = renderRunStrategiesForContext('write personalized AI-search emails for the market leader accounts');
  assert.match(hit, /Prior verified run \(candidate only; confirm it fits this request\) used: composio_execute_tool; write_file \(path, content\)/);
  assert.match(hit, /Use this request's own targets and values/);
  assert.doesNotMatch(hit, /first-target|ML-30|Desktop|30 personalized|produced|similar past run/, 'nothing from that instance reaches the hint');
});

test('a route beside a method keeps its operation segments; a path on its own is a value like any other', async () => {
  const { shapeOfProvenArguments, normalizeProvenShape, elideRouteResources, describeProvenShapeRoles } = await import('./run-strategy-store.js');
  assert.equal(shapeOfProvenArguments({ path: '/Users/example/notes/plan.txt', max_chars: 4000 }), '{"path":"string","max_chars":"number"}');
  assert.equal(
    shapeOfProvenArguments({ method: 'GET', endpoint: 'https://api.provider.example/v1/sites/first-target.example/summary?key=abc#x' }),
    '{"method":"GET","endpoint":"/v1/sites/{id}/summary"}',
    'the origin, a resource segment, the query and the fragment are not the operation',
  );
  assert.equal(elideRouteResources('/v3/accounts/123456/users/9f8e7d6c5b4a39281716/live'), '/v3/accounts/{id}/users/{id}/live');
  assert.equal(normalizeProvenShape('{"path":"~/.clementine-next/output/fixture/note.txt","max_chars":"number"}'), '{"path":"string","max_chars":"number"}');
  assert.equal(normalizeProvenShape('{"method":"POST","path":"/v3/serp/live?token=1","data":[{"target":"string"}]}'), '{"method":"POST","path":"/v3/serp/live","data":[{"target":"string"}]}');
  assert.equal(normalizeProvenShape('{"method":"POST","path":"/v3/serp/li'), '{"method":"POST","path":"/v3/serp/li', 'a clipped shape is left as it is');
  assert.equal(
    describeProvenShapeRoles([{ tool: 't', shape: '{"method":"POST","path":"/v3/serp/live","data":[{"target":"string","depth":"number"}]}' }], 't'),
    'method=POST, path=/v3/serp/live, data[].target, data[].depth',
  );
  assert.equal(describeProvenShapeRoles([{ tool: 'other', shape: '{"q":"string"}' }], 't'), '', 'roles come from the named tool only');
});

test('a stored shape recorded under the old literal rule is re-read without its literal path and written back once', () => {
  const file = path.join(TMP_HOME, 'state', 'run-strategies.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { strategies: Array<Record<string, unknown>> };
  raw.strategies.push({
    id: 'strat-legacy-shape', objective: 'read the note file and count its words', keywords: ['read', 'note', 'file', 'count', 'words'],
    toolsUsed: ['read_file'], workerCount: 0, durationMs: 5, createdAt: new Date().toISOString(), uses: 1, scope: 'chat',
    provenShapes: [{ tool: 'read_file', shape: '{"path":"~/.clementine-next/output/fixture-question-back/note.txt","max_chars":"number"}' }],
    learningReceipt: receipt('legacy-shape'),
  });
  writeFileSync(file, JSON.stringify(raw));
  const hit = renderRunStrategiesForContext('read the note file and count its words');
  assert.match(hit, /read_file \(path, max_chars\)/);
  assert.doesNotMatch(hit, /fixture-question-back|note\.txt/);
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { strategies: Array<{ id: string; provenShapes?: Array<{ shape: string }> }> };
  assert.equal(persisted.strategies.find((s) => s.id === 'strat-legacy-shape')?.provenShapes?.[0]?.shape, '{"path":"string","max_chars":"number"}');
});

test('legacy strategy records stay on disk for audit but cannot steer a future run', () => {
  const storePath = path.join(TMP_HOME, 'state', 'run-strategies.json');
  const store = JSON.parse(readFileSync(storePath, 'utf-8')) as {
    version: 'v1';
    strategies: Array<Record<string, unknown>>;
  };
  store.strategies.push({
    id: 'legacy-false-green',
    objective: 'Compile an exotic orchid greenhouse inventory',
    keywords: ['compile', 'exotic', 'orchid', 'greenhouse', 'inventory'],
    toolsUsed: ['write_file'],
    workerCount: 120,
    durationMs: 373,
    createdAt: new Date().toISOString(),
    uses: 1,
  });
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');

  assert.equal(
    renderRunStrategiesForContext('compile the exotic orchid greenhouse inventory'),
    '',
    'unverified legacy success is excluded from prompt recall',
  );
  assert.equal(getRunStrategyLearningStats().legacyExcluded, 1);
});

// ─── scope: a step strategy never answers a chat request ─────────────────────

test('a strategy learned in a workflow-kind session is step-scoped; chat matching skips it, "any" keeps it', async () => {
  const { createSession } = await import('../runtime/harness/eventlog.js');
  createSession({ id: 'workflow:run-scope:draft', kind: 'workflow' });
  createSession({ id: 'sess-desktop-scope', kind: 'chat' });
  const stepReceipt = evaluateLearningCandidate({
    target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'workflow:run-scope:draft', sourceId: 'workflow:run-scope:draft:1',
    terminalSuccess: true, controllerValidation: true,
  }).receipt!;
  const chatReceipt = evaluateLearningCandidate({
    target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'sess-desktop-scope', sourceId: 'sess-desktop-scope:1',
    terminalSuccess: true, controllerValidation: true,
  }).receipt!;
  const step = recordRunStrategy({
    objective: 'Workflow: Invite digest Step: draft_digest — draft the pending invite digest from the calendar',
    toolsUsed: ['outlook_get_calendar_view', 'workflow_step_result'], workerCount: 0, durationMs: 1_000, learningReceipt: stepReceipt,
  })!;
  assert.equal(step.scope, 'workflow_step', 'the scope follows the session that learned it');
  const chat = recordRunStrategy({
    objective: 'draft the pending invite digest from the calendar for tomorrow',
    toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 1_000, learningReceipt: chatReceipt,
  })!;
  assert.equal(chat.scope, 'chat');
  assert.notEqual(chat.id, step.id, 'near-duplicate objectives do not merge across scopes');
  assert.equal(chat.uses, 1);

  const forChat = listMatchingRunStrategies('draft the invite digest from the calendar', 4);
  assert.ok(forChat.some((m) => m.strategy.id === chat.id));
  assert.ok(!forChat.some((m) => m.strategy.id === step.id), 'a chat request is never offered a step strategy');
  const forStep = listMatchingRunStrategies('draft the invite digest from the calendar', 4, { scope: 'any' });
  assert.ok(forStep.some((m) => m.strategy.id === step.id));
});

test('records learned before scopes resolve theirs from the receipt session on read and are written back', async () => {
  const { createSession } = await import('../runtime/harness/eventlog.js');
  createSession({ id: 'workflow:legacy:step', kind: 'workflow' });
  const file = path.join(TMP_HOME, 'state', 'run-strategies.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { strategies: Array<Record<string, unknown>> };
  const legacyReceipt = evaluateLearningCandidate({
    target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'workflow:legacy:step', sourceId: 'workflow:legacy:step:1',
    terminalSuccess: true, controllerValidation: true,
  }).receipt!;
  raw.strategies.push({
    id: 'strat-legacy-step', objective: 'legacy step strategy about quarterly numbers', keywords: ['legacy', 'step', 'strategy', 'quarterly', 'numbers'],
    toolsUsed: ['googlesheets_batch_get', 'workflow_step_result'], workerCount: 0, durationMs: 5, createdAt: new Date().toISOString(), uses: 3,
    learningReceipt: legacyReceipt,
  });
  writeFileSync(file, JSON.stringify(raw));
  const forChat = listMatchingRunStrategies('legacy step strategy quarterly numbers', 4);
  assert.ok(!forChat.some((m) => m.strategy.id === 'strat-legacy-step'), 'resolved to step scope on read');
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { strategies: Array<{ id: string; scope?: string }> };
  assert.equal(persisted.strategies.find((s) => s.id === 'strat-legacy-step')?.scope, 'workflow_step', 'the resolved scope is written back once');
});

test('compact objective previews do not truncate the recall index or leave refreshed evidence stale', () => {
  const prefix = 'Proceed with the requested review using existing context. '.repeat(5);
  const tail = 'inventory quarantine provenance reconciliation';
  const objective = `${prefix} ${Array(8).fill(tail).join(' ')}`;
  const input = { objective, toolsUsed: ['fixture_catalog_inspect'], workerCount: 0, durationMs: 1,
    learningReceipt: receipt('full-objective') };
  const record = recordRunStrategy(input)!;
  assert.ok(record.objective.length <= 200, 'visible memory stays compact');
  assert.deepEqual(record.keywords, strategyKeywords(objective), 'index the full accepted request');
  assert.equal(listMatchingRunStrategies(tail)[0]?.strategy.id, record.id);
  const refreshedObjective = `${prefix} ${Array(9).fill(tail).join(' ')} retention`;
  const refreshed = recordRunStrategy({ ...input, objective: refreshedObjective,
    learningReceipt: receipt('full-objective-refreshed') })!;
  assert.equal(refreshed.id, record.id);
  assert.deepEqual(refreshed.keywords, strategyKeywords(refreshedObjective), 'new proof refreshes its exact recall index');
});


test('replaying the same learning receipt does not inflate successful uses', () => {
  const input = { objective: 'observe nebula spectrum', toolsUsed: ['fixture_spectrum_read'],
    workerCount: 0, durationMs: 1, learningReceipt: receipt('same-source-replay') };
  const first = recordRunStrategy(input)!;
  const replay = recordRunStrategy(input)!;
  assert.equal(replay.id, first.id);
  assert.equal(replay.uses, first.uses);
});

test('proven request shapes elide values, keep operation selectors literal, dedupe and cap', async () => {
  const { shapeOfProvenArguments, recordRunStrategy, listVerifiedRunStrategies } = await import('./run-strategy-store.js');
  const { evaluateLearningCandidate } = await import('./learning-receipt.js');
  const shape = shapeOfProvenArguments({ method: 'POST', path: '/v3/dataforseo_labs/google/domain_rank_overview/live', data: [{ target: 'weartriallaw.com', location_code: 2840, language_code: 'en', flag: true, nested: { key: 'secret' } }] });
  assert.equal(shape, '{"method":"POST","path":"/v3/dataforseo_labs/google/domain_rank_overview/live","data":[{"target":"string","location_code":"number","language_code":"string","flag":"boolean","nested":{"key":"string"}}]}');
  assert.doesNotMatch(shape, /weartriallaw|secret/, 'no user value survives');
  assert.equal(shapeOfProvenArguments({ tool_slug: 'SAMPLEMAIL_SEARCH_MESSAGES', arguments: { query: 'Dana Lee', top: 10 } }), '{"tool_slug":"SAMPLEMAIL_SEARCH_MESSAGES","arguments":{"query":"string","top":"number"}}');
  const receipt = evaluateLearningCandidate({ target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'background:shapes', sourceId: 'shapes-1', terminalSuccess: true, controllerValidation: true }).receipt!;
  const shapes = Array.from({ length: 12 }, (_, i) => ({ tool: 'dataforseo__api_request', shape: `{"method":"POST","path":"/v3/endpoint-${i}"}` }));
  const recorded = recordRunStrategy({ objective: 'organic traffic value for a law firm domain over six months', toolsUsed: ['dataforseo__api_request'], workerCount: 0, durationMs: 5_000, learningReceipt: receipt,
    provenShapes: [...shapes, shapes[0]!, { tool: '', shape: 'x' }, { tool: 'dataforseo__api_request', shape: '' }] });
  assert.ok(recorded);
  assert.equal(recorded.provenShapes?.length, 8, 'capped at eight distinct shapes, blanks and duplicates dropped');
  const reopened = listVerifiedRunStrategies().find((row) => row.id === recorded.id);
  assert.equal(reopened?.provenShapes?.[0]?.shape, shapes[0]!.shape, 'shapes persist with the strategy');
  // A later observation of the same strategy merges new shapes ahead of old ones without duplicates.
  const again = recordRunStrategy({ objective: 'organic traffic value for a law firm domain over six months', toolsUsed: ['dataforseo__api_request'], workerCount: 0, durationMs: 4_000,
    learningReceipt: evaluateLearningCandidate({ target: 'strategy', authority: 'background_delivery_verifier', sessionId: 'background:shapes-2', sourceId: 'shapes-2', terminalSuccess: true, controllerValidation: true }).receipt!,
    provenShapes: [{ tool: 'dataforseo__api_request', shape: '{"method":"POST","path":"/v3/new"}' }, shapes[0]!] });
  assert.equal(again?.id, recorded.id);
  assert.equal(again?.provenShapes?.[0]?.shape, '{"method":"POST","path":"/v3/new"}');
  assert.equal(new Set(again?.provenShapes?.map((r) => r.shape)).size, again?.provenShapes?.length);
});

test('recall candidates remain advisory when similar vocabulary does not establish the same work', () => {
  recordRunStrategy({ objective: 'Build a platypus digest workspace from calendar and emails', toolsUsed: ['outlook_get_calendar_view'], workerCount: 0, durationMs: 20_000, learningReceipt: receipt('platypus-build') });
  const rendered = renderRunStrategiesForContext('Show me the platypus digest space');
  assert.match(rendered, /candidate only; confirm it fits this request/);
  assert.match(rendered, /outlook_get_calendar_view/);
  assert.doesNotMatch(rendered, /this kind of request|skip tool_search/);
});

test('a long phrasing retains the learned tool example without a Jaccard cutoff', () => {
  recordRunStrategy({ objective: 'reconcile walrus invoices monthly figures', toolsUsed: ['walrus_reconcile_tool'], workerCount: 0, durationMs: 5_000, learningReceipt: receipt('walrus-long') });
  const rendered = renderRunStrategiesForContext('Please reconcile the walrus invoices monthly figures and give a careful report with sources, dates, discrepancies, explanations and recommended next steps');
  assert.match(rendered, /walrus_reconcile_tool/);
  assert.match(rendered, /candidate only/);
});

test('a turn whose surface is locked is not told about a proven run', async () => {
  // Regression: the ranked tail named a proven run's tools even on a step
  // that declined remembered tool choices, for tools it cannot call.
  recordRunStrategy({
    objective: 'reconcile narwhal invoices monthly figures',
    toolsUsed: ['narwhal_covering_tool'],
    workerCount: 0,
    durationMs: 5_000,
    learningReceipt: receipt('narwhal-covering'),
  });
  const { renderTurnMemoryTail, rankedTailHitBudget } = await import('../agents/harness-context.js');
  const request = 'reconcile narwhal invoices monthly figures';
  const scope = {
    coreRefKeys: new Set<string>(),
    policyCounts: { dispatchConstraint: 0, coreProfile: 0, promptInstruction: 0, standingPreference: 0 },
  };
  const signal = { kind: 'ranked' as const, text: '[MEMORY PRIMER]\n\n## Relevant To This Request\n- a hit', refs: [] };
  const open = renderTurnMemoryTail(scope, signal, { request });
  assert.match(open.text, /narwhal_covering_tool/, 'an open surface is told about the covering run');
  const locked = renderTurnMemoryTail({ ...scope, includeRememberedToolChoices: false }, signal, { request });
  assert.doesNotMatch(locked.text, /Proven Run Strategies|narwhal_covering_tool/, 'a locked surface is not');
  assert.ok(rankedTailHitBudget(request, false) > rankedTailHitBudget(request),
    'the hit budget reserves no room for a line that will not be sent');
});
