/**
 * Run: npx tsx --test src/spaces/space-gap-test.test.ts
 *
 * The Space gap test (mirror of workflow-gap-test): a clean Workspace emits zero
 * questions; the real failure shapes (view doesn't fetch data, view ignores a
 * source, a send with no recipient, a zero-row source) each emit one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSpaceGaps, renderSpaceGapQuestions } from './space-gap-test.js';
import type { SpaceRecord } from './store.js';

function rec(partial: Partial<SpaceRecord>): SpaceRecord {
  return {
    id: 'x', title: 'X', status: 'active', viewEntry: 'view/index.html',
    dataSources: [], actions: [], version: 1, revisions: [],
    createdAt: '', updatedAt: '', ...partial,
  };
}

const GOOD_VIEW = `<html><script>
fetch('/api/console/spaces/x/data').then(r=>r.json()).then(j=>{const rows=j.data.contacts.contacts;render(rows)});
function go(row){ clem.action('send_email', { to_email: row.email }); }
</script></html>`;

test('a clean Workspace emits zero questions (byte-identical save)', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    GOOD_VIEW,
  );
  assert.equal(gaps.length, 0);
  assert.equal(renderSpaceGapQuestions(gaps), '');
});

test('view that never consumes its data (no bridge, no fetch, no embed) → a question', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    '<html><body>static, no fetch</body></html>',
  );
  assert.ok(gaps.some((g) => g.question.includes('never reads them')));
});

test('view that never references a declared source → a question (the nesting class)', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    `<html><script>fetch('/api/console/spaces/x/data')</script></html>`, // fetches /data but never mentions "contacts"
  );
  assert.ok(gaps.some((g) => g.sourceId === 'contacts' && /reads the rows from data\["contacts"\]/.test(g.question)));
});

test('send-like action with no recipient in template → a question', () => {
  const gaps = analyzeSpaceGaps(
    rec({
      dataSources: [{ id: 'contacts', runner: 'r.mjs' }],
      actions: [{ id: 'send_email', composioSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', argsTemplate: { user_id: 'me' } }],
    }),
    GOOD_VIEW,
  );
  assert.ok(gaps.some((g) => g.actionId === 'send_email' && /recipient/i.test(g.question)));
});

test('send action WITH a recipient key in template → no recipient question', () => {
  const gaps = analyzeSpaceGaps(
    rec({
      dataSources: [{ id: 'contacts', runner: 'r.mjs' }],
      actions: [{ id: 'send_email', composioSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', argsTemplate: { to_email: '' } }],
    }),
    GOOD_VIEW,
  );
  assert.equal(gaps.filter((g) => g.actionId === 'send_email').length, 0);
});

test('zero-row source from the smoke → a question', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    GOOD_VIEW,
    ['contacts'],
  );
  assert.ok(gaps.some((g) => g.sourceId === 'contacts' && /0 rows/.test(g.question)));
});

test('report is capped at 5 questions', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, runner: 'r.mjs' }));
  const gaps = analyzeSpaceGaps(rec({ dataSources: many }), '<html>nothing</html>');
  assert.ok(gaps.length <= 5);
});

test('C1: a view with a JS syntax error → a question', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    '<html><script>const x = {;</script></html>',
  );
  assert.ok(gaps.some((g) => /syntax error/i.test(g.question)));
});

test('C1: valid top-level await in the view does NOT false-flag a syntax error', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    "<html><script>const j = await (await fetch('/api/console/spaces/x/data')).json(); render(j.data.contacts);</script></html>",
  );
  assert.ok(!gaps.some((g) => /syntax error/i.test(g.question)));
});

test('C1: an action the view never wires → a question', () => {
  const gaps = analyzeSpaceGaps(
    rec({
      dataSources: [{ id: 'contacts', runner: 'r.mjs' }],
      actions: [{ id: 'send_email', composioSlug: 'OUTLOOK_OUTLOOK_SEND_EMAIL', argsTemplate: { to_email: '' } }],
    }),
    "<html><script>fetch('/api/console/spaces/x/data').then(r=>r.json()).then(j=>render(j.data.contacts));</script></html>",
  );
  assert.ok(gaps.some((g) => /never fires one|never references "send_email"/.test(g.question)));
});

test('check 1 is GENEROUS: every legitimate consumption pattern passes (workspaces are unlimited)', () => {
  const record = { dataSources: [{ id: 'pipeline' }], actions: [] } as never;
  const shapes: Array<[string, string]> = [
    ['clem bridge data()', '<script>async function load(){ const d = await clem.data(); render(d.pipeline); }</script>'],
    ['clem bridge refresh()', '<script>document.getElementById("r").onclick = () => clem.refresh("pipeline");</script>'],
    ['hand-rolled /data fetch', '<script>fetch("/api/console/spaces/x/data").then(r=>r.json()).then(d=>render(d.pipeline));</script>'],
    ['inlined JSON dataset', '<script type="application/json" id="dataset">{"pipeline":[]}</script><script>render(JSON.parse(document.getElementById("dataset").textContent).pipeline)</script>'],
    ['embedded window seed', '<script>window.__PIPELINE_DATA = {"pipeline":[]}; render(window.__PIPELINE_DATA.pipeline);</script>'],
  ];
  for (const [label, html] of shapes) {
    const gaps = analyzeSpaceGaps(record, `<html><body>${html}</body></html>`, []);
    assert.ok(!gaps.some((g) => g.question.includes('never reads them')), `${label} must not trip check 1`);
  }
});

test('check 1 still fires on a view that demonstrably consumes nothing', () => {
  const record = { dataSources: [{ id: 'pipeline' }], actions: [] } as never;
  const gaps = analyzeSpaceGaps(record, '<html><body><h1>pipeline dashboard</h1><script>document.title="x";</script></body></html>', []);
  assert.ok(gaps.some((g) => g.question.includes('never reads them')), 'a truly data-blind view is still flagged');
});
