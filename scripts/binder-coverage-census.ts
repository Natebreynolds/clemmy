/**
 * Binder Coverage Census — how many compiled turn graphs actually BIND?
 *
 * The acceptance instrument for retiring the legacy loops. Measured 2026-08-21:
 * across all 467 `turn_graph_compiled` events on a live install, exactly ONE
 * carried a node with an `operationId` or `capabilityRole`. 429 were act/retrieve
 * with nothing bound — under `dispatchAdmittedSource` those become
 * `unboundConstructStop`, a user-visible BLOCKED turn, not a silent fallthrough.
 *
 * The shadow compiler already runs on every turn, so this census answers the
 * only question that matters for the tag — "would typed execution have carried
 * this traffic?" — at zero user risk, from evidence rather than from reading the
 * code. Deleting a legacy loop is gated on the BOUND number, never on judgment.
 *
 * Buckets mirror the live dispatch decision in typed-source-dispatch.ts:
 *   bound              → has an executable node; typed execution runs
 *   unbound_act        → route act|retrieve, nothing bound → HARD BLOCK today
 *   unbound_reply      → direct_reply, nothing bound → falls to conversation
 *
 * Run: npx tsx scripts/binder-coverage-census.ts [--since 2026-08-01] [--json]
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';

interface Bucket {
  bound: number;
  unboundAct: number;
  unboundReply: number;
}

interface CensusRow {
  route: string;
  construct: string;
  total: number;
  bound: number;
}

/** The ledger this install writes to. CLEMENTINE_HOME wins so a test home is measurable. */
function harnessDbPath(): string {
  const base = process.env.CLEMENTINE_HOME
    || path.join(os.homedir(), '.clementine-next');
  return path.join(base, 'state', 'harness.db');
}

/**
 * The same predicate the dispatcher uses. Kept as a local copy on purpose: the
 * census must measure what production DECIDES, so if the dispatcher's rule ever
 * changes this file has to change with it deliberately, not silently inherit.
 */
