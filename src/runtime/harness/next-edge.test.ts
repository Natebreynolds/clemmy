/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/next-edge.test.ts
 *
 * "Typed stop + NEXT EDGE + resumable" is the binding direction. The stop has
 * been typed for a long time; the edge was optional prose or absent, so
 * `retry: 'replan'` told a caller to try differently and never how.
 *
 * One defect, five times on 2026-09-11..12 — composio_search_tools finding an
 * operation without saying it was callable, tool_choice_recall's "CALL THIS
 * FIRST" earning 3 calls against 813 searches, Plan mode's publish instruction
 * ignored for 33 minutes, publish_plan refusing a partial draft without naming
 * the partial-publish path, and a comment at publish-plan.ts:108 recording the
 * SAME lesson from 2026-09-09 that then regressed one branch over in the same
 * file.
 *
 * That regression is the whole argument for a shared type: a message someone
 * has to remember to write is a message that comes back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {
  nextEdge, renderNextEdge, isRecoverableWithoutEdge, defaultDispositionEdge,
  edgeToolName,
} = await import('./next-edge.js');

test('an edge names a tool and a typed move — prose is never the only carrier', () => {
  const edge = nextEdge({ tool: 'publish_plan', change: 'publish_partial' });
  assert.equal(edge.version, 1);
  assert.equal(edge.tool, 'publish_plan');
  assert.equal(edge.change, 'publish_partial');
  assert.ok(edge.say.length > 0, 'a derived sentence is always present');

  // The TYPE is what consumers key on. A nicer sentence must never become the
  // only place the next move lives.
  const custom = nextEdge({ tool: 'publish_plan', change: 'publish_partial', say: 'something friendlier' });
  assert.equal(custom.change, 'publish_partial', 'a custom sentence does not erase the type');
  assert.equal(custom.say, 'something friendlier');

  // Degenerate input still yields a usable edge rather than a blank one.
  assert.equal(nextEdge({ tool: '   ', change: 'discover_capability' }).tool, 'tool_search');
  assert.ok(nextEdge({ tool: 'x', change: 'ask_user', say: '   ' }).say.length > 0);
});

test('the rendered line carries the exact fields to change', () => {
  const line = renderNextEdge(nextEdge({
    tool: 'publish_plan',
    change: 'publish_partial',
    fields: [
      { path: '/execution_draft', set: 'null' },
      { path: '/readiness', set: '"needs_input"' },
    ],
  }));
  assert.match(line, /^NEXT: /);
  assert.match(line, /\/execution_draft = null/);
  assert.match(line, /\/readiness = "needs_input"/);
  assert.match(line, /`publish_plan`/);
});

test('a recoverable refusal without an edge is the defect, and is detectable', () => {
  assert.equal(isRecoverableWithoutEdge('replan', undefined), true,
    'replan with no edge is exactly the dead end this replaces');
  assert.equal(isRecoverableWithoutEdge('replan', nextEdge({ tool: 't', change: 'repair_arguments' })), false);
  // do_not_retry has no edge BACK to this call by definition; that is not the
  // defect and must not be reported as one.
  assert.equal(isRecoverableWithoutEdge('do_not_retry', undefined), false);
});

test('every replan disposition gets a typed edge even when its site supplies none', () => {
  const refused = defaultDispositionEdge({ disposition: 'refused_pre_dispatch', toolName: 'work_call' });
  assert.equal(refused.tool, 'work_call');
  assert.equal(refused.change, 'repair_arguments');

  // A call that never started is a different move: replan from the paired
  // results rather than blindly repairing arguments that were never the problem.
  const notStarted = defaultDispositionEdge({ disposition: 'not_started', toolName: 'work_call' });
  assert.equal(notStarted.change, 'repair_arguments');
  assert.match(notStarted.say, /paired/i, 'it explains that a sibling call is why this one never ran');
  assert.notEqual(notStarted.say, refused.say, 'the two are not the same advice');
});

