import { dedupeCalls, emptyLane, rollupLane } from './trial.js';
import type { CanonicalCall, LaneTotals } from './types.js';

export const LIVE_SOURCES = ['clementine', 'claude-code', 'cowork', 'codex'] as const;
export type LiveSource = (typeof LIVE_SOURCES)[number];

export const LIVE_WINDOW_MS = 90_000;

export interface LiveTask {
  id: string;
  source: LiveSource;
  model?: string;
  kind?: string;
  brain?: string;
  cwd?: string;
  firstAt: string;
  lastAt: string;
  live: boolean;
  subagents: number;
  totals: LaneTotals;
}

export interface LiveSnapshot {
  watchingSince: string;
  sources: Record<LiveSource, LaneTotals>;
  tasks: LiveTask[];
  recentCalls: CanonicalCall[];
}

export function liveSourceOf(call: CanonicalCall): LiveSource {
  if (call.lane === 'clementine' || call.source === 'clementine') return 'clementine';
  if (call.source === 'cowork') return 'cowork';
  if (call.source === 'codex') return 'codex';
  return 'claude-code';
}

export function keepLiveCall(call: CanonicalCall): boolean {
  if (call.kind === 'warmup') return false;
  return true;
}

export function emptySources(): Record<LiveSource, LaneTotals> {
  return {
    clementine: emptyLane(),
    'claude-code': emptyLane(),
    cowork: emptyLane(),
    codex: emptyLane(),
  };
}

export function buildLiveSnapshot(calls: CanonicalCall[], watchingSince: string, now = Date.now()): LiveSnapshot {
  const kept = dedupeCalls(calls.filter(keepLiveCall));
  const byTask = new Map<string, CanonicalCall[]>();
  for (const call of kept) {
    const key = `${liveSourceOf(call)}:${call.rootSessionId}`;
    const list = byTask.get(key) ?? [];
    list.push(call);
    byTask.set(key, list);
  }
  const sources = emptySources();
  for (const source of LIVE_SOURCES) {
    sources[source] = rollupLane(kept.filter((c) => liveSourceOf(c) === source));
  }
  const tasks: LiveTask[] = [];
  for (const list of byTask.values()) {
    const first = list[0];
    const last = list[list.length - 1];
    const totals = rollupLane(list);
    const agents = new Set(list.filter((c) => c.isSubagent && c.agentId).map((c) => c.agentId as string));
    tasks.push({
      id: first.rootSessionId,
      source: liveSourceOf(first),
      model: totals.byModel[0]?.model || last.model || first.model,
      kind: last.kind || first.kind,
      brain: last.brain || first.brain,
      cwd: last.cwd || first.cwd,
      firstAt: first.at,
      lastAt: last.at,
      live: now - Date.parse(last.at) <= LIVE_WINDOW_MS,
      subagents: agents.size || (totals.subagentCalls > 0 ? 1 : 0),
      totals,
    });
  }
  tasks.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.lastAt.localeCompare(a.lastAt);
  });
  return {
    watchingSince,
    sources,
    tasks,
    recentCalls: kept.slice(-80).reverse(),
  };
}
