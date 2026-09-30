/** Durable ownership between saved-source consent, the shared call kernel and
 * dataset publication. A new scheduler tick cannot step around unfinished or
 * uncertain execution by inventing another occurrence. No recurring grant is
 * minted here: activation still requires the exact existing v3 approval. */
import { createHash } from 'node:crypto';
import { createSession, getSession, openEventLog } from '../runtime/harness/eventlog.js';
import { get as getApproval } from '../runtime/harness/approval-registry.js';
import { ensureReviewedLocalWorkflowCapability } from '../runtime/harness/reviewed-local-workflow-capability.js';
import { executeActivatedWorkflowNodeCall } from '../execution/workflow-node-invocation-executor.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';
import { prepareWorkspaceScriptCall, activateApprovedWorkspaceScriptCall } from './workspace-script-authority.js';
import { captureWorkspaceScriptArguments } from './workspace-script-carrier.js';
import { WORKSPACE_SCRIPT_OPERATION } from './workspace-script-contract.js';
import { spaceStore, type SpaceDataSource } from './store.js';
import { canonicalWorkspaceJson } from './workspace-set-data-contract.js';
import { parseSpaceSourceTransforms, transformSpaceSourceData } from './source-transforms.js';
import { bootstrapWorkspaceObservationHistory, commitWorkspaceObservationBatch,
  getWorkspaceDatasetObservationByRefreshId, healWorkspaceDataProjection,
  indexWorkspaceRecord, type CommitWorkspaceObservationBatchResult } from './workspace-db.js';
import { finalizeWorkspaceObservationCommit } from './workspace-observation-finalize.js';

export interface WorkspaceScriptOccurrenceKey {
  slug: string;
  sourceId: string;
  occurrenceId: string;
}
type Prepared = ReturnType<typeof prepareWorkspaceScriptCall>;
interface Preparation {
  args: Prepared['args'];
  plan: Prepared['plan'];
  consent: Prepared['consent'];
  source: SpaceDataSource;
}
interface OccurrenceRow {
  workspace_id: string; source_id: string; occurrence_id: string;
  session_id: string; logical_call_id: string; preparation_json: string;
  approval_id: string | null; activation_id: string | null;
  observed_at: string | null; observation_id: string | null; created_at: string;
}
const table = 'workspace_script_occurrences_v1';
const digest = (value: unknown) => createHash('sha256').update(canonicalWorkspaceJson(value)).digest('hex');
const refreshId = (key: WorkspaceScriptOccurrenceKey) => `saved-script:${digest([key.slug, key.sourceId, key.occurrenceId])}`;
const keyArgs = (key: WorkspaceScriptOccurrenceKey) => [key.slug, key.sourceId, key.occurrenceId];

function rowFor(key: WorkspaceScriptOccurrenceKey): OccurrenceRow | undefined {
  return openEventLog().prepare(`SELECT * FROM ${table}
    WHERE workspace_id = ? AND source_id = ? AND occurrence_id = ?`).get(...keyArgs(key)) as OccurrenceRow | undefined;
}

export type ReserveWorkspaceScriptOccurrenceResult =
  | { status: 'reserved' | 'existing'; key: WorkspaceScriptOccurrenceKey;
      sessionId: string; consent: Prepared['consent']; published: boolean }
  | { status: 'blocked'; occurrenceId: string; reason: string };

/** Call before presenting consent. Retain both the exact canonical invocation
 * and the source transforms before any process can be authorized or launched. */
