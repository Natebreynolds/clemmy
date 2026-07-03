/**
 * Tasks board — a live Kanban of everything Clementine is working on in the
 * background (autonomous tasks, runs, executions, in-flight workflow runs),
 * unified across four columns: Queued · Running · Needs you · Done.
 *
 * Drag a card to act on it: → Done cancels, → Running starts/resumes. A drop
 * is a REQUEST — the server decides the real status and the board re-polls,
 * so the card lands where its true state puts it. Click "View trace" to watch
 * the agent work live.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor,
  useSensor, useSensors, closestCorners,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { X, Archive } from 'lucide-react';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/cn';
import { BoardColumn } from '@/components/board/BoardColumn';
import { LiveTraceDrawer } from '@/components/board/LiveTraceDrawer';
import { NowStrip } from '@/components/board/NowStrip';
import {
  listBoard, COLUMNS, intentForDrop, rejectReason, runBoardAction, cardTone, sourceLabel,
  type BoardCard, type BoardColumnId, type BoardButtonIntent,
} from '@/lib/board';

interface Toast { tone: 'success' | 'danger'; text: string; }

export function BackgroundTasks() {
  const qc = useQueryClient();
  const board = usePoll(['board'], listBoard, 4000);
  const cards = useMemo(() => board.data?.cards ?? [], [board.data]);

  const [active, setActive] = useState<BoardCard | null>(null);
  const [open, setOpen] = useState<BoardCard | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [keptStale, setKeptStale] = useState(false); // "Keep them" dismisses the banner for this view

  const staleCards = useMemo(() => cards.filter((c) => c.stale), [cards]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const byColumn = (col: BoardColumnId) => cards.filter((c) => c.column === col);

  const flash = (t: Toast) => { setToast(t); window.setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 3500); };

  const onDragStart = (e: DragStartEvent) => {
    setActive((e.active.data.current?.card as BoardCard) ?? null);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const card = e.active.data.current?.card as BoardCard | undefined;
    setActive(null);
    if (!card || !e.over) return;
    const target = e.over.id as BoardColumnId;
    const intent = intentForDrop(card, target);
    if (!intent) {
      const reason = rejectReason(card, target);
      if (reason) flash({ tone: 'danger', text: reason });
      return; // snap-back is automatic — we never moved the card
    }
    const verb = intent === 'cancel' ? 'Cancelling' : intent === 'resume' ? 'Resuming' : 'Starting';
    flash({ tone: 'success', text: `${verb} “${card.title}”…` });
    const res = await runBoardAction(card, intent);
    if (!res.ok) flash({ tone: 'danger', text: res.reason || 'That action didn’t go through.' });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };

  const onArchive = async (card: BoardCard) => {
    flash({ tone: 'success', text: `Archived “${card.title}”.` });
    const res = await runBoardAction(card, 'archive');
    if (!res.ok) flash({ tone: 'danger', text: res.reason || 'Couldn’t archive that task.' });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };

  const onCardAction = async (card: BoardCard, intent: BoardButtonIntent) => {
    const label = intent === 'approve' ? 'Approving'
      : intent === 'reject' ? 'Rejecting'
        : intent === 'retry_failed_items' ? 'Retrying failed items for'
          : intent === 'resume_safe' || intent === 'resume' ? 'Continuing'
            : intent === 'cancel' ? 'Cancelling'
              : 'Updating';
    flash({ tone: 'success', text: `${label} “${card.title}”…` });
    const res = await runBoardAction(card, intent);
    if (!res.ok) flash({ tone: 'danger', text: res.reason || 'That action didn’t go through.' });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };

  const onArchiveAll = async (tasks: BoardCard[]) => {
    const results = await Promise.all(tasks.map((t) => runBoardAction(t, 'archive')));
    const failed = results.filter((r) => !r.ok).length;
    flash(failed
      ? { tone: 'danger', text: `Archived ${tasks.length - failed} of ${tasks.length}; ${failed} couldn’t be archived.` }
      : { tone: 'success', text: `Archived ${tasks.length} old task${tasks.length > 1 ? 's' : ''}.` });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };

  return (
    <Page
      title="Tasks"
      subtitle="Everything Clementine is working on — drag to cancel or start, click a card to watch it live."
      actions={<Button variant="secondary" onClick={() => void board.refetch()}>Refresh</Button>}
    >
      {!board.isLoading && staleCards.length > 0 && !keptStale && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-tint/50 p-4">
          <div className="flex items-start gap-2">
            <Archive className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold text-fg">
                {staleCards.length} old task{staleCards.length > 1 ? 's' : ''} — archive {staleCards.length > 1 ? 'them' : 'it'}?
              </p>
              <p className="mt-0.5 text-caption text-muted">
                {staleCards.some((c) => c.staleKind === 'parked')
                  ? 'Some have been waiting on you, others just finished — all idle for over a week. Archiving is recoverable.'
                  : 'These finished over a week ago and are still on the board. Archiving is recoverable.'}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void onArchiveAll(staleCards)}>
              <Archive className="h-4 w-4" aria-hidden /> Archive all
            </Button>
            <Button variant="secondary" onClick={() => setKeptStale(true)}>Keep them</Button>
          </div>
        </div>
      )}

      {/* Live "running now" rail — rides the telemetry SSE, independent of the
          board poll, so swarms / tool calls / brain switches show as they happen. */}
      <NowStrip cards={cards} onOpen={setOpen} />

      {board.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((c) => <Skeleton key={c.id} className="h-64" />)}
        </div>
      ) : cards.length === 0 ? (
        <EmptyState
          title="Nothing running"
          description="When Clementine picks up background work — tasks, workflows, or long-running goals — it shows up here live."
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {COLUMNS.map((col) => (
              <BoardColumn
                key={col.id}
                id={col.id}
                label={col.label}
                cards={byColumn(col.id)}
                activeCard={active}
                onOpen={setOpen}
                onArchive={(card) => void onArchive(card)}
                onAction={(card, intent) => void onCardAction(card, intent)}
              />
            ))}
          </div>
          <DragOverlay>
            {active ? <DragPreview card={active} /> : null}
          </DragOverlay>
        </DndContext>
      )}

      {open && <LiveTraceDrawer card={open} onClose={() => setOpen(null)} onAction={(card, intent) => void onCardAction(card, intent)} />}

      {toast && (
        <div
          className={cn(
            'fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md px-4 py-2.5 text-body shadow-lg animate-fade-in',
            toast.tone === 'danger' ? 'bg-danger text-white' : 'bg-fg text-canvas',
          )}
          role="status"
        >
          {toast.text}
          <button onClick={() => setToast(null)} aria-label="Dismiss"><X className="h-4 w-4 opacity-70 hover:opacity-100" /></button>
        </div>
      )}
    </Page>
  );
}

/** A lightweight card preview that follows the cursor during a drag. */
function DragPreview({ card }: { card: BoardCard }) {
  const tone = cardTone(card);
  return (
    <div className="w-64 rotate-1 rounded-md border border-border bg-surface p-3 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-muted">{sourceLabel(card.sourceKind)}</span>
        <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
      </div>
      <p className="mt-2 line-clamp-2 text-body font-medium text-fg">{card.title}</p>
    </div>
  );
}
