/** Reconstruct a card persisted by an older installation. Production refreshes
 * must not create these: approval never supplied the retired runner's carrier. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isolatedTestContractActive } from '../runtime/harness/isolated-test-contract.js';
import { createSession, getSession } from '../runtime/harness/eventlog.js';
import { registerResumable } from '../runtime/harness/approval-registry.js';
import { emitApprovalRequestedCard } from '../runtime/harness/approval-card.js';
import { appendNote } from './data-store.js';
import { commitWorkspaceObservationBatch } from './workspace-db.js';
import { resolveInSpace, spaceStore, type SpaceDataSource } from './store.js';

export function seedLegacySpaceTrustApproval(slug: string, source: SpaceDataSource, observation = false) {
  if (!isolatedTestContractActive()) throw new Error('legacy approval fixture requires an isolated test contract');
  const rec = spaceStore.get(slug)!;
  const sessionId = `space-${slug}`;
  if (!getSession(sessionId)) createSession({ id: sessionId, kind: 'chat', title: rec.title });
  const schedulePolicy = { schedule: source.schedule?.trim() || null, timezone: source.timezone?.trim() || null };
  const runner = source.runner?.trim();
  const snapshot = runner ? {
    spaceDataRunnerTrustVersion: 1, spaceSlug: slug, sourceId: source.id, runner,
    runnerSha256: createHash('sha256').update(readFileSync(resolveInSpace(slug, `data/${runner}`))).digest('hex'),
    schedulePolicy,
  } : {
    spaceCliSourceTrustVersion: 1, spaceSlug: slug, sourceId: source.id,
    cliArgv: source.cliArgv!.slice(), schedulePolicy,
  };
  const trustKey = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const tool = runner ? 'space_trust_data_runner' : 'space_trust_cli_source';
  const { row } = registerResumable({
    sessionId, resumeKey: `${runner ? 'space-data-runner-trust' : 'space-cli-source-trust'}:v1:${trustKey}`,
    ttlMs: 90 * 24 * 60 * 60 * 1_000, subject: `Historical refresh ${source.id}`, tool,
    args: { ...snapshot, trustKey },
  });
  appendNote(slug, { text: 'Historical approval pending.', kind: 'data-source', meta: {
    kind: tool, sourceId: source.id, approvalId: row.approvalId, status: 'pending',
  } });
  emitApprovalRequestedCard({ sessionId, approvalId: row.approvalId });
  if (observation) commitWorkspaceObservationBatch({
    workspaceId: slug, observations: [{
      sourceKey: source.id, refreshId: `runner-trust-pending:${row.approvalId}`, cause: 'manual',
      status: 'awaiting_approval', error: 'Historical approval pending.',
      provenance: { approvalId: row.approvalId, adapter: 'legacy_runner' },
    }],
  });
  return row;
}
