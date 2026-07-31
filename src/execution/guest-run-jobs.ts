/**
 * Guest-run jobs — the async registry over runGuestHarness.
 *
 * Guest runs regularly outlive a single agent turn (a full SEO audit is
 * 10–30 min; the background worker's per-turn wall clock is 10), so the
 * tool surface is start → poll → kill, the same contract cli_setup uses
 * for install/auth jobs. The registry keeps a rolling narration tail so
 * a poll cheaply answers "what is it doing right now", and completion
 * lands a dashboard notification (silent — the polling agent owns the
 * substantive report-back, same division as background tasks).
 *
 * Effect boundary: startGuestRun only accepts projects resolved from the
 * user's workspace roster — a raw path that is not a detected workspace
 * project is refused, so neither the model nor a console client can point
 * a guest harness at an arbitrary directory.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  runGuestHarness,
  type GuestHarnessId,
  type GuestRunResult,
} from './guest-harness.js';
import { listWorkspaceProjects, type WorkspaceProject } from '../tools/shared.js';
import { BASE_DIR } from '../config.js';

export type GuestRunStatus = 'running' | 'succeeded' | 'failed' | 'killed';

export interface GuestRunJob {
  id: string;
  harness: GuestHarnessId;
  projectPath: string;
  projectName: string;
  prompt: string;
  status: GuestRunStatus;
  /** Rolling narration tail (newest last, capped). */
  events: string[];
  finalMessage: string;
  changedFiles: string[];
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** The conversation that started this run — completion reports back into it
   *  through the canonical outcome pipeline (same spine as background tasks),
   *  so the origin turn can END instead of babysitting a 20-minute run. */
  originSessionId?: string;
}

const EVENTS_TAIL_MAX = 100;
const JOBS_MAX = 50;

// Loaded-from-disk records have no live process, hence no AbortController.
const jobs = new Map<string, { job: GuestRunJob; abort?: AbortController }>();

// ─── Durable registry (2026-07-30) ──────────────────────────────────────────
// The registry used to be memory-only: a daemon restart silently orphaned
// every record — the origin conversation never heard back, and the console
// showed nothing. Runs now persist to state/guest-runs.json (identity +
// status; the live narration tail stays memory-only), and boot marks any
// still-"running" record as failed with an honest reason, delivering that
// outcome through the same report-back spine as a normal finish. The child
// CLI process cannot survive the daemon, so orphan-fail is the truthful
// terminal state, not a resume.
const STATE_DIR = path.join(BASE_DIR, 'state');
const GUEST_RUNS_FILE = path.join(STATE_DIR, 'guest-runs.json');

type PersistedGuestRun = Omit<GuestRunJob, 'events'>;

function persistJobs(): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    const records: PersistedGuestRun[] = [...jobs.values()]
      .map(({ job }) => { const { events: _events, ...rest } = job; return rest; })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, JOBS_MAX);
    writeFileSync(GUEST_RUNS_FILE, JSON.stringify(records, null, 2), 'utf-8');
  } catch { /* persistence is best-effort; the live map still serves this process */ }
}

