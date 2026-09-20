/** Read-only audit of the owner's event and usage ledgers. No runtime imports,
 * migrations, credentials, model calls, or writes to the Clementine home.
 * node --import tsx scripts/audit-live-harness.mts --since 2026-09-12 --until 2026-09-20
 * Dates are UTC, with an exclusive upper bound. Output contains identifiers
 * and totals, never prompts, memory contents, or tool payloads. */
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[index + 1];
}
const home = option('--home', path.join(os.homedir(), '.clementine-next'));
const since = option('--since', '2026-09-12');
const until = option('--until', '2026-09-20');
for (const date of [since, until]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Use YYYY-MM-DD dates');
}
if (since >= until) throw new Error('--until must be after --since');
const db = new Database(path.join(home, 'state/harness.db'), { readonly: true, fileMustExist: true });
const memory = new Database(path.join(home, 'state/memory.db'), { readonly: true, fileMustExist: true });
type Row = Record<string, any>;
const parse = (text: string): Row | null => { try { return JSON.parse(text); } catch { return null; } };
const events = db.prepare(`SELECT seq, session_id, type, data_json, created_at FROM events
  WHERE created_at >= ? AND created_at < ? AND type IN
  ('user_input_received','user_steer_note','conversation_completed','goal_alignment_judged',
   'plan_revision_published','plan_execution_claimed') ORDER BY seq`).all(since, until) as Row[];
const counts: Record<string, number> = {};
const outcomes = new Map<string, Row>();
const lastJudged = new Map<string, Row>();
const carried: Row[] = [];
for (const event of events) {
  counts[event.type] = (counts[event.type] ?? 0) + 1;
  const data = parse(event.data_json);
  if (!data) continue;
  const seq = data.sourceUserSeq ?? data.presentation?.identity?.sourceUserSeq;
  if (!seq) continue;
  const key = `${event.session_id}:${seq}`;
  if (event.type === 'conversation_completed') outcomes.set(key, {
    reason: data.reason ?? null, delivered: data.delivered ?? null,
    verificationDetail: data.verificationDetail ?? null,
  });
  if (event.type === 'goal_alignment_judged' && data.kind === 'completion') {
    const previous = lastJudged.get(key);
    if (data.carriedVerdict) carried.push({ acceptedSource: key, verdictSeq: event.seq,
      previousVerdictSeq: previous?.seq ?? null,
      changedReply: previous?.replyDigest && data.replyDigest ? previous.replyDigest !== data.replyDigest : null });
    lastJudged.set(key, { seq: event.seq, replyDigest: data.replyDigest,
      fulfills: data.fulfills, carried: data.carriedVerdict === true, blocked: data.blocked === true,
      failedOpen: data.failedOpen === true });
  }
}
const groups = new Map<string, Row>();
const seen = new Set<string>();
let malformedRows = 0;
let uncertifiedRows = 0;
let unattributedRows = 0;
let duplicates = 0;
const usageDir = path.join(home, 'state/token-usage');
for (const filename of readdirSync(usageDir).sort()) {
  if (!filename.endsWith('.ndjson') || filename.slice(0, 10) < since || filename.slice(0, 10) >= until) continue;
  for (const line of readFileSync(path.join(usageDir, filename), 'utf8').split('\n').filter(Boolean)) {
    const row = parse(line);
    if (!row) { malformedRows++; continue; }
    const id = row.responseId ?? row.trace?.modelCallId;
    if (id) {
      const key = `${row.source}:${id}`;
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
    }
    const source = row.trace?.acceptedSource;
    if (!source) unattributedRows++;
    const key = source ?? `unattributed:${row.source}`;
    let group = groups.get(key);
    if (!group) {
      group = { acceptedSource: source ?? null, source: row.source, kind: row.kind ?? 'unknown',
        calls: 0, certifiedCalls: 0, promptTokens: 0, cachedReadTokens: 0, uncachedWorkTokens: 0,
        outputTokens: 0, models: {}, firstAt: row.at, lastAt: row.at };
      groups.set(key, group);
    }
    group.calls++;
    group.outputTokens += row.outputTokens ?? 0;
    group.models[row.model] = (group.models[row.model] ?? 0) + 1;
    if (row.at < group.firstAt) group.firstAt = row.at;
    if (row.at > group.lastAt) group.lastAt = row.at;
    // Do not invent comparable totals from unknown provider dialects.
    if (row.canonical?.certified === true) {
      group.certifiedCalls++;
      group.promptTokens += row.canonical.promptTokens;
      group.cachedReadTokens += row.canonical.cachedReadTokens;
      group.uncachedWorkTokens += row.canonical.uncachedWorkTokens;
    } else uncertifiedRows++;
  }
}
const turns = [...groups.entries()].map(([key, group]) => ({ ...group,
  allRowsCertified: group.calls === group.certifiedCalls,
  sourceAttributed: !!group.acceptedSource,
  verdict: lastJudged.get(key) ?? null, completion: outcomes.get(key) ?? null,
})).sort((a, b) => b.uncachedWorkTokens - a.uncachedWorkTokens);
const report = {
  since, until, generatedAt: new Date().toISOString(), counts,
  accounting: { usageRows: turns.reduce((n, t) => n + t.calls, 0), duplicates, malformedRows, uncertifiedRows, unattributedRows,
    note: 'Token totals include only certified rows. Certification does not prove that unattributed side calls are included. Usage date range may cut across a running task. Verdicts are recorded assertions, not independently verified task quality.' },
  carriedVerdicts: carried,
  pinnedMemory: memory.prepare(`SELECT kind, count(*) AS facts, sum(length(content)) AS chars
    FROM consolidated_facts WHERE active=1 AND pinned=1 GROUP BY kind`).all(),
  turns,
};
db.close();
memory.close();
console.log(JSON.stringify(report, null, 2));
