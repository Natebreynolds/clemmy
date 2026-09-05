import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Sparkles, Zap } from 'lucide-react';
import { runWorkflow } from '@/lib/automate';
import type { QuickAction } from '@/lib/home-prefs';
import { cn } from '@/lib/cn';
import { HomeNotice, type HomeNoticeState } from './HomeSection';

/** The window event the Customize panel listens for. Dispatched from every
 *  "Add" affordance so there is one door into shaping the home. */
export const CUSTOMIZE_HOME_EVENT = 'clem:customize-home';

export function openCustomizeHome(): void {
  window.dispatchEvent(new Event(CUSTOMIZE_HOME_EVENT));
}

const CHIP =
  'inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-small text-fg '
  + 'transition-colors hover:border-border-strong hover:bg-hover disabled:pointer-events-none disabled:opacity-50 cursor-pointer';

/**
 * The user's own prompts and workflows, one tap. Prompts go through the
 * caller's composer path; workflows start through the same run door Automate
 * uses and report back inline.
 */
export function QuickActions({
  actions,
  onPrompt,
  disabled = false,
  className,
}: {
  actions: readonly QuickAction[];
  onPrompt: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<HomeNoticeState | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const startWorkflow = async (action: QuickAction) => {
    setBusyId(action.id);
    setNotice(null);
    try {
      const queued = await runWorkflow(action.value) as { id?: string; held?: boolean; message?: string } | undefined;
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['working-now-badge'] });
      void qc.invalidateQueries({ queryKey: ['command-center'] });
      if (!mountedRef.current) return;
      if (queued?.held) {
        setNotice({ tone: 'info', text: queued.message ?? `“${action.label}” is being prepared; it starts by itself.` });
        return;
      }
      const href = queued?.id ? `/tasks?select=${encodeURIComponent(queued.id)}` : '/automate';
      setNotice({
        tone: 'success',
        text: `Started “${action.label}”.`,
        action: (
          <Link to={href} className="shrink-0 rounded-sm px-1 font-semibold text-primary hover:underline">
            Open
          </Link>
        ),
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setNotice({
        tone: 'error',
        text: error instanceof Error && error.message.trim() ? error.message : `Couldn’t start “${action.label}”.`,
      });
    } finally {
      if (mountedRef.current) setBusyId(null);
    }
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick actions">
        {actions.map((action, index) => {
          const Icon = action.kind === 'workflow' ? Zap : Sparkles;
          const running = busyId === action.id;
          return (
            <button
              key={`${action.id}:${index}`}
              type="button"
              disabled={disabled || running || (action.kind === 'workflow' && busyId !== null)}
              onClick={() => {
                if (action.kind === 'workflow') void startWorkflow(action);
                else onPrompt(action.value);
              }}
              title={action.kind === 'workflow' ? `Run the “${action.value}” workflow` : action.value}
              className={CHIP}
            >
              {running
                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
                : <Icon className="h-3.5 w-3.5 text-primary" aria-hidden />}
              <span className="max-w-64 truncate">{action.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={openCustomizeHome}
          className={cn(CHIP, 'border-dashed bg-transparent text-faint hover:bg-transparent hover:text-fg')}
          aria-label="Add a quick action"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {actions.length === 0 ? 'Add a prompt or workflow' : 'Add'}
        </button>
      </div>
      {notice && <HomeNotice notice={notice} onDismiss={() => setNotice(null)} />}
    </div>
  );
}
