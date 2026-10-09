/**
 * Which workflows feed which Spaces, read from what the workflows do.
 *
 * A workflow feeds a Space when one of its `call` steps runs a reviewed local
 * write into a Space dataset with a literal Space and collection in its
 * arguments. That is recognised by the tool's registered local execution
 * contract, never by a tool name list, and prose that merely mentions a Space
 * never counts. Each such pair is kept as a WorkflowSurfaceBindingV1 row whose
 * id starts with `feed:`; this module writes only those rows and never touches
 * a binding another writer owns. The first feeder of a Space is its primary
 * feed and later ones support it.
 *
 * The summaries tell the Space what feeds it: the workflow, what it fills,
 * when it last ran and how that went, and when it runs next.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { cronMatches } from '../execution/workflow-scheduler.js';
import { subscribeWorkflowChanges } from '../memory/workflow-change-bus.js';
import { listWorkflows, readWorkflow, type WorkflowDefinition } from '../memory/workflow-store.js';
import { BASE_DIR } from '../config.js';
import { isValidSpaceSlug, spaceStore } from './store.js';
import type { WorkflowSurfaceBindingV1 } from './workflow-surface-binding.js';
import {
  listWorkflowSurfaceBindingsForWorkspace,
  listWorkflowSurfaceBindingsWithIdPrefix,
  putWorkflowSurfaceBinding,
} from './workflow-surface-binding-store.js';

export const FEED_BINDING_PREFIX = 'feed:';

/** How many of the newest run records are read to find a feed's last run. */
const RECENT_RUN_RECORDS = 120;
/** How far ahead a next run is looked for. */
const NEXT_RUN_HORIZON_MINUTES = 8 * 24 * 60;