export function reserveWorkspaceScriptOccurrence(
  input: WorkspaceScriptOccurrenceKey & { cause: 'manual' | 'scheduled' },
): ReserveWorkspaceScriptOccurrenceResult {
  const db = openEventLog();
  return db.transaction((): ReserveWorkspaceScriptOccurrenceResult => {
    const existing = rowFor(input);
    if (existing) {
      const saved = JSON.parse(existing.preparation_json) as Preparation;
      if (saved.args.cause !== input.cause) throw new Error('An occurrence cannot change its refresh cause.');
      return { status: 'existing', key: { slug: input.slug, sourceId: input.sourceId, occurrenceId: input.occurrenceId },
        sessionId: existing.session_id, consent: saved.consent, published: existing.observation_id !== null };
    }
    const pending = db.prepare(`SELECT occurrence_id FROM ${table}
      WHERE workspace_id = ? AND source_id = ? AND observation_id IS NULL`).get(input.slug, input.sourceId) as { occurrence_id: string } | undefined;
    if (pending) return { status: 'blocked', occurrenceId: pending.occurrence_id,
      reason: 'This source has an unfinished occurrence. Recover that occurrence before admitting another run.' };
    const args = captureWorkspaceScriptArguments({ slug: input.slug, source_id: input.sourceId,
      occurrence_id: input.occurrenceId, cause: input.cause });
    const prepared = prepareWorkspaceScriptCall(args);
    const source = spaceStore.get(input.slug)!.dataSources.find(row => row.id === input.sourceId)!;
    if (source.transforms !== undefined) parseSpaceSourceTransforms(source.transforms);
    if (digest(source) !== args.source_digest) throw new Error('Saved source changed during occurrence preparation.');
    const rec = spaceStore.get(input.slug)!;
    indexWorkspaceRecord(rec, { emitOperational: false, appendStateEvent: false, strict: true });
    const baseline = bootstrapWorkspaceObservationHistory(input.slug);
    if (!baseline.ok) throw new Error(`Saved script was not admitted: ${baseline.error}`);
    if (!getSession(prepared.sessionId)) createSession({ id: prepared.sessionId, kind: 'workflow', title: `Workspace ${input.slug} script refreshes` });
    const saved: Preparation = { args: prepared.prepared.prepared.canonicalArgs as Prepared['args'],
      plan: prepared.plan, consent: prepared.consent, source };
    db.prepare(`INSERT INTO ${table} (workspace_id, source_id, occurrence_id, session_id,
      logical_call_id, preparation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      ...keyArgs(input), prepared.sessionId, prepared.prepared.prepared.logicalCallId, JSON.stringify(saved), new Date().toISOString());
    return { status: 'reserved', key: { slug: input.slug, sourceId: input.sourceId, occurrenceId: input.occurrenceId },
      sessionId: prepared.sessionId, consent: prepared.consent, published: false };
  }).immediate();
}

type FaultPoint = 'after_activation' | 'after_kernel' | 'after_observation';
let fault: FaultPoint | null = null;
export function setWorkspaceScriptOccurrenceFaultForTests(point: FaultPoint | null): void {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') throw new Error('Saved script fault injection requires an isolated test home.');
  fault = point;
}
function crash(point: FaultPoint): void { if (fault === point) throw new Error(`saved-script crash: ${point}`); }

/** Restore the activation from the kernel's own journal if the process died
 * after arming but before recording its address here. Never re-prepare a new
 * call from a script that may have changed/disappeared since execution. */
function recoverActivation(row: OccurrenceRow): string | null {
  if (row.activation_id) return row.activation_id;
  const db = openEventLog();
  const prior = db.prepare(`SELECT activation_id FROM workflow_node_invocation_activations
    WHERE session_id = ? AND logical_call_id = ?`).get(row.session_id, row.logical_call_id) as { activation_id: string } | undefined;
  if (!prior) return null;
  db.prepare(`UPDATE ${table} SET activation_id = ? WHERE workspace_id = ? AND source_id = ?
    AND occurrence_id = ? AND activation_id IS NULL`).run(prior.activation_id, row.workspace_id, row.source_id, row.occurrence_id);
  return prior.activation_id;
}

export function activateWorkspaceScriptOccurrence(key: WorkspaceScriptOccurrenceKey, approvalId: string): string {
  const db = openEventLog();
  let row = rowFor(key);
  if (!row) throw new Error('Saved script occurrence was not reserved.');
  const saved = JSON.parse(row.preparation_json) as Preparation;
  const approval = getApproval(approvalId);
  if (!approval || approval.status !== 'resolved' || approval.resolution !== 'approved'
    || approval.sessionId !== row.session_id || approval.tool !== saved.consent.tool
    || approval.resumeKey !== saved.consent.resumeKey
    || closedCanonicalJson(approval.args) !== closedCanonicalJson(saved.consent.args)) {
    throw new Error('Saved script occurrence lacks approval for its exact retained call.');
  }
  // Persist the exact decision address first. Do not nest the authority arm
  // transaction: it publishes committed activation events to subscribers.
  db.prepare(`UPDATE ${table} SET approval_id = ? WHERE workspace_id = ? AND source_id = ?
    AND occurrence_id = ? AND approval_id IS NULL`).run(approvalId, ...keyArgs(key));
  row = rowFor(key)!;
  if (row.approval_id !== approvalId) throw new Error('Saved script occurrence already owns a different approval.');
  const recovered = recoverActivation(row);
  if (recovered) return recovered;
  const current = prepareWorkspaceScriptCall(saved.args);
  if (closedCanonicalJson(current.plan) !== closedCanonicalJson(saved.plan)
    || closedCanonicalJson(current.consent) !== closedCanonicalJson(saved.consent)) {
    throw new Error('Saved script binding changed after occurrence preparation; no process was started.');
  }
  const active = activateApprovedWorkspaceScriptCall({ args: saved.args, approvalId });
  crash('after_activation');
  db.prepare(`UPDATE ${table} SET activation_id = ? WHERE workspace_id = ? AND source_id = ?
    AND occurrence_id = ? AND activation_id IS NULL`).run(active.activationId, ...keyArgs(key));
  return active.activationId;
}

export type ExecuteWorkspaceScriptOccurrenceResult =
  | { status: 'published'; observationId: string; replayed: boolean }
  | { status: 'held'; reason: string };

/** Only the kernel's retained host result may become a dataset. The source
 * barrier releases after the canonical observation and file projection are
 * saved. A crash in either database is recovered from the exact same result. */
export async function executeWorkspaceScriptOccurrence(
  key: WorkspaceScriptOccurrenceKey, signal?: AbortSignal,
): Promise<ExecuteWorkspaceScriptOccurrenceResult> {
  let row = rowFor(key);
  if (!row) return { status: 'held', reason: 'Saved script occurrence was not reserved.' };
  const saved = JSON.parse(row.preparation_json) as Preparation;
  const activationId = recoverActivation(row);
  if (!activationId) return { status: 'held', reason: 'Saved script occurrence has no approved activation.' };
  // A fresh daemon needs the current host port registered, but recovery must
  // never recapture the source or replace its sealed plan with a new one.
  const capability = ensureReviewedLocalWorkflowCapability({ operationId: WORKSPACE_SCRIPT_OPERATION, args: saved.args });
  if (!capability.ok) return { status: 'held', reason: `Saved script carrier is unavailable: ${capability.reason}` };
  const result = await executeActivatedWorkflowNodeCall({ activationId,
    invocationPlan: saved.plan, args: saved.args, signal });
  crash('after_kernel');
  if (result.status !== 'completed' && result.status !== 'replayed') {
    // zeroBody describes THIS invocation, not necessarily a previous claimed
    // occurrence. Never free a source's barrier based on a retry's zeroBody.
    return { status: 'held', reason: result.reason };
  }
  const payload = result.result as Record<string, unknown> | null;
  if (!payload || payload.kind !== 'workspace_script_result' || payload.version !== 1
    || payload.workspaceId !== key.slug || payload.sourceId !== key.sourceId
    || payload.occurrenceId !== key.occurrenceId || payload.declarationDigest !== saved.args.source_digest
    || payload.scriptDigest !== saved.args.script_sha256 || !Object.hasOwn(payload, 'data')) {
    return { status: 'held', reason: 'Saved script result does not match its retained occurrence.' };
  }
  const db = openEventLog();
  db.prepare(`UPDATE ${table} SET observed_at = ? WHERE workspace_id = ? AND source_id = ?
    AND occurrence_id = ? AND observed_at IS NULL`).run(new Date().toISOString(), ...keyArgs(key));
  row = rowFor(key)!;
  let committed: CommitWorkspaceObservationBatchResult;
  try {
    const data = saved.source.transforms === undefined ? payload.data
      : transformSpaceSourceData(saved.source.transforms, payload.data, row.observed_at!);
    const existing = getWorkspaceDatasetObservationByRefreshId(key.slug, key.sourceId, refreshId(key));
    if (existing) {
      if (existing.status !== 'ok' || existing.provenance.runId !== key.occurrenceId
        || existing.provenance.argsHash !== saved.args.source_digest
        || existing.provenance.runnerHash !== saved.args.script_sha256
        || existing.contentHash !== digest(data)) {
        return { status: 'held', reason: 'The source observation conflicts with this saved script occurrence.' };
      }
      committed = { batchId: existing.batchId, observations: [{ ...existing, deduped: true }],
        projection: healWorkspaceDataProjection(key.slug) };
    } else {
      if (row.observation_id) return { status: 'held', reason: 'Previously published script observation is no longer retained.' };
      const rec = spaceStore.get(key.slug);
      const source = rec?.dataSources.find(source => source.id === key.sourceId);
      if (!rec || rec.status === 'archived' || !source || digest(source) !== saved.args.source_digest) {
        return { status: 'held', reason: 'The saved source changed before its result was published. Its process will not run again.' };
      }
      indexWorkspaceRecord(rec, { emitOperational: false, appendStateEvent: false, strict: true });
      committed = commitWorkspaceObservationBatch({ workspaceId: key.slug, batchId: refreshId(key), observations: [{
        sourceKey: key.sourceId, refreshId: refreshId(key), cause: saved.args.cause,
        status: 'ok', data, observedAt: row.observed_at!, provenance: {
          adapter: 'workspace_script', runner: saved.source.runner, runnerHash: saved.args.script_sha256,
          argsHash: saved.args.source_digest, runId: key.occurrenceId, sessionId: row.session_id,
          ...(saved.source.schedule ? { schedule: saved.source.schedule } : {}),
        },
      }] });
    }
  } catch (error) {
    return { status: 'held', reason: `Saved script result was not published: ${error instanceof Error ? error.message : String(error)}` };
  }
  crash('after_observation');
  // Finalization is idempotent and has its own durable memory-recovery path.
  await finalizeWorkspaceObservationCommit(key.slug, committed);
  const observation = committed.observations[0]!;
  db.prepare(`UPDATE ${table} SET observation_id = ? WHERE workspace_id = ? AND source_id = ?
    AND occurrence_id = ? AND observation_id IS NULL`).run(observation.id, ...keyArgs(key));
  return { status: 'published', observationId: observation.id, replayed: result.status === 'replayed' };
}
