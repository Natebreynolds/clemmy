/**
 * Which workflows feed which Spaces, read from what the workflows do.
 *
 * A workflow feeds a Space when one of its `call` steps runs a reviewed local
 * write into a Space dataset whose Space and collection are literal and
 * exactly admissible by that write's own identity rules. It is recognised by
 * the tool's registered local execution contract, never by a tool name list,
 * and prose that merely mentions a Space never counts.
 *
 * These links are derived, not authority. They live in an in-memory index
 * rebuilt from the saved workflows (at start and after any workflow change)
 * and are never written into the reviewed workflow-to-Workspace binding
 * store, whose rows carry formal approval and projection identity. A Space
 * shows both: its derived feeds and any formal bindings, as a lookup only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { cronMatches } from '../execution/workflow-scheduler.js';
import { subscribeWorkflowChanges } from '../memory/workflow-change-bus.js';
import { listWorkflows, readWorkflow, type WorkflowDefinition } from '../memory/workflow-store.js';
import { workspaceSetDataIdentityProblem } from './workspace-set-data-contract.js';
import { listWorkflowSurfaceBindingsForWorkspace } from './workflow-surface-binding-store.js';

/** How many of the newest run records are read to find a feed's last run. */
const RECENT_RUN_RECORDS = 120;
/** How far ahead an exact next run is looked for, in hours. */
const NEXT_RUN_HORIZON_HOURS = 8 * 24;

export interface WorkflowSpaceWrite {
  workspaceId: string;
  collection: string;
  stepId: string;
}

export type SpaceWriteTest = (tool: string) => boolean;

/** The registered test: a reviewed local tool whose execution commits a
 *  Space dataset. Loaded on demand to keep this module out of the harness's
 *  import graph at load time. */
export async function spaceDatasetWriteTest(): Promise<SpaceWriteTest> {
  const { observeReviewedLocalTool } = await import('../runtime/harness/reviewed-local-tool-transport.js');
  return (tool) => observeReviewedLocalTool(tool)?.execution.adapter === 'workspace_dataset_v1';
}

/** The Spaces a workflow writes into, and the steps whose target is not a
 *  fixed, admissible Space and collection (chosen at run time, or invalid). */
export function workflowSpaceWrites(
  def: Pick<WorkflowDefinition, 'steps'>,
  isSpaceWrite: SpaceWriteTest,
): { writes: WorkflowSpaceWrite[]; notFixed: string[] } {
  const writes: WorkflowSpaceWrite[] = [];
  const notFixed: string[] = [];
  for (const step of def.steps ?? []) {
    const tool = step.call?.tool;
    if (typeof tool !== 'string' || !isSpaceWrite(tool)) continue;
    const slug = step.call?.args?.slug;
    const source = step.call?.args?.source_id;
    if (
      typeof slug === 'string' && typeof source === 'string'
      && !slug.includes('{{') && !source.includes('{{')
      && workspaceSetDataIdentityProblem(slug, source) === null
    ) {
      writes.push({ workspaceId: slug, collection: source, stepId: step.id });
    } else {
      notFixed.push(step.id);
    }
  }
  return { writes, notFixed };
}

export interface FeedLink {
  workflow: string;
  collections: string[];
  enabled: boolean;
  /** When the workflow was first saved; the earliest feed leads. */
  since: number;
}

let index: Map<string, FeedLink[]> | null = null;

function workflowSince(filePath: string): number {
  try {
    const stat = statSync(filePath);
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Rebuild the derived feed index from every saved workflow. */
export async function rebuildFeedIndex(options: { isSpaceWrite?: SpaceWriteTest } = {}): Promise<Map<string, FeedLink[]>> {
  const isSpaceWrite = options.isSpaceWrite ?? await spaceDatasetWriteTest();
  const next = new Map<string, FeedLink[]>();
  for (const entry of listWorkflows()) {
    const bySpace = new Map<string, Set<string>>();
    for (const write of workflowSpaceWrites(entry.data, isSpaceWrite).writes) {
      const collections = bySpace.get(write.workspaceId) ?? new Set<string>();
      collections.add(write.collection);
      bySpace.set(write.workspaceId, collections);
    }
    for (const [workspaceId, collections] of bySpace) {
      const links = next.get(workspaceId) ?? [];
      links.push({
        workflow: entry.name,
        collections: [...collections],
        enabled: entry.data.enabled !== false,
        since: workflowSince(entry.filePath),
      });
      next.set(workspaceId, links);
    }
  }
  for (const links of next.values()) links.sort((a, b) => a.since - b.since || a.workflow.localeCompare(b.workflow));
  index = next;
  return next;
}

/** The derived feeds of one Space, earliest first. */
export async function feedLinksForSpace(workspaceId: string): Promise<FeedLink[]> {
  return ((index ?? await rebuildFeedIndex()).get(workspaceId) ?? []).slice();
}

/**
 * Keep the derived index current: built now, and rebuilt shortly after any
 * workflow is created, changed or deleted. Returns the unsubscribe.
 */
export function installWorkflowFeedIndex(onError: (error: unknown) => void = () => undefined): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => { void rebuildFeedIndex().catch(onError); };
  run();
  const unsubscribe = subscribeWorkflowChanges(() => {
    index = null;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run(); }, 1_000);
    timer.unref?.();
  });
  return () => { if (timer) clearTimeout(timer); unsubscribe(); };
}

export type FeedRunState = 'running' | 'done' | 'failed' | 'waiting';

