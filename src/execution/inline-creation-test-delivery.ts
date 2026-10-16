/** Delivery only: retained results confer no execution or activation authority. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getEvent, getRunAttemptBySourceUserSeq, getToolOutputForInvocation, isKillRequested, listToolOutputInvocationNonces, openEventLog } from '../runtime/harness/eventlog.js';
import { harnessRunContextStorage } from '../runtime/harness/brackets.js';
import { currentDispatchLease, isDispatchLeaseCurrent, type DispatchLeaseRef } from '../runtime/harness/dispatch-lease.js';
import { isExecutionSourceBoundary } from '../runtime/harness/accepted-source-kind.js';
import { compactResultProvesExactToolOutput } from '../runtime/harness/exact-output-receipt.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { currentToolAbortDeadlineAt } from '../runtime/tool-abort-context.js';
import { withWorkflowRunRecordLock, readWorkflowRunRecordUnlocked, writeWorkflowRunRecordDurablyUnlocked } from './workflow-run-record.js';

export const INLINE_CREATION_TEST_WAIT_MS = 240_000;
export interface InlineCreationTestDeliveryIntent {
  version: 1; runId: string; originSessionId: string; sourceUserSeq: number;
  logicalToolCallId?: string; callId?: string; token: string; createdAt: string;
  expiresAt: string; ownerPid: number; lease: DispatchLeaseRef; releasedAt?: string;
}
interface InlineReceipt { runId: string; token: string; reportDigest: string }
export interface InlineCreationTestReturnMetadata {
  inlineCreationTestDelivery?: { version: 1; invocationNonce: string; outputSha256: string; ownerScopeId: string; ownerLeaseId: string; ownerAttemptId: string; receipts: InlineReceipt[] };
}
const SHA = /^[a-f0-9]{64}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/;
const MARKER = /\[clementine:inline-creation-test:v1\] (\{[^\r\n]*?\})/g;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const runFile = (id: string) => path.join(BASE_DIR, 'workflows', 'runs', `${id}.json`);

function intentOf(run: Record<string, unknown>): InlineCreationTestDeliveryIntent | null {
  const v = run.inlineCreationTestDelivery;
  if (!object(v) || v.version !== 1 || v.runId !== run.id || typeof v.runId !== 'string' || !RUN.test(v.runId)
    || typeof v.originSessionId !== 'string' || !v.originSessionId || !Number.isSafeInteger(v.sourceUserSeq) || Number(v.sourceUserSeq) <= 0
    || (v.logicalToolCallId !== undefined && (typeof v.logicalToolCallId !== 'string' || !v.logicalToolCallId))
    || v.callId !== v.logicalToolCallId
    || typeof v.token !== 'string' || !SHA.test(v.token) || typeof v.createdAt !== 'string' || typeof v.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(v.createdAt)) || !(Date.parse(v.expiresAt) > Date.parse(v.createdAt))
    || Date.parse(v.expiresAt) - Date.parse(v.createdAt) > INLINE_CREATION_TEST_WAIT_MS
    || !Number.isSafeInteger(v.ownerPid) || Number(v.ownerPid) <= 0 || !object(v.lease)
    || v.lease.sessionId !== v.originSessionId || (v.lease.sourceUserSeq !== undefined && v.lease.sourceUserSeq !== v.sourceUserSeq)
    || (v.logicalToolCallId !== undefined && (v.lease.logicalToolCallId !== v.logicalToolCallId || v.lease.sourceUserSeq !== v.sourceUserSeq)) || typeof v.lease.scopeId !== 'string' || !v.lease.scopeId
    || typeof v.lease.leaseId !== 'string' || !v.lease.leaseId || typeof v.lease.runAttemptId !== 'string' || !v.lease.runAttemptId
    || (v.releasedAt !== undefined && (typeof v.releasedAt !== 'string' || !Number.isFinite(Date.parse(v.releasedAt))))) return null;
  return v as unknown as InlineCreationTestDeliveryIntent;
}
function reportOf(run: Record<string, unknown>): { workflowName: string; outcome: string; detail: string } | null {
  const r = run.reportBack;
  if (!['creation_test', 'cancelled', 'error', 'failed', 'blocked'].includes(String(run.status)) || typeof run.finishedAt !== 'string' || !Number.isFinite(Date.parse(run.finishedAt))
    || !object(r) || r.version !== 1 || typeof r.workflowName !== 'string'
    || (run.status !== 'creation_test' && r.outcome === 'done')
    || !['done', 'blocked', 'failed'].includes(String(r.outcome)) || typeof r.detail !== 'string' || !r.detail.trim()) return null;
  return r as { workflowName: string; outcome: string; detail: string };
}
/** Same canonical content digest as workflowRunReportBackContentDigest; this
 * leaf avoids pulling queue/report-back modules into lifecycle hooks. */
