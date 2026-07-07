/**
 * TurnActivity — the premium "watch the team work" strip inside an assistant
 * message. While a turn runs it shows the live sequence of tool calls and the
 * parallel agents it spawned (Claude / Codex / GLM dots + live status), so the
 * wait becomes visible progress instead of a dead "Still working…". After the
 * turn it collapses to a one-line summary you can expand.
 */
import { useState } from 'react';
import { Wrench, Users, Check, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ActivityItem } from '@/lib/useChat';

const PROVIDER_DOT: Record<NonNullable<ActivityItem['provider']>, string> = {
  claude: '#d97757',
  codex: '#10a37f',
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

function summarize(toolCount: number, agentCount: number): string {
  const parts: string[] = [];
  if (agentCount) parts.push(`${agentCount} agent${agentCount > 1 ? 's' : ''}`);
  if (toolCount) parts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);
  return parts.length ? `Used ${parts.join(' · ')}` : 'Activity';
}

export function TurnActivity({ items, live }: { items: ActivityItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;

  // Turn's over → a still-'running' row reads as done (no perpetual spinners).
  const view = live ? items : items.map((a) => (a.status === 'running' ? { ...a, status: 'done' as const } : a));
  const agents = view.filter((a) => a.kind === 'agent');
  const tools = view.filter((a) => a.kind === 'tool');
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
        <span>{summarize(tools.length, agents.length)}</span>
        <span aria-hidden>· show</span>
      </button>
    );
  }

  return (
    <div className="mt-2.5 border-t border-border/60 pt-2">
      {agents.length > 0 && (
        <div className="mb-1.5 flex items-center gap-1.5 text-caption text-muted">
          <Users className="h-3.5 w-3.5" aria-hidden />
          <span>{live && runningAgents > 0 ? `${runningAgents} agent${runningAgents > 1 ? 's' : ''} working` : `${agents.length} agent${agents.length > 1 ? 's' : ''}`}</span>
          <span className="flex -space-x-1">
            {agents.slice(0, 6).map((a) => (
              <span key={a.id} className="h-2.5 w-2.5 rounded-full ring-1 ring-surface" style={{ backgroundColor: PROVIDER_DOT[a.provider ?? 'unknown'] }} aria-hidden />
            ))}
          </span>
        </div>
      )}
      <ul className="flex max-h-52 flex-col gap-1 overflow-y-auto">
        {view.map((a) => (
          <li key={a.id} className="flex items-center gap-2 text-caption">
            {a.kind === 'agent' ? (
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PROVIDER_DOT[a.provider ?? 'unknown'] }} aria-hidden />
            ) : (
              <Wrench className="h-3 w-3 shrink-0 text-faint" aria-hidden />
            )}
            <span className={cn('min-w-0 flex-1 truncate', a.status === 'running' ? 'text-fg' : 'text-muted')}>{a.label}</span>
            <StatusIcon status={a.status} />
          </li>
        ))}
      </ul>
      {!live && open && (
        <button type="button" onClick={() => setOpen(false)} className="mt-1 text-caption text-faint transition-colors hover:text-muted">hide</button>
      )}
    </div>
  );
}
