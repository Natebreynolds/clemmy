/**
 * Run: npx tsx --test src/spaces/runner.test.ts
 *
 * Guards Space declaration validation, durable migration decisions, refresh
 * projection, and the release containment that keeps local runner/CLI bodies
 * zero-process until they are compiled into the shared durable call kernel.
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
const runnerTrust = await import('./space-data-runner-trust.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const operationalTelemetry = await import('../runtime/operational-telemetry.js');

test('importing the Workspace runner registers trust recovery without opening the event log', async () => {
  // Registration used to enqueue an unowned setImmediate scan. Besides making
  // imports mutate durable state, that callback could collide with a foreground
  // v55 migration. Boot recovery now has an explicit daemon-owned phase.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(existsSync(eventlog.HARNESS_DB_PATH), false);
});

function writeRunner(slug: string, file: string, body: string, exec = false): void {
  const dir = store.resolveInSpace(slug, 'data');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, file);
  writeFileSync(p, body, 'utf-8');
  if (exec) chmodSync(p, 0o755);
}

/** Install exact runner trust without firing the live approval-resolution
 * resume listener. These fixtures exercise refresh/scheduler persistence, not
 * approval orchestration, and the entrypoint still crosses the production
 * pinned-hash gate on every run. */
async function approveInstalledRunnerFixture(
  slug: string,
  source: Parameters<typeof runner.runSpaceDataSource>[1],
): Promise<void> {
  const blocked = await runner.runSpaceDataSource(slug, source);
  assert.equal(blocked.ok, false);
  const card = approvalRegistry.listPending({
    sessionId: `space-${slug}`,
    status: 'pending',
  }).find((row) => row.args?.sourceId === source.id);
  assert.ok(card, `expected runner-trust card for ${slug}:${source.id}`);
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('runner-fixture-trust', new Date().toISOString(), card.approvalId);
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

test('node (.mjs) compatibility entrypoint is zero-body without shared durable authority', async () => {
  const slug = 'env-node';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);
  // A daemon secret present at spawn time MUST NOT reach agent-authored code.
  process.env.SPACE_TEST_SECRET = 'leak-canary';
  try {
    const res = await runner.runScript(slug, 'echo.mjs');
    assert.equal(res.ok, false);
    assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
    assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
  } finally {
    delete process.env.SPACE_TEST_SECRET;
  }
});

test('runner extras cannot turn the compatibility entrypoint into authority', async () => {
  const slug = 'payload-identity';
  writeRunner(slug, 'echo.mjs', ENV_ECHO_MJS);

  const res = await runner.runScript(slug, 'echo.mjs', {
    slug: '../other-space',
    runner: '../view/evil.mjs',
    customInput: true,
  });

  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
});

test('shell (.sh) compatibility entrypoint is zero-body', async () => {
  const slug = 'env-sh';
  writeRunner(slug, 'echo.sh', `#!/bin/bash\nprintf '{"electron":"%s","slug":"%s"}' "\${ELECTRON_RUN_AS_NODE:-}" "$CLEMENTINE_SPACE_SLUG"\n`);
  const res = await runner.runScript(slug, 'echo.sh');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
});

test('python (.py) compatibility entrypoint is zero-body', { skip: !hasPython }, async () => {
  const slug = 'env-py';
  writeRunner(slug, 'echo.py', `import json,os\nprint(json.dumps({"slug": os.environ.get("CLEMENTINE_SPACE_SLUG"), "rows": [1,2]}))\n`);
  const res = await runner.runScript(slug, 'echo.py');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match(res.ok ? '' : res.error, /no shared durable call authority/i);
});

