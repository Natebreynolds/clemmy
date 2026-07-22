/**
 * TurnActivity — the premium "watch the team work" strip inside an assistant
 * message. While a turn runs it shows the live sequence of tool calls (with
 * WHAT each call is about — recipient, keyword, path — and a ticking elapsed
 * timer), the parallel agents it spawned (Claude / Codex / GLM dots + live
 * status), and any run_batch as a single live progress meter ("Sending 18 ×
 * outlook send email ▓▓▓░ 12/18 · 0 failed"). After the turn it collapses to
 * a one-line summary you can expand.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wrench, Users, Check, X, Zap, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ActivityItem } from '@/lib/useChat';

const PROVIDER_DOT: Record<NonNullable<ActivityItem['provider']>, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  byo: '#4f8fc0',
  glm: '#7c6cf0',
  unknown: '#8a8f98',
};

function StatusIcon({ status }: { status: ActivityItem['status'] }) {
  if (status === 'running') {
    return <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary/80" aria-hidden />;
  }
  if (status === 'failed') return <X className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />;
  return <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />;
}

function summarize(toolCount: number, agentCount: number, batchCount: number): string {
  const parts: string[] = [];
  if (agentCount) parts.push(`${agentCount} agent${agentCount > 1 ? 's' : ''}`);
  if (batchCount) parts.push(`${batchCount} batch${batchCount > 1 ? 'es' : ''}`);
  if (toolCount) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);
  return parts.length ? `Used ${parts.join(' · ')}` : 'Activity';
}

function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (!startedAt) return '';
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  if (s < 1) return '';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`;
}

/** One run_batch as a live meter: label, thin progress bar, honest counts. */
function BatchRow({ a, now, live }: { a: ActivityItem; now: number; live: boolean }) {
  const b = a.batch ?? { done: 0, total: 0, failed: 0 };
  const pct = b.total > 0 ? Math.min(100, Math.round((b.done / b.total) * 100)) : 0;
  const running = live && a.status === 'running';
  return (
    <li className="flex flex-col gap-1 py-0.5 text-caption">
      <div className="flex items-center gap-2">
        <Zap className="h-3 w-3 shrink-0 text-primary" aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate', running ? 'text-fg' : 'text-muted')}>{a.label}</span>
        <span className="shrink-0 tabular-nums text-faint">
          {b.done}/{b.total}
          {b.failed > 0 && <span className="text-danger"> · {b.failed} failed</span>}
          {running && b.throttled && <span className="text-warning"> · throttled, backing off…</span>}
          {running && elapsedLabel(a.startedAt, now) && <span> · {elapsedLabel(a.startedAt, now)}</span>}
        </span>
        <StatusIcon status={a.status} />
      </div>
      <div className="ml-5 flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-border/60" role="progressbar" aria-valuenow={b.done} aria-valuemin={0} aria-valuemax={b.total}>
          <div
            className={cn('h-full rounded-full transition-all duration-300', a.status === 'failed' ? 'bg-danger' : 'bg-primary', running && 'animate-pulse')}
            style={{ width: `${pct}%` }}
          />
        </div>
        {running && a.detail && <span className="max-w-40 shrink-0 truncate text-faint">→ {a.detail}</span>}
      </div>
    </li>
  );
}

export function TurnActivity({ items, live, traceHref }: {
  items: ActivityItem[];
  live: boolean;
  /** Deep link to this run's card on the Tasks board (the ONE expanded live-run
   *  view). The inline strip is the compact summary of the SAME run — this link
   *  is the seam that keeps the two surfaces from reading as duplicates. */
  traceHref?: string;
}) {
  const [open, setOpen] = useState(false);
  // Tick once a second while anything is live-running so elapsed timers and the
  // header stay honest; completely quiescent (no interval) otherwise.
  const anyRunning = live && items.some((a) => a.status === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  if (items.length === 0) return null;

  // Turn's over → a still-'running' row reads as done (no perpetual spinners).
  const view = live ? items : items.map((a) => (a.status === 'running' ? { ...a, status: 'done' as const } : a));
  const agents = view.filter((a) => a.kind === 'agent');
  const tools = view.filter((a) => a.kind === 'tool');
  const batches = view.filter((a) => a.kind === 'batch');
  const runningAgents = agents.filter((a) => a.status === 'running').length;

  // Finished turn, collapsed: a quiet one-line summary.
  if (!live && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2 text-caption text-faint transition-colors hover:text-muted"
      >
        <Users className="h-3.5 w-3.5" aria-hidden />
        <span>{summarize(tools.length, agents.length, batches.length)}</span>
        <span aria-hidden>· show</span>
      </button>
    );
  }

  return (
    <div className="mt-2.5 border-t border-border/60 pt-2">
      {(agents.length > 0 || traceHref) && (
        <div className="mb-1.5 flex items-center gap-1.5 text-caption text-muted">
          {agents.length > 0 && (
            <>
              <Users className="h-3.5 w-3.5" aria-hidden />
              <span>{live && runningAgents > 0 ? `${runningAgents} agent${runningAgents > 1 ? 's' : ''} working` : `${agents.length} agent${agents.length > 1 ? 's' : ''}`}</span>
              <span className="flex -space-x-1">
                {agents.slice(0, 6).map((a) => (
                  <span key={a.id} className="h-2.5 w-2.5 rounded-full ring-1 ring-surface" style={{ backgroundColor: PROVIDER_DOT[a.provider ?? 'unknown'] }} aria-hidden />
                ))}
              </span>
            </>
          )}
          {traceHref && (
            <Link
              to={traceHref}
              className="ml-auto flex items-center gap-0.5 text-caption text-faint transition-colors hover:text-muted"
            >
              Full trace
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      )}
      <ul className="flex max-h-52 flex-col gap-1 overflow-y-auto">
        {view.map((a) => {
          if (a.kind === 'batch') return <BatchRow key={a.id} a={a} now={now} live={live} />;
          const running = live && a.status === 'running';
          const elapsed = running ? elapsedLabel(a.startedAt, now) : '';
          return (
            <li key={a.id} className="flex items-center gap-2 text-caption">
              {a.kind === 'agent' ? (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_DOT[a.provider ?? 'unknown'] }} aria-hidden />
              ) : a.kind === 'check' ? (
                <Check className={cn('h-3 w-3 shrink-0', a.status === 'failed' ? 'text-warning' : 'text-success')} aria-hidden />
              ) : (
                <Wrench className="h-3 w-3 shrink-0 text-faint" aria-hidden />
              )}
              <span className={cn('min-w-0 truncate', running ? 'text-fg' : 'text-muted')}>{a.label}</span>
              {a.detail && (a.kind === 'tool' || a.kind === 'check') && (
                <span className="min-w-0 flex-1 truncate text-faint">→ {a.detail}</span>
              )}
              {!a.detail && <span className="flex-1" />}
              {elapsed && <span className="shrink-0 tabular-nums text-faint">{elapsed}</span>}
              <StatusIcon status={a.status} />
            </li>
          );
        })}
      </ul>
      {!live && open && (
        <button type="button" onClick={() => setOpen(false)} className="mt-1 text-caption text-faint transition-colors hover:text-muted">hide</button>
      )}
    </div>
  );
}