function reportDigest(r: { workflowName: string; outcome: string; detail: string }): string {
  return createHash('sha256').update('clementine.workflow-run-report-back-content.v1\0')
    .update(JSON.stringify({ workflowName: r.workflowName, outcome: r.outcome, detail: r.detail })).digest('hex');
}
function readRun(id: string): Record<string, unknown> | null {
  if (!RUN.test(id)) return null;
  try { const r: unknown = JSON.parse(readFileSync(runFile(id), 'utf8')); return object(r) && r.id === id ? r : null; } catch { return null; }
}
function acceptedSourceIsCurrent(sessionId: string, sourceUserSeq: number): boolean {
  try {
    if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0 || isKillRequested(sessionId, { sourceUserSeq })) return false;
    const db = openEventLog();
    const source = db.prepare(`SELECT id FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received' AND role = 'user'`)
      .get(sessionId, sourceUserSeq) as { id: string } | undefined;
    const event = source && getEvent(source.id);
    if (!event || !isExecutionSourceBoundary(event)) return false;
    const attempt = getRunAttemptBySourceUserSeq(sessionId, sourceUserSeq);
    if (attempt && attempt.status !== 'active') return false;
    const newer = db.prepare(`SELECT id FROM events WHERE session_id = ? AND seq > ? AND type = 'user_input_received' ORDER BY seq`)
      .all(sessionId, sourceUserSeq) as Array<{ id: string }>;
    return !newer.some(row => {
      const next = getEvent(row.id);
      // Missing/corrupt candidates are not permission to retain an old owner.
      return !next || isExecutionSourceBoundary(next);
    });
  } catch { return false; }
}
function sourceIsCurrent(i: InlineCreationTestDeliveryIntent): boolean {
  const attempt = getRunAttemptBySourceUserSeq(i.originSessionId, i.sourceUserSeq);
  return Boolean(attempt && attempt.attemptId === i.lease.runAttemptId && acceptedSourceIsCurrent(i.originSessionId, i.sourceUserSeq));
}
/** Physical ownership is not call authority: MCP and standard SDK brackets
 * already carry a query lease, while host-owned calls carry a child lease. */
