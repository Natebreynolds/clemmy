/**
 * Run: npx tsx --test src/spaces/runner.test.ts
 *
 * Guards the spaces runner's spawn/env contract — the seam that broke every
 * runner-backed space in the packaged app (process.execPath = Electron without
 * ELECTRON_RUN_AS_NODE → GUI launch → empty stdout). Round-trips real runners
 * through runSpaceDataSource and asserts the child env: flag set for node
 * runners (NOT for sh), augmented PATH, locale baseline, slug, stdin payload,
 * and — critically — that the daemon's secrets are NOT leaked into agent code.
 * Temp CLEMENTINE_HOME so the real instance is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-runner-test-'));

const runner = await import('./runner.js');
const store = await import('./store.js');
const dataStore = await import('./data-store.js');
const workspaceDb = await import('./workspace-db.js');
const observationDiff = await import('./observation-diff.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');

function writeRunner(slug: string, file: string, body: string, exec = false): void {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  writeFileSync(p, body, 'utf-8');
  if (exec) chmodSync(p, 0o755);
}

const hasPython = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A node runner that echoes its own env + the stdin payload back as JSON.
const ENV_ECHO_MJS = `
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  const p = (() => { try { return JSON.parse(input || '{}'); } catch { return {}; } })();
  process.stdout.write(JSON.stringify({
    electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
    slug: process.env.CLEMENTINE_SPACE_SLUG ?? null,
    lang: process.env.LANG ?? null,
    pathHasWellKnown: (process.env.PATH || '').split(':').some((d) => d === '/usr/local/bin' || d === '/opt/homebrew/bin'),
    sawSecret: process.env.SPACE_TEST_SECRET ?? null,
    payloadSlug: p.slug ?? null,
    payloadRunner: p.runner ?? null,
  }));
});
`;

test('node (.mjs) runner: ELECTRON_RUN_AS_NODE set, PATH augmented, secrets scrubbed, stdin round-trips', async () => {
  const slug = 'env-node';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);
  // A daemon secret present at spawn time MUST NOT reach agent-authored code.
  process.env.SPACE_TEST_SECRET = 'leak-canary';
  try {
    const res = await runner.runScript(slug, 'echo.mjs');
    assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
    const d = (res as { data: Record<string, unknown> }).data;
    assert.equal(d.electron, '1', 'ELECTRON_RUN_AS_NODE must be 1 for a node runner');
    assert.equal(d.slug, slug);
    assert.equal(d.payloadSlug, slug, 'stdin JSON payload must round-trip');
    assert.equal(d.payloadRunner, 'echo.mjs', 'stdin JSON payload must include runner identity');
    assert.equal(d.pathHasWellKnown, true, 'PATH must be augmented with the well-known bin dirs');
    assert.ok(d.lang, 'LANG baseline must be set');
    assert.equal(d.sawSecret, null, 'daemon secret env must NOT leak into the runner');
  } finally {
    delete process.env.SPACE_TEST_SECRET;
  }
});

test('runner stdin identity cannot be overridden by dry-run payload extras', async () => {
  const slug = 'payload-identity';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);

  const res = await runner.runScript(slug, 'echo.mjs', {
    slug: '../other-space',
    runner: '../view/evil.mjs',
    customInput: true,
  });

  assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
  const d = (res as { data: Record<string, unknown> }).data;
  assert.equal(d.slug, slug);
  assert.equal(d.payloadSlug, slug);
  assert.equal(d.payloadRunner, 'echo.mjs');
});

test('shell (.sh) runner: works and does NOT get ELECTRON_RUN_AS_NODE', async () => {
  const slug = 'env-sh';
  writeRunner(slug, 'echo.sh', `#!/bin/bash\nprintf '{"electron":"%s","slug":"%s"}' "\${ELECTRON_RUN_AS_NODE:-}" "$CLEMENTINE_SPACE_SLUG"\n`);
  const res = await runner.runScript(slug, 'echo.sh');
  assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
  const d = (res as { data: Record<string, unknown> }).data;
  assert.equal(d.electron, '', 'ELECTRON_RUN_AS_NODE must NOT be set for a shell runner');
  assert.equal(d.slug, slug);
});

test('python (.py) runner: resolves python3 on the augmented PATH and yields JSON', { skip: !hasPython }, async () => {
  const slug = 'env-py';
  writeRunner(slug, 'echo.py', `import json,os\nprint(json.dumps({"slug": os.environ.get("CLEMENTINE_SPACE_SLUG"), "rows": [1,2]}))\n`);
  const res = await runner.runScript(slug, 'echo.py');
  assert.equal(res.ok, true, res.ok ? '' : (res as { error: string }).error);
  const d = (res as { data: Record<string, unknown> }).data;
  assert.equal(d.slug, slug);
  assert.deepEqual(d.rows, [1, 2]);
});

test('runner that prints non-JSON → clear error (not a crash)', async () => {
  const slug = 'bad-json';
  writeRunner(slug, 'r.mjs', `process.stdout.write('not json at all');`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /not valid JSON/);
});

test('refreshSpaceData refuses malformed hand-written manifest JSON before running sources', async () => {
  const slug = 'bad-manifest-refresh';
  const dir = store.resolveSpaceDir(slug);
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'r.mjs'), `process.stdout.write(JSON.stringify({rows:[1]}));`, 'utf-8');
  writeFileSync(path.join(dir, 'space.json'), JSON.stringify({
    id: slug,
    title: 'Bad Manifest Refresh',
    dataSources: [{ id: 'pull', runner: 'r.mjs', composio_args_json: '{not json' }],
  }), 'utf-8');

  const res = await runner.refreshSpaceData(slug, 'pull');
  assert.equal(res[0].ok, false);
  assert.match(res[0].error ?? '', /workspace manifest is invalid/);
  assert.match(res[0].error ?? '', /composio_args_json is not valid JSON/);
});

test('runtime refuses mutating and unknown Composio data sources before provider dispatch', async () => {
  let dispatches = 0;
  runner._setSpaceComposioDispatchForTests(async (toolSlug, _args) => {
    dispatches += 1;
    return {
      ok: true as const,
      result: { toolSlug },
      connectionId: 'ca-proof',
      identity: 'proof@example.test',
    };
  });
  try {
    for (const composioSlug of [
      'GOOGLESHEETS_UPDATE_SPREADSHEET',
      'GMAIL_MARK_AS_READ',
      'ACME_DO_THING',
    ]) {
      const res = await runner.runSpaceDataSource('runtime-source-policy', {
        id: 'pull',
        composioSlug,
      });
      assert.equal(res.ok, false, `${composioSlug} must fail closed`);
      assert.match(res.ok ? '' : res.error, /provably read-only/i);
    }
    assert.equal(dispatches, 0, 'unsafe refresh declarations never cross the provider boundary');

    const read = await runner.runSpaceDataSource('runtime-source-policy', {
      id: 'events',
      composioSlug: 'GOOGLECALENDAR_LIST_EVENTS',
    });
    assert.equal(read.ok, true, read.ok ? '' : read.error);
    assert.equal(dispatches, 1, 'a proven read still refreshes normally');
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('runtime refuses opaque runner-backed data sources before spawning', async () => {
  const slug = 'runner-data-source-disabled';
  writeRunner(
    slug,
    'pull.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./spawned.txt', import.meta.url), 'yes');
process.stdout.write('[]');`,
  );

  const res = await runner.runSpaceDataSource(slug, {
    id: 'pull',
    runner: 'pull.mjs',
  });

  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /opaque runner|read-only Composio/i);
  assert.equal(
    (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/spawned.txt')),
    false,
  );
});

test('an installed legacy data runner requests one pinned-entrypoint trust card, then runs only after approval', async () => {
  const slug = 'legacy-runner-trust';
  const source = {
    id: 'pull',
    runner: 'pull.mjs',
    schedule: '0 7 * * *',
    timezone: 'America/Los_Angeles',
  };
  writeRunner(slug, 'pull.mjs', 'process.stdout.write(JSON.stringify({version:1}));');
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner trust',
    dataSources: [source],
  });

  const first = await runner.runSpaceDataSource(slug, source);
  assert.equal(first.ok, false);
  assert.match(first.ok ? '' : first.error, /one-time approval|awaiting.*approval/i);
  const cards = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  });
  assert.equal(cards.length, 1, 'first compatibility refresh mints one decision');
  assert.equal(cards[0]?.tool, 'space_trust_data_runner');
  assert.equal(cards[0]?.args?.spaceSlug, slug);
  assert.equal(cards[0]?.args?.sourceId, source.id);
  assert.equal(cards[0]?.args?.runner, source.runner);
  assert.match(String(cards[0]?.args?.runnerSha256 ?? ''), /^[a-f0-9]{64}$/);
  assert.match(cards[0]?.subject ?? '', /pinned entrypoint/i);
  assert.match(String(cards[0]?.args?.reason ?? ''), /helpers.*packages.*CLIs.*local files.*auth.*network/i);
  assert.match(String(cards[0]?.args?.reason ?? ''), /not.*read-only sandbox/i);
  assert.doesNotMatch(String(cards[0]?.args?.reason ?? ''), /this exact local code/i);
  assert.deepEqual(cards[0]?.args?.schedulePolicy, {
    schedule: source.schedule,
    timezone: source.timezone,
  });
  const inlineCards = eventlog.listEvents(`space-${slug}`, { types: ['approval_requested'] });
  assert.equal(inlineCards.length, 1, 'the exact trust card is visible in Workspace chat');
  assert.equal(
    (inlineCards[0]?.data as { approvalId?: string }).approvalId,
    cards[0]?.approvalId,
  );

  const duplicate = await runner.runSpaceDataSource(slug, source);
  assert.equal(duplicate.ok, false);
  assert.equal(
    approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    1,
    'retries and scheduler ticks converge on the same pending card',
  );

  const resolved = approvalRegistry.resolve(cards[0]!.approvalId, 'approved', 'runner-trust-test');
  assert.equal(resolved.ok, true);
  const approved = await runner.runSpaceDataSource(slug, source);
  assert.deepEqual(approved, { ok: true, data: { version: 1 } });
});

test('verified runner execution snapshots approved entry bytes before spawn and cleans the snapshot', async () => {
  const slug = 'verified-entrypoint-snapshot';
  const file = 'pull.mjs';
  const approvedSource = [
    "import { readFileSync } from 'node:fs';",
    "const helper = JSON.parse(readFileSync(new URL('./live-helper.json', import.meta.url), 'utf8'));",
    "process.stdout.write(JSON.stringify({ entry: 'approved', helper }));",
  ].join('\n');
  writeRunner(slug, file, approvedSource);
  writeFileSync(
    store.resolveInSpace(slug, 'data/live-helper.json'),
    JSON.stringify({ version: 1 }),
    'utf-8',
  );
  const target = store.resolveInSpace(slug, `data/${file}`);
  const expectedSha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  let snapshotPath = '';

  runner._setRunnerEntrypointSnapshotHookForTests((snapshot) => {
    snapshotPath = snapshot.snapshotPath;
    assert.equal(path.dirname(snapshot.sourcePath), path.dirname(snapshot.snapshotPath));
    assert.equal(path.extname(snapshot.snapshotPath), '.mjs');
    assert.equal(readFileSync(snapshot.snapshotPath, 'utf-8'), approvedSource);
    writeFileSync(
      snapshot.sourcePath,
      "process.stdout.write(JSON.stringify({ entry: 'unapproved' }));",
      'utf-8',
    );
    writeFileSync(
      store.resolveInSpace(slug, 'data/live-helper.json'),
      JSON.stringify({ version: 2 }),
      'utf-8',
    );
  });
  try {
    const result = await runner.runScript(slug, file, undefined, { expectedSha256 });
    assert.deepEqual(result, {
      ok: true,
      data: {
        entry: 'approved',
        helper: { version: 2 },
      },
    }, 'the pinned entrypoint executes while explicitly live sibling data remains live');
  } finally {
    runner._setRunnerEntrypointSnapshotHookForTests(null);
  }

  assert.match(snapshotPath, /\.clementine-entry-/);
  assert.equal(existsSync(snapshotPath), false, 'ephemeral approved-entry snapshot is removed after success');
});

test('verified runner snapshots are cleaned after a non-zero runner exit', async () => {
  const slug = 'verified-entrypoint-cleanup-failure';
  const file = 'pull.mjs';
  writeRunner(slug, file, "process.stderr.write('expected failure'); process.exit(7);");
  const target = store.resolveInSpace(slug, `data/${file}`);
  const expectedSha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  let snapshotPath = '';
  runner._setRunnerEntrypointSnapshotHookForTests((snapshot) => {
    snapshotPath = snapshot.snapshotPath;
  });
  try {
    const result = await runner.runScript(slug, file, undefined, { expectedSha256 });
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error, /exited 7/);
  } finally {
    runner._setRunnerEntrypointSnapshotHookForTests(null);
  }
  assert.ok(snapshotPath);
  assert.equal(existsSync(snapshotPath), false, 'ephemeral approved-entry snapshot is removed after failure');
});

test('runner-trust approval resumes exactly one refresh while rejection never executes', async () => {
  for (const resolution of ['approved', 'rejected'] as const) {
    const slug = `legacy-runner-trust-note-${resolution}`;
    const source = { id: 'pull', runner: 'pull.mjs' };
    writeRunner(
      slug,
      'pull.mjs',
      `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./decision-spawned.txt', import.meta.url), 'yes');
process.stdout.write('{}');`,
    );
    store.spaceStore.save({
      id: slug,
      title: `Legacy runner trust note ${resolution}`,
      dataSources: [source],
    });

    const refresh = await runner.refreshSpaceData(slug, source.id);
    assert.match(refresh[0]?.pendingApprovalId ?? '', /^apr-/);
    const approvalId = refresh[0]!.pendingApprovalId!;
    const repeated = await runner.refreshSpaceData(slug, source.id);
    assert.equal(repeated[0]?.pendingApprovalId, approvalId);
    assert.equal(
      workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: source.id,
        limit: 10,
      }).filter((observation) => observation.status === 'awaiting_approval').length,
      1,
      'repeated clicks on one trust card remain one historical observation',
    );
    assert.equal(approvalRegistry.resolve(approvalId, resolution, 'runner-trust-note-test').ok, true);

    const spawnedPath = store.resolveInSpace(slug, 'data/decision-spawned.txt');
    if (resolution === 'approved') {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const projected = dataStore.readData(slug) as {
          _meta?: { pull?: { ok?: boolean } };
        };
        if (projected._meta?.pull?.ok === true) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const current = dataStore.readData(slug) as {
      _meta?: { pull?: { status?: string; approvalId?: string } };
    };
    assert.equal(
      (await import('node:fs')).existsSync(spawnedPath),
      resolution === 'approved',
      resolution === 'approved'
        ? 'the exact approved refresh resumes automatically'
        : 'rejection never executes the runner',
    );
    const note = dataStore.listNotes(slug).find((item) => (
      item.meta?.approvalId === approvalId && item.meta?.status === resolution
    ));
    assert.ok(note);
    assert.equal(note.meta?.status, resolution);
    if (resolution === 'approved') {
      assert.equal((current._meta?.pull as { ok?: boolean } | undefined)?.ok, true);
      assert.equal(approvalRegistry.get(approvalId)?.consumedAt !== null, true);
      assert.match(note.text, /refresh.*resum/i);
      const completion = eventlog.listEvents(`space-${slug}`, {
        types: ['conversation_completed'],
      }).find((event) => (
        (event.data as { approvalId?: string }).approvalId === approvalId
      ));
      assert.ok(completion, 'Workspace chat receives the real resumed refresh outcome');
      assert.equal(
        (completion.data as { reason?: string }).reason,
        'workspace_runner_approval_refresh_completed',
      );
    } else {
      assert.equal(current._meta?.pull?.status, 'awaiting_approval');
      assert.equal(current._meta?.pull?.approvalId, approvalId);
      assert.equal(note.meta?.staleDataStatus, true);
      assert.match(note.text, /runner remains blocked/i);
    }
  }
});

test('an unreaped expired runner-trust card renews cleanly without executing the runner', async () => {
  const slug = 'legacy-runner-trust-expired';
  const source = { id: 'pull', runner: 'pull.mjs' };
  writeRunner(
    slug,
    'pull.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./expired-card-spawned.txt', import.meta.url), 'yes');
process.stdout.write('{}');`,
  );
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner trust expired',
    dataSources: [source],
  });

  await runner.runSpaceDataSource(slug, source);
  const firstCard = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  })[0];
  assert.ok(firstCard);
  eventlog.openEventLog().prepare(
    'UPDATE pending_approvals SET expires_at = ? WHERE approval_id = ?',
  ).run('2000-01-01T00:00:00.000Z', firstCard.approvalId);

  const renewed = await runner.runSpaceDataSource(slug, source);
  assert.equal(renewed.ok, false);
  assert.equal(
    (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/expired-card-spawned.txt')),
    false,
    'an expired decision never executes opaque code',
  );
  const pending = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  });
  assert.equal(pending.length, 1);
  assert.notEqual(pending[0]?.approvalId, firstCard.approvalId);
  assert.equal(
    approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'any' })
      .find((row) => row.approvalId === firstCard.approvalId)?.status,
    'expired',
  );
});

test('editing a trusted runner entrypoint or its automatic schedule invalidates the pinned grant before spawn', async () => {
  const slug = 'legacy-runner-trust-drift';
  const source = {
    id: 'pull',
    runner: 'pull.mjs',
    schedule: '0 7 * * *',
    timezone: 'America/Los_Angeles',
  };
  writeRunner(slug, 'pull.mjs', 'process.stdout.write(JSON.stringify({version:1}));');
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner trust drift',
    dataSources: [source],
  });

  await runner.runSpaceDataSource(slug, source);
  const firstCard = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  })[0];
  assert.ok(firstCard);
  assert.equal(approvalRegistry.resolve(firstCard.approvalId, 'approved', 'runner-trust-test').ok, true);
  assert.equal((await runner.runSpaceDataSource(slug, source)).ok, true);

  writeRunner(
    slug,
    'pull.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./unapproved-spawn.txt', import.meta.url), 'yes');
process.stdout.write(JSON.stringify({version:2}));`,
  );
  const codeDrift = await runner.runSpaceDataSource(slug, source);
  assert.equal(codeDrift.ok, false);
  assert.match(codeDrift.ok ? '' : codeDrift.error, /approval/i);
  assert.equal(
    (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/unapproved-spawn.txt')),
    false,
    'changed entrypoint bytes never inherit the old durable grant',
  );

  const codeCard = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  })[0];
  assert.ok(codeCard);
  assert.notEqual(codeCard.approvalId, firstCard.approvalId);
  assert.notEqual(codeCard.args?.runnerSha256, firstCard.args?.runnerSha256);
  assert.equal(approvalRegistry.resolve(codeCard.approvalId, 'approved', 'runner-trust-test').ok, true);

  const changedSchedule = { ...source, schedule: '*/5 * * * *' };
  store.spaceStore.update(slug, { dataSources: [changedSchedule] });
  const scheduleDrift = await runner.runSpaceDataSource(slug, changedSchedule);
  assert.equal(scheduleDrift.ok, false);
  const pending = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  });
  assert.equal(pending.length, 1, 'schedule drift gets one fresh exact decision');
  assert.deepEqual(pending[0]?.args?.schedulePolicy, {
    schedule: changedSchedule.schedule,
    timezone: changedSchedule.timezone,
  });
});