function hasExecutableOperations(graph: unknown): boolean {
  const nodes = (graph as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((node) => {
    const n = node as { operationId?: unknown; capabilityRole?: unknown };
    return Boolean(n?.operationId || n?.capabilityRole);
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const sinceIndex = args.indexOf('--since');
  const since = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;

  const dbPath = harnessDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`no harness ledger at ${dbPath} — nothing to measure`);
    process.exit(2);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    since
      ? `SELECT created_at, data_json FROM events
           WHERE type = 'turn_graph_compiled' AND created_at >= ? ORDER BY seq`
      : `SELECT created_at, data_json FROM events
           WHERE type = 'turn_graph_compiled' ORDER BY seq`,
  ).all(...(since ? [since] : [])) as Array<{ created_at: string; data_json: string }>;

  const totals: Bucket = { bound: 0, unboundAct: 0, unboundReply: 0 };
  const byRoute = new Map<string, CensusRow>();

  for (const row of rows) {
    let payload: { graph?: unknown; route?: unknown };
    try { payload = JSON.parse(row.data_json); } catch { continue; }
    const graph = payload.graph as {
      classification?: { route?: string; goalConstraints?: { construct?: string } };
    } | undefined;
    const route = graph?.classification?.route ?? String(payload.route ?? 'unknown');
    const construct = graph?.classification?.goalConstraints?.construct ?? 'none';

    const bound = hasExecutableOperations(payload.graph);
    if (bound) totals.bound += 1;
    else if (route === 'act' || route === 'retrieve') totals.unboundAct += 1;
    else totals.unboundReply += 1;

    const key = `${route}/${construct}`;
    const entry = byRoute.get(key) ?? { route, construct, total: 0, bound: 0 };
    entry.total += 1;
    if (bound) entry.bound += 1;
    byRoute.set(key, entry);
  }

  const total = rows.length;
  const bindRate = total ? (totals.bound / total) * 100 : 0;
  const blockRate = total ? (totals.unboundAct / total) * 100 : 0;

  if (asJson) {
    console.log(JSON.stringify({
      dbPath, since: since ?? null, total, ...totals, bindRate, blockRate,
      buckets: [...byRoute.values()].sort((a, b) => b.total - a.total),
    }, null, 2));
    return;
  }

  console.log(`BINDER COVERAGE CENSUS  (${dbPath})`);
  console.log(`${since ? `since ${since}` : 'all time'} — ${total} compiled turn graphs\n`);
  console.log(`  BOUND (typed execution runs)      ${String(totals.bound).padStart(5)}  ${bindRate.toFixed(1)}%`);
  console.log(`  UNBOUND act/retrieve (HARD BLOCK) ${String(totals.unboundAct).padStart(5)}  ${blockRate.toFixed(1)}%`);
  console.log(`  UNBOUND direct_reply (converses)  ${String(totals.unboundReply).padStart(5)}`);
  console.log('\n  route/construct                      total   bound');
  for (const entry of [...byRoute.values()].sort((a, b) => b.total - a.total)) {
    const label = `${entry.route}/${entry.construct}`.padEnd(34);
    console.log(`  ${label} ${String(entry.total).padStart(5)}   ${String(entry.bound).padStart(5)}`);
  }
  console.log('\nThe legacy loops may be retired when BOUND carries the act/retrieve traffic.');
  console.log('Until then, unbound act/retrieve is what the legacy loop is still absorbing.');

  reportCeremonyCost(db, since);
}

/**
 * What a turn spends BEFORE it does anything.
 *
 * Bind rate says whether the kernel could carry the work; this says what the
 * user waited through either way. It is the number that made "lighter and
 * better" concrete: a calendar read that answered correctly still spent ~43s
 * of the 64 before its first tool call — capability resolution, a semantic
 * interpretation, then two MORE capability resolutions.
 *
 * Derived entirely from `created_at` deltas on events the ledger already
 * carries, so it needs no new instrumentation and can be run against any
 * install, including one recorded before this script existed.
 */
function reportCeremonyCost(db: Database.Database, since?: string): void {
  const rows = db.prepare(
    `SELECT session_id, turn, type, created_at
       FROM events
      WHERE type IN ('user_input_received','tool_called','conversation_completed')
        ${since ? 'AND created_at >= ?' : ''}
      ORDER BY seq`,
  ).all(...(since ? [since] : [])) as Array<{
    session_id: string; turn: number; type: string; created_at: string;
  }>;

  interface Turn { startedAt: number; firstTool?: number; finishedAt?: number }
  const turns = new Map<string, Turn>();
  for (const row of rows) {
    const key = `${row.session_id}#${row.turn}`;
    const at = Date.parse(row.created_at);
    if (Number.isNaN(at)) continue;
    if (row.type === 'user_input_received') {
      // A retry reuses the turn number; the latest acceptance is the one whose
      // wait the user actually experienced.
      turns.set(key, { startedAt: at });
      continue;
    }
    const turn = turns.get(key);
    if (!turn) continue;
    if (row.type === 'tool_called') turn.firstTool ??= at;
    else turn.finishedAt ??= at;
  }

  const ceremony: number[] = [];
  const total: number[] = [];
  for (const turn of turns.values()) {
    if (turn.firstTool !== undefined && turn.firstTool >= turn.startedAt) {
      ceremony.push(turn.firstTool - turn.startedAt);
    }
    if (turn.finishedAt !== undefined && turn.finishedAt >= turn.startedAt) {
      total.push(turn.finishedAt - turn.startedAt);
    }
  }
  if (ceremony.length === 0 && total.length === 0) return;

  const at = (values: number[], q: number): string => {
    if (values.length === 0) return '—';
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return `${(sorted[index]! / 1000).toFixed(1)}s`;
  };

  console.log(`\nTURN COST — ${turns.size} accepted turns`);
  console.log(`  time to FIRST TOOL CALL   median ${at(ceremony, 0.5)}   p90 ${at(ceremony, 0.9)}   (n=${ceremony.length})`);
  console.log(`  time to terminal          median ${at(total, 0.5)}   p90 ${at(total, 0.9)}   (n=${total.length})`);
  console.log('Everything before the first tool call is ceremony the user waited through.');
}

main();