export interface WorkflowSpaceWrite {
  workspaceId: string;
  /** The collection (source id) the step fills; empty when chosen at run time. */
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

function literal(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && !value.includes('{{') ? value.trim() : null;
}

/** The Spaces a workflow writes into, and the steps whose Space is only known
 *  when the workflow runs. */
export function workflowSpaceWrites(
  def: Pick<WorkflowDefinition, 'steps'>,
  isSpaceWrite: SpaceWriteTest,
): { writes: WorkflowSpaceWrite[]; chosenAtRun: string[] } {
  const writes: WorkflowSpaceWrite[] = [];
  const chosenAtRun: string[] = [];
  for (const step of def.steps ?? []) {
    const tool = step.call?.tool?.trim();
    if (!tool || !isSpaceWrite(tool)) continue;
    const slug = literal(step.call?.args?.slug);
    if (slug && isValidSpaceSlug(slug)) {
      writes.push({ workspaceId: slug, collection: literal(step.call?.args?.source_id) ?? '', stepId: step.id });
    } else {
      chosenAtRun.push(step.id);
    }
  }
  return { writes, chosenAtRun };
}

type StoredBinding = WorkflowSurfaceBindingV1 & { digest: string };

function revise(existing: StoredBinding, patch: Partial<Pick<WorkflowSurfaceBindingV1, 'state' | 'role'>>, now: string): boolean {
  const { digest, ...binding } = existing;
  const result = putWorkflowSurfaceBinding({
    binding: { ...binding, ...patch, revision: binding.revision + 1, updatedAt: now },
    expectedDigest: digest,
  });
  return result.ok;
}

export interface FeedReconcileResult {
  bound: string[];
  changed: string[];
  retired: string[];
  /** Bindings that could not be written yet (their Space does not exist). */
  waiting: string[];
}

/**
 * Bring the `feed:` bindings in line with what every saved workflow writes.
 * Idempotent; safe to call after any workflow or Space change.
 */
export async function reconcileWorkflowFeeds(
  options: { isSpaceWrite?: SpaceWriteTest; now?: Date } = {},
): Promise<FeedReconcileResult> {
  const isSpaceWrite = options.isSpaceWrite ?? await spaceDatasetWriteTest();
  const now = (options.now ?? new Date()).toISOString();
  const out: FeedReconcileResult = { bound: [], changed: [], retired: [], waiting: [] };

  const desired = new Map<string, { workflowId: string; workspaceId: string; state: 'active' | 'paused' }>();
  for (const entry of listWorkflows()) {
    for (const write of workflowSpaceWrites(entry.data, isSpaceWrite).writes) {
      desired.set(`${FEED_BINDING_PREFIX}${entry.name}:${write.workspaceId}`, {
        workflowId: entry.name,
        workspaceId: write.workspaceId,
        state: entry.data.enabled === false ? 'paused' : 'active',
      });
    }
  }

  const existing = new Map(listWorkflowSurfaceBindingsWithIdPrefix(FEED_BINDING_PREFIX).map((b) => [b.bindingId, b]));
  const touched = new Set<string>();

  for (const [id, binding] of existing) {
    if (desired.has(id) || binding.state === 'retired') continue;
    if (revise(binding, { state: 'retired' }, now)) { out.retired.push(id); touched.add(binding.workspaceId); }
  }

  for (const [id, want] of desired) {
    const have = existing.get(id);
    if (have) {
      if (have.state !== want.state && revise(have, { state: want.state }, now)) {
        out.changed.push(id);
        touched.add(want.workspaceId);
      }
      continue;
    }
    if (!spaceStore.get(want.workspaceId)) { out.waiting.push(id); continue; }
    const others = listWorkflowSurfaceBindingsForWorkspace(want.workspaceId).filter((b) => b.state !== 'retired');
    const result = putWorkflowSurfaceBinding({
      binding: {
        version: 1,
        bindingId: id,
        workflowId: want.workflowId,
        workspaceId: want.workspaceId,
        revision: 1,
        role: others.some((b) => b.role === 'primary') ? 'supporting' : 'primary',
        projectionVersion: 1,
        scheduleAuthority: 'workflow',
        state: want.state,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (result.ok) { out.bound.push(id); touched.add(want.workspaceId); } else out.waiting.push(id);
  }

  // Exactly one primary per Space among the bindings still in use: the
  // earliest one, and a binding another writer owns is never re-roled.
  for (const workspaceId of touched) {
    const live = listWorkflowSurfaceBindingsForWorkspace(workspaceId)
      .filter((b) => b.state !== 'retired')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.bindingId.localeCompare(b.bindingId));
    const primary = live.find((b) => b.role === 'primary') ?? live[0];
    for (const binding of live) {
      if (!binding.bindingId.startsWith(FEED_BINDING_PREFIX)) continue;
      const role = binding === primary ? 'primary' : 'supporting';
      if (binding.role !== role && revise(binding, { role }, now)) out.changed.push(binding.bindingId);
    }
  }
  return out;
}

export type FeedRunState = 'running' | 'done' | 'failed' | 'waiting';

export interface SpaceFeedSummary {
  workflow: string;
  title: string;
  description?: string;
  role: 'primary' | 'supporting';
  enabled: boolean;
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

/** The newest run of one workflow among the most recent run records. */
export function latestFeedRun(names: string[], runsDir = path.join(BASE_DIR, 'workflows', 'runs')): SpaceFeedSummary['lastRun'] {
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
    return undefined;
  }
  for (const { file } of files) {
    try {
      const raw = JSON.parse(readFileSync(path.join(runsDir, file), 'utf-8')) as Record<string, unknown>;
      if (typeof raw.workflow !== 'string' || !names.includes(raw.workflow)) continue;
      const at = String(raw.startedAt ?? raw.createdAt ?? '');
      const problem = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim().slice(0, 300) : undefined;
      return {
        id: String(raw.id ?? file.replace(/\.json$/, '')),
        state: runState(String(raw.status ?? '')),
        at,
        ...(typeof raw.finishedAt === 'string' ? { finishedAt: raw.finishedAt } : {}),
        ...(problem ? { problem } : {}),
      };
    } catch { /* an unreadable record is skipped */ }
  }
  return undefined;
}

/** The next minute a cron schedule fires, within the next eight days. */
export function nextScheduledRun(schedule: string, timezone: string | undefined, now = new Date()): string | undefined {
  const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < NEXT_RUN_HORIZON_MINUTES; i += 1) {
    const at = new Date(start + i * 60_000);
    if (cronMatches(schedule, at, timezone)) return at.toISOString();
  }
  return undefined;
}

/** What feeds one Space, primary first. */
export async function spaceFeedSummaries(
  workspaceId: string,
  options: { isSpaceWrite?: SpaceWriteTest; runsDir?: string; now?: Date } = {},
): Promise<SpaceFeedSummary[]> {
  const isSpaceWrite = options.isSpaceWrite ?? await spaceDatasetWriteTest();
  const summaries: SpaceFeedSummary[] = [];
  for (const binding of listWorkflowSurfaceBindingsForWorkspace(workspaceId)) {
    if (binding.state === 'retired') continue;
    const entry = readWorkflow(binding.workflowId);
    if (!entry) continue;
    const def = entry.data;
    const schedule = def.trigger?.schedule?.trim() || undefined;
    const timezone = (def.trigger as { timezone?: string } | undefined)?.timezone;
    const enabled = def.enabled !== false;
    const collections = [...new Set(workflowSpaceWrites(def, isSpaceWrite).writes
      .filter((w) => w.workspaceId === workspaceId && w.collection)
      .map((w) => w.collection))];
    const lastRun = latestFeedRun([entry.name, def.name], options.runsDir);
    const nextRunAt = enabled && schedule ? nextScheduledRun(schedule, timezone, options.now) : undefined;
    summaries.push({
      workflow: entry.name,
      title: def.name || entry.name,
      ...(def.description ? { description: def.description.slice(0, 300) } : {}),
      role: binding.role,
      enabled,
      ...(schedule ? { schedule } : {}),
      ...(timezone ? { timezone } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
      collections,
      ...(lastRun ? { lastRun } : {}),
    });
  }
  return summaries;
}

/**
 * Keep the feed bindings current: once now, and again shortly after any
 * workflow is created, changed or deleted. Returns the unsubscribe.
 */
export function installWorkflowFeedReconciler(onError: (error: unknown) => void = () => undefined): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => { void reconcileWorkflowFeeds().catch(onError); };
  run();
  const unsubscribe = subscribeWorkflowChanges(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; run(); }, 1_000);
    timer.unref?.();
  });
  return () => { if (timer) clearTimeout(timer); unsubscribe(); };
}