test('runner output parsing is unreachable without shared durable authority', async () => {
  const slug = 'bad-json';
  writeRunner(slug, 'r.mjs', `process.stdout.write('not json at all');`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
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

test('runtime refuses unsafe Composio sources and contains exact reads until shared durable authority exists', async () => {
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
    assert.equal(read.ok, false);
    assert.match(read.ok ? '' : read.error, /no shared durable call authority/i);
    assert.equal(read.ok ? undefined : read.provenNoDispatch, true);
    assert.equal(dispatches, 0, 'an exact read has no raw Space-provider fallback');
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

test('an installed legacy data runner trust card remains migration metadata after approval', async () => {
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
  assert.equal(approved.ok, false);
  assert.equal(approved.ok ? undefined : approved.provenNoDispatch, true);
  assert.match(approved.ok ? '' : approved.error, /no shared durable call authority/i);
});

test('daemon-owned runner-trust recovery consumes an offline decision without spawning', async () => {
  const slug = 'legacy-runner-trust-boot-recovery';
  const source = { id: 'pull', runner: 'pull.mjs' };
  writeRunner(
    slug,
    source.runner,
    `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./boot-recovered.txt', import.meta.url), 'yes');
process.stdout.write('{}');`,
  );
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner trust boot recovery',
    dataSources: [source],
  });

  const refresh = await runner.refreshSpaceData(slug, source.id);
  const approvalId = refresh[0]?.pendingApprovalId;
  assert.match(approvalId ?? '', /^apr-/);

  // Simulate a decision committed by another process while the daemon and its
  // live resolution listener were offline.
  const resolvedAt = new Date().toISOString();
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET status = 'resolved', resolution = 'approved', resolver = ?, resolved_at = ?
     WHERE approval_id = ? AND status = 'pending'
  `).run('runner-trust-offline-test', resolvedAt, approvalId);

  assert.equal(runnerTrust.recoverResolvedRunnerTrustApprovals(), 1);
  assert.equal(approvalRegistry.get(approvalId!)?.consumedAt !== null, true);
  assert.equal(runnerTrust.recoverResolvedRunnerTrustApprovals(), 0, 'the durable resume claim is one-shot');

  const recoveredPath = store.resolveInSpace(slug, 'data/boot-recovered.txt');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(existsSync(recoveredPath), false);
});

test('frozen CLI data source approval pins argv + schedule but cannot mint process authority', async () => {
  const slug = 'cli-source-trust';
  const source = {
    id: 'pull',
    cliArgv: ['node', '-e', 'console.log(JSON.stringify({ rows: [1, 2, 3] }))'],
    schedule: '0 7 * * *',
    timezone: 'America/Los_Angeles',
  };
  store.spaceStore.save({
    id: slug,
    title: 'CLI source trust',
    dataSources: [source],
  });

  // 1. First refresh never spawns — it mints exactly one approval card that
  //    shows the human the full frozen command line.
  const first = await runner.runSpaceDataSource(slug, source);
  assert.equal(first.ok, false);
  assert.match(first.ok ? '' : first.error, /one-time approval/i);
  assert.equal(first.provenNoDispatch, true, 'blocked CLI refresh must prove it never spawned');
  const cards = approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' });
  assert.equal(cards.length, 1, 'first refresh mints one decision');
  assert.equal(cards[0]?.tool, 'space_trust_cli_source');
  assert.deepEqual(cards[0]?.args?.cliArgv, source.cliArgv, 'the card pins the exact argv vector');
  assert.deepEqual(cards[0]?.args?.schedulePolicy, { schedule: source.schedule, timezone: source.timezone });
  assert.match(cards[0]?.subject ?? '', /refresh .*automatically/i);
  assert.match(String(cards[0]?.args?.reason ?? ''), /no shell, no substitutions/i);
  assert.match(String(cards[0]?.args?.reason ?? ''), /auth state.*network services.*live/i);
  assert.match(String(cards[0]?.args?.reason ?? ''), /90 days/);

  // 2. Retries and scheduler ticks converge on the same pending card.
  await runner.runSpaceDataSource(slug, source);
  assert.equal(
    approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    1,
  );

  // 3. Approval remains useful migration metadata but cannot mint the shared
  //    kernel activation/plan required to start a process.
  assert.equal(approvalRegistry.resolve(cards[0]!.approvalId, 'approved', 'cli-trust-test').ok, true);
  const approved = await runner.runSpaceDataSource(slug, source);
  assert.equal(approved.ok, false);
  assert.equal(approved.ok ? undefined : approved.provenNoDispatch, true);
  assert.match(approved.ok ? '' : approved.error, /no shared durable call authority/i);
  const again = await runner.runSpaceDataSource(slug, source);
  assert.equal(again.ok, false, 'repeat refreshes remain contained without a new decision');
  assert.equal(
    approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    0,
    'covered refreshes never mint another card',
  );

  // 4. Any argv drift voids the grant BEFORE a spawn and re-asks.
  const drifted = {
    ...source,
    cliArgv: ['node', '-e', 'console.log(JSON.stringify({ rows: ["changed"] }))'],
  };
  store.spaceStore.save({ id: slug, title: 'CLI source trust', dataSources: [drifted] });
  const afterDrift = await runner.runSpaceDataSource(slug, drifted);
  assert.equal(afterDrift.ok, false);
  assert.match(afterDrift.ok ? '' : afterDrift.error, /one-time approval/i);
  assert.equal(
    approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    1,
    'a changed argv is a NEW decision',
  );
});

test('frozen CLI source: schedule drift re-asks, caller/installed mismatch and unknown commands fail closed', async () => {
  const slug = 'cli-source-trust-edges';
  const source = {
    id: 'pull',
    cliArgv: ['node', '-e', 'console.log("plain text, not json")'],
  };
  store.spaceStore.save({ id: slug, title: 'CLI edges', dataSources: [source] });

  const first = await runner.runSpaceDataSource(slug, source);
  assert.equal(first.ok, false);
  const card = approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' })[0];
  assert.ok(card);
  assert.equal(approvalRegistry.resolve(card.approvalId, 'approved', 'cli-trust-test').ok, true);

  // The approved command never reaches stdout parsing without kernel authority.
  const text = await runner.runSpaceDataSource(slug, source);
  assert.equal(text.ok, false);
  assert.equal(text.ok ? undefined : text.provenNoDispatch, true);
  assert.match(text.ok ? '' : text.error, /no shared durable call authority/i);

  // A caller-supplied argv that differs from the installed manifest is not the
  // approved program — blocked without spawning, and without minting a card
  // for the mismatched shape.
  const tampered = await runner.runSpaceDataSource(slug, {
    id: 'pull',
    cliArgv: ['node', '-e', 'console.log("tampered")'],
  });
  assert.equal(tampered.ok, false);
  assert.match(tampered.ok ? '' : tampered.error, /does not exactly match its installed CLI declaration/i);
  assert.equal(tampered.provenNoDispatch, true);

  // Schedule drift on the same argv is a new decision (the human approved
  // "runs at THIS cadence", not "runs whenever").
  const rescheduled = { ...source, schedule: '*/5 * * * *' };
  store.spaceStore.save({ id: slug, title: 'CLI edges', dataSources: [rescheduled] });
  const afterReschedule = await runner.runSpaceDataSource(slug, rescheduled);
  assert.equal(afterReschedule.ok, false);
  assert.match(afterReschedule.ok ? '' : afterReschedule.error, /one-time approval/i);

  // Even an approved command that is not installed is refused before PATH
  // lookup because legacy CLI trust is not shared-kernel authority.
  const missing = { id: 'gone', cliArgv: ['definitely-not-a-real-cli-9f3a', '--version'] };
  store.spaceStore.save({ id: `${slug}-missing`, title: 'CLI missing', dataSources: [missing] });
  const pendingMissing = await runner.runSpaceDataSource(`${slug}-missing`, missing);
  assert.equal(pendingMissing.ok, false);
  const missingCard = approvalRegistry.listPending({ sessionId: `space-${slug}-missing`, status: 'pending' })[0];
  assert.ok(missingCard);
  assert.equal(approvalRegistry.resolve(missingCard.approvalId, 'approved', 'cli-trust-test').ok, true);
  const ran = await runner.runSpaceDataSource(`${slug}-missing`, missing);
  assert.equal(ran.ok, false);
  assert.equal(ran.ok ? undefined : ran.provenNoDispatch, true);
  assert.match(ran.ok ? '' : ran.error, /no shared durable call authority/i);
});

test('a pinned legacy entrypoint digest does not unlock the retired raw runner', async () => {
  const slug = 'verified-entrypoint-contained';
  const file = 'pull.mjs';
  writeRunner(slug, file, "process.stdout.write('{}');");
  const target = store.resolveInSpace(slug, `data/${file}`);
  const expectedSha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  const result = await runner.runScript(slug, file, undefined, { expectedSha256 });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.provenNoDispatch, true);
  assert.match(result.ok ? '' : result.error, /no shared durable call authority/i);
});

test('runner-trust resolution reports once while both approval and rejection remain zero-process', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = dataStore.readData(slug) as {
      _meta?: { pull?: { status?: string; approvalId?: string } };
    };
    assert.equal(
      (await import('node:fs')).existsSync(spawnedPath),
      false,
      'neither a trust approval nor rejection carries process authority',
    );
    const note = dataStore.listNotes(slug).find((item) => (
      item.meta?.approvalId === approvalId && item.meta?.status === resolution
    ));
    assert.ok(note);
    assert.equal(note.meta?.status, resolution);
    if (resolution === 'approved') {
      assert.equal((current._meta?.pull as { ok?: boolean } | undefined)?.ok, false);
      assert.equal(approvalRegistry.get(approvalId)?.consumedAt !== null, true);
      assert.match(note.text, /refresh.*resum/i);
      const outcome = eventlog.listEvents(`space-${slug}`, {
        types: ['user_input_received'],
      }).find((event) => (
        event.data.synthetic === true
        && event.data.source === 'outcome'
        && event.data.sourceLabel === 'workspace refresh'
        && event.data.sourceId === `${approvalId}:${source.id}`
      ));
      assert.ok(outcome, 'Workspace refresh reports through the unified async Outcome edge');
      assert.equal(outcome.data.status, 'failed');
      assert.match(String(outcome.data.text ?? ''), /could not refresh|activity log/i);
      assert.equal(
        eventlog.listEvents(`space-${slug}`, { types: ['conversation_completed'] })
          .some((event) => event.data.approvalId === approvalId),
        false,
        'async approval work never fabricates a foreground turn terminal',
      );
    } else {
      assert.equal(current._meta?.pull?.status, 'awaiting_approval');
      assert.equal(current._meta?.pull?.approvalId, approvalId);
      assert.equal(note.meta?.staleDataStatus, true);
      assert.match(note.text, /runner remains blocked/i);
    }
  }
});

test('contained approved refresh reports a safe async Outcome without entering runner diagnostics', async () => {
  const slug = 'legacy-runner-trust-safe-failure';
  const source = { id: 'pull', runner: 'pull.mjs' };
  writeRunner(
    slug,
    source.runner,
    `process.stderr.write('provider-secret-diagnostic'); process.exit(7);`,
  );
  store.spaceStore.save({
    id: slug,
    title: 'Legacy runner safe failure',
    dataSources: [source],
  });

  const refresh = await runner.refreshSpaceData(slug, source.id);
  const approvalId = refresh[0]?.pendingApprovalId;
  assert.match(approvalId ?? '', /^apr-/);
  assert.equal(approvalRegistry.resolve(approvalId!, 'approved', 'safe-failure-test').ok, true);

  let outcome: ReturnType<typeof eventlog.listEvents>[number] | undefined;
  // The process-wide corpus runs many child-process suites concurrently; the
  // approved runner can be scheduler-starved even though the async outcome is
  // healthy. This is a polling guard, not a three-second product SLA.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    outcome = eventlog.listEvents(`space-${slug}`, { types: ['user_input_received'] })
      .find((event) => (
        event.data.synthetic === true
        && event.data.source === 'outcome'
        && event.data.sourceId === `${approvalId}:${source.id}`
      ));
    if (outcome) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.ok(outcome);
  assert.equal(outcome.data.status, 'failed');
  assert.match(String(outcome.data.text ?? ''), /activity log for technical details/i);
  assert.doesNotMatch(String(outcome.data.text ?? ''), /provider-secret-diagnostic/);
  assert.equal(
    eventlog.listEvents(`space-${slug}`, { types: ['conversation_completed'] })
      .some((event) => event.data.approvalId === approvalId),
    false,
  );
  const diagnostics = operationalTelemetry.listOperationalEvents({
    source: 'workspace',
    type: 'workspace_data_refresh_failed',
    workspaceId: slug,
    limit: 20,
  });
  assert.ok(
    diagnostics.every((event) => !JSON.stringify(event.payload).includes('provider-secret-diagnostic')),
    'runner-controlled diagnostics are impossible because the body never starts',
  );
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
  const approved = await runner.runSpaceDataSource(slug, source);
  assert.equal(approved.ok, false);
  assert.equal(approved.ok ? undefined : approved.provenNoDispatch, true);
  assert.match(approved.ok ? '' : approved.error, /no shared durable call authority/i);

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

test('Composio actions require approval when applicable and shared durable authority in every case', async () => {
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
    assert.equal(read.ok, false);
    assert.match(read.ok ? '' : read.error, /no shared durable call authority/i);
    assert.equal(read.ok ? undefined : read.provenNoDispatch, true);
    assert.equal(dispatches, 0);
  } finally {
    runner._setSpaceComposioDispatchForTests(null);
  }
});

test('concurrent same-space local refreshes both remain contained without projecting runner data', async () => {
  const slug = 'refresh-serial';
  const alphaSource = { id: 'alpha', runner: 'alpha.mjs' };
  const betaSource = { id: 'beta', runner: 'beta.mjs' };
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Serial',
    dataSources: [alphaSource, betaSource],
  });
  writeRunner(slug, alphaSource.runner, `setTimeout(() => process.stdout.write(JSON.stringify({rows:[{id:'alpha'}]})), 80);`);
  writeRunner(slug, betaSource.runner, `setTimeout(() => process.stdout.write(JSON.stringify({rows:[{id:'beta'}]})), 20);`);
  await approveInstalledRunnerFixture(slug, alphaSource);
  await approveInstalledRunnerFixture(slug, betaSource);
  try {
    const [alpha, beta] = await Promise.all([
      runner.refreshSpaceData(slug, 'alpha'),
      runner.refreshSpaceData(slug, 'beta'),
    ]);

    assert.equal(alpha[0].ok, false);
    assert.equal(beta[0].ok, false);
    assert.match(alpha[0].error ?? '', /no shared durable call authority/i);
    assert.match(beta[0].error ?? '', /no shared durable call authority/i);
    const data = dataStore.readData(slug) as Record<string, unknown>;
    assert.equal(Object.hasOwn(data, 'alpha'), false);
    assert.equal(Object.hasOwn(data, 'beta'), false);
    assert.equal((data._meta as Record<string, { ok?: boolean }>).alpha.ok, false);
    assert.equal((data._meta as Record<string, { ok?: boolean }>).beta.ok, false);
  } finally {
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('contained sibling sources persist bounded error observations and retry without duplicates', async () => {
  const slug = 'refresh-partial-batch';
  const smallSource = { id: 'small', runner: 'small.mjs' };
  const oversizedSource = { id: 'oversized', runner: 'oversized.mjs' };
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Partial Batch',
    dataSources: [smallSource, oversizedSource],
  });
  writeRunner(slug, smallSource.runner, `process.stdout.write(JSON.stringify({rows:[{id:'kept',value:42}]}));`);
  writeRunner(slug, oversizedSource.runner, `process.stdout.write(JSON.stringify({payload:'x'.repeat(6*1024*1024)}));`);
  await approveInstalledRunnerFixture(slug, smallSource);
  await approveInstalledRunnerFixture(slug, oversizedSource);
  try {
    for (const batchId of ['partial-batch-first', 'partial-batch-retry']) {
      const results = await runner.refreshSpaceData(slug, undefined, {
        cause: 'scheduled',
        refreshId: 'stable-refresh',
        batchId,
      });
      assert.equal(results.length, 2);
      assert.equal(results[0]?.sourceId, 'small');
      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.error ?? '', /no shared durable call authority/i);
      assert.equal(results[1]?.sourceId, 'oversized');
      assert.equal(results[1]?.ok, false);
      assert.match(results[1]?.error ?? '', /no shared durable call authority/i);
      assert.equal(
        results.every((result) => result.write?.ok === true),
        true,
        JSON.stringify(results),
      );
    }

    const data = dataStore.readData(slug) as Record<string, unknown>;
    assert.equal(Object.hasOwn(data, 'small'), false);
    assert.equal(Object.hasOwn(data, 'oversized'), false);
    assert.equal(
      (data._meta as Record<string, { ok?: boolean | null }>).small.ok,
      false,
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
      'contained source retry reuses its durable error observation',
    );
    const oversized = workspaceDb.listWorkspaceDatasetObservations(slug, {
      sourceKey: 'oversized',
      limit: 10,
    });
    assert.equal(oversized.length, 1, 'contained sibling retry reuses its error observation');
    assert.equal(oversized[0]?.status, 'error');
  } finally {
    runner._resetSpaceRefreshQueuesForTest();
  }
});

test('contained refresh preserves a 2.7.5 baseline and dedupes its error observation', async () => {
  const slug = 'refresh-temporal-baseline';
  const source = { id: 'campaigns', runner: 'campaigns.mjs' };
  store.spaceStore.save({
    id: slug,
    title: 'Refresh Temporal Baseline',
    dataSources: [source],
  });
  const legacy = {
    campaigns: { rows: [{ id: 'campaign-1', spend: 10, status: 'active' }] },
    _meta: { campaigns: { refreshedAt: '2026-06-01T00:00:00.000Z', ok: true } },
  };
  assert.equal(dataStore.writeData(slug, legacy).ok, true);

  writeRunner(slug, source.runner, `process.stdout.write(JSON.stringify({rows:[{id:'campaign-1',spend:15,status:'paused'}]}));`);
  await approveInstalledRunnerFixture(slug, source);
  try {
    const first = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-1',
      batchId: 'manual-batch-1',
    });
    assert.equal(first[0]?.ok, false);
    assert.match(first[0]?.error ?? '', /no shared durable call authority/i);
    assert.match(first[0]?.observationId ?? '', /^[a-f0-9-]{36}$/i);

    const afterFirst = workspaceDb.listWorkspaceDatasetObservations(slug, {
      sourceKey: 'campaigns',
      limit: 10,
    });
    assert.equal(afterFirst.length, 2);
    assert.equal(afterFirst[0]?.cause, 'manual');
    assert.equal(afterFirst[0]?.status, 'error');
    assert.equal(afterFirst[1]?.cause, 'legacy_import');
    assert.equal(afterFirst[0]?.previousObservationId, afterFirst[1]?.id);
    assert.deepEqual(
      (dataStore.readData(slug) as { campaigns?: unknown }).campaigns,
      legacy.campaigns,
      'the last successful projection remains visible during containment',
    );

    const same = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-2',
      batchId: 'manual-batch-2',
    });
    assert.equal(same[0]?.ok, false);
    const replay = await runner.refreshSpaceData(slug, 'campaigns', {
      cause: 'manual',
      refreshId: 'manual-refresh-2',
      batchId: 'manual-batch-replayed',
    });
    assert.equal(replay[0]?.ok, false);
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

test('no-output runner is contained before output handling', async () => {
  const slug = 'no-output';
  writeRunner(slug, 'r.mjs', `process.exit(0);`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
});

test('non-zero runner is contained before its stderr can execute', async () => {
  const slug = 'nonzero';
  writeRunner(slug, 'r.mjs', `process.stderr.write('boom happened'); process.exit(3);`);
  const res = await runner.runScript(slug, 'r.mjs');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
  assert.doesNotMatch((res as { error: string }).error, /boom happened/);
});

test('an otherwise valid legacy filename is contained before interpreter selection', async () => {
  const slug = 'bad-ext';
  writeRunner(slug, 'data.txt', `whatever`);
  const res = await runner.runScript(slug, 'data.txt');
  assert.equal(res.ok, false);
  assert.equal(res.ok ? undefined : res.provenNoDispatch, true);
  assert.match((res as { error: string }).error, /no shared durable call authority/i);
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