function loadPersistedJobs(): void {
  try {
    if (!existsSync(GUEST_RUNS_FILE)) return;
    const parsed = JSON.parse(readFileSync(GUEST_RUNS_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) return;
    let orphaned = false;
    for (const raw of parsed as PersistedGuestRun[]) {
      if (!raw || typeof raw.id !== 'string' || jobs.has(raw.id)) continue;
      const job: GuestRunJob = { ...raw, events: [] };
      if (job.status === 'running') {
        job.status = 'failed';
        job.error = 'The app restarted while this run was in progress, so the CLI process did not survive. Start it again to re-run.';
        job.completedAt = new Date().toISOString();
        orphaned = true;
        jobs.set(job.id, { job });
        notifyDone(job);
        deliverGuestOutcome(job);
      } else {
        jobs.set(job.id, { job });
      }
    }
    if (orphaned) persistJobs();
  } catch { /* a corrupt file only costs history, never boot */ }
}

loadPersistedJobs();

/** Test seam: simulate a daemon restart — drop the live map and re-run the
 *  boot-time load + orphan sweep against whatever is on disk. */
export function _reloadPersistedJobsForTests(): void {
  jobs.clear();
  loadPersistedJobs();
}

/** Resolve a user-supplied project reference (name or path) against the
 *  workspace roster. Returns null when it is not a detected project. */
export function resolveRosterProject(ref: string): WorkspaceProject | null {
  const projects = listWorkspaceProjects();
  const trimmed = (ref || '').trim();
  if (!trimmed) return null;
  const asPath = path.resolve(trimmed);
  return projects.find((p) => p.path === asPath)
    ?? projects.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
    ?? null;
}

export interface StartGuestRunInput {
  harness: GuestHarnessId;
  /** Project name or absolute path — must resolve on the workspace roster. */
  project: string;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  sessionId?: string;
}

export function startGuestRun(input: StartGuestRunInput): GuestRunJob {
  const project = resolveRosterProject(input.project);
  if (!project) {
    throw new Error(
      `"${input.project}" is not a project on the user's workspace roster. `
      + 'Guest harnesses only run inside detected workspace projects — check workspace_list, '
      + 'or have the user add the folder under Connect → Projects.',
    );
  }

  const id = `guest-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const job: GuestRunJob = {
    id,
    harness: input.harness,
    projectPath: project.path,
    projectName: project.name,
    prompt: input.prompt,
    status: 'running',
    events: [],
    finalMessage: '',
    changedFiles: [],
    startedAt: new Date().toISOString(),
    ...(input.sessionId ? { originSessionId: input.sessionId } : {}),
  };
  const abort = new AbortController();
  jobs.set(id, { job, abort });
  pruneJobs();
  persistJobs();

  void runGuestHarness({
    harness: input.harness,
    projectPath: project.path,
    prompt: input.prompt,
    model: input.model,
    timeoutMs: input.timeoutMs,
    sessionId: input.sessionId,
    signal: abort.signal,
    onEvent: (event) => {
      job.events.push(`${event.kind}: ${event.text.slice(0, 300)}`);
      if (job.events.length > EVENTS_TAIL_MAX) job.events.splice(0, job.events.length - EVENTS_TAIL_MAX);
    },
  }).then(
    (result: GuestRunResult) => finishJob(job, result),
    (err: unknown) => {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = new Date().toISOString();
      notifyDone(job);
      deliverGuestOutcome(job);
      persistJobs();
    },
  );

  return job;
}

function finishJob(job: GuestRunJob, result: GuestRunResult): void {
  job.status = result.killed ? 'killed' : result.ok ? 'succeeded' : 'failed';
  job.finalMessage = result.finalMessage;
  job.changedFiles = result.changedFiles;
  job.durationMs = result.durationMs;
  job.completedAt = new Date().toISOString();
  if (!result.ok && !result.killed) {
    job.error = result.timedOut
      ? 'Timed out before finishing.'
      : `Exited with code ${result.exitCode}${result.stderrTail ? ` — stderr tail: ${result.stderrTail.slice(-500)}` : ''}`;
  }
  if (job.status === 'succeeded') recordRunDeliverables(job);
  notifyDone(job);
  deliverGuestOutcome(job);
  persistJobs();
}

/** Test seam — capture outcome deliveries instead of touching the real pipeline. */
type OutcomeDeliverer = (job: GuestRunJob) => void;
let outcomeDelivererForTests: OutcomeDeliverer | null = null;
export function _setGuestOutcomeDelivererForTests(fn: OutcomeDeliverer | null): void {
  outcomeDelivererForTests = fn;
}

/**
 * Report the finished run back into the conversation that started it, through
 * the canonical outcome pipeline (the same always-report-back spine background
 * tasks and workflows use). This is what frees the origin turn to END with a
 * conversational ack instead of polling for 20 minutes. Skips: no origin
 * (console-started runs — the dashboard notification covers those) and kills
 * (the user ended it on purpose; a report-back would be noise).
 */
function deliverGuestOutcome(job: GuestRunJob): void {
  if (!job.originSessionId || job.status === 'killed' || job.status === 'running') return;
  if (outcomeDelivererForTests) {
    outcomeDelivererForTests(job);
    return;
  }
  void Promise.all([import('../runtime/outcome.js'), import('../runtime/report-voice.js')])
    .then(([{ deliverOutcome }, { humanizeReportBody }]) => {
      const minutes = job.durationMs ? `${Math.round(job.durationMs / 60000)} min` : undefined;
      deliverOutcome(
        {
          status: job.status === 'succeeded' ? 'done' : 'failed',
          summary: job.status === 'succeeded'
            ? `${job.harness} finished in ${job.projectName}${minutes ? ` (${minutes})` : ''}`
            : `${job.harness} run failed in ${job.projectName}`,
          detail: humanizeReportBody(job.finalMessage || job.error || '')
            + (job.changedFiles.length
              ? `\n\nFiles created/changed in ${job.projectPath}:\n${job.changedFiles.map((f) => `- ${f}`).join('\n')}`
              : ''),
        },
        {
          originSessionId: job.originSessionId,
          sourceLabel: 'project run',
          sourceId: job.id,
          title: `${job.harness} · ${job.projectName}`,
          proactiveTurn: true,
        },
      );
    })
    .catch(() => { /* dashboard notification + poll path still carry the outcome */ });
}

/** Document-shaped outputs a user will later ask "where did we put…" about.
 *  Research/scratch JSON and screenshots stay out — the index answers recall,
 *  it is not a second changed-files list. */
const DELIVERABLE_EXT_RE = /\.(html?|pdf|md|docx?|pptx?|xlsx?|csv)$/i;
const MAX_RUN_DELIVERABLES = 3;

/** Capture at the effect boundary (the deliverable-index contract): a
 *  successful guest run's document outputs land in memory.db so a future
 *  "where's that audit?" recalls the file AND the project_run route that
 *  produced it. Best-effort — capture must never fail a finished run. */
function recordRunDeliverables(job: GuestRunJob): void {
  const docs = job.changedFiles.filter((f) => DELIVERABLE_EXT_RE.test(f)).slice(0, MAX_RUN_DELIVERABLES);
  if (docs.length === 0) return;
  void import('../memory/deliverable-index.js')
    .then(({ recordDeliverable }) => {
      for (const file of docs) {
        recordDeliverable({
          kind: 'file',
          target: path.join(job.projectPath, file),
          why: `Produced by "${job.prompt.slice(0, 120)}" in ${job.projectName} via project_run (${job.harness})`,
          lane: 'guest',
        });
      }
    })
    .catch(() => { /* recall just misses this run; the files still exist */ });
}

function notifyDone(job: GuestRunJob): void {
  // Silent: the dashboard Activity panel gets the lifecycle event; the
  // agent that polls the job delivers the substantive result to the user.
  void import('../runtime/notifications.js')
    .then(({ addNotification }) => addNotification({
      id: `guest-run-${job.id}`,
      kind: 'execution',
      title: job.status === 'succeeded'
        ? `${job.harness} finished in ${job.projectName}`
        : `${job.harness} run ${job.status} in ${job.projectName}`,
      body: (job.finalMessage || job.error || job.prompt).slice(0, 400),
      createdAt: new Date().toISOString(),
      read: false,
      silent: true,
      metadata: { guestRunId: job.id, projectPath: job.projectPath, harness: job.harness },
    }))
    .catch(() => { /* the poll path still carries the outcome */ });
}

export function getGuestRun(id: string): GuestRunJob | undefined {
  return jobs.get(id)?.job;
}

export function listGuestRuns(): GuestRunJob[] {
  return [...jobs.values()].map((entry) => entry.job)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function killGuestRun(id: string): GuestRunJob | undefined {
  const entry = jobs.get(id);
  if (!entry) return undefined;
  if (entry.job.status === 'running') entry.abort?.abort();
  return entry.job;
}

/** Drop the oldest COMPLETED jobs beyond the cap — running jobs are never
 *  evicted, so a kill switch can always find its target. */
function pruneJobs(): void {
  if (jobs.size <= JOBS_MAX) return;
  const done = [...jobs.entries()]
    .filter(([, entry]) => entry.job.status !== 'running')
    .sort(([, a], [, b]) => a.job.startedAt.localeCompare(b.job.startedAt));
  for (const [id] of done.slice(0, jobs.size - JOBS_MAX)) jobs.delete(id);
}
