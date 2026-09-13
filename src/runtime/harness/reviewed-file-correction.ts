/** A revision of this request's own local file, never a second create or a
 * grant for another destination. Prior receipts and synthesis rows stay intact. */
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { acceptedPlanExecution } from './accepted-plan-execution.js';
import { openEventLog } from './eventlog.js';
import { loadExpectedWorkContract } from './expected-work-contract.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import { parseHostLocalWriteCommitFacts, readCommittedArtifactContent } from './host-local-write-commit.js';
import { canonicalLocalFileTarget, isLocalFileRevisionHandle, localFileRevisionReplaces } from './local-file-revision.js';
import { resolveWorkTopologyJsonPointer } from '../graph/work-topology.js';
import { unwrapRuntimeEffectiveToolIdentity } from './tool-effect.js';

type Identity = { sessionId: string; sourceUserSeq: number };
const hash = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const targetFor = (value: string) => canonicalLocalFileTarget(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
type Correction = { stepId: string; resultId: number; target: string; content: string;
  priorCallId: string; priorReceiptDigest: string; expectedContentDigest: string };

function selected(identity: Identity, stepId: string) {
  const execution = acceptedPlanExecution(identity.sessionId, identity.sourceUserSeq);
  const outline = execution?.artifact.structuredPlan as any;
  const step = outline?.steps?.find((s: any) => s.id === stepId) as any;
  const binding = outline?.preparedBindings?.find((b: any) => b.stepId === stepId) as any;
  // This native operation already implements atomic replacement and prior-byte
  // retention. No other tool, external mutation or collection inherits it.
  if (!step || step.effect !== 'local_write' || step.forEach || binding?.identity.kind !== 'local_registry'
    || binding.identity.definition.name !== 'write_file' || typeof step.staticArguments?.path !== 'string'
    || ![undefined, null, 'create', 'overwrite'].includes(step.staticArguments.mode)
    || step.staticArguments.append != null || step.dynamicBindings?.length !== 1
    || step.dynamicBindings[0].targetPath !== '/content') return null;
  const producer = outline!.steps.find((s: any) => s.id === step.dynamicBindings[0].producerStepId) as any;
  if (!producer || producer.effect !== 'compute' || producer.capabilityRef) return null;
  const contract = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
  if (contract.status !== 'ok') return null;
  return { execution: execution!, step, binding, producer, contract: contract.contract };
}

function ownedFile(identity: Identity, stepId: string) {
  const selection = selected(identity, stepId);
  if (!selection) return null;
  const rows = openEventLog().prepare(`SELECT b.logical_tool_call_id AS callId, s.outcome_kind AS outcome,
      s.requires_reconciliation AS reconcile FROM expected_work_call_bindings b
    JOIN logical_call_settlements s USING(session_id, source_user_seq, logical_tool_call_id)
    WHERE b.session_id=? AND b.source_user_seq=? AND b.contract_id=? AND b.requirement_id=?
    ORDER BY s.rowid DESC`).all(identity.sessionId, identity.sourceUserSeq, selection.contract.contractId, stepId) as any[];
  // Unknown effects must be reconciled, never retried as an owned revision.
  if (rows.some(row => row.reconcile || row.outcome === 'uncertain_write')) return null;
  const last = rows.find(row => row.outcome === 'succeeded');
  if (!last) return null;
  const result = redeemSuccessfulSettlementResultForHost({ ...identity, acceptedTaskId: selection.contract.acceptedTaskId, logicalToolCallId: last.callId });
  if (result.status !== 'ok' || result.value.toolName !== 'write_file') return null;
  const facts = parseHostLocalWriteCommitFacts(result.value.rawPayload);
  if (!facts || !isLocalFileRevisionHandle(facts.handle)) return null;
  const current = readCommittedArtifactContent(facts);
  const target = targetFor(selection.step.staticArguments.path);
  if (!current.verified || current.parts.length !== 1 || current.parts[0]!.handle !== target) return null;
  return { ...selection, target, current: current.parts[0]!.bytes, last, facts };
}

export function canReviseReviewedFileStep(identity: Identity, stepId: string, producerId: string): boolean {
  const owned = ownedFile(identity, stepId);
  return owned !== null && owned.producer.id === producerId;
}

export function reviewedFileCorrection(identity: Identity, stepId: string): Correction | null {
  const owned = ownedFile(identity, stepId);
  if (!owned) return null;
  const row = openEventLog().prepare(`SELECT id,result_json,result_digest FROM reviewed_plan_step_results_v1
    WHERE session_id=? AND source_user_seq=? AND plan_digest=? AND step_id=? ORDER BY id DESC LIMIT 1`)
    .get(identity.sessionId, identity.sourceUserSeq, owned.execution.artifact.digest, owned.producer.id) as any;
  if (!row || hash(row.result_json) !== row.result_digest) return null;
  const value = resolveWorkTopologyJsonPointer(JSON.parse(row.result_json), owned.step.dynamicBindings[0].outputPath);
  if (!value.ok || typeof value.value !== 'string') return null;
  const content = value.value;
  if (owned.current.equals(Buffer.from(content.endsWith('\n') ? content : `${content}\n`))) return null;
  return { stepId, resultId: row.id, target: owned.target, content, priorCallId: owned.last.callId,
    priorReceiptDigest: owned.facts.contentDigest, expectedContentDigest: hash(owned.current) };
}

export function reviewedFileCorrectionForCall(identity: Identity, stepId: string, tool: string, args: unknown): Correction | null {
  const effective = unwrapRuntimeEffectiveToolIdentity(tool, args);
  if (effective.toolName !== 'write_file') return null;
  const correction = reviewedFileCorrection(identity, stepId);
  const actual = effective.args as any;
  if (!correction || actual?.content !== correction.content || actual?.mode !== 'overwrite' || actual?.append != null
    || typeof actual.path !== 'string' || targetFor(actual.path) !== correction.target) return null;
  return correction;
}

function store() {
  const db = openEventLog();
  db.exec(`CREATE TABLE IF NOT EXISTS reviewed_file_corrections_v1 (
    session_id TEXT NOT NULL, source_user_seq INTEGER NOT NULL, logical_tool_call_id TEXT NOT NULL,
    correction_json TEXT NOT NULL, PRIMARY KEY(session_id,source_user_seq,logical_tool_call_id))`);
  return db;
}

export function reviewedFileReplacements(identity: Identity, stepId: string): Map<string, string> {
  const db = openEventLog();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reviewed_file_corrections_v1'").get()) return new Map();
  const selection = selected(identity, stepId);
  if (!selection) return new Map();
  const rows = db.prepare(`SELECT c.correction_json, c.logical_tool_call_id AS callId FROM reviewed_file_corrections_v1 c
    JOIN expected_work_call_bindings b USING(session_id,source_user_seq,logical_tool_call_id)
    JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
    WHERE c.session_id=? AND c.source_user_seq=? AND b.requirement_id=? AND b.contract_id=?
      AND s.outcome_kind='succeeded' AND s.requires_reconciliation=0`)
    .all(identity.sessionId, identity.sourceUserSeq, stepId, selection.contract.contractId) as { correction_json: string; callId: string }[];
  const replacements = new Map<string, string>();
  for (const row of rows) {
    try {
      const correction = JSON.parse(row.correction_json) as Correction;
      if (correction.stepId !== stepId || correction.target !== targetFor(selection.step.staticArguments.path)) continue;
      const predecessor = db.prepare(`SELECT 1 FROM expected_work_call_bindings
        WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=? AND contract_id=? AND requirement_id=?`)
        .get(identity.sessionId, identity.sourceUserSeq, correction.priorCallId, selection.contract.contractId, stepId);
      const producer = db.prepare(`SELECT result_json,result_digest FROM reviewed_plan_step_results_v1
        WHERE id=? AND session_id=? AND source_user_seq=? AND plan_digest=? AND step_id=?`)
        .get(correction.resultId, identity.sessionId, identity.sourceUserSeq, selection.execution.artifact.digest, selection.producer.id) as any;
      if (!predecessor || !producer || hash(producer.result_json) !== producer.result_digest) continue;
      const value = resolveWorkTopologyJsonPointer(JSON.parse(producer.result_json), selection.step.dynamicBindings[0].outputPath);
      if (!value.ok || typeof value.value !== 'string' || value.value !== correction.content) continue;
      const facts = [correction.priorCallId, row.callId].map(logicalToolCallId => {
        const result = redeemSuccessfulSettlementResultForHost({ ...identity, acceptedTaskId: selection.contract.acceptedTaskId, logicalToolCallId });
        return result.status === 'ok' && result.value.toolName === 'write_file'
          ? parseHostLocalWriteCommitFacts(result.value.rawPayload) : null;
      });
      const [prior, next] = facts;
      if (!prior || !next || prior.contentDigest !== correction.priorReceiptDigest
        || !localFileRevisionReplaces({ prior, next, target: correction.target,
          expectedContentDigest: correction.expectedContentDigest, content: correction.content })) continue;
      if (replacements.has(correction.priorCallId)) return new Map();
      replacements.set(correction.priorCallId, row.callId);
    } catch { /* Incomplete/corrupt lineage never erases an obligation. */ }
  }
  return replacements;
}

export function supersededReviewedFileCalls(identity: Identity, stepId: string, observedCalls?: Set<string>): Set<string> {
  const replacements = reviewedFileReplacements(identity, stepId);
  return new Set([...replacements.keys()].filter(prior => {
    const visited = new Set<string>();
    let current = prior;
    while (replacements.has(current)) {
      if (visited.has(current)) return false;
      visited.add(current);
      current = replacements.get(current)!;
    }
    return current !== prior && (!observedCalls || observedCalls.has(current));
  }));
}

export function retainReviewedFileCorrection(identity: Identity & { logicalToolCallId: string }, correction: Correction): void {
  store().prepare('INSERT INTO reviewed_file_corrections_v1 VALUES (?,?,?,?)')
    .run(identity.sessionId, identity.sourceUserSeq, identity.logicalToolCallId, JSON.stringify(correction));
}

/** A readback observed an older output generation when a proven correction of
 * an upstream write settled after it. Preserve that observation as history,
 * but let the same reviewed read execute against the new generation. */
export function staleReviewedReadCalls(identity: Identity, stepId: string): Set<string> {
  const db = openEventLog();
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reviewed_file_corrections_v1'").get()) return new Set();
  const execution = acceptedPlanExecution(identity.sessionId, identity.sourceUserSeq);
  const steps = execution?.artifact.structuredPlan?.steps as any[] | undefined;
  const step = steps?.find(s => s.id === stepId);
  if (!step || step.effect !== 'read' || step.forEach) return new Set();
  const ancestors = new Set<string>();
  const visit = (node: any) => {
    for (const id of [...(node.dependsOn ?? []), ...(node.dynamicBindings ?? []).map((b: any) => b.producerStepId)]) {
      if (ancestors.has(id)) continue;
      ancestors.add(id);
      const parent = steps!.find(s => s.id === id);
      if (parent) visit(parent);
    }
  };
  visit(step);
  let generation = 0;
  for (const id of ancestors) {
    const replacements = reviewedFileReplacements(identity, id);
    if (!replacements.size) continue;
    const rows = db.prepare(`SELECT c.correction_json, c.logical_tool_call_id AS callId, s.rowid AS settledAt FROM reviewed_file_corrections_v1 c
      JOIN expected_work_call_bindings b USING(session_id,source_user_seq,logical_tool_call_id)
      JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
      WHERE c.session_id=? AND c.source_user_seq=? AND b.requirement_id=? AND s.outcome_kind='succeeded'`)
      .all(identity.sessionId, identity.sourceUserSeq, id) as { correction_json: string; callId: string; settledAt: number }[];
    for (const row of rows) {
      try { if (replacements.get(JSON.parse(row.correction_json).priorCallId) === row.callId) generation = Math.max(generation, row.settledAt); }
      catch { /* An invalid journal does not refresh reads. */ }
    }
  }
  if (!generation) return new Set();
  const contract = loadExpectedWorkContract(identity.sessionId, identity.sourceUserSeq);
  if (contract.status !== 'ok') return new Set();
  const rows = db.prepare(`SELECT b.logical_tool_call_id AS id FROM expected_work_call_bindings b
    JOIN logical_call_settlements s USING(session_id,source_user_seq,logical_tool_call_id)
    WHERE b.session_id=? AND b.source_user_seq=? AND b.contract_id=? AND b.requirement_id=?
      AND s.outcome_kind IN ('succeeded','empty_result') AND s.rowid < ?`)
    .all(identity.sessionId, identity.sourceUserSeq, contract.contract.contractId, stepId, generation) as { id: string }[];
  return new Set(rows.map(row => row.id));
}

export function reviewedFileCorrectionReservation(identity: Identity & { logicalToolCallId: string }, stepId: string, tool: string, args: unknown): string | null {
  const current = reviewedFileCorrectionForCall(identity, stepId, tool, args);
  if (!current) return null;
  const row = store().prepare('SELECT correction_json FROM reviewed_file_corrections_v1 WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
    .get(identity.sessionId, identity.sourceUserSeq, identity.logicalToolCallId) as { correction_json: string } | undefined;
  if (!row || row.correction_json !== JSON.stringify(current)) return null;
  return hash(JSON.stringify({ sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, stepId, resultId: current.resultId, priorCallId: current.priorCallId }));
}

export function retainedFileCorrectionReservation(identity: Identity & { logicalToolCallId: string }): string | null {
  const row = store().prepare('SELECT correction_json FROM reviewed_file_corrections_v1 WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
    .get(identity.sessionId, identity.sourceUserSeq, identity.logicalToolCallId) as { correction_json: string } | undefined;
  if (!row) return null;
  const correction = JSON.parse(row.correction_json) as Correction;
  return hash(JSON.stringify({ sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq, stepId: correction.stepId, resultId: correction.resultId, priorCallId: correction.priorCallId }));
}

/** The durable call binding selects this precondition; the model cannot supply
 * it. Check it again under the native file lock immediately before mutation. */
export function reviewedFileCorrectionPrecondition(identity: Identity & { logicalToolCallId: string }, input: { target: string; content: string; mode: string }): string | undefined {
  const row = store().prepare('SELECT correction_json FROM reviewed_file_corrections_v1 WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?')
    .get(identity.sessionId, identity.sourceUserSeq, identity.logicalToolCallId) as { correction_json: string } | undefined;
  if (!row) return undefined;
  const correction = JSON.parse(row.correction_json) as Correction;
  if (input.target !== correction.target || input.content !== correction.content || input.mode !== 'overwrite') throw new Error('The owned-file correction no longer matches its admitted call.');
  return correction.expectedContentDigest;
}
