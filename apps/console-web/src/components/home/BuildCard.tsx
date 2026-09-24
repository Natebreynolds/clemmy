import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, CircleStop, Hand, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { unifiedChatSessionId } from '@/lib/last-session';
import type { BuildState, HomeBuild } from '@/lib/home-builds';
import { agoLabel, plainText } from './home-model';

/**
 * One Build Home request, told from its real state (lib/home-builds.ts):
 * what Clem is doing now, what it is waiting on, and how it ended — with the
 * one next step each ending needs. A card is never "done" until a Space is.
 */
export function BuildCard({ build, state, onHome, onRetry, onDismiss, onAddToHome }: {
  build: HomeBuild;
  state: BuildState;
  /** The resulting Space is on the Home layout now. */
  onHome: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  onAddToHome: (spaceId: string) => void;
}) {
  const chat = build.sessionId ? `/chat/${encodeURIComponent(unifiedChatSessionId(build.sessionId))}` : null;
  const asked = plainText(build.prompt, 140);
  const since = agoLabel(build.startedAt);
  const reply = 'reply' in state ? plainText(state.reply, 220) : '';

  const { icon, tone, headline, detail } = describe(state, asked);
  const Icon = icon;
  const busy = state.kind === 'sending' || state.kind === 'working' || state.kind === 'checking';

  return (
    <div
      role={state.kind === 'failed' || state.kind === 'unsent' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col gap-3 rounded-md border bg-surface px-4 py-3.5',
        tone === 'warning' ? 'border-warning/40' : tone === 'danger' ? 'border-danger/40' : tone === 'success' ? 'border-success/40' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn('mt-0.5 h-4 w-4 shrink-0', busy && 'animate-spin', {
            'text-primary': tone === 'active', 'text-warning': tone === 'warning', 'text-danger': tone === 'danger', 'text-success': tone === 'success', 'text-muted': tone === 'quiet',
          })}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-body font-semibold text-fg">{headline}</p>
          <p className="mt-0.5 line-clamp-2 text-small text-muted" title={build.prompt}>{detail ?? `“${asked}”`}</p>
          {reply && <p className="mt-1.5 line-clamp-3 text-small text-fg">{reply}</p>}
        </div>
        {since && <span className="shrink-0 pt-0.5 text-caption text-faint">{since}</span>}
        {!busy && state.kind !== 'waiting' && (
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-mr-1 shrink-0 rounded-sm p-1 text-faint transition-colors hover:bg-hover hover:text-fg cursor-pointer">
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-7">
        {state.kind === 'ready' && (
          <>
            <Link to={`/workspaces/${encodeURIComponent(state.space.id)}`} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-small font-semibold text-primary-fg hover:bg-primary-hover">
              Open {plainText(state.space.title, 60)}
            </Link>
            {!onHome && <Button size="sm" variant="secondary" onClick={() => onAddToHome(state.space.id)}>Add to Home</Button>}
          </>
        )}
        {state.kind === 'waiting' && (
          <Link to="/inbox?tab=needs" className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-small font-semibold text-primary-fg hover:bg-primary-hover">Review</Link>
        )}
        {(state.kind === 'failed' || state.kind === 'stopped' || state.kind === 'lost' || state.kind === 'unsent') && (
          <Button size="sm" onClick={onRetry}>Try again</Button>
        )}
        {chat && state.kind !== 'lost' && (
          <Link to={chat} className="inline-flex h-8 items-center rounded-md px-2.5 text-small font-semibold text-muted hover:bg-hover hover:text-fg">
            {state.kind === 'no_space' ? 'Answer in the conversation' : busy || state.kind === 'waiting' ? 'Watch in the conversation' : 'Open the conversation'}
          </Link>
        )}
      </div>
    </div>
  );
}

function describe(state: BuildState, asked: string): {
  icon: typeof Loader2;
  tone: 'active' | 'warning' | 'danger' | 'success' | 'quiet';
  headline: string;
  detail?: string;
} {
  switch (state.kind) {
    case 'sending': return { icon: Loader2, tone: 'active', headline: 'Sending to Clem…' };
    case 'unsent': return { icon: AlertCircle, tone: 'danger', headline: 'This didn’t reach Clem', detail: `${plainText(state.error, 160)} “${asked}”` };
    case 'working': return { icon: Loader2, tone: 'active', headline: state.progress ? `Building · ${state.progress}` : 'Building…' };
    case 'waiting': return { icon: Hand, tone: 'warning', headline: 'Waiting on your approval to continue' };
    case 'checking': return { icon: Loader2, tone: 'active', headline: 'Finishing up…' };
    case 'ready': return { icon: CheckCircle2, tone: 'success', headline: `${plainText(state.space.title, 80)} is ready` };
    case 'no_space': return { icon: Hand, tone: 'warning', headline: 'Clem finished without saving a Space' };
    case 'stopped': return { icon: CircleStop, tone: 'quiet', headline: 'Stopped before it finished' };
    case 'failed': return { icon: AlertCircle, tone: 'danger', headline: 'Couldn’t build it' };
    case 'lost': return { icon: AlertCircle, tone: 'danger', headline: 'The conversation for this build is gone' };
  }
}
