/** A bounded, content-minimal view of retained evidence for one accepted request.
 * This does not run tools, ask models, infer choice reasons or alter accounting. */
import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { TaskHandlingDetails } from '../types/task-handling.js';
import { BASE_DIR } from '../config.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { latestModelMemoryManifest } from '../runtime/harness/model-memory-evidence.js';
import { readAcceptedSourceUsage } from '../runtime/accepted-source-usage.js';
import { listRecallUses, readRecallRun } from '../memory/recall-usage.js';
import { openMemoryDb } from '../memory/db.js';
import { redactSensitiveText } from '../runtime/security.js';

const CAP = 100;
const clean = (value: unknown, max = 240): string | undefined => typeof value === 'string' && value.trim()
  ? redactSensitiveText(value.trim()).slice(0, max) : undefined;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const positive = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(item => clean(item) ?? []) : [];
type Row = { id: string; seq: number; type: string; created_at: string; data_json: string };

export function readTaskHandlingDetails(
  identity: { sessionId: string; sourceUserSeq: number },
  now = new Date(),
): TaskHandlingDetails | null {
  const { sessionId, sourceUserSeq } = identity;
  if (!sessionId || sessionId.length > 256 || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return null;
  const db = openEventLog();
  const accepted = db.prepare(`SELECT created_at FROM events WHERE session_id = ? AND seq = ?
    AND type = 'user_input_received' AND role = 'user'`).get(sessionId, sourceUserSeq) as { created_at: string } | undefined;
  if (!accepted) return null;
  const result: TaskHandlingDetails = {
    version: 1, ...identity, acceptedAt: accepted.created_at, observedAt: now.toISOString(), attemptIds: [], tools: [], models: [],
    usage: null, memory: { provided: null, recall: [] },
    limits: { toolsTruncated: false, modelsTruncated: false, memoryTruncated: false },
    limitations: ['This shows saved activity for this request. Choices without a saved explanation remain unknown.',
      'Usage covers this request. Other delegated work may be missing, and these are not billed charges.'],
  };
  const attemptIds = new Set<string>();
  const attempts = db.prepare(`SELECT attempt_id FROM run_attempts WHERE session_id = ? AND source_user_seq = ?
    ORDER BY started_at ASC LIMIT 101`).all(sessionId, sourceUserSeq) as Array<{ attempt_id: string }>;
  for (const row of attempts.slice(0, CAP)) if (clean(row.attempt_id)) attemptIds.add(clean(row.attempt_id)!);
  if (attempts.length > CAP) result.limitations.push('Only the first 100 recorded attempts are shown.');
  // Exact-source rows can settle after the next request starts; there is no
  // next-message/time-window ownership fallback here. SQL projects only the
  // fields needed by this view, never full tool arguments or tool output.
  function events(types: readonly string[], cap: number): Array<{ id: string; seq: number; type: string; at: string; data: Record<string, unknown> }> {
    const fields = ['sourceUserSeq', 'callId', 'canonicalCallId', 'attemptId', 'runAttemptId', 'dispatchLeaseId',
      'accounting', 'tool', 'effectiveTool', 'toolSlug', 'effect', 'ok', 'successful', 'success', 'failed',
      'providerDispatched', 'replayKind', 'strategyId', 'tools', 'nativeTools', 'ownerRule', 'recallId'];
    const projection = fields.flatMap(field => [`'${field}'`, `json_extract(data_json, '$.${field}')`]).join(', ');
    const calls = types.length === 1 && types[0] === 'tool_called';
    const inner = `SELECT id, seq, type, created_at, json_object(${projection}) AS data_json
      ${calls ? `, ROW_NUMBER() OVER (PARTITION BY
        COALESCE(json_extract(data_json, '$.canonicalCallId'), json_extract(data_json, '$.callId'), id),
        COALESCE(json_extract(data_json, '$.attemptId'), json_extract(data_json, '$.runAttemptId'), ''),
        COALESCE(json_extract(data_json, '$.dispatchLeaseId'), '') ORDER BY seq ASC) AS occurrence` : ''}
      FROM events WHERE session_id = ? AND seq > ? AND type IN (${types.map(() => '?').join(',')})
      AND json_valid(data_json) AND json_extract(data_json, '$.sourceUserSeq') = ?
      ${calls ? `AND COALESCE(json_extract(data_json, '$.accounting'), '') != 'transport_mirror'` : ''}`;
    const rows = db.prepare(`SELECT id, seq, type, created_at, data_json FROM (${inner})
      ${calls ? 'WHERE occurrence = 1' : ''} ORDER BY seq ASC LIMIT ?`)
      .all(sessionId, sourceUserSeq, ...types, sourceUserSeq, cap) as Row[];
    return rows.map(row => ({ id: row.id, seq: row.seq, type: row.type, at: row.created_at, data: object(JSON.parse(row.data_json)) }));
  }
  const selected = events(['proven_operation_selected'], CAP + 1);
  const starts = events(['tool_called'], CAP + 1);
  result.limits.toolsTruncated = starts.length > CAP;
  const physical = db.prepare(`SELECT logical_tool_call_id, tool_name, lease_id FROM physical_dispatches
    WHERE session_id = ? AND source_user_seq = ? ORDER BY started_at ASC LIMIT 1001`)
    .all(sessionId, sourceUserSeq) as Array<{ logical_tool_call_id: string; tool_name: string; lease_id: string | null }>;
  if (physical.length > 1000) result.limitations.push('Only the first 1000 physical dispatch records were checked.');
  // Returns are looked up per bounded call, so a large output or adjacent task
  // never needs to be loaded merely to report that the call returned.
  for (const call of starts.slice(0, CAP)) {
    const data = call.data;
    if (data.accounting === 'transport_mirror') continue;
    const callId = clean(data.canonicalCallId) ?? clean(data.callId);
    const name = clean(data.effectiveTool) ?? clean(data.toolSlug) ?? clean(data.tool);
    if (!callId || !name) continue;
    const attemptId = clean(data.attemptId) ?? clean(data.runAttemptId);
    if (attemptId) attemptIds.add(attemptId);
    const returned = db.prepare(`SELECT created_at, json_object(
      'ok', json_extract(data_json, '$.ok'), 'successful', json_extract(data_json, '$.successful'),
      'success', json_extract(data_json, '$.success'), 'failed', json_extract(data_json, '$.failed'),
      'providerDispatched', json_extract(data_json, '$.providerDispatched'), 'replayKind', json_extract(data_json, '$.replayKind')) AS data_json
      FROM events WHERE session_id = ? AND type = 'tool_returned' AND seq > ? AND json_valid(data_json)
      AND json_extract(data_json, '$.sourceUserSeq') = ? AND json_extract(data_json, '$.callId') = ?
      AND parent_event_id = ? AND COALESCE(json_extract(data_json, '$.accounting'), '') != 'transport_mirror'
      AND COALESCE(json_extract(data_json, '$.dispatchLeaseId'), '') = ?
      AND COALESCE(json_extract(data_json, '$.attemptId'), json_extract(data_json, '$.runAttemptId'), '') = ?
      ORDER BY seq ASC LIMIT 1`).get(sessionId, call.seq, sourceUserSeq, clean(data.callId) ?? callId, call.id,
        clean(data.dispatchLeaseId) ?? '', attemptId ?? '') as { created_at: string; data_json: string } | undefined;
    const output = returned ? object(JSON.parse(returned.data_json)) : {};
    const failed = output.ok === 0 || output.successful === 0 || output.success === 0 || output.failed === 1;
    const replayed = output.providerDispatched === 0 && Boolean(clean(output.replayKind));
    const crossings = physical.slice(0, 1000).filter(row => row.logical_tool_call_id === callId && row.tool_name === name
      && (clean(data.dispatchLeaseId) ? row.lease_id === clean(data.dispatchLeaseId) : !attemptId && !row.lease_id));
    const selection = [...selected].reverse().find(row => row.seq < call.seq
      && [...strings(row.data.tools), ...strings(row.data.nativeTools)].includes(name));
    const rule = object(selection?.data.ownerRule);
    const ruleFact = strings(selection?.data.tools)[0] === name ? positive(rule.factId) : undefined;
    const ruleText = clean(rule.text, 600);
    const item: TaskHandlingDetails['tools'][number] = { callId, eventSeq: call.seq, name,
      ...(attemptId ? { attemptId } : {}), status: !returned ? 'started' : failed ? 'failed' : replayed ? 'reused' : 'returned',
      dispatchEvidence: replayed ? 'reused' : crossings.length ? 'physical' : 'lifecycle',
      ...(crossings.length ? { physicalDispatches: crossings.length } : {}),
      ...(clean(data.effect) ? { effect: clean(data.effect) } : {}), startedAt: call.at,
      ...(returned ? { finishedAt: returned.created_at } : {}) };
    if (selection) item.selection = {
      kind: ruleFact && ruleText ? 'owner_preference' : 'prepared_approach',
      ...(clean(selection.data.strategyId) ? { strategyId: clean(selection.data.strategyId) } : {}),
      ...(ruleFact && ruleText ? { factId: ruleFact, text: ruleText } : {}),
    };
    result.tools.push(item);
  }
  if (result.tools.some(tool => tool.status === 'returned')) result.limitations.push('A tool returning does not by itself prove the requested business outcome.');
  if (result.tools.some(tool => tool.dispatchEvidence === 'lifecycle')) result.limitations.push('Some tool calls were recorded without separate confirmation that the connected service ran them.');
  if (selected.length > CAP) result.limitations.push('Some older selection records are outside this bounded view.');
  try {
    const usage = readAcceptedSourceUsage(identity);
    if (usage) result.usage = { scope: 'accepted_source', meteringStartedAt: usage.meteringStartedAt,
      sourcePredatesMetering: usage.sourcePredatesMetering, totals: usage.totals, byRole: usage.byRole };
    if (usage?.sourcePredatesMetering) result.limitations.push('This request predates the current usage meter; earlier calls may be missing.');
    if (usage?.totals.uncertifiedCalls) result.limitations.push('Some calls did not report how cached tokens were counted.');
    if (usage?.totals.unknownCostCalls) result.limitations.push('Some failed calls reported no usage; their cost is unknown, not zero.');
  } catch { result.limitations.push('Recorded usage is unavailable.'); }
  try {
    const manifest = latestModelMemoryManifest(sessionId, sourceUserSeq);
    if (manifest) {
      const sections = Array.isArray(manifest.manifest) ? manifest.manifest : [];
      if (sections.length > CAP) result.limits.memoryTruncated = true;
      const projected = sections.slice(0, CAP).flatMap(section => {
        const entry = object(section);
        const name = clean(entry.section, 100);
        const tier = entry.tier;
        if (!name || !['core', 'relevant', 'now'].includes(String(tier))
          || typeof entry.tokens !== 'number' || !Number.isFinite(entry.tokens) || entry.tokens < 0
          || typeof entry.bytes !== 'number' || !Number.isFinite(entry.bytes) || entry.bytes < 0) return [];
        const refs = Array.isArray(entry.refs) ? entry.refs : [];
        if (refs.length > CAP) result.limits.memoryTruncated = true;
        return [{ section: name, tier: tier as 'core' | 'relevant' | 'now', tokens: entry.tokens, bytes: entry.bytes,
          refs: refs.slice(0, CAP).flatMap(value => {
            const ref = object(value), type = clean(ref.type, 40), id = clean(ref.id);
            return type && id ? [{ type, id }] : [];
          }) }];
      });
      const totals = manifest.totals;
      const validTotals = totals && ['tokens', 'bytes', 'coreTokens', 'relevantTokens', 'nowTokens'].every(key => {
        const value = (totals as unknown as Record<string, unknown>)[key];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0;
      });
      result.memory.provided = { recordedAt: manifest.recordedAt, sourceUserSeq,
        ...(validTotals ? { totals: { tokens: totals.tokens, bytes: totals.bytes, coreTokens: totals.coreTokens, relevantTokens: totals.relevantTokens, nowTokens: totals.nowTokens } } : {}), manifest: projected };
      if (projected.length !== Math.min(CAP, sections.length)) result.limitations.push('Some saved memory details could not be verified.');
    }
  } catch { result.limitations.push('The retained memory manifest could not be verified.'); }
  const primers = events(['turn_memory_primer'], 21);
  result.limits.memoryTruncated ||= primers.length > 20;
  const seenRecall = new Set<string>();
  for (const primer of primers.slice(0, 20)) {
    const id = clean(primer.data.recallId);
    if (!id || seenRecall.has(id)) continue;
    seenRecall.add(id);
    try {
      const owned = openMemoryDb().prepare('SELECT id FROM memory_recall_runs WHERE id = ? AND session_id = ?').get(id, sessionId);
      if (!owned) continue;
      const run = readRecallRun(id, now.toISOString());
      if (!run) continue;
      const uses = new Map(listRecallUses(id).map(use => [`${use.type}:${use.id}`, use.outcome]));
      result.memory.recall.push({ id, surface: clean(run.surface) ?? 'memory', createdAt: run.createdAt,
        refs: run.candidateRefs.slice(0, CAP).map(ref => ({ type: ref.type, id: ref.id,
          ...(clean(ref.snippet, 240) ? { text: clean(ref.snippet, 240) } : {}),
          outcome: uses.get(`${ref.type}:${ref.id}`) ?? 'offered' })) });
      if (run.candidateRefs.length > CAP) result.limits.memoryTruncated = true;
    } catch { result.limitations.push('A retained recall record is unavailable.'); }
  }
  if (result.memory.provided || result.memory.recall.length) result.limitations.push('Memory made available and detected recall use do not prove why a tool or model was chosen.');
  readModels(result, attemptIds, accepted.created_at, now);
  result.attemptIds = [...attemptIds];
  return result;
}

function readModels(result: TaskHandlingDetails, attempts: Set<string>, acceptedAt: string, now: Date): void {
  const file = path.join(BASE_DIR, 'state', 'model-route-metrics.db');
  if (!existsSync(file)) { result.limitations.push('Model details are unavailable; usage by role may still be recorded.'); return; }
  let db: Database.Database | undefined;
  try {
    // Read-only, no schema initialization or metrics writes on UI expansion.
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`SELECT d.id, d.role, d.provider, d.requested_model, d.resolved_model,
      json_extract(d.reason_json, '$.runAttemptId') AS attempt_id,
      o.status, o.latency_ms, o.fallover_to_model,
      CASE WHEN json_valid(o.metadata_json) THEN json_extract(o.metadata_json, '$.responseCompleted') END AS response_completed,
      CASE WHEN json_valid(o.metadata_json) THEN json_extract(o.metadata_json, '$.actualModel') END AS actual_model,
      CASE WHEN json_valid(o.metadata_json) THEN json_extract(o.metadata_json, '$.actualProvider') END AS actual_provider,
      CASE WHEN json_valid(o.metadata_json) THEN json_extract(o.metadata_json, '$.providerReportedModel') END AS provider_reported_model
      FROM model_route_decisions d LEFT JOIN model_route_outcomes o ON o.decision_id = d.id
      WHERE d.session_id = ? AND d.created_at >= ? AND d.created_at <= ? AND json_valid(d.reason_json)
      AND json_extract(d.reason_json, '$.sourceUserSeq') = ? ORDER BY d.created_at DESC, d.id DESC LIMIT 101`)
      .all(result.sessionId, acceptedAt, now.toISOString(), result.sourceUserSeq) as Array<Record<string, unknown>>;
    result.limits.modelsTruncated = rows.length > CAP;
    result.models = rows.slice(0, CAP).reverse().flatMap(row => {
      const callId = clean(row.id), model = clean(row.resolved_model), role = clean(row.role), provider = clean(row.provider);
      if (!callId || !model || !role || !provider) return [];
      const attemptId = clean(row.attempt_id);
      if (attemptId) attempts.add(attemptId);
      const status = ['success', 'failed', 'fallback', 'cancelled'].includes(String(row.status))
        ? row.status as 'success' | 'failed' | 'fallback' | 'cancelled' : 'started';
      const responseCompleted = row.response_completed === 1 && (status === 'success' || status === 'fallback');
      return [{ callId, role, provider, resolvedModel: model, status, responseCompleted,
        ...(clean(row.requested_model) ? { requestedModel: clean(row.requested_model) } : {}),
        ...(responseCompleted && clean(row.actual_model) ? { servedModel: clean(row.actual_model) } : {}),
        ...(responseCompleted && clean(row.actual_provider) ? { servedProvider: clean(row.actual_provider) } : {}),
        ...(responseCompleted && clean(row.provider_reported_model) ? { providerReportedModel: clean(row.provider_reported_model) } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(clean(row.fallover_to_model) ? { fallbackToModel: clean(row.fallover_to_model) } : {}),
        ...(typeof row.latency_ms === 'number' && row.latency_ms >= 0 ? { durationMs: row.latency_ms } : {}),
      }];
    });
    result.limitations.push('Model details cover recorded calls and may omit some helpers. Token totals come from the separate request meter.');
  } catch { result.limitations.push('Model details could not be read.'); }
  finally { db?.close(); }
}
