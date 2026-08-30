/**
 * Run: node scripts/run-tests-isolated.mjs src/spaces/space-data-runner-trust-terminal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-runner-terminal-test-'));

const runner = await import('./runner.js');
const store = await import('./store.js');
const dataStore = await import('./data-store.js');
const workspaceDb = await import('./workspace-db.js');
const runnerTrust = await import('./space-data-runner-trust.js');
const approvalRegistry = await import('../runtime/harness/approval-registry.js');
const eventlog = await import('../runtime/harness/eventlog.js');

const cases = [
  { resolution: 'rejected', copy: /You declined approval/i },
  { resolution: 'expired', copy: /approval .* expired .* without a decision/i },
  { resolution: 'cancelled_by_user', copy: /You cancelled approval/i },
  { resolution: 'cancelled_by_system', copy: /Clementine cancelled approval/i },
] as const;

test('terminal CLI trust decisions close stale observations and only an explicit refresh asks again', async () => {
  for (const fixture of cases) {
    const suffix = fixture.resolution.replaceAll('_', '-');
    const slug = `terminal-cli-${suffix}`;
    const sentinel = path.join(process.env.CLEMENTINE_HOME!, `${slug}-executed`);
    const source = {
      id: 'salesforce_pull',
      cliArgv: [
        'node',
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')`,
      ],
      schedule: '0 7 * * *',
      timezone: 'America/Los_Angeles',
    };
    store.spaceStore.save({
      id: slug,
      title: `Terminal CLI ${fixture.resolution}`,
      dataSources: [source],
    });

    const first = await runner.refreshSpaceData(slug, source.id, { cause: 'manual' });
    const approvalId = first[0]?.pendingApprovalId;
    assert.match(approvalId ?? '', /^apr-/);
    assert.equal(existsSync(sentinel), false);
    assert.equal(
      workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: source.id,
        limit: 10,
      }).filter((observation) => observation.status === 'awaiting_approval').length,
      1,
    );

    const decision = approvalRegistry.resolve(
      approvalId!,
      fixture.resolution,
      'terminal-projection-test',
    );
    assert.equal(decision.ok, true);
    const row = approvalRegistry.get(approvalId!);
    assert.equal(row?.resolution, fixture.resolution);
    assert.match(row?.resolvedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    const observations = workspaceDb.listWorkspaceDatasetObservations(slug, {
      sourceKey: source.id,
      limit: 10,
    });
    assert.equal(
      observations.some((observation) => observation.status === 'awaiting_approval'),
      false,
      'a terminal approval decision cannot leave a live waiting observation',
    );
    assert.equal(observations.length, 1, 'resolution transitions the original fact in place');
    assert.equal(observations[0]?.status, 'error');
    assert.equal(observations[0]?.provenance.approvalId, approvalId);
    assert.equal(observations[0]?.provenance.approvalResolution, fixture.resolution);
    assert.equal(observations[0]?.provenance.approvalResolvedAt, row?.resolvedAt);
    assert.match(observations[0]?.error ?? '', fixture.copy);
    assert.match(observations[0]?.error ?? '', /\d{4}-\d{2}-\d{2} at \d{2}:\d{2} UTC/);
    assert.match(observations[0]?.error ?? '', /remained blocked and was not executed/i);

    const projected = dataStore.readData(slug) as {
      _meta?: {
        salesforce_pull?: {
          ok?: boolean | null;
          status?: string;
          error?: string;
          approvalId?: string;
          approvalResolution?: string;
          approvalResolvedAt?: string;
        };
      };
    };
    assert.equal(projected._meta?.salesforce_pull?.ok, false);
    assert.equal(projected._meta?.salesforce_pull?.status, 'error');
    assert.equal(projected._meta?.salesforce_pull?.approvalId, approvalId);
    assert.equal(projected._meta?.salesforce_pull?.approvalResolution, fixture.resolution);
    assert.equal(projected._meta?.salesforce_pull?.approvalResolvedAt, row?.resolvedAt);
    assert.match(projected._meta?.salesforce_pull?.error ?? '', fixture.copy);
    assert.equal(existsSync(sentinel), false, 'decision projection never starts the CLI');

    const decisionNotes = () => dataStore.listNotes(slug, Number.MAX_SAFE_INTEGER)
      .filter((note) => note.meta?.approvalId === approvalId);
    assert.equal(decisionNotes().length, 2, 'one pending note plus one terminal note');
    assert.match(decisionNotes().at(-1)?.text ?? '', fixture.copy);
    assert.match(decisionNotes().at(-1)?.text ?? '', /\d{4}-\d{2}-\d{2} at \d{2}:\d{2} UTC/);

    const beforeReplay = JSON.stringify({
      data: dataStore.readData(slug),
      observations: workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: source.id,
        limit: 10,
      }),
      notes: decisionNotes(),
    });
    assert.equal(runnerTrust.recoverResolvedRunnerTrustApprovals(), 0);
    assert.equal(runnerTrust.recoverResolvedRunnerTrustApprovals(), 0);
    assert.equal(JSON.stringify({
      data: dataStore.readData(slug),
      observations: workspaceDb.listWorkspaceDatasetObservations(slug, {
        sourceKey: source.id,
        limit: 10,
      }),
      notes: decisionNotes(),
    }), beforeReplay, 'terminal projection replay is byte-for-byte idempotent');

    const backgroundRetry = await runner.runSpaceDataSource(slug, source);
    assert.equal(backgroundRetry.ok, false);
    assert.match(backgroundRetry.ok ? '' : backgroundRetry.error, fixture.copy);
    assert.equal(
      approvalRegistry.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
      0,
      'an implicit retry does not erase the prior no',
    );

    const [explicit, duplicateExplicit] = await Promise.all([
      runner.refreshSpaceData(slug, source.id, { cause: 'manual' }),
      runner.refreshSpaceData(slug, source.id, { cause: 'manual' }),
    ]);
    const newApprovalId = explicit[0]?.pendingApprovalId;
    assert.match(newApprovalId ?? '', /^apr-/);
    assert.equal(duplicateExplicit[0]?.pendingApprovalId, newApprovalId);
    assert.notEqual(newApprovalId, approvalId, 'the old decision is never revived as authority');
    const pending = approvalRegistry.listPending({
      sessionId: `space-${slug}`,
      status: 'pending',
    });
    assert.equal(pending.length, 1, 'concurrent explicit requests converge on one fresh card');
    assert.equal(pending[0]?.approvalId, newApprovalId);
    assert.equal(approvalRegistry.get(approvalId!)?.resolution, fixture.resolution);
    assert.equal(
      eventlog.listEvents(`space-${slug}`, { types: ['approval_requested'] })
        .filter((event) => event.data.approvalId === newApprovalId).length,
      1,
      'the fresh decision reuses the ordinary chat/mobile approval-card event',
    );
    assert.equal(existsSync(sentinel), false);
  }
});