test('runner-backed actions cannot execute without approval authority', async () => {
  const slug = 'runner-action-needs-approval';
  writeRunner(
    slug,
    'act.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./dispatched.txt', import.meta.url), 'yes');
process.stdout.write(JSON.stringify({ok:true}));`,
  );

  const res = await runner.runSpaceAction(
    slug,
    { id: 'refresh-looking-name', label: 'Refresh rows', runner: 'act.mjs' },
    {},
  );

  assert.equal(res.ok, false);
  assert.match(res.ok ? '' : res.error, /approval/i);
  assert.equal(
    (await import('node:fs')).existsSync(store.resolveInSpace(slug, 'data/dispatched.txt')),
    false,
    'an opaque runner is never launched on the immediate path',
  );
});

test('mutating and unknown Composio actions cannot bypass approval through the runner API', async () => {
  let dispatches = 0;
  runner._setSpaceComposioDispatchForTests(async (toolSlug, _args) => {
    dispatches += 1;
    return {
      ok: true as const,
      result: { toolSlug },
      connectionId: 'ca-proof',
      identity: 'proof@example.test',
    };
  });
  try {
    for (const composioSlug of ['GMAIL_SEND_EMAIL', 'ACME_DO_THING']) {
      const res = await runner.runSpaceAction(
        'runtime-action-policy',
        { id: 'act', composioSlug },
        {},
      );
      assert.equal(res.ok, false, `${composioSlug} must require approval`);
      assert.match(res.ok ? '' : res.error, /approval/i);
    }
    assert.equal(dispatches, 0);

    const read = await runner.runSpaceAction(
      'runtime-action-policy',
      { id: 'list', composioSlug: 'GOOGLECALENDAR_LIST_EVENTS' },
      {},
    );
    assert.equal(read.ok, true, read.ok ? '' : read.error);
    assert.equal(dispatches, 1);
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('refreshSpaceData serializes same-space read-only Composio refreshes so concurrent sources do not clobber data.json', async () => {
  const slug = 'refresh-serial';
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Serial',
    dataSources: [
      { id: 'alpha', composioSlug: 'SALESFORCE_GET_ALPHA' },
      { id: 'beta', composioSlug: 'SALESFORCE_GET_BETA' },
    ],
  });
  runner._setSpaceComposioDispatchForTests(async (toolSlug) => {
    await new Promise((resolve) => setTimeout(resolve, toolSlug.endsWith('ALPHA') ? 80 : 20));
    const id = toolSlug.endsWith('ALPHA') ? 'alpha' : 'beta';
    return {
      ok: true as const,
      result: { rows: [{ id }] },
      connectionId: 'ca-proof',
      identity: 'proof@example.test',
    };
  });
  try {
    const [alpha, beta] = await Promise.all([
      runner.refreshSpaceData(slug, 'alpha'),
      runner.refreshSpaceData(slug, 'beta'),
    ]);

    assert.equal(alpha[0].ok, true, alpha[0].error ?? '');
    assert.equal(beta[0].ok, true, beta[0].error ?? '');
    const data = dataStore.readData(slug) as Record<string, unknown>;
    assert.deepEqual(data.alpha, { rows: [{ id: 'alpha' }] });
    assert.deepEqual(data.beta, { rows: [{ id: 'beta' }] });
    assert.equal((data._meta as Record<string, { ok?: boolean }>).alpha.ok, true);
    assert.equal((data._meta as Record<string, { ok?: boolean }>).beta.ok, true);
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('refreshSpaceData commits valid sources when a sibling result is oversized, and retries without duplicates', async () => {
  const slug = 'refresh-partial-batch';
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Partial Batch',
    dataSources: [
      { id: 'small', composioSlug: 'SALESFORCE_GET_SMALL' },
      { id: 'oversized', composioSlug: 'SALESFORCE_GET_OVERSIZED' },
    ],
  });
  runner._setSpaceComposioDispatchForTests(async (toolSlug) => ({
    ok: true as const,
    result: toolSlug.endsWith('OVERSIZED')
      ? { payload: 'x'.repeat(6 * 1024 * 1024) }
      : { rows: [{ id: 'kept', value: 42 }] },
    connectionId: 'ca-proof',
    identity: 'proof@example.test',
  }));
  try {
    for (const batchId of ['partial-batch-first', 'partial-batch-retry']) {
      const results = await runner.refreshSpaceData(slug, undefined, {
        cause: 'scheduled',
        refreshId: 'stable-refresh',
        batchId,
      });
      assert.equal(results.length, 2);
      assert.equal(results[0]?.sourceId, 'small');
      assert.equal(results[0]?.ok, true, results[0]?.error ?? '');
      assert.equal(results[1]?.sourceId, 'oversized');
      assert.equal(results[1]?.ok, false);
      assert.match(results[1]?.error ?? '', /not persisted|byte cap|exceeds/i);
      assert.equal(
        results.every((result) => result.write?.ok === true),
        true,
        JSON.stringify(results),
      );
    }

    const data = dataStore.readData(slug) as Record<string, unknown>;
    assert.deepEqual(data.small, { rows: [{ id: 'kept', value: 42 }] });
    assert.equal(Object.hasOwn(data, 'oversized'), false);
    assert.equal(
      (data._meta as Record<string, { ok?: boolean | null }>).small.ok,
      true,
    );
    assert.equal(
      (data._meta as Record<string, { ok?: boolean | null }>).oversized.ok,
      false,
    );
    assert.equal(
      workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: 'small',
        limit: 10,
      }).length,
      1,
      'valid source retry reuses its durable observation',
    );
    const oversized = workspaceDb.listWorkspaceDatasetObservations(slug, {
      sourceKey: 'oversized',
      limit: 10,
    });
    assert.equal(oversized.length, 1, 'oversized source retry reuses its error observation');
    assert.equal(oversized[0]?.status, 'error');
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('refreshSpaceData preserves a 2.7.5 snapshot as baseline and appends restart-deduped observations', async () => {
  const slug = 'refresh-temporal-baseline';
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Temporal Baseline',
    dataSources: [{ id: 'campaigns', composioSlug: 'GOOGLEADS_SEARCH_CAMPAIGNS' }],
  });
  const legacy = {
    campaigns: { rows: [{ id: 'campaign-1', spend: 10, status: 'active' }] },
    _meta: { campaigns: { refreshedAt: '2026-06-01T00:00:00.000Z', ok: true } },
  };
  assert.equal(dataStore.writeData(slug, legacy).ok, true);

  runner._setSpaceComposioDispatchForTests(async () => ({
    ok: true as const,
    result: { rows: [{ id: 'campaign-1', spend: 15, status: 'paused' }] },
    connectionId: 'ca-proof',
    identity: 'proof@example.test',
  }));
  try {
    const first = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-1',
      batchId: 'manual-batch-1',
    });
    assert.equal(first[0]?.ok, true, first[0]?.error ?? '');
    assert.equal(first[0]?.changed, true);
    assert.match(first[0]?.observationId ?? '', /^[a-f0-9-]{36}$/i);

    const afterFirst = workspaceDb.listWorkspaceDatasetObservations(slug, {
      sourceKey: 'campaigns',
      limit: 10,
    });
    assert.equal(afterFirst.length, 2);
    assert.equal(afterFirst[0]?.cause, 'manual');
    assert.equal(afterFirst[1]?.cause, 'legacy_import');
    assert.equal(afterFirst[0]?.previousObservationId, afterFirst[1]?.id);
    const beforeDoc = workspaceDb.getWorkspaceObservationDocument(slug, afterFirst[1]!.id);
    const afterDoc = workspaceDb.getWorkspaceObservationDocument(slug, afterFirst[0]!.id);
    const delta = observationDiff.diffWorkspaceObservationDocuments(beforeDoc, afterDoc);
    assert.deepEqual(delta.changes.map((entry) => entry.path), [
      '/rows/@id=campaign-1/spend',
      '/rows/@id=campaign-1/status',
    ]);

    const same = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-2',
      batchId: 'manual-batch-2',
    });
    assert.equal(same[0]?.ok, true);
    assert.equal(same[0]?.changed, false);
    const replay = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-2',
      batchId: 'manual-batch-replayed',
    });
    assert.equal(replay[0]?.ok, true);
    assert.equal(replay[0]?.observationId, same[0]?.observationId);
    assert.equal(
      workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: 'campaigns',
        limit: 10,
      }).length,
      3,
      'same refresh identity reuses its observation after restart/retry',
    );
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('refreshSpaceData does not advance lastRefreshedAt when every source fails', async () => {
  const slug = 'refresh-failed-stamp';
  const oldSuccess = '2026-06-01T00:00:00.000Z';
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Failed Stamp',
    dataSources: [{ id: 'bad', runner: 'bad.mjs' }],
  });
  store.spaceStore.update(slug, { lastRefreshedAt: oldSuccess });
  writeRunner(slug, 'bad.mjs', `process.stderr.write('source broke'); process.exit(2);`);
  await runner.runSpaceDataSource(slug, store.spaceStore.get(slug)!.dataSources[0]);
  const approval = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  })[0];
  assert.ok(approval);
  assert.equal(
    approvalRegistry.resolve(approval.approvalId, 'approved', 'runner-failure-test').ok,
    true,
  );

  const res = await runner.refreshSpaceData(slug);

  assert.equal(res[0].ok, false);
  assert.equal(store.spaceStore.get(slug)?.lastRefreshedAt, oldSuccess);
  const data = dataStore.readData(slug) as Record<string, unknown>;
  assert.equal(((data._meta as Record<string, { ok?: boolean }>).bad).ok, false);
  runner._resetSpaceRefreshQueuesForTest();
});

test('runner that prints nothing (exit 0) → "produced no output"', async () => {
  const slug = 'no-output';
  writeRunner(slug, 'r.mjs', `process.exit(0);`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /produced no output/);
});

test('runner that exits non-zero → surfaces stderr', async () => {
  const slug = 'nonzero';
  writeRunner(slug, 'r.mjs', `process.stderr.write('boom happened'); process.exit(3);`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /exited 3/);
  assert.match((res as { error: string }).error, /boom happened/);
});

test('unsupported extension → actionable error', async () => {
  const slug = 'bad-ext';
  writeRunner(slug, 'data.txt', `whatever`);
  const res = await runner.runScript(slug, 'data.txt');
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /unsupported runner extension/);
});

test('runner path traversal is refused even if the target file exists inside the workspace', async () => {
  const slug = 'runner-path-traversal';
  const viewDir = store.resolveInSpace(slug, 'view');
  mkdirSync(viewDir, { recursive: true });
  writeFileSync(path.join(viewDir, 'evil.mjs'), `process.stdout.write(JSON.stringify({ran:true}));`, 'utf-8');

  const res = await runner.runScript(slug, '../view/evil.mjs');

  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /runner must be a filename under data\//);
});
