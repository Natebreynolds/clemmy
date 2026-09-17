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
clem.data().then(data=>{const rows=data.contacts.contacts;render(rows)});
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

test('data-backed Workspace rejects a legacy mustache seed instead of activating an empty dynamic view', () => {
  // Fresh GLM live proof, 2026-07-28: application/json was treated as an
  // embedded dataset even though {{tasks}} is never expanded by the Workspace
  // runtime. The saved surface activated with no authored bridge call.
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'tasks', runner: 'tasks.mjs' }] }),
    `<html>
      <script id="dataset" type="application/json">{{tasks}}</script>
      <script>
        const raw = document.getElementById("dataset").textContent;
        const data = raw !== "{{tasks}}" ? JSON.parse(raw) : [];
        render(data);
      </script>
    </html>`,
  );
  const bridgeGap = gaps.find((g) => /clem\.data\(\)/.test(g.question));
  assert.equal(bridgeGap?.resolution, 'fix');
  assert.match(bridgeGap?.question ?? '', /not expanded|legacy/i);
});

test('data-backed Workspace preserves the scoped compatibility data route', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    `<html><script>
      fetch('/api/console/spaces/x/data').then(r => r.json()).then(({data}) => render(data.contacts));
    </script></html>`,
  );
  assert.equal(gaps.length, 0);
});

test('static Workspace remains valid without clem.data()', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [] }),
    '<html><body><h1>Reference board</h1><p>No dynamic data.</p></body></html>',
  );
  assert.deepEqual(gaps, []);
});

test('view that never references a declared source → a question (the nesting class)', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    `<html><script>fetch('/api/console/spaces/x/data')</script></html>`, // fetches /data but never mentions "contacts"
  );
  assert.ok(gaps.some((g) => g.sourceId === 'contacts' && /reads the rows from data\["contacts"\]/.test(g.question)));
});

test('relative data fetch is a Clementine implementation fix, not a user question', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'open-tasks', runner: 'r.mjs' }] }),
    '<html><script>fetch("./data/open_tasks").then(render)</script><p>open-tasks</p></html>',
  );
  const brokenFetch = gaps.find((g) => /relative fetch/.test(g.question));
  assert.equal(brokenFetch?.resolution, 'fix');
  const rendered = renderSpaceGapQuestions(gaps);
  assert.match(rendered, /fix these implementation issues now/);
  assert.match(rendered, /do not ask the user to debug/i);
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
  assert.equal(gaps.find((g) => g.actionId === 'send_email')?.resolution, 'clarify');
});

test('a reply draft whose operation declares no recipient input asks no recipient question', () => {
  const draft = { id: 'draft_reply', composioSlug: 'VENDOR_CREATE_REPLY_ALL_DRAFT', argsTemplate: { message_id: '{{message_id}}', comment: '{{comment}}' } };
  const withSchema = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'mail', runner: 'r.mjs' }], actions: [draft] }),
    GOOD_VIEW,
    [],
    { actionInputNames: { draft_reply: ['comment', 'mail_folder_id', 'message_id', 'user_id'] } },
  );
  assert.equal(withSchema.filter((g) => /recipient/i.test(g.question)).length, 0, 'the operation takes no recipient');
  const sendSchema = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'mail', runner: 'r.mjs' }], actions: [{ id: 'send_email', composioSlug: 'VENDOR_SEND_EMAIL', argsTemplate: { user_id: 'me' } }] }),
    GOOD_VIEW,
    [],
    { actionInputNames: { send_email: ['to_email', 'subject', 'body', 'user_id'] } },
  );
  assert.ok(sendSchema.some((g) => g.actionId === 'send_email' && /recipient/i.test(g.question)), 'an operation that takes a recipient still asks');
  const unread = analyzeSpaceGaps(rec({ dataSources: [{ id: 'mail', runner: 'r.mjs' }], actions: [draft] }), GOOD_VIEW);
  assert.ok(unread.some((g) => /recipient/i.test(g.question)), 'without the schema the conservative question stays');
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

