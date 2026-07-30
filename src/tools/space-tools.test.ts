/**
 * Run: npx tsx --test src/tools/space-tools.test.ts
 *
 * Exercises the space_save / space_list / space_get tool handlers directly
 * (no LLM, no MCP transport) via a fake capturing server. Temp CLEMENTINE_HOME
 * so the real home is safe.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-tools-test-'));

const { registerSpaceTools, deriveRunnerProvenance } = await import('./space-tools.js');
const store = await import('../spaces/store.js');
const { spaceActionNeedsApproval } = await import('../spaces/space-action-gate.js');
const approvals = await import('../runtime/harness/approval-registry.js');

type Handler = (input: Record<string, unknown>) => Promise<unknown> | unknown;
function captureTools(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const fake = { tool(name: string, _d: string, _p: unknown, h: Handler) { handlers[name] = h; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerSpaceTools(fake as any);
  return handlers;
}

function text(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> })?.content;
  return content?.[0]?.text ?? '';
}

const tools = captureTools();

test('registerSpaceTools exposes Workspace authoring and deferred temporal reads', () => {
  assert.ok(tools.space_save);
  assert.ok(tools.space_list);
  assert.ok(tools.space_get);
  assert.ok(tools.space_history);
  assert.ok(tools.space_diff);
});

test('space_save creates a workspace, installs the view, returns the URL', async () => {
  // Clem "writes" the view with write_file first → emulate by writing into BASE_DIR.
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'spaces', 'crm', 'view', 'index.html');
  mkdirSync(path.dirname(draft), { recursive: true });
  writeFileSync(draft, '<html><body>CRM v1</body></html>', 'utf-8');

  const res = await tools.space_save({
    slug: 'crm',
    title: 'CRM Board',
    objective: 'Keep the sales team focused on the deals that need action.',
    success_criteria: ['Every risky deal has a current next step'],
    invariants: ['Never update the CRM without approval'],
    view_path: draft,
  });
  const out = text(res);
  assert.match(out, /Created workspace "CRM Board"/);
  assert.match(out, /\/workspaces\/crm/);

  const rec = store.spaceStore.get('crm');
  assert.equal(rec?.title, 'CRM Board');
  assert.deepEqual(rec?.contract, {
    objective: 'Keep the sales team focused on the deals that need action.',
    successCriteria: ['Every risky deal has a current next step'],
    invariants: ['Never update the CRM without approval'],
  });
  const canonical = store.resolveInSpace('crm', 'view/index.html');
  assert.ok(existsSync(canonical));
  assert.match(readFileSync(canonical, 'utf-8'), /CRM v1/);
});

test('space_save rejects an invalid slug and a missing view on create', async () => {
  assert.match(text(await tools.space_save({ slug: 'Bad Slug', title: 'x', view_path: null })), /not a valid workspace slug/);
  assert.match(text(await tools.space_save({ slug: 'newone', title: 'x', view_path: null })), /view_path is required/);
});

test('space_save updates in place + snapshots the prior view (revert path)', async () => {
  const draft2 = path.join(process.env.CLEMENTINE_HOME!, 'tmp-crm-v2.html');
  writeFileSync(draft2, '<html><body>CRM v2</body></html>', 'utf-8');
  const res = await tools.space_save({ slug: 'crm', title: 'CRM Board', view_path: draft2 });
  assert.match(text(res), /Updated workspace/);
  const rec = store.spaceStore.get('crm');
  assert.equal(rec?.version, 2);
  assert.equal(rec?.revisions.length, 1);
  assert.equal(
    rec?.contract?.objective,
    'Keep the sales team focused on the deals that need action.',
    'later saves preserve an omitted contract',
  );
  // canonical now holds v2; the snapshot holds v1.
  assert.match(readFileSync(store.resolveInSpace('crm', 'view/index.html'), 'utf-8'), /CRM v2/);
  assert.match(readFileSync(store.resolveInSpace('crm', rec!.revisions[0].file), 'utf-8'), /CRM v1/);
});

test('space_save records declared data sources + re-engage contract', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-planner.html');
  writeFileSync(draft, '<html><script>clem.data().then(data => render(data.cal))</script></html>', 'utf-8');
  await tools.space_save({
    slug: 'planner',
    title: 'Daily Planner',
    view_path: draft,
    data_sources: [{ id: 'cal', composio_slug: 'GOOGLECALENDAR_LIST_EVENTS', composio_args_json: '{"max":10}', schedule: '0 7 * * *', timezone: 'America/Los_Angeles', runner: null }],
    reengage_triggers: ['note', 'ask'],
    reengage_guidance: 'reschedule anything that slips',
  });
  const rec = store.spaceStore.get('planner');
  assert.equal(rec?.dataSources.length, 1);
  assert.equal(rec?.dataSources[0].composioSlug, 'GOOGLECALENDAR_LIST_EVENTS');
  assert.deepEqual(rec?.dataSources[0].composioArgs, { max: 10 });
  assert.deepEqual(rec?.reengage?.triggers, ['note', 'ask']);
});

test('space_save refuses a data-backed view that only reads an imaginary window seed', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-imaginary-seed.html');
  writeFileSync(draft, '<html><script>const data=window.__SPACE_DATA__||{}; render(data.tasks)</script></html>', 'utf-8');

  const out = text(await tools.space_save({
    slug: 'imaginary-seed',
    title: 'Imaginary Seed',
    view_path: draft,
    data_sources: [{ id: 'tasks', composio_slug: 'SALESFORCE_GET_TASKS' }],
  }));

  assert.match(out, /was NOT saved/);
  assert.match(out, /fix these implementation issues now/);
  assert.equal(store.spaceStore.get('imaginary-seed'), undefined);
});

test('space_save refuses legacy {{source}} binding before activating a dynamic Workspace', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-legacy-binding.html');
  writeFileSync(
    draft,
    `<html>
      <script id="dataset" type="application/json">{{tasks}}</script>
      <script>
        const raw = document.getElementById("dataset").textContent;
        const data = raw !== "{{tasks}}" ? JSON.parse(raw) : [];
        render(data);
      </script>
    </html>`,
    'utf-8',
  );
  const out = text(await tools.space_save({
    slug: 'legacy-binding',
    title: 'Legacy Binding',
    view_path: draft,
    data_sources: [{ id: 'tasks', composio_slug: 'SALESFORCE_GET_TASKS', allow_empty: true }],
  }));

  assert.match(out, /was NOT saved/);
  assert.match(out, /clem\.data\(\)/);
  assert.match(out, /not expanded|legacy/i);
  assert.equal(store.spaceStore.get('legacy-binding'), undefined);
});

test('space_save refuses a newly-authored opaque data-source runner before installing it', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-one-pass.html');
  const runnerDraft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-open-tasks.mjs');
  writeFileSync(
    draft,
    '<html><script>async function load(){const data=await clem.data();render(data["open-tasks"])}</script></html>',
    'utf-8',
  );
  writeFileSync(runnerDraft, 'process.stdout.write(JSON.stringify([]))', 'utf-8');

  const out = text(await tools.space_save({
    slug: 'one-pass',
    title: 'One Pass',
    view_path: draft,
    data_sources: [{
      id: 'open-tasks',
      runner: null,
      runner_path: runnerDraft,
      composio_slug: null,
      composio_args_json: null,
      schedule: null,
      timezone: null,
    }],
  }));

  assert.match(out, /was NOT saved/);
  assert.match(out, /opaque runner|provably read-only Composio/i);
  assert.equal(store.spaceStore.get('one-pass'), undefined);
  assert.equal(existsSync(store.resolveInSpace('one-pass', 'data/tmp-open-tasks.mjs')), false);
});

test('space_save preserves an installed runner source and holds its smoke for pinned-entrypoint approval', async () => {
  const slug = 'legacy-runner-save';
  const view = store.resolveInSpace(slug, 'view/index.html');
  const runnerFile = store.resolveInSpace(slug, 'data/pull.mjs');
  mkdirSync(path.dirname(view), { recursive: true });
  mkdirSync(path.dirname(runnerFile), { recursive: true });
  writeFileSync(
    view,
    '<html><script>clem.data().then(data => render(data.pull))</script></html>',
    'utf-8',
  );
  writeFileSync(runnerFile, 'process.stdout.write(JSON.stringify({rows:[1]}))', 'utf-8');
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner save',
    dataSources: [{ id: 'pull', runner: 'pull.mjs', schedule: '0 7 * * *' }],
  });

  const out = text(await tools.space_save({
    slug,
    title: 'Legacy runner save',
    data_sources: [{
      id: 'pull',
      runner: 'pull.mjs',
      runner_path: null,
      composio_slug: null,
      composio_args_json: null,
      schedule: '0 7 * * *',
      timezone: null,
    }],
  }));

  assert.match(out, /Updated workspace/);
  assert.match(out, /Legacy runner.*preserved/i);
  assert.match(out, /waiting for your one-time approval/i);
  assert.doesNotMatch(out, /Data refreshed:.*pull/i);
  assert.equal(store.spaceStore.get(slug)?.status, 'active', 'migration wait is not a broken build');
  assert.equal(store.spaceStore.get(slug)?.dataSources[0]?.runner, 'pull.mjs');
  assert.equal(
    approvals.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    1,
  );

  const refreshOut = text(await tools.space_refresh({ slug, source_id: 'pull' }));
  assert.match(refreshOut, /Refresh awaiting approval for/i);
  assert.match(refreshOut, /pull: AWAITING APPROVAL/i);
  assert.doesNotMatch(refreshOut, /FAILED/i);
});

test('space_save preserves an exact local post-approval action without fake outbound remediation', async () => {
  const slug = 'local-post-approval';
  const viewDraft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-local-post-approval.html');
  const actionDraft = path.join(process.env.CLEMENTINE_HOME!, 'approve-post.mjs');
  writeFileSync(
    viewDraft,
    '<html><button onclick="approve()">Approve</button><script>function approve(){return clem.action("approve_post", {postId:"synthetic-1"})}</script></html>',
    'utf-8',
  );
  writeFileSync(
    actionDraft,
    'process.stdout.write(JSON.stringify({ok:true,external:false}))',
    'utf-8',
  );

  const out = text(await tools.space_save({
    slug,
    title: 'Local Post Approval',
    view_path: viewDraft,
    actions: [{
      id: 'approve_post',
      label: 'Approve locally',
      runner_path: actionDraft,
      args_template_json: '{"external":false}',
      confirm: false,
    }],
  }));

  assert.match(out, /Created workspace "Local Post Approval"/);
  assert.match(out, /confirm:true|approval/i);
  const rec = store.spaceStore.get(slug);
  assert.equal(rec?.actions.length, 1, 'the valid local action remains declared');
  assert.equal(rec?.actions[0].id, 'approve_post');
  assert.equal(rec?.actions[0].confirm, true);
  assert.equal(spaceActionNeedsApproval(rec!.actions[0]), true, 'opaque runner code must take the approval path');
});

test('space_save preserves a newer installed action-runner repair over a stale runner_path', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-newer-runner-view.html');
  const runnerDraft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-newer-runner.mjs');
  const original = 'process.stdout.write(JSON.stringify([]))';
  const repaired = 'process.stdout.write(JSON.stringify([{title:"kept repair"}]))';
  writeFileSync(
    draft,
    '<html><button onclick="clem.action(\'sync\',{})">Sync</button></html>',
    'utf-8',
  );
  writeFileSync(runnerDraft, original, 'utf-8');

  const args = {
    slug: 'newer-runner-wins',
    title: 'Newer Runner Wins',
    view_path: draft,
    actions: [{
      id: 'sync',
      label: 'Sync',
      runner: null,
      runner_path: runnerDraft,
      composio_slug: null,
      args_template_json: null,
      confirm: true,
    }],
  };
  assert.match(text(await tools.space_save(args)), /Created workspace/);

  const installed = store.resolveInSpace('newer-runner-wins', 'data/tmp-newer-runner.mjs');
  writeFileSync(installed, repaired, 'utf-8');
  const old = new Date('2026-01-01T00:00:01.000Z');
  const newer = new Date('2026-01-01T00:00:02.000Z');
  utimesSync(runnerDraft, old, old);
  utimesSync(installed, newer, newer);

  const out = text(await tools.space_save(args));
  assert.match(out, /Preserved newer edited runner/);
  assert.equal(readFileSync(installed, 'utf-8'), repaired);
});

test('space_save rejects conflicting runner sources before installing either', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-conflict.html');
  const runnerA = path.join(process.env.CLEMENTINE_HOME!, 'conflict-a.mjs');
  const runnerB = path.join(process.env.CLEMENTINE_HOME!, 'conflict-b.mjs');
  writeFileSync(draft, '<html><script>clem.data().then(data=>render(data.a,data.b))</script></html>', 'utf-8');
  writeFileSync(runnerA, 'process.stdout.write("{}")', 'utf-8');
  writeFileSync(runnerB, 'process.stdout.write("[]")', 'utf-8');

  const out = text(await tools.space_save({
    slug: 'runner-conflict',
    title: 'Runner Conflict',
    view_path: draft,
    data_sources: [
      { id: 'a', runner: 'same.mjs', runner_path: runnerA, composio_slug: null, composio_args_json: null, schedule: null, timezone: null },
      { id: 'b', runner: 'same.mjs', runner_path: runnerB, composio_slug: null, composio_args_json: null, schedule: null, timezone: null },
    ],
  }));

  assert.match(out, /was NOT saved/);
  assert.match(out, /different source files/);
  assert.equal(store.spaceStore.get('runner-conflict'), undefined);
  assert.equal(existsSync(store.resolveInSpace('runner-conflict', 'data/same.mjs')), false);
});

test('space_save rejects invalid Composio JSON templates before installing a workspace', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-bad-json.html');
  writeFileSync(draft, '<html>bad-json</html>', 'utf-8');

  const sourceRes = text(await tools.space_save({
    slug: 'bad-json-source',
    title: 'Bad Source',
    view_path: draft,
    data_sources: [{
      id: 'cal',
      composio_slug: 'GOOGLECALENDAR_LIST_EVENTS',
      composio_args_json: '{not json',
      runner: null,
      schedule: null,
      timezone: null,
    }],
  }));
  assert.match(sourceRes, /was NOT saved/);
  assert.match(sourceRes, /Data source "cal" composio_args_json is not valid JSON/);
  assert.equal(store.spaceStore.get('bad-json-source'), undefined);

  const actionRes = text(await tools.space_save({
    slug: 'bad-json-action',
    title: 'Bad Action',
    view_path: draft,
    actions: [{
      id: 'send',
      label: 'Send',
      composio_slug: 'OUTLOOK_SEND_EMAIL',
      args_template_json: '[1,2]',
      runner: null,
      confirm: null,
    }],
  }));
  assert.match(actionRes, /was NOT saved/);
  assert.match(actionRes, /Action "send" args_template_json must be a JSON object/);
  assert.equal(store.spaceStore.get('bad-json-action'), undefined);
});

test('space_get surfaces hand-written manifest JSON errors and space_save requires corrected definitions', async () => {
  const slug = 'handwrite-fix';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'view'), { recursive: true });
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'view', 'index.html'), '<html>old</html>', 'utf-8');
  writeFileSync(path.join(dir, 'data', 'r.mjs'), 'process.stdout.write(JSON.stringify({rows:[{ok:true}]}))', 'utf-8');
  writeFileSync(path.join(dir, 'data', 'act.mjs'), 'process.stdout.write(JSON.stringify({ok:true}))', 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Handwritten',
    dataSources: [{ id: 'pull', composio_slug: 'GOOGLECALENDAR_LIST_EVENTS', composio_args_json: '{not json' }],
    actions: [{ id: 'act', runner: 'act.mjs', args_template_json: '[1,2]' }],
  }), 'utf-8');

  const got = text(await tools.space_get({ slug }));
  assert.match(got, /Manifest errors: fix with space_save/);
  assert.match(got, /composio_args_json is not valid JSON/);
  assert.match(got, /args_template_json must be a JSON object/);

  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-handwrite-fix.html');
  writeFileSync(
    draft,
    '<html><script>function act(){return clem.action("act", {})}</script></html>',
    'utf-8',
  );
  const viewOnly = text(await tools.space_save({ slug, title: 'Handwritten', view_path: draft }));
  assert.match(viewOnly, /was NOT saved/);
  assert.match(viewOnly, /Pass corrected data_sources and actions/);

  const fixed = text(await tools.space_save({
    slug,
    title: 'Handwritten',
    view_path: draft,
    data_sources: [],
    actions: [{ id: 'act', label: 'Act', runner: 'act.mjs', composio_slug: null, args_template_json: '{"scope":"team"}', confirm: null }],
  }));
  assert.match(fixed, /Updated workspace/);
  const rec = store.spaceStore.get(slug);
  assert.equal(rec?.manifestErrors, undefined);
  assert.deepEqual(rec?.actions[0].argsTemplate, { scope: 'team' });
  assert.equal(rec?.version, 2, 'fixing a malformed manifest while replacing the view still snapshots the prior view');
  assert.equal(rec?.revisions.length, 1);
  assert.match(readFileSync(store.resolveInSpace(slug, rec!.revisions[0].file), 'utf-8'), /old/);
});

test('space_list + space_get read back', async () => {
  assert.match(text(await tools.space_list({})), /CRM Board/);
  const got = text(await tools.space_get({ slug: 'crm' }));
  assert.match(got, /Workspace "CRM Board"/);
  assert.match(got, /v2/);
  assert.match(got, /Objective: Keep the sales team focused/);
  assert.match(got, /Success criteria:.*Every risky deal/);
  assert.match(got, /Invariants:.*Never update the CRM/);
  assert.match(got, /Dataset history: no retained observations yet/i);
});

test('space_edit_view applies a targeted change + bumps version + snapshots', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-edit-view.html');
  writeFileSync(draft, '<html><body><button>Call</button></body></html>', 'utf-8');
  await tools.space_save({ slug: 'editable', title: 'Editable', view_path: draft });
  const before = store.spaceStore.get('editable')!.version;

  const res = await tools.space_edit_view({
    slug: 'editable',
    edits: [{ find: '<button>Call</button>', replace: '<a href="tel:+1">Call</a>' }],
  });
  assert.match(text(res), /Applied 1 edit/);
  const canonical = readFileSync(store.resolveInSpace('editable', 'view/index.html'), 'utf-8');
  assert.match(canonical, /href="tel:\+1"/);
  assert.equal(canonical.includes('<button>Call</button>'), false);
  assert.equal(store.spaceStore.get('editable')!.version, before + 1); // bumped + snapshot taken
});

test('space_edit_view refuses malformed manifests so revisions are reliable', async () => {
  const slug = 'bad-edit-manifest';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'view'), { recursive: true });
  writeFileSync(path.join(dir, 'view', 'index.html'), '<html><body>Old</body></html>', 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Edit Manifest',
    actions: [{ id: 'send', runner: 'act.mjs', args_template_json: '[1,2]' }],
  }), 'utf-8');

  const res = text(await tools.space_edit_view({
    slug,
    edits: [{ find: 'Old', replace: 'New' }],
  }));

  assert.match(res, /was NOT edited/);
  assert.match(res, /manifest is invalid/);
  assert.match(res, /args_template_json must be a JSON object/);
  assert.match(readFileSync(store.resolveInSpace(slug, 'view/index.html'), 'utf-8'), /Old/);
});

test('space_edit_view reports when no find string matches (no write)', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-edit-nomatch.html');
  writeFileSync(draft, '<html>hello</html>', 'utf-8');
  await tools.space_save({ slug: 'nomatch', title: 'NoMatch', view_path: draft });
  const res = await tools.space_edit_view({ slug: 'nomatch', edits: [{ find: 'NOT THERE', replace: 'x' }] });
  assert.match(text(res), /No edits applied/);
  // The miss-message points at space_get_view (which returns the view HTML), NOT
  // space_get — the old instruction was impossible and forced a shell read_file/grep.
  assert.match(text(res), /space_get_view\('nomatch'/);
  assert.doesNotMatch(text(res), /Call space_get\('nomatch'\)/);
  assert.match(readFileSync(store.resolveInSpace('nomatch', 'view/index.html'), 'utf-8'), /hello/);
});

// --- space_get_view: the catch-22 keystone (space_get never returned view HTML) ---

test('space_get_view is registered alongside the other space tools', () => {
  assert.ok(tools.space_get_view, 'space_get_view must be registered for both lanes');
});

test('space_get_view returns the full view, line-numbered (the editable text space_get never gave)', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-getview.html');
  writeFileSync(draft, '<html>\n<body>\n  <button id="send">Send</button>\n</body>\n</html>', 'utf-8');
  await tools.space_save({ slug: 'getview', title: 'GetView', view_path: draft });

  const out = text(await tools.space_get_view({ slug: 'getview', grep: null, around: null }));
  // line-numbered (cat -n style: "<n>\t<line>") and contains the real view bytes
  assert.match(out, /1\t<html>/);
  assert.match(out, /3\t {2}<button id="send">Send<\/button>/);
  assert.match(out, /5\t<\/html>/);
  // space_get, by contrast, must NOT leak the view HTML (it stays manifest-only)
  assert.doesNotMatch(text(await tools.space_get({ slug: 'getview' })), /<button id="send"/);
});

test('space_get_view with grep returns only the matching region + context, with line numbers', async () => {
  const lines = Array.from({ length: 40 }, (_, i) => `  <div class="row-${i}">row ${i}</div>`);
  lines[20] = '  <button id="target">Click me</button>';
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-getview-grep.html');
  writeFileSync(draft, lines.join('\n'), 'utf-8');
  await tools.space_save({ slug: 'getviewgrep', title: 'GetViewGrep', view_path: draft });

  const out = text(await tools.space_get_view({ slug: 'getviewgrep', grep: 'target', around: 2 }));
  assert.match(out, /1 line matching "target"/);
  assert.match(out, /21\t {2}<button id="target">Click me<\/button>/); // the hit (1-indexed)
  assert.match(out, /19\t/); // ±2 context above
  assert.match(out, /23\t/); // ±2 context below
  assert.doesNotMatch(out, /1\t {2}<div class="row-0"/); // far-away lines excluded
});

test('space_get_view grep with no match falls through to the full view (never a dead end)', async () => {
  const out = text(await tools.space_get_view({ slug: 'getview', grep: 'NONEXISTENT_TEXT', around: null }));
  assert.match(out, /No view line matched "NONEXISTENT_TEXT"/);
  assert.match(out, /1\t<html>/); // still gives the model the full view to work from
});

test('space_get_view caps a large view and tells the model to grep', async () => {
  const big = Array.from({ length: 5000 }, (_, i) => `<div>filler line number ${i} with some padding text to add bytes</div>`).join('\n');
  assert.ok(big.length > 60_000);
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-getview-big.html');
  writeFileSync(draft, big, 'utf-8');
  await tools.space_save({ slug: 'getviewbig', title: 'GetViewBig', view_path: draft });

  const out = text(await tools.space_get_view({ slug: 'getviewbig', grep: null, around: null }));
  assert.ok(out.length < big.length, 'a large view must be capped, not dumped whole');
  assert.match(out, /view is large.*pass grep/i);
});

test('space_get_view errors cleanly for a missing workspace', async () => {
  assert.match(text(await tools.space_get_view({ slug: 'no-such-space', grep: null, around: null })), /No workspace named/);
});

// --- space_edit_view structured feedback: precise mismatch hint on a near-miss ---

test('space_edit_view surfaces a whitespace mismatch hint instead of a blind miss', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-edit-mismatch.html');
  // The view indents the button with a TAB; the model will (wrongly) use spaces.
  writeFileSync(draft, '<body>\n\t<button id="go">Go</button>\n</body>', 'utf-8');
  await tools.space_save({ slug: 'mismatch', title: 'Mismatch', view_path: draft });
  const res = text(await tools.space_edit_view({
    slug: 'mismatch',
    edits: [{ find: '  <button id="go">Go</button>', replace: '  <button id="go">Done</button>' }],
  }));
  assert.match(res, /No edits applied/);
  assert.match(res, /matched the first \d+ char\(s\)/); // pinpoints where it diverged
  assert.match(res, /space_get_view/); // points the model at the real fix
  assert.match(res, /watch tabs vs spaces/);
  // the view is untouched
  assert.match(readFileSync(store.resolveInSpace('mismatch', 'view/index.html'), 'utf-8'), /Go<\/button>/);
});

test('space_edit_view notes when a find hit multiple occurrences', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-edit-multi.html');
  writeFileSync(draft, '<span>x</span><span>x</span>', 'utf-8');
  await tools.space_save({ slug: 'multi', title: 'Multi', view_path: draft });
  const res = text(await tools.space_edit_view({ slug: 'multi', edits: [{ find: '<span>x</span>', replace: '<span>y</span>' }] }));
  assert.match(res, /Applied 1 edit/);
  assert.match(res, /ALL 2 occurrences/);
});

// --- space_try_runner: static-only safety inspection (never spawns code) ---

test('space_try_runner never spawns arbitrary runner code', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-tryrunner.html');
  writeFileSync(draft, '<html>tr</html>', 'utf-8');
  await tools.space_save({ slug: 'tryrunner', title: 'TryRunner', view_path: draft });
  const runnerDir = store.resolveInSpace('tryrunner', 'data');
  mkdirSync(runnerDir, { recursive: true });
  writeFileSync(path.join(runnerDir, 'pull.mjs'),
    'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./spawned.txt", import.meta.url), "yes"); process.stdout.write("[]")', 'utf-8');

  const res = text(await tools.space_try_runner({ slug: 'tryrunner', runner_path: 'pull.mjs', payload_json: null }));
  assert.match(res, /did not execute|static/i);
  assert.match(res, /arbitrary runner|external/i);
  assert.equal(existsSync(path.join(runnerDir, 'spawned.txt')), false);
  assert.equal(existsSync(store.resolveInSpace('tryrunner', 'data.json')), false);
});

test('space_try_runner gives action runners approval-safe guidance without executing them', async () => {
  const runnerDir = store.resolveInSpace('tryrunner', 'data');
  writeFileSync(
    path.join(runnerDir, 'act.mjs'),
    'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./action-ran.txt", import.meta.url), "yes"); process.stdout.write("{}")',
    'utf-8',
  );
  store.spaceStore.update('tryrunner', {
    actions: [{ id: 'act', runner: 'act.mjs' }],
  });
  const res = text(await tools.space_try_runner({ slug: 'tryrunner', runner_path: 'act.mjs', payload_json: null }));
  assert.match(res, /action/i);
  assert.match(res, /approval/i);
  assert.equal(existsSync(path.join(runnerDir, 'action-ran.txt')), false);
});

// --- space_set_data: the sanctioned inline-commit (replaces /tmp scrub scripts) ---

test('space_set_data commits inline JSON, counts rows, and stamps _meta.provenance=manual', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-setdata.html');
  writeFileSync(draft, '<html>sd</html>', 'utf-8');
  await tools.space_save({ slug: 'setdata', title: 'SetData', view_path: draft });

  const res = text(await tools.space_set_data({
    slug: 'setdata', source_id: 'deals',
    data_json: JSON.stringify([{ firm: 'Acme', stage: 'won' }, { firm: 'Globex', stage: 'lost' }]),
  }));
  assert.match(res, /Saved 2 rows under "deals"/);
  assert.match(res, /marked manual/);

  const dataMod = await import('../spaces/data-store.js');
  const data = dataMod.readData('setdata') as Record<string, unknown>;
  assert.equal((data.deals as unknown[]).length, 2);
  const meta = data._meta as Record<string, { provenance?: string }>;
  assert.equal(meta.deals.provenance, 'manual');

  const history = text(await tools.space_history({
    slug: 'setdata',
    source_id: 'deals',
    status: null,
    limit: null,
  }));
  assert.match(history, /"status":"ok"/);
  assert.match(history, /"cause":"manual"/);
  assert.doesNotMatch(history, /"firm": "Acme"/, 'history metadata must not copy retained rows');

  const baseline = text(await tools.space_diff({
    slug: 'setdata',
    source_id: 'deals',
    from_observation_id: null,
    to_observation_id: null,
    max_changes: null,
  }));
  assert.match(baseline, /"status":"insufficient_history"/);

  await tools.space_set_data({
    slug: 'setdata',
    source_id: 'deals',
    data_json: JSON.stringify([{ firm: 'Acme', stage: 'renewal' }, { firm: 'Globex', stage: 'lost' }]),
  });
  const diff = text(await tools.space_diff({
    slug: 'setdata',
    source_id: 'deals',
    from_observation_id: null,
    to_observation_id: null,
    max_changes: null,
  }));
  assert.match(diff, /"status":"changed"/);
  assert.match(diff, /stage/);

  const stringNullDiff = text(await tools.space_diff({
    slug: 'setdata',
    source_id: 'deals',
    from_observation_id: 'null',
    to_observation_id: 'null',
    max_changes: 25,
  }));
  assert.match(
    stringNullDiff,
    /"status":"changed"/,
    'BYO models that serialize optional null ids as the string "null" still get the default current-versus-prior diff',
  );
  assert.match(stringNullDiff, /stage/);

  const bogusIdDiff = text(await tools.space_diff({
    slug: 'setdata',
    source_id: 'deals',
    from_observation_id: 'not-a-real-observation-id',
    to_observation_id: null,
    max_changes: 25,
  }));
  assert.match(
    bogusIdDiff,
    /"status":"observation_not_found"/,
    'only known null sentinels are normalized; a real bogus id must still fail closed',
  );
  assert.match(text(await tools.space_get({ slug: 'setdata' })), /space_diff is confirmed for: deals/);
});

test('space_get imports a pre-3.0 data.json once as an honest baseline', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-legacy-history.html');
  writeFileSync(draft, '<html>legacy history</html>', 'utf-8');
  await tools.space_save({ slug: 'legacy-history', title: 'Legacy History', view_path: draft });
  const dataMod = await import('../spaces/data-store.js');
  const written = dataMod.writeData('legacy-history', {
    metrics: { spend: 100, conversions: 4 },
    _meta: { metrics: { provenance: 'legacy' } },
  });
  assert.equal(written.ok, true);

  const firstGet = text(await tools.space_get({ slug: 'legacy-history' }));
  assert.match(firstGet, /1 retained observation/);
  assert.match(firstGet, /Baseline only/);
  const firstHistory = text(await tools.space_history({
    slug: 'legacy-history',
    source_id: 'metrics',
    status: null,
    limit: null,
  }));
  assert.match(firstHistory, /"cause":"legacy_import"/);

  await tools.space_get({ slug: 'legacy-history' });
  const secondHistory = text(await tools.space_history({
    slug: 'legacy-history',
    source_id: 'metrics',
    status: null,
    limit: null,
  }));
  assert.match(secondHistory, /"returned":1/, 'repeated reads must not duplicate the baseline');
});

test('space_set_data refuses to overwrite malformed pre-3.0 data before it has a baseline', async () => {
  const draft = path.join(process.env.CLEMENTINE_HOME!, 'tmp-malformed-legacy-history.html');
  writeFileSync(draft, '<html>malformed legacy history</html>', 'utf-8');
  await tools.space_save({
    slug: 'malformed-legacy-history',
    title: 'Malformed Legacy History',
    view_path: draft,
  });
  const dataFile = store.resolveInSpace('malformed-legacy-history', 'data.json');
  const original = '{"metrics":{"spend":100},"unfinished":';
  writeFileSync(dataFile, original, 'utf-8');

  const result = text(await tools.space_set_data({
    slug: 'malformed-legacy-history',
    source_id: 'metrics',
    data_json: JSON.stringify({ spend: 999 }),
  }));
  assert.match(result, /Could not save data/i);
  assert.match(result, /legacy comparison baseline could not be imported/i);
  assert.equal(readFileSync(dataFile, 'utf-8'), original, 'the malformed legacy bytes remain untouched');

  const workspaceDb = await import('../spaces/workspace-db.js');
  assert.equal(
    workspaceDb.listWorkspaceDatasetObservations('malformed-legacy-history', { limit: 10 }).length,
    0,
    'no observation may commit when the prior file could not be preserved',
  );
});

test('space_set_data rejects invalid JSON (no write)', async () => {
  const res = text(await tools.space_set_data({ slug: 'setdata', source_id: 'deals', data_json: '{not json' }));
  assert.match(res, /not valid JSON/);
});

test('space_set_data refuses the reserved "_meta" source id (would clobber provenance)', async () => {
  const dataMod = await import('../spaces/data-store.js');
  const before = JSON.stringify(dataMod.readData('setdata'));
  const res = text(await tools.space_set_data({ slug: 'setdata', source_id: '_meta', data_json: '[{"x":1}]' }));
  assert.match(res, /reserved key/);
  // the existing dataset + its _meta map are untouched
  assert.equal(JSON.stringify(dataMod.readData('setdata')), before);
});

test('space_set_data refuses paused or archived workspaces without mutating data', async () => {
  const dataMod = await import('../spaces/data-store.js');
  store.spaceStore.update('setdata', { status: 'paused' });
  const beforePaused = JSON.stringify(dataMod.readData('setdata'));
  const paused = text(await tools.space_set_data({
    slug: 'setdata',
    source_id: 'deals',
    data_json: JSON.stringify([{ firm: 'Paused Write' }]),
  }));
  assert.match(paused, /data writes are disabled/);
  assert.equal(JSON.stringify(dataMod.readData('setdata')), beforePaused);

  store.spaceStore.update('setdata', { status: 'archived' });
  const beforeArchived = JSON.stringify(dataMod.readData('setdata'));
  const archived = text(await tools.space_set_data({
    slug: 'setdata',
    source_id: 'deals',
    data_json: JSON.stringify([{ firm: 'Archived Write' }]),
  }));
  assert.match(archived, /data writes are disabled/);
  assert.equal(JSON.stringify(dataMod.readData('setdata')), beforeArchived);
});

// --- space_get_runner / space_edit_runner: grounded runner read+edit (the Space twin of the workflow fix) ---

function makeRunnerSpace(): string {
  const slug = 'deal-risk';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'view'), { recursive: true });
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'view', 'index.html'), '<html>deal risk</html>', 'utf-8');
  // Simple data-source runner (no external call).
  writeFileSync(path.join(dir, 'data', 'refresh.mjs'), 'process.stdout.write(JSON.stringify([{ deal: "A", risk: 9 }]))', 'utf-8');
  // Synthetic action runner that pulls email bodies from Salesforce (sf CLI +
  // SOQL), preserving the connector-provenance regression shape.
  writeFileSync(path.join(dir, 'data', 'deepwhy.mjs'), [
    "import { execFileSync } from 'node:child_process';",
    "const q = `SELECT Subject, TextBody, FromAddress FROM EmailMessage WHERE RelatedToId IN ('FIXTURE_OPPORTUNITY_ID')`;",
    "const out = execFileSync('sf', ['data', 'query', '--query', q, '--json'], { encoding: 'utf8' });",
    "process.stdout.write(out);",
  ].join('\n'), 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Deal Risk',
    dataSources: [{ id: 'risk', runner: 'refresh.mjs', schedule: '0 7 * * *' }],
    actions: [{ id: 'deepwhy', label: 'Refresh Why — pull fixture emails', runner: 'deepwhy.mjs' }],
  }), 'utf-8');
  return slug;
}

test('deriveRunnerProvenance surfaces the REAL connector from runner source (Salesforce, not guessed)', () => {
  const src = "import {execFileSync} from 'node:child_process';\nexecFileSync('sf',['data','query','--query',`SELECT Subject FROM EmailMessage WHERE RelatedToId IN ('x')`,'--json']);";
  const out = deriveRunnerProvenance(src).join(' · ');
  assert.match(out, /shells: sf.*Salesforce CLI/);
  assert.match(out, /SOQL FROM: EmailMessage \(Salesforce\)/);
});

test('deriveRunnerProvenance flags composio/connector refs but ignores engine tokens', () => {
  const out = deriveRunnerProvenance("composio_execute_tool({ slug: 'OUTLOOK_FETCH_MESSAGES' }); const ctx = STEP_CONTEXT; fetch('https://api.z.ai/v1');").join(' · ');
  assert.match(out, /composio_execute_tool/);
  assert.match(out, /OUTLOOK_FETCH_MESSAGES/);
  assert.match(out, /http: api\.z\.ai/);
  assert.doesNotMatch(out, /STEP_CONTEXT/);
});

test('registerSpaceTools exposes the runner read/edit/revert tools', () => {
  assert.ok(tools.space_get_runner);
  assert.ok(tools.space_edit_runner);
  assert.ok(tools.space_revert_runner);
});

test('space_get_runner reads a runner line-numbered + surfaces its Salesforce provenance (kills the is-it-Composio blind spot)', async () => {
  const slug = makeRunnerSpace();
  const out = text(await tools.space_get_runner({ slug, runner_path: 'deepwhy.mjs', grep: null, around: null }));
  // provenance line — the real data source is VISIBLE
  assert.match(out, /shells: sf.*Salesforce CLI/);
  assert.match(out, /SOQL FROM: EmailMessage \(Salesforce\)/);
  // self-locating: which action uses it
  assert.match(out, /used by action "Refresh Why — pull fixture emails"/);
  // line-numbered source (cat -n), pointing at space_edit_runner
  assert.match(out, /1\timport \{ execFileSync \}/);
  assert.match(out, /space_edit_runner/);
});

test('space_get_runner with no runner_path LISTS every runner + provenance', async () => {
  const slug = makeRunnerSpace();
  const out = text(await tools.space_get_runner({ slug, runner_path: null, grep: null, around: null }));
  assert.match(out, /refresh\.mjs ← data source "risk"/);
  assert.match(out, /deepwhy\.mjs ← action "Refresh Why/);
  assert.match(out, /Salesforce/); // deepwhy's provenance shows in the list
});

test('space_get still hides runner SOURCE but now shows the runner filename + the space_get_runner pointer', async () => {
  const slug = makeRunnerSpace();
  const out = text(await tools.space_get({ slug }));
  assert.match(out, /risk → refresh\.mjs/);
  assert.match(out, /Refresh Why.*→ deepwhy\.mjs/);
  assert.match(out, /space_get_runner/);
  // the runner SOURCE must not leak into space_get (it stays manifest-level)
  assert.doesNotMatch(out, /execFileSync/);
  assert.doesNotMatch(out, /EmailMessage/);
});

test('space_edit_runner applies a verbatim find/replace on a runner and is reversible', async () => {
  const slug = makeRunnerSpace();
  const res = text(await tools.space_edit_runner({
    slug, runner_path: 'deepwhy.mjs',
    edits: [{ find: "RelatedToId IN ('FIXTURE_OPPORTUNITY_ID')", replace: "AccountId IN ('FIXTURE_ACCOUNT_ID')" }],
  }));
  assert.match(res, /Applied 1 edit/);
  assert.match(res, /space_revert_runner/);
  // action runner → NOT auto-run (no side effect)
  assert.match(res, /action "Refresh Why.*not auto-run/);
  const after = readFileSync(store.resolveInSpace(slug, 'data/deepwhy.mjs'), 'utf-8');
  assert.match(after, /AccountId IN \('FIXTURE_ACCOUNT_ID'\)/);
  assert.equal(after.includes("RelatedToId IN ('FIXTURE_OPPORTUNITY_ID')"), false);

  const rev = text(await tools.space_revert_runner({ slug, runner_path: 'deepwhy.mjs' }));
  assert.match(rev, /Reverted/);
  assert.match(readFileSync(store.resolveInSpace(slug, 'data/deepwhy.mjs'), 'utf-8'), /RelatedToId IN \('FIXTURE_OPPORTUNITY_ID'\)/);
});

test('space_edit_runner on a non-matching find returns a precise hint and does NOT write (the grounding catch-22)', async () => {
  const slug = makeRunnerSpace();
  const res = text(await tools.space_edit_runner({
    slug, runner_path: 'deepwhy.mjs',
    edits: [{ find: 'RelatedToXd IN', replace: 'x' }],
  }));
  assert.match(res, /No edits applied/);
  assert.match(res, /matched the first \d+ char/);
  assert.match(res, /space_get_runner/);
  // unchanged
  assert.match(readFileSync(store.resolveInSpace(slug, 'data/deepwhy.mjs'), 'utf-8'), /RelatedToId IN \('FIXTURE_OPPORTUNITY_ID'\)/);
});

test('space_get_runner errors cleanly for a missing runner + lists what IS declared', async () => {
  const slug = makeRunnerSpace();
  const out = text(await tools.space_get_runner({ slug, runner_path: 'ghost.mjs', grep: null, around: null }));
  assert.match(out, /has no runner "data\/ghost\.mjs"/);
  assert.match(out, /deepwhy\.mjs/);
});