function ambientOwner(): DispatchLeaseRef | undefined {
  return harnessRunContextStorage.getStore()?.dispatchLease ?? currentDispatchLease();
}
function sameOwner(a: DispatchLeaseRef, b: DispatchLeaseRef): boolean {
  return a.sessionId === b.sessionId && a.scopeId === b.scopeId && a.leaseId === b.leaseId
    && typeof a.runAttemptId === 'string' && !!a.runAttemptId && a.runAttemptId === b.runAttemptId;
}
export function createInlineCreationTestDeliveryIntent(runId: string, originSessionId?: string): InlineCreationTestDeliveryIntent | undefined {
  const lease = ambientOwner(), context = getToolOutputContext(), harness = harnessRunContextStorage.getStore(), now = Date.now();
  const sourceUserSeq = context?.sourceUserSeq;
  const expires = Math.min(now + INLINE_CREATION_TEST_WAIT_MS, currentToolAbortDeadlineAt() ?? Infinity);
  if (!RUN.test(runId) || !lease?.runAttemptId || !originSessionId || !sourceUserSeq
    || lease.sessionId !== originSessionId || context?.sessionId !== originSessionId
    || (harness && (harness.sessionId !== originSessionId || harness.sourceUserSeq !== sourceUserSeq))
    || (lease.sourceUserSeq !== undefined && lease.sourceUserSeq !== sourceUserSeq)
    || !isDispatchLeaseCurrent(lease) || expires <= now) return undefined;
  // Only a genuinely call-bound physical lease supplies an original call fence.
  // Generated inner context ids are not the later outer recipient's identity.
  const callId = lease.sourceUserSeq === sourceUserSeq ? lease.logicalToolCallId : undefined;
  const i: InlineCreationTestDeliveryIntent = { version: 1, runId, originSessionId, sourceUserSeq,
    ...(callId ? { logicalToolCallId: callId, callId } : {}), token: hash(randomUUID()),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(), ownerPid: process.pid, lease: { ...lease } };
  return sourceIsCurrent(i) ? i : undefined;
}
export function releaseInlineCreationTestWait(runId: string): void {
  if (!RUN.test(runId)) return;
  try { withWorkflowRunRecordLock(runFile(runId), () => {
    const run = readWorkflowRunRecordUnlocked(runFile(runId)), lease = ambientOwner();
    const i = run && intentOf(run);
    if (!run || !i || i.releasedAt || !lease || lease.scopeId !== i.lease.scopeId || lease.leaseId !== i.lease.leaseId) return;
    writeWorkflowRunRecordDurablyUnlocked(runFile(runId), { ...run, inlineCreationTestDelivery: { ...i, releasedAt: new Date().toISOString() } });
  }); } catch { /* deadline/owner checks still release a failed waiter */ }
}
function marker(r: InlineReceipt): string { return `[clementine:inline-creation-test:v1] ${JSON.stringify(r)}`; }
function receipts(text: string): InlineReceipt[] {
  const found = new Map<string, InlineReceipt>();
  const pending: Array<{value: unknown; depth: number}> = [{value: text, depth: 0}]; let seen = 0;
  while (pending.length && ++seen < 4096) {
    const {value, depth} = pending.pop()!;
    if (typeof value === 'string') {
      for (const m of value.matchAll(MARKER)) try {
        const v: unknown = JSON.parse(m[1]!);
        if (!object(v) || Object.keys(v).sort().join(',') !== 'reportDigest,runId,token' || typeof v.runId !== 'string' || !RUN.test(v.runId)
          || typeof v.token !== 'string' || !SHA.test(v.token) || typeof v.reportDigest !== 'string' || !SHA.test(v.reportDigest)) continue;
        const r = v as unknown as InlineReceipt;
        if (marker(r) !== m[0]) continue;
        found.set(m[0], r); if (found.size > 8) return [];
      } catch { /* untrusted prose never mints a receipt */ }
      if (depth < 8) try { pending.push({value: JSON.parse(value), depth: depth + 1}); } catch { /* plain text */ }
    } else if (depth < 8 && (Array.isArray(value) || object(value))) for (const child of Object.values(value)) pending.push({value: child, depth: depth + 1});
  }
  return [...found.values()];
}
/** Normalize only the formal MCP text envelope; ordinary JSON payloads retain
 * their exact bytes. No arbitrary object field is treated as result text. */
function resultText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try { const parsed: unknown = JSON.parse(value); const normalized = mcpText(parsed); if (normalized !== undefined) return normalized; } catch { /* plain text */ }
    return value;
  }
  return mcpText(value) ?? JSON.stringify(value);
}
function mcpText(value: unknown): string | undefined {
  const blocks = object(value) && Array.isArray(value.content) ? value.content : undefined;
  if (!blocks || !blocks.length || !blocks.every(v => object(v) && v.type === 'text' && typeof v.text === 'string')) return undefined;
  return blocks.map(v => (v as {text: string}).text).join('\n');
}
/** Both report and opaque receipt must coexist in one text segment, including
 * ordinary nested MCP/carrier JSON. No fuzzy body/run-id matching. */