test('local post approval is not misclassified as an outbound recipient send', () => {
  const gaps = analyzeSpaceGaps(
    rec({
      actions: [{
        id: 'approve_post',
        label: 'Approve locally',
        runner: 'approve-post.mjs',
        argsTemplate: { external: false },
      }],
    }),
    '<html><script>clem.action("approve_post", { postId: "synthetic-1" })</script></html>',
  );
  assert.equal(
    gaps.some((g) => g.actionId === 'approve_post' && /recipient|outside world/i.test(g.question)),
    false,
  );
});

test('broadcast publishing does not ask for an email-style recipient', () => {
  const gaps = analyzeSpaceGaps(
    rec({
      actions: [{
        id: 'publish_post',
        label: 'Publish post',
        composioSlug: 'LINKEDIN_CREATE_POST',
      }],
    }),
    '<html><script>clem.action("publish_post", { text: "approved copy" })</script></html>',
  );
  assert.equal(
    gaps.some((g) => g.actionId === 'publish_post' && /recipient/i.test(g.question)),
    false,
  );
});

test('zero-row source from the smoke → a question', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'contacts', runner: 'r.mjs' }] }),
    GOOD_VIEW,
    ['contacts'],
  );
  assert.ok(gaps.some((g) => g.sourceId === 'contacts' && /0 rows/.test(g.question)));
});

