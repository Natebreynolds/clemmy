/**
 * Every background job that keeps the memory, grouped Learning then Upkeep:
 * what it is, which model does its thinking (and whose model that is), when
 * it last ran and how that went, when it runs next, and what it did today.
 *
 * A roster, not a wall of cards: with room, each job is one row and the model,
 * last run, next run and today line up in columns, so "which model, and
 * when" reads down the page. Narrow, a row stacks and says each part in full.
 */
import { clsx } from 'clsx';
import type { JobDot, JobView } from '@/lib/memory-work';
import { JOB_ICON } from './job-icon';

const TILE: Record<JobDot, string> = {
  running: 'bg-primary-tint text-primary',
  waiting: 'bg-warning-tint text-warning',
  off: 'bg-subtle text-faint',
  ok: 'bg-subtle text-muted',
  failed: 'bg-subtle text-muted',
  never: 'bg-subtle text-faint',
};

const DOT: Record<JobDot, string> = {
  running: 'memory-pulse bg-primary',
  waiting: 'border-2 border-warning bg-raised',
  off: 'border-2 border-dashed border-border-strong bg-raised',
  ok: 'bg-success',
  failed: 'bg-warning',
  never: 'border-2 border-border-strong bg-raised',
};

const DOT_WORDS: Record<JobDot, string> = {
  running: 'working now',
  waiting: 'waiting',
  off: 'off',
  ok: 'last run went fine',
  failed: 'last run didn’t finish',
  never: 'hasn’t run yet',
};

/** Visible when the row is stacked; a screen-reader label once it is a column. */
function InlineLabel({ children }: { children: string }) {
  return <span className="memory-jobs-inline">{children} </span>;
}

function JobRow({ job }: { job: JobView }) {
  const Icon = JOB_ICON[job.id];
  return (
    <li className="memory-jobs-row px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className={clsx('relative mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-slow', TILE[job.dot])}>
          <Icon className="h-4 w-4" aria-hidden />
          <span className={clsx('absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--bg-raised)]', DOT[job.dot])} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h6 className="flex flex-wrap items-baseline gap-x-2 text-small font-semibold leading-snug text-fg">
            {job.title}
            {job.stateLabel && (
              <span className={clsx('text-caption font-semibold', job.state === 'running' ? 'text-primary' : job.state === 'waiting' ? 'text-warning' : 'text-faint')}>
                {job.stateLabel}
              </span>
            )}
            <span className="sr-only">({DOT_WORDS[job.dot]})</span>
          </h6>
          <p className="mt-0.5 text-caption leading-snug text-muted">{job.state === 'running' && job.doing ? `${job.doing}…` : job.blurb}</p>
        </div>
      </div>
      <div className="memory-jobs-meta min-w-0 text-caption leading-snug">
        <InlineLabel>Model:</InlineLabel>
        {job.modelOwner === 'none'
          ? <span className="text-muted">No model</span>
          : <span className={job.modelName ? 'text-fg' : 'text-faint'}>{job.modelName ?? 'None available'}</span>}
        <span className="memory-jobs-sub text-faint">{job.modelOwner === 'none' ? 'Rules only' : job.modelOwnerText}</span>
      </div>
      <div className="memory-jobs-meta min-w-0 text-caption leading-snug">
        {job.lastWhen
          ? <><InlineLabel>Last ran</InlineLabel><span className={job.lastFailed ? 'text-warning' : 'text-fg'}>{job.lastWhen}</span><span className={clsx('memory-jobs-sub', job.lastFailed ? 'text-warning' : 'text-faint')}>{job.lastDetail}</span></>
          : <span className="text-faint">Hasn’t run yet</span>}
      </div>
      <div className="memory-jobs-meta min-w-0 text-caption leading-snug text-muted">
        <span className="sr-only">Runs: </span>
        {job.nextText || <span className="text-faint">—</span>}
      </div>
      <div className={clsx('memory-jobs-meta min-w-0 text-caption leading-snug tabular-nums', !job.todayText && 'memory-jobs-empty')}>
        <InlineLabel>Today:</InlineLabel>
        {job.todayText ? <span className="text-muted">{job.todayText}</span> : <span className="text-faint">none yet</span>}
      </div>
    </li>
  );
}

function Group({ title, jobs }: { title: string; jobs: JobView[] }) {
  if (jobs.length === 0) return null;
  return (
    <>
      <h5 className="memory-jobs-group bg-subtle px-3.5 py-1.5 text-caption font-semibold text-muted">{title}</h5>
      <ul className="divide-y divide-border">
        {jobs.map((job) => <JobRow key={job.id} job={job} />)}
      </ul>
    </>
  );
}

export function JobRoster({ jobs }: { jobs: { learning: JobView[]; upkeep: JobView[] } }) {
  if (jobs.learning.length + jobs.upkeep.length === 0) {
    return <p className="text-small text-muted">— <span className="text-faint">the jobs couldn’t be read</span></p>;
  }
  return (
    <div className="overflow-hidden rounded-md border border-border bg-raised">
      <div className="memory-jobs-head px-3.5 py-2 text-caption font-semibold text-faint" aria-hidden>
        <span>Job</span><span>Model</span><span>Last ran</span><span>When it runs</span><span>Today</span>
      </div>
      <Group title="Learning" jobs={jobs.learning} />
      <Group title="Upkeep" jobs={jobs.upkeep} />
    </div>
  );
}
