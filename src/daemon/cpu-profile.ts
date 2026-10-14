/**
 * A bounded CPU profile of the daemon's main thread, taken in-process.
 *
 * The loop-hold journal names the phase that held the main loop, but code that
 * runs between known points (an unwrapped timer, an event listener, a stream
 * callback) is charged to whichever phase last took the thread. A sampled
 * profile names the functions themselves. The inspector session lives inside
 * this process and opens no port; the profile is written beside the daemon's
 * logs, the few newest kept, and the reply carries the heaviest functions.
 */
import { Session } from 'node:inspector/promises';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface CpuProfileFunction {
  functionName: string;
  url: string;
  line: number;
  selfMs: number;
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  hitCount?: number;
  children?: number[];
}
interface Profile { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] }

const MAX_SECONDS = 120;
const KEEP_PROFILES = 5;
let running = false;

/** Self time per function, heaviest first, from a V8 CPU profile. Time is
 *  apportioned by each sample's own interval, so idle gaps are not counted
 *  against the function that ran before them. */
export function heaviestFunctions(profile: Profile, limit = 25): CpuProfileFunction[] {
  const byNode = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfUs = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const next = deltas[index + 1] ?? 0;
    selfUs.set(samples[index]!, (selfUs.get(samples[index]!) ?? 0) + Math.max(0, next));
  }
  const totals = new Map<string, CpuProfileFunction>();
  for (const [id, us] of selfUs) {
    const node = byNode.get(id);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    if (functionName === '(idle)') continue;
    const key = `${functionName}\u0000${url}\u0000${lineNumber}`;
    const existing = totals.get(key);
    if (existing) existing.selfMs += us / 1000;
    else totals.set(key, { functionName: functionName || '(anonymous)', url: url.replace(/^file:\/\//, ''), line: lineNumber + 1, selfMs: us / 1000 });
  }
  return [...totals.values()]
    .sort((left, right) => right.selfMs - left.selfMs)
    .slice(0, limit)
    .map((entry) => ({ ...entry, selfMs: Math.round(entry.selfMs) }));
}

function prune(dir: string): void {
  try {
    const files = readdirSync(dir).filter((name) => name.endsWith('.cpuprofile'))
      .map((name) => ({ name, at: statSync(path.join(dir, name)).mtimeMs }))
      .sort((left, right) => right.at - left.at);
    for (const old of files.slice(KEEP_PROFILES)) rmSync(path.join(dir, old.name), { force: true });
  } catch { /* the newest profile is already written */ }
}

export async function captureMainThreadCpuProfile(input: { seconds: number; dir: string }): Promise<{
  file: string; seconds: number; busyMs: number; heaviest: CpuProfileFunction[];
}> {
  if (running) throw new Error('A CPU profile is already being taken.');
  const seconds = Math.max(1, Math.min(MAX_SECONDS, Math.trunc(input.seconds)));
  running = true;
  const session = new Session();
  try {
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.setSamplingInterval', { interval: 1000 });
    await session.post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const { profile } = await session.post('Profiler.stop') as unknown as { profile: Profile };
    mkdirSync(input.dir, { recursive: true });
    const file = path.join(input.dir, `daemon-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
    writeFileSync(file, JSON.stringify(profile));
    prune(input.dir);
    const heaviest = heaviestFunctions(profile);
    const busyMs = heaviestFunctions(profile, Number.MAX_SAFE_INTEGER)
      .filter((entry) => entry.functionName !== '(program)' && entry.functionName !== '(garbage collector)')
      .reduce((sum, entry) => sum + entry.selfMs, 0);
    return { file, seconds, busyMs, heaviest };
  } finally {
    try { await session.post('Profiler.disable'); } catch { /* already stopped */ }
    session.disconnect();
    running = false;
  }
}
