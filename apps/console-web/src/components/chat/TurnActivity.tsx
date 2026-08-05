/**
 * TurnActivity — the premium "watch the team work" strip inside an assistant
 * message. While a turn runs it shows the live sequence of tool calls (with
 * WHAT each call is about — recipient, keyword, path — and a ticking elapsed
 * timer), the parallel agents it spawned (Claude / Codex / GLM dots + live
 * status), any run_batch as a single live progress meter ("Sending 18 ×
 * outlook send email ▓▓▓░ 12/18 · 0 failed"), and the plain-human effects it
 * produced ("Sent a message to paul@…"). After the turn it collapses to a
 * one-line summary you can expand. Rows render through the shared ActivityFeed
 * primitives so the strip and the board drawer speak ONE visual language.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, ArrowUpRight } from 'lucide-react';
import { ActivityRow, BatchRow, PROVIDER_DOT, useNowTick } from '@/components/chat/ActivityFeed';
import type { ActivityItem } from '@/lib/useChat';
import {
  settleTerminalActivity,
  type ActivityTerminalOutcome,
} from '@/lib/activity-presentation';

/** Results first, then effort: "3 files saved · 2 agents · 12 tools". The
 *  collapsed line is the turn's lasting record — what it PRODUCED outranks
 *  what it used. */
function summarize(toolCount: number, agentCount: number, batchCount: number, filesSaved: number): string {
  const parts: string[] = [];
  if (filesSaved) parts.push(`${filesSaved} file${filesSaved > 1 ? 's' : ''} saved`);
  if (agentCount) parts.push(`${agentCount} agent${agentCount > 1 ? 's' : ''}`);
  if (batchCount) parts.push(`${batchCount} batch${batchCount > 1 ? 'es' : ''}`);
  if (toolCount) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);
  if (parts.length === 0) return 'Activity';
  return filesSaved ? parts.join(' · ') : `Used ${parts.join(' · ')}`;
}

export function TurnActivity({ items, live, traceHref, terminalOutcome }: {
  items: ActivityItem[];
  live: boolean;
  terminalOutcome?: ActivityTerminalOutcome;
  /** Deep link to this run's card on the Tasks board (the ONE expanded live-run
   *  view). The inline strip is the compact summary of the SAME run — this link
   *  is the seam that keeps the two surfaces from reading as duplicates. */
  traceHref?: string;
}) {
  const [open, setOpen] = useState(false);
  // Tick once a second while anything is live-running so elapsed timers and the
  // header stay honest; completely quiescent (no interval) otherwise.
  const anyRunning = live && items.some((a) => a.status === 'running');
  const now = useNowTick(anyRunning);

  if (items.length === 0) return null;

  const view = settleTerminalActivity(items, live ? undefined : (terminalOutcome ?? 'interrupted'));
  const agents = view.filter((a) => a.kind === 'agent');
  const tools = view.filter((a) => a.kind === 'tool');
  const batches = view.filter((a) => a.kind === 'batch');
  const filesSaved = view.find((a) => a.id === 'deliverables')?.count ?? 0;
  const runningAgents = agents.filter((a) => a.status === 'running').length;

  // Finished turn, collapsed: a quiet one-line record leading with results.
  if (!live && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2.5 flex items-center gap-2 border-t border-border/60 pt-2 text-caption text-faint transition-colors hover:text-muted"
      >
        <Users className="h-3.5 w-3.5" aria-hidden />
        <span>{summarize(tools.length, agents.length, batches.length, filesSaved)}</span>
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
      <LiveActivityList view={view} now={now} live={live} />
      {!live && open && (
        <button type="button" onClick={() => setOpen(false)} className="mt-1 text-caption text-faint transition-colors hover:text-muted">hide</button>
      )}
    </div>
  );
}

/** The scrolling row list. While live, it stays PINNED to the newest row —
 *  a capped list that silently hides the current action reads as a stall
 *  (the newest work sat below the fold while old rows filled the viewport).
 *  The pin releases the moment the user scrolls up to inspect history and
 *  re-engages when they return to the bottom. role="log" + polite live region
 *  narrates new rows to screen readers without interrupting. */
function LiveActivityList({ view, now, live }: { view: ActivityItem[]; now: number; live: boolean }) {
  const listRef = useRef<HTMLUListElement | null>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (!el || !live || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [view, live]);
  return (
    <ul
      ref={listRef}
      role="log"
      aria-live={live ? 'polite' : 'off'}
      aria-relevant="additions text"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="flex max-h-52 flex-col gap-1 overflow-y-auto"
    >
      {view.map((a) => (a.kind === 'batch'
        ? <BatchRow key={a.id} a={a} now={now} live={live} />
        : <ActivityRow key={a.id} a={a} now={now} live={live} />))}
    </ul>
  );
}
