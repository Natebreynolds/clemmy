#!/usr/bin/env node
/**
 * Measure one accepted turn on the live home the way the owner reads it:
 * wall time, frames by explicit role, uncached tokens, total and largest
 * prompt, output, repair calls — not cache percentage alone.
 *
 *   node scripts/measure-source-turn.mjs <sessionId> <sourceUserSeq> [--home DIR]
 *
 * Reads state/token-usage/*.ndjson (rows joined by trace.acceptedSource) and
 * the eventlog through `?mode=ro` (the WAL is visible; `immutable=1` is not).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [sessionId, seqArg, ...rest] = process.argv.slice(2);
if (!sessionId || !seqArg) {
  console.error('usage: measure-source-turn.mjs <sessionId> <sourceUserSeq> [--home DIR]');
  process.exit(2);
}
const seq = Number(seqArg);
const homeFlag = rest.indexOf('--home');
const home = homeFlag >= 0 ? rest[homeFlag + 1] : (process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next'));
const accepted = `${sessionId}:${seq}`;

const usageDir = path.join(home, 'state', 'token-usage');
const rows = [];
for (const file of readdirSync(usageDir).filter((f) => f.endsWith('.ndjson')).sort().slice(-3)) {
  for (const line of readFileSync(path.join(usageDir, file), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.trace?.acceptedSource === accepted) rows.push(row);
    } catch { /* skip */ }
  }
}
rows.sort((a, b) => a.at.localeCompare(b.at));

const db = `file:${path.join(home, 'state', 'harness.db')}?mode=ro`;
const sql = (q) => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, q], { maxBuffer: 1 << 28 }).toString() || '[]');
const events = sql(`select seq, type, created_at, substr(data_json,1,600) as d from events where session_id='${sessionId.replace(/'/g, "''")}' and seq >= ${seq} and (type in ('user_input_received','conversation_completed','run_completed','tool_called','guardrail_tripped','approval_requested') ) and (json_extract(data_json,'$.sourceUserSeq') = ${seq} or seq = ${seq} or type in ('conversation_completed','run_completed','approval_requested')) order by seq`);
const started = events.find((e) => e.seq === seq)?.created_at;
const completed = events.find((e) => e.type === 'conversation_completed' && e.seq > seq)?.created_at
  ?? events.find((e) => e.type === 'run_completed' && e.seq > seq)?.created_at;
const wallMs = started && completed ? Date.parse(completed) - Date.parse(started) : null;

const byRole = {};
let totalPrompt = 0; let maxPrompt = 0; let uncached = 0; let output = 0; let modelMs = 0;
for (const r of rows) {
  const role = r.role ?? '(unset)';
  const canon = r.canonical ?? {};
  const prompt = canon.promptTokens ?? r.inputTokens ?? 0;
  const unc = canon.uncachedInputTokens ?? Math.max(0, (r.inputTokens ?? 0) - (r.cachedInputTokens ?? 0));
  const b = byRole[role] ?? (byRole[role] = { frames: 0, prompt: 0, uncached: 0, output: 0, ms: 0, models: new Set() });
  b.frames += 1; b.prompt += prompt; b.uncached += unc; b.output += r.outputTokens ?? 0; b.ms += r.durationMs ?? 0; b.models.add(r.model);
  totalPrompt += prompt; maxPrompt = Math.max(maxPrompt, prompt); uncached += unc; output += r.outputTokens ?? 0; modelMs += r.durationMs ?? 0;
}
const repairKinds = ['refused_pre_dispatch', 'recovery_surface_reprompt', 'tool_call_guardrail', 'schema_invalid', 'invalid_arguments', 'no_progress_check_in'];
const repairs = {};
let toolCalls = 0; let approvals = 0; let retries = 0;
for (const e of events) {
  let d = {}; try { d = JSON.parse(e.d); } catch { /* truncated */ }
  if (e.type === 'tool_called' && d.accounting === 'top_level') toolCalls += 1;
  if (e.type === 'approval_requested') approvals += 1;
  if (e.type === 'guardrail_tripped') {
    const k = String(d.kind ?? '');
    if (repairKinds.includes(k)) repairs[k] = (repairs[k] ?? 0) + 1;
    if (k === 'no_progress_decision' && d.reason === 'retry_available') retries += 1;
  }
}
const out = {
  acceptedSource: accepted,
  wallSeconds: wallMs === null ? null : Math.round(wallMs / 100) / 10,
  frames: rows.length,
  modelSeconds: Math.round(modelMs / 100) / 10,
  totalPromptTokens: totalPrompt,
  largestPromptTokens: maxPrompt,
  uncachedTokens: uncached,
  outputTokens: output,
  toolCalls,
  approvalsRequested: approvals,
  repairCalls: Object.values(repairs).reduce((s, n) => s + n, 0),
  repairsByKind: repairs,
  retryDecisions: retries,
  byRole: Object.fromEntries(Object.entries(byRole).map(([k, v]) => [k, { ...v, models: [...v.models] }])),
};
console.log(JSON.stringify(out, null, 2));