function carries(text: string, r: InlineReceipt, detail: string): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: text, depth: 0 }]; let seen = 0;
  while (pending.length && ++seen < 4096) {
    const { value, depth } = pending.pop()!;
    if (typeof value === 'string') {
      if (value.includes(marker(r)) && value.includes(detail.trim())) return true;
      if (depth < 8) try { pending.push({ value: JSON.parse(value), depth: depth + 1 }); } catch { /* plain text */ }
    } else if (depth < 8 && (Array.isArray(value) || object(value))) for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 });
  }
  return false;
}
export function inlineCreationTestReceiptForSettlement(settled: { runId: string; body: string }): string {
  const run = readRun(settled.runId), lease = ambientOwner(), context = getToolOutputContext(); const i = run && intentOf(run), report = run && reportOf(run);
  if (!i || !report || !lease || !sameOwner(lease, i.lease) || !isDispatchLeaseCurrent(lease)
    || context?.sessionId !== i.originSessionId || context.sourceUserSeq !== i.sourceUserSeq || i.releasedAt || Date.now() >= Date.parse(i.expiresAt)
    || !sourceIsCurrent(i) || settled.body.trim() !== report.detail.trim()) return '';
  return `${marker({ runId: i.runId, token: i.token, reportDigest: reportDigest(report) })}\n`;
}
/** Called only for an authoritative paired lifecycle result, after retention.
 * It seals the actual callback's report against one exact top-level nonce. */