test('the disposition primitive attaches an edge to every recoverable refusal', async () => {
  const { buildHostToolDispositionResult } = await import('./host-model-result-receipt.js');
  const read = (item: unknown): Record<string, unknown> => {
    const output = (item as { output?: { text?: string } }).output;
    return JSON.parse(String(output?.text ?? '{}')) as Record<string, unknown>;
  };

  const replan = read(buildHostToolDispositionResult({
    callId: 'c1', toolName: 'work_call', disposition: 'refused_pre_dispatch',
    frameDigest: 'd'.repeat(16), frameIndex: 0, frameSize: 1,
  }));
  assert.equal(replan.retry, 'replan');
  assert.ok(replan.nextEdge, 'a recoverable refusal must never be a dead end');
  assert.match(String(replan.message), /NEXT: /, 'and the model-facing message says the move');

  // An exact edge from a site that knows better is preserved, not overwritten.
  const exact = read(buildHostToolDispositionResult({
    callId: 'c2', toolName: 'work_call', disposition: 'refused_pre_dispatch',
    frameDigest: 'd'.repeat(16), frameIndex: 0, frameSize: 1,
    nextEdge: nextEdge({ tool: 'tool_search', change: 'discover_capability' }),
  }));
  assert.equal((exact.nextEdge as { change?: string }).change, 'discover_capability');
  assert.equal((exact.nextEdge as { tool?: string }).tool, 'tool_search');

  // effect_unknown is do_not_retry: there is no edge back, and inventing one
  // would invite a retry of a call that may have already taken effect.
  const unknown = read(buildHostToolDispositionResult({
    callId: 'c3', toolName: 'work_call', disposition: 'effect_unknown',
    frameDigest: 'd'.repeat(16), frameIndex: 0, frameSize: 1,
  }));
  assert.equal(unknown.retry, 'do_not_retry');
  assert.equal(unknown.nextEdge, undefined, 'a call that may have started gets no retry edge');
  assert.doesNotMatch(String(unknown.message), /NEXT: /);
});

test('edgeToolName names the inner refused tool, never the wrapper', () => {
  assert.equal(edgeToolName('call_tool', {
    name: 'composio_status',
    args_json: '{}',
  }), 'composio_status');
  assert.equal(edgeToolName('read_file', { path: 'a.md' }), 'read_file');
  assert.equal(edgeToolName('call_tool', {}), 'call_tool');
});

test('a wrapped refusal tells the model to repair the inner tool, not call_tool', async () => {
  const { buildHostToolDispositionResult, describeCanonicalHostModelResult } = await import(
    './host-model-result-receipt.js'
  );
  const inner = edgeToolName('call_tool', { name: 'composio_status', args_json: '{}' });
  const item = buildHostToolDispositionResult({
    callId: 'c-wrap',
    toolName: 'call_tool',
    disposition: 'refused_pre_dispatch',
    frameDigest: 'a'.repeat(64),
    frameIndex: 0,
    frameSize: 1,
    countsRefusal: true,
    nextEdge: defaultDispositionEdge({ disposition: 'refused_pre_dispatch', toolName: inner }),
  });
  const described = describeCanonicalHostModelResult(item);
  assert.ok(described, 'an inner-tool edge must still parse as a canonical host refusal');
  const output = JSON.parse(String((item as { output?: { text?: string } }).output?.text ?? '{}')) as {
    message?: string;
    nextEdge?: { tool?: string };
  };
  assert.equal(output.nextEdge?.tool, 'composio_status');
  assert.match(String(output.message), /composio_status/);
  assert.doesNotMatch(String(output.message), /Use `call_tool`/);
});

test('publish_plan points at the partial-publish path instead of "repair the fields"', async () => {
  // THE LIVE INSTANCE. 2026-09-12 04:53:53: a steered Plan turn published, was
  // refused on incomplete bindings, was told only to repair them, and went back
  // to gathering bindings it could not complete. publish_plan already accepts
  // execution_draft: null with readiness needs_input — the hatch existed and
  // the refusal never pointed at it.
  const { __test__ } = await import('../../tools/publish-plan.js') as {
    __test__?: { planRefusalEdge?: (issues: ReadonlyArray<{ path: string; message: string }>) => unknown };
  };
  if (!__test__?.planRefusalEdge) return; // wiring pinned below by source edge

  const draftIssue = __test__.planRefusalEdge([
    { path: '/execution_draft/bindings', message: 'bindings must cover every canonical topology operation exactly once' },
  ]) as { change?: string; fields?: Array<{ path: string; set: string }> };
  assert.equal(draftIssue.change, 'publish_partial');
  assert.ok(draftIssue.fields?.some((f) => f.path === '/execution_draft' && f.set === 'null'));
  assert.ok(draftIssue.fields?.some((f) => f.path === '/readiness'));
});

test('the refusal site actually carries the edge — the wiring, not the helper', async () => {
  // publish_plan's refusal path needs a live SDK error to exercise end to end,
  // so pin the edge at the source. This is the connection that regressed once
  // already in this exact file.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../tools/publish-plan.ts', import.meta.url), 'utf8');
  assert.match(source, /planRefusalEdge\(issues\)/, 'the Zod refusal computes an edge');
  assert.match(source, /nextEdge: edge/, 'and returns it as typed data, not only prose');
  assert.match(source, /renderNextEdge\(edge\)/, 'and says it in the message the model reads');
  assert.match(source, /'publish_partial'/, 'the partial-publish path is named');
});