test('an explicitly valid empty product state does not become a fake failure', () => {
  const gaps = analyzeSpaceGaps(
    rec({ dataSources: [{ id: 'content-calendar', runner: 'r.mjs', allowEmpty: true }] }),
    '<html><script>clem.data().then(data => render(data["content-calendar"]))</script></html>',
    ['content-calendar'],
  );
  assert.equal(gaps.length, 0);
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

test('check 1 accepts canonical bridge calls and rejects non-canonical dynamic loading shapes', () => {
  const record = { dataSources: [{ id: 'pipeline' }], actions: [] } as never;
  const canonical = [
    '<script>async function load(){ const d = await clem.data(); render(d.pipeline); }</script>',
    '<script>clem . data ( ).then(d => render(d.pipeline));</script>',
    '<script>clem.refresh("pipeline").then(({data}) => render(data.pipeline));</script>',
    '<script>fetch("/api/console/spaces/x/data").then(r => r.json()).then(({data}) => render(data.pipeline));</script>',
  ];
  for (const html of canonical) {
    const gaps = analyzeSpaceGaps(record, `<html><body>${html}</body></html>`, []);
    assert.ok(!gaps.some((g) => /canonical bridge/.test(g.question)), `${html} must pass the bridge check`);
  }

  const legacyShapes: Array<[string, string]> = [
    ['inlined JSON dataset', '<script type="application/json" id="dataset">{"pipeline":[]}</script><script>render(JSON.parse(document.getElementById("dataset").textContent).pipeline)</script>'],
    ['embedded window seed', '<script>window.__PIPELINE_DATA = {"pipeline":[]}; render(window.__PIPELINE_DATA.pipeline);</script>'],
  ];
  for (const [label, html] of legacyShapes) {
    const gaps = analyzeSpaceGaps(record, `<html><body>${html}</body></html>`, []);
    assert.ok(
      gaps.some((g) => g.resolution === 'fix' && /clem\.data\(\)/.test(g.question)),
      `${label} must require the canonical bridge`,
    );
  }
});

test('check 1 still fires on a view that demonstrably consumes nothing', () => {
  const record = { dataSources: [{ id: 'pipeline' }], actions: [] } as never;
  const gaps = analyzeSpaceGaps(record, '<html><body><h1>pipeline dashboard</h1><script>document.title="x";</script></body></html>', []);
  assert.ok(gaps.some((g) => g.question.includes('never reads them')), 'a truly data-blind view is still flagged');
});

test('the host-planted dataset is a live binding; a JSON literal pasted into the view is not', () => {
  const record = { dataSources: [{ id: 'tasks' }], actions: [] } as never;
  // The server plants the current dataset as window.__SPACE_DATA__ on every
  // serve and the desktop remounts the frame when the dataset changes, so a
  // view rendering from it is data-connected, as the tool text instructs.
  const planted = analyzeSpaceGaps(
    record,
    '<html><script>const data = window.__SPACE_DATA__ || {}; render(data.tasks)</script></html>',
    [],
  );
  assert.equal(planted.some((g) => g.question.includes('never reads them')), false);
  // A snapshot of the data typed into the HTML never changes after authoring.
  const pasted = analyzeSpaceGaps(
    record,
    '<html><script>const DATA = {"tasks":[{"title":"Call Ana"}]}; render(DATA.tasks)</script></html>',
    [],
  );
  assert.ok(pasted.some((g) => g.resolution === 'fix' && g.question.includes('never reads them')));
});

test('2d: an action whose operation requires an input neither the template nor the literal view call supplies is a fix gap', () => {
  const record = {
    dataSources: [],
    actions: [{ id: 'draft_reply', composioSlug: 'OUTLOOK_CREATE_DRAFT_REPLY', argsTemplate: { user_id: 'me' } }],
  } as never;
  const requirements = { actionInputRequirements: { draft_reply: ['user_id', 'message_id', 'mail_folder_id', 'comment'] } };
  const call = (args: string) => `<html><button onclick="go()">Draft</button><script>async function go(){ await clem.action('draft_reply', ${args}); }</script></html>`;

  const missing = analyzeSpaceGaps(record, call('{ message_id: row.id, comment: text }'), [], requirements);
  const gap = missing.find((g) => g.actionId === 'draft_reply' && g.resolution === 'fix' && g.question.includes('requires'));
  assert.ok(gap, JSON.stringify(missing));
  assert.match(gap.question, /requires `mail_folder_id`/);
  assert.doesNotMatch(gap.question, /message_id|comment|user_id/, 'only the input nobody supplies is named');

  // Supplied by the view (keyed, quoted, shorthand) or by the template: clean.
  for (const args of [
    '{ message_id: row.id, mail_folder_id: row.folder, comment: text }',
    '{ "message_id": row.id, \'mail_folder_id\': row.folder, comment }',
    '{ message_id, mail_folder_id, comment: `Thanks {name}, will do` }',
  ]) {
    assert.equal(
      analyzeSpaceGaps(record, call(args), [], requirements).some((g) => g.actionId === 'draft_reply' && g.question.includes('requires')),
      false,
      args,
    );
  }
  const templated = {
    dataSources: [],
    actions: [{ id: 'draft_reply', composioSlug: 'OUTLOOK_CREATE_DRAFT_REPLY', argsTemplate: { user_id: 'me', mail_folder_id: 'inbox' } }],
  } as never;
  assert.equal(
    analyzeSpaceGaps(templated, call('{ message_id: row.id, comment: text }'), [], requirements).some((g) => g.actionId === 'draft_reply' && g.question.includes('requires')),
    false,
  );

  // Cannot be proven statically: never refused on a guess.
  for (const args of [
    'args',
    '{ ...base, comment: text }',
    '{ [field]: row.id, comment: text }',
  ]) {
    assert.equal(
      analyzeSpaceGaps(record, call(args), [], requirements).some((g) => g.actionId === 'draft_reply' && g.question.includes('requires')),
      false,
      args,
    );
  }
  // A nested object's keys do not count as top-level inputs.
  const nested = analyzeSpaceGaps(record, call('{ message_id: row.id, comment: text, meta: { mail_folder_id: 1 } }'), [], requirements);
  assert.ok(nested.some((g) => g.actionId === 'draft_reply' && g.question.includes('requires')));
  // One of two call sites missing the input is still a broken button.
  const twoSites = `<html><script>clem.action('draft_reply', { message_id: a, mail_folder_id: b, comment: c }); clem.action("draft_reply", { message_id: a, comment: c });</script></html>`;
  assert.ok(analyzeSpaceGaps(record, twoSites, [], requirements).some((g) => g.actionId === 'draft_reply' && g.question.includes('requires')));
  // No schema requirements known: not checked.
  assert.equal(analyzeSpaceGaps(record, call('{ comment: text }'), []).some((g) => g.question.includes('requires')), false);
});