export function inlineCreationTestReturnedMetadata(input: { sessionId: string; sourceUserSeq: number; callId: string; toolName: string; result: unknown; invocationNonce?: string; authoritativeReturn?: boolean; dispatchLease: DispatchLeaseRef }): InlineCreationTestReturnMetadata {
  try {
    if (input.authoritativeReturn !== true) return {};
    const actual = resultText(input.result);
    if (!actual || (!actual.includes('[clementine:inline-creation-test:v1]') && !actual.includes('[exact-output-receipt:v1'))) return {};
    // Ordinary tool replies do no source/kill or retained-output lookup.
    if (!input.dispatchLease?.runAttemptId || input.dispatchLease.sessionId !== input.sessionId
      || !isDispatchLeaseCurrent(input.dispatchLease) || !acceptedSourceIsCurrent(input.sessionId, input.sourceUserSeq)) return {};
    const nonces = input.invocationNonce ? [input.invocationNonce] : listToolOutputInvocationNonces(input.sessionId, input.callId, 2);
    const matching = nonces.flatMap(invocationNonce => {
      const parked = getToolOutputForInvocation(input.sessionId, input.callId, invocationNonce);
      if (!parked || parked.truncatedAtWrite || parked.tool !== input.toolName) return [];
      const exactText = resultText(parked.output);
      if (exactText === undefined) return [];
      if (exactText !== actual && !compactResultProvesExactToolOutput(actual, parked.output, invocationNonce)) return [];
      // A whole-payload frame must actually carry that whole payload. A compact
      // nonce/hash reference proves a retrievable result, not arbitrary prose.
      try {
        const frame: unknown = JSON.parse(actual);
        if (object(frame) && object(frame.__clementine) && frame.__clementine.kind === 'whole_inline_result_v1'
          && frame.providerPayload !== parked.output) return [];
      } catch { /* plain text or formal compact digest */ }
      const eligible = receipts(parked.output).filter(receipt => {
        const run = readRun(receipt.runId), intent = run && intentOf(run), report = run && reportOf(run);
        return intent && report && sameOwner(intent.lease, input.dispatchLease)
          && intent.originSessionId === input.sessionId && intent.sourceUserSeq === input.sourceUserSeq
          && (intent.callId === undefined || intent.callId === input.callId)
          && intent.token === receipt.token && reportDigest(report) === receipt.reportDigest
          && !intent.releasedAt && Date.now() < Date.parse(intent.expiresAt) && sourceIsCurrent(intent)
          && carries(parked.output, receipt, report.detail);
      });
      if (!eligible.length) return [];
      return [{ invocationNonce, outputSha256: hash(parked.output), receipts: eligible }];
    });
    if (matching.length !== 1) return {};
    return { inlineCreationTestDelivery: { version: 1, ownerScopeId: input.dispatchLease.scopeId, ownerLeaseId: input.dispatchLease.leaseId, ownerAttemptId: input.dispatchLease.runAttemptId, ...matching[0]! } };
  } catch { return {}; }
}
function acknowledged(run: Record<string, unknown>, i: InlineCreationTestDeliveryIntent): boolean {
  const report = reportOf(run); if (!report) return false; const digest = reportDigest(report);
  const rows = openEventLog().prepare(`SELECT id FROM events WHERE session_id = ? AND type = 'tool_returned'
    AND json_extract(data_json, '$.sourceUserSeq') = ? ORDER BY seq`)
    .all(i.originSessionId, i.sourceUserSeq) as Array<{ id: string }>;
  return rows.some(row => {
    const e = getEvent(row.id), d = e?.data, p = d?.inlineCreationTestDelivery;
    if (!e || !d || typeof d.callId !== 'string' || !d.callId || (i.callId !== undefined && d.callId !== i.callId)
      || d.accounting !== 'top_level' || d.ok === false || !e.parentEventId || !object(p) || p.version !== 1
      || p.ownerScopeId !== i.lease.scopeId || p.ownerLeaseId !== i.lease.leaseId || p.ownerAttemptId !== i.lease.runAttemptId
      || typeof p.invocationNonce !== 'string' || !p.invocationNonce || typeof p.outputSha256 !== 'string' || !SHA.test(p.outputSha256)
      || !Array.isArray(p.receipts) || Date.parse(e.createdAt) < Date.parse(i.createdAt) || Date.parse(e.createdAt) >= Date.parse(i.expiresAt)
      || (i.releasedAt && Date.parse(e.createdAt) >= Date.parse(i.releasedAt))) return false;
    const parent = getEvent(e.parentEventId);
    if (!parent || parent.sessionId !== e.sessionId || parent.type !== 'tool_called' || parent.seq >= e.seq
      || parent.data.sourceUserSeq !== i.sourceUserSeq || parent.data.callId !== d.callId || parent.data.tool !== d.tool
      || parent.data.accounting !== 'top_level' || (d.canonicalCallId !== undefined && d.canonicalCallId !== d.callId)) return false;
    if (!p.receipts.some(v => object(v) && v.runId === i.runId && v.token === i.token && v.reportDigest === digest)) return false;
    const parked = getToolOutputForInvocation(i.originSessionId, d.callId, p.invocationNonce);
    return Boolean(parked && !parked.truncatedAtWrite && parked.tool === d.tool && hash(parked.output) === p.outputSha256
      && carries(parked.output, { runId: i.runId, token: i.token, reportDigest: digest }, report.detail));
  });
}
export function inlineCreationTestOriginDisposition(run: Record<string, unknown>, originSessionId: string, now = Date.now()): 'acknowledged' | 'pending' | 'fallback' {
  try {
    const i = intentOf(run); if (!i || i.originSessionId !== originSessionId) return 'fallback';
    // Repair a timely retained delivery even after process death or expiry.
    if (acknowledged(run, i)) return 'acknowledged';
    if (i.releasedAt || now >= Date.parse(i.expiresAt) || !sourceIsCurrent(i)) return 'fallback';
    try { process.kill(i.ownerPid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return 'fallback'; }
    if (!isDispatchLeaseCurrent(i.lease) && (!i.logicalToolCallId || !openEventLog().prepare(`SELECT 1 FROM logical_call_settlements
      WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?`).get(i.originSessionId, i.sourceUserSeq, i.logicalToolCallId))) return 'fallback';
    return 'pending';
  } catch { return 'fallback'; }
}
let reconcile: ((runId: string) => void) | undefined;
export function registerInlineCreationTestDeliveryReconciler(callback: (runId: string) => void): void { reconcile = callback; }
export function notifyInlineCreationTestReturned(eventId: string): void {
  try { const p = getEvent(eventId)?.data.inlineCreationTestDelivery;
    if (object(p) && Array.isArray(p.receipts)) for (const v of p.receipts) if (object(v) && typeof v.runId === 'string' && RUN.test(v.runId)) reconcile?.(v.runId);
  } catch { /* ordinary drain repairs a missed nudge from the durable event */ }
}
