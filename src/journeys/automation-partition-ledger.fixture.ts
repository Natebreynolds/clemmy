import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ClementineAssistant } from '../assistant/core.js';

const home = process.env.CLEMENTINE_HOME;
assert.ok(home && process.env.CLEMMY_TEST_ISOLATED_HOME === '1', 'fixture requires an isolated Clementine home');
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const runId = process.env.ROW10_RUN_ID;
const activationId = process.env.ROW10_ACTIVATION_ID;
const workflowId = process.env.ROW10_WORKFLOW_ID;
const firstFireAt = process.env.ROW10_FIRST_FIRE_AT;
const proposalId = process.env.ROW10_PROPOSAL_ID;
assert.ok(runId && activationId && workflowId && firstFireAt && proposalId, 'fixture lineage environment is incomplete');

const support = await import('./automation-partition-ledger.fixture-support.js');
const opportunityStore = await import('../execution/automation-opportunity-store.js');
const targets = await import('../execution/automation-pilot-target.js');
const scheduler = await import('../execution/workflow-scheduler.js');
const runner = await import('../execution/workflow-runner.js');
const partitions = await import('../execution/automation-partition-authority.js');
const fanout = await import('../execution/durable-fanout.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const memoryDb = await import('../memory/db.js');
const shared = await import('../tools/shared.js');

const proposal = opportunityStore.loadAutomationOpportunityProposal(proposalId);
assert.ok(proposal && proposal.status === 'approved');
const target = targets.selectAutomaticReadPilotTarget(proposal.opportunity);
assert.equal(target.ok, true, JSON.stringify(target));

const carrier = support.installGeneratedPartitionCarrier();
const materialized = await carrier.acquisition.acquire({
  requirementId: target.requirement.id,
  objective: target.requirement.description,
  effect: 'read',
});
assert.equal(materialized.status, 'installed', JSON.stringify(materialized));

const dedupedFire = await scheduler.processWorkflowSchedules(new Date(firstFireAt));
assert.equal(
  dedupedFire.deduped.filter((candidate) => candidate === workflowId).length,
  1,
  JSON.stringify(dedupedFire),
);
const intervalRuns = () => readdirSync(shared.WORKFLOW_RUNS_DIR)
  .filter((file) => file.endsWith('.json'))
  .map((file) => JSON.parse(readFileSync(path.join(shared.WORKFLOW_RUNS_DIR, file), 'utf8')) as {
    id?: string;
    workflow?: string;
    source?: string;
    status?: string;
    terminalOutcome?: string;
    goalOutcome?: string;
    workflowRecurringReadAdmission?: { activationAuthority?: { activationId?: string } };
  })
  .filter((run) => (
    run.source === 'schedule'
    && run.workflow === workflowId
    && run.workflowRecurringReadAdmission?.activationAuthority?.activationId === activationId
  ));
assert.equal(intervalRuns().length, 1, JSON.stringify(intervalRuns()));

await runner.processWorkflowRuns({} as ClementineAssistant);
const completedRuns = intervalRuns();
assert.equal(completedRuns.length, 1);
assert.equal(completedRuns[0]?.id, runId);
assert.equal(completedRuns[0]?.status, 'completed', JSON.stringify(completedRuns[0]));
assert.equal(completedRuns[0]?.terminalOutcome, 'succeeded');
assert.equal(completedRuns[0]?.goalOutcome, 'satisfied');
assert.equal(carrier.counts.call, support.PARTITION_PAGE_COUNT);
assert.deepEqual(carrier.counts.cursors, [null, 'partition-page-1', 'partition-page-2']);

const admitted = partitions.reconcileAutomationPartitionRun(runId);
assert.equal(admitted.ok, true, JSON.stringify(admitted));
assert.equal(admitted.state, 'admitted');
assert.equal(admitted.authority.partitionCount, support.PARTITION_RECORD_COUNT);
assert.equal(admitted.authority.source.pageCount, support.PARTITION_PAGE_COUNT);
assert.equal(admitted.plan.durable.windows.length, Math.ceil(support.PARTITION_RECORD_COUNT / 256));
assert.deepEqual(admitted.plan.contract.fanoutExecution, {
  maxConcurrentWindows: 2,
  maxWindowAttempts: 2,
});
assert.equal(fanout.listFanoutActivations(admitted.plan.planId).length, support.PARTITION_RECORD_COUNT);

const scheduled = fanout.scheduleDurableFanout(admitted.plan.planId);
assert.ok(scheduled);
assert.equal(scheduled.workerTasks.length, 2);
const failedTask = scheduled.workerTasks[0]!.id;
const liveTask = scheduled.workerTasks[1]!.id;
const retried = fanout.reconcileDurableFanout({
  taskState: (taskId) => taskId === failedTask ? 'failed' : taskId === liveTask ? 'alive' : 'alive',
});
assert.deepEqual(retried.rescheduled, [admitted.plan.planId]);
const windowsAfterRetry = fanout.listFanoutWindows(admitted.plan.planId);
const retryTask = windowsAfterRetry.find((window) => window.windowIndex === 0)?.workerTaskId;
assert.ok(retryTask);
assert.equal(windowsAfterRetry.filter((window) => window.status === 'claimed').length, 2);
assert.equal(windowsAfterRetry.find((window) => window.windowIndex === 0)?.attempts, 2);
assert.equal(new Set([failedTask, liveTask, retryTask]).size, 3);

const replay = partitions.reconcileAutomationPartitionRun(runId);
assert.equal(replay.ok, true, JSON.stringify(replay));
assert.equal(replay.state, 'replayed');
assert.equal(replay.authority.authorityId, admitted.authority.authorityId);
assert.equal(replay.plan.planId, admitted.plan.planId);
assert.equal(fanout.listFanoutActivations(admitted.plan.planId).length, support.PARTITION_RECORD_COUNT);
assert.equal(fanout.scheduleDurableFanout(admitted.plan.planId)?.workerTasks.length, 0);

const summary = {
  occurrenceDeduped: true,
  scheduledRunCount: completedRuns.length,
  providerCalls: carrier.counts.call,
  authorityId: admitted.authority.authorityId,
  ledgerDigest: admitted.authority.ledgerDigest,
  partitionCount: admitted.authority.partitionCount,
  pageCount: admitted.authority.source.pageCount,
  fanoutPlanId: admitted.plan.planId,
  activationCount: fanout.listFanoutActivations(admitted.plan.planId).length,
  windowCount: admitted.plan.durable.windows.length,
  initialWorkerTasks: scheduled.workerTasks.length,
  claimedAfterRetry: windowsAfterRetry.filter((window) => window.status === 'claimed').length,
  retriedWindowAttempts: windowsAfterRetry.find((window) => window.windowIndex === 0)?.attempts,
  replayState: replay.state,
};

partitions.closeAutomationPartitionAuthorityForTests();
fanout.closeDurableFanoutForTests();
opportunityStore.closeAutomationOpportunityStoreForTests();
eventlog.closeEventLog();
memoryDb.closeMemoryDb();
catalogs.installHostCapabilityCatalogFactory(null);
manifestStores.installCapabilityManifestStore(null);
observations.clearIndependentCapabilityObservations();
ports.clearProductionCapabilityPorts();

process.stdout.write(`ROW10_RESULT ${JSON.stringify(summary)}\n`);