export interface SpaceFeedSummary {
  workflow: string;
  title: string;
  description?: string;
  role: 'primary' | 'supporting';
  /** derived: read from the workflow's steps; reviewed: a formal binding. */
  link: 'derived' | 'reviewed';
  enabled: boolean;
  /** Has a schedule. nextRunAt is set only when the next run is near enough to name. */
  scheduled: boolean;
  schedule?: string;
  timezone?: string;
  nextRunAt?: string;
  collections: string[];
  lastRun?: { id: string; state: FeedRunState; at: string; finishedAt?: string; problem?: string };
}

function runState(status: string): FeedRunState {
  if (status === 'completed' || status === 'success' || status === 'succeeded') return 'done';
  if (status === 'error' || status === 'failed' || status === 'cancelled' || status === 'timed_out') return 'failed';
  if (status === 'queued' || status === 'running' || status === 'finalizing') return 'running';
  return 'waiting';
}

/** The newest run records, read once and shared by every feed of a request. */
export function recentRunRecords(runsDir = path.join(BASE_DIR, 'workflows', 'runs')): Array<Record<string, unknown>> {
  let files: Array<{ file: string; mtime: number }>;
  try {
    files = readdirSync(runsDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        try { return { file, mtime: statSync(path.join(runsDir, file)).mtimeMs }; } catch { return { file, mtime: 0 }; }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, RECENT_RUN_RECORDS);
  } catch {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  for (const { file } of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(runsDir, file), 'utf-8')) as Record<string, unknown>;
      records.push({ ...raw, id: raw.id ?? file.replace(/\.json$/, '') });
    } catch { /* an unreadable record is skipped */ }
  }
  return records;
}

/** The newest run of one workflow among already-read recent records. */
export function latestFeedRun(names: string[], records: Array<Record<string, unknown>>): SpaceFeedSummary['lastRun'] {
  const raw = records.find((record) => typeof record.workflow === 'string' && names.includes(record.workflow));
  if (!raw) return undefined;
  const problem = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim().slice(0, 300) : undefined;
  return {
    id: String(raw.id),
    state: runState(String(raw.status ?? '')),
    at: String(raw.startedAt ?? raw.createdAt ?? ''),
    ...(typeof raw.finishedAt === 'string' ? { finishedAt: raw.finishedAt } : {}),
    ...(problem ? { problem } : {}),
  };
}

/**
 * The next minute a cron schedule fires within the next eight days, found an
 * hour at a time with the scheduler's own matcher (minute field widened), then
 * a minute at a time inside the first matching hour. Undefined past the
 * horizon: a schedule may still exist, it is just not named.
 */
export function nextScheduledRun(schedule: string, timezone: string | undefined, now = new Date()): string | undefined {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const anyMinute = ['*', ...fields.slice(1)].join(' ');
  const startMinute = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  const firstHour = Math.floor(startMinute / 3_600_000) * 3_600_000;
  for (let h = 0; h <= NEXT_RUN_HORIZON_HOURS; h += 1) {
    const hour = firstHour + h * 3_600_000;
    // Half-hour zones shift where a local hour starts, so test both halves.
    if (!cronMatches(anyMinute, new Date(hour), timezone) && !cronMatches(anyMinute, new Date(hour + 1_800_000), timezone)) continue;
    for (let m = 0; m < 60; m += 1) {
      const at = hour + m * 60_000;
      if (at < startMinute) continue;
      if (cronMatches(schedule, new Date(at), timezone)) return new Date(at).toISOString();
    }
  }
  return undefined;
}

/** What feeds one Space, primary first: derived feeds, then formal bindings. */
export async function spaceFeedSummaries(
  workspaceId: string,
  options: { runsDir?: string; now?: Date; links?: FeedLink[] } = {},
): Promise<SpaceFeedSummary[]> {
  const derived = options.links ?? await feedLinksForSpace(workspaceId);
  const reviewed = listWorkflowSurfaceBindingsForWorkspace(workspaceId)
    .filter((binding) => binding.state !== 'retired' && !derived.some((link) => link.workflow === binding.workflowId));
  if (derived.length === 0 && reviewed.length === 0) return [];
  const records = recentRunRecords(options.runsDir);
  const summaries: SpaceFeedSummary[] = [];
  const describe = (name: string, link: SpaceFeedSummary['link'], role: SpaceFeedSummary['role'], collections: string[]) => {
    const entry = readWorkflow(name);
    if (!entry) return;
    const def = entry.data;
    const schedule = def.trigger?.schedule?.trim() || undefined;
    const timezone = (def.trigger as { timezone?: string } | undefined)?.timezone;
    const enabled = def.enabled !== false;
    const nextRunAt = enabled && schedule ? nextScheduledRun(schedule, timezone, options.now) : undefined;
    const lastRun = latestFeedRun([entry.name, def.name], records);
    summaries.push({
      workflow: entry.name,
      title: def.name || entry.name,
      ...(def.description ? { description: def.description.slice(0, 300) } : {}),
      role,
      link,
      enabled,
      scheduled: Boolean(schedule),
      ...(schedule ? { schedule } : {}),
      ...(timezone ? { timezone } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
      collections,
      ...(lastRun ? { lastRun } : {}),
    });
  };
  const reviewedPrimary = reviewed.some((binding) => binding.role === 'primary');
  derived.forEach((link, i) => describe(link.workflow, 'derived', i === 0 && !reviewedPrimary ? 'primary' : 'supporting', link.collections));
  for (const binding of reviewed) describe(binding.workflowId, 'reviewed', binding.role, []);
  return summaries.sort((a, b) => (a.role === b.role ? 0 : a.role === 'primary' ? -1 : 1));
}
