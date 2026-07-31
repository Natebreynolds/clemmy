/**
 * Live agents — the glanceable "who is working right now" side panel.
 *
 * The owner's model: you hand Clem work in the chat, the chat stays free, this
 * panel pops with the agent working in the background, and the result comes
 * back to the conversation proactively. So this surface is deliberately
 * simple — live rows + waiting-on-you rows + a stop button — and deep
 * inspection (plan, tools, artifacts, trace) stays on the Tasks board. It
 * replaced the Run environment panel, whose inline provenance bookkeeping is
 * exactly what it subtracts.
 *
 * Docked as a real flex sibling at xl+ (pushes content, never covers the
 * chat); below xl it is a scrimmed dialog with a focus trap.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Bot, CircleStop, X } from 'lucide-react';
import { Button } from './ui/Button';
import { cn } from '@/lib/cn';
import { runBoardAction, type BoardCard } from '@/lib/board';
import { liveAgentRows, sourceKindLabel, type LiveAgentRow } from '@/lib/live-agents';

function AgentRow({ row, onOpenTasks }: { row: LiveAgentRow; onOpenTasks: () => void }) {
  const qc = useQueryClient();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');

  const stop = async () => {
    setStopping(true);
    setStopError('');
    try {
      const result = await runBoardAction(row.card, 'cancel');
      if (!result.ok) setStopError(result.reason || 'Could not stop this run.');
      await qc.invalidateQueries({ queryKey: ['board'] });
    } catch (error) {
      setStopError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  };

  return (
    <li
      className={cn(
        'rounded-lg border px-3 py-2.5',
        row.needsYou ? 'border-warning/50 bg-warning-tint/40' : 'border-border bg-canvas',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            row.needsYou ? 'bg-warning' : 'animate-breathe bg-success',
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate text-small font-medium text-fg" title={row.title}>{row.title}</span>
        <span className="shrink-0 text-caption text-faint">{row.elapsedLabel}</span>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 pl-4">
        <span className="shrink-0 rounded border border-border px-1.5 py-px text-caption text-muted">{sourceKindLabel(row.sourceKind)}</span>
        <span className="min-w-0 flex-1 truncate text-caption text-muted" title={row.statusLine}>
          {row.needsYou ? 'Waiting on you' : (row.statusLine || 'Working…')}
        </span>
        {row.needsYou ? (
          <button
            type="button"
            onClick={onOpenTasks}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-caption font-medium text-warning transition-colors hover:bg-warning-tint"
          >
            Review
          </button>
        ) : row.canStop ? (
          <button
            type="button"
            onClick={() => { void stop(); }}
            disabled={stopping}
            aria-label={`Stop ${row.title}`}
            title="Stop this run"
            className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-danger-tint hover:text-danger disabled:opacity-50"
          >
            <CircleStop className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {stopError && <div className="mt-1 pl-4 text-caption text-danger">{stopError}</div>}
    </li>
  );
}

export function LiveAgentsPanel({
  open,
  cards,
  loading,
  error,
  onRetry,
  onClose,
}: {
  open: boolean;
  cards: BoardCard[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const [mobileDialog, setMobileDialog] = useState(() => (
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 1279px)').matches : false
  ));

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)');
    const sync = () => setMobileDialog(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !mobileDialog) return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileDialog, onClose, open]);

  if (!open) return null;

  const rows = liveAgentRows(cards);
  const openTasks = () => { onClose(); navigate('/tasks'); };

  return (
    <>
      <button
        type="button"
        aria-label="Close live agents"
        onClick={onClose}
        tabIndex={-1}
        className="fixed inset-0 z-40 bg-black/20 xl:hidden"
      />
      <aside
        id="live-agents-panel"
        ref={panelRef}
        tabIndex={-1}
        role={mobileDialog ? 'dialog' : 'complementary'}
        aria-modal={mobileDialog ? true : undefined}
        aria-labelledby="live-agents-title"
        className={cn(
          'fixed inset-x-3 inset-y-3 z-50 flex min-w-0 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl',
          'animate-fade-in xl:relative xl:inset-auto xl:z-auto xl:w-[320px] xl:max-w-none xl:shrink-0 xl:rounded-none xl:border-y-0 xl:border-r-0 xl:shadow-none',
        )}
      >
        <div className="app-drag flex min-h-14 min-w-0 shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <Bot className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <h2 id="live-agents-title" className="min-w-0 flex-1 truncate text-body font-semibold text-fg">Working now</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close live agents" title="Close" className="app-no-drag">
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {error ? (
            <div className="rounded-lg border border-danger/40 bg-danger-tint/40 px-3 py-2 text-small text-fg">
              Couldn’t load live work.
              <button type="button" onClick={onRetry} className="ml-2 font-medium text-danger underline">Retry</button>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-1 py-6 text-center text-small text-muted">
              {loading ? 'Checking…' : 'Nothing running right now. Kick something off in the chat and it shows up here.'}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {rows.map((row) => <AgentRow key={row.id} row={row} onOpenTasks={openTasks} />)}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-border px-4 py-2.5">
          <button
            type="button"
            onClick={openTasks}
            className="inline-flex items-center gap-1.5 text-small font-medium text-primary transition-colors hover:underline"
          >
            All work + finished results
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </aside>
    </>
  );
}
