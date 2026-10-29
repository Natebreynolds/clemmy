import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { presentInboxQuestion, QUESTION_PRESENTATION_EVENT, sameQuestionPresentation, type QuestionPresentationReceipt } from '@/lib/inbox';
import { ATTENTION_PRESENTATION_EVENT, ATTENTION_PRESENTATION_INVALIDATE, presentAttentionItem, type AttentionPresentationReceipt } from '@/lib/attention-presentation';

type Receipt = { target: 'question' | 'attention'; id: string; action: QuestionPresentationReceipt['action']; generation: string; mutationToken: string };
const sameReceipt = (a: Receipt | null, b: Receipt) => Boolean(a && a.target === b.target && sameQuestionPresentation(a, b));

/** This receipt outlives its removed row, so hiding a question is reversible. */
export function QuestionPresentationUndo() {
  const queryClient = useQueryClient();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const latest = useRef<Receipt | null>(null);
  const [pending, setPending] = useState<Receipt | null>(null);
  const inFlight = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const receive = (next: Receipt) => {
      if (!next.generation || !next.mutationToken || !next.id) return;
      if (next.action === 'restore') {
        if (sameReceipt(latest.current, next)) { latest.current = null; setReceipt(null); }
        return;
      }
      latest.current = next;
      setReceipt(next); setError(null);
    };
    const receiveQuestion = (event: Event) => {
      const item = (event as CustomEvent<QuestionPresentationReceipt>).detail;
      if (item?.ok) receive({ ...item, target: 'question' });
    };
    const receiveAttention = (event: Event) => {
      const item = (event as CustomEvent<AttentionPresentationReceipt>).detail;
      if (item?.ok) receive({ ...item, target: 'attention', id: item.key });
    };
    window.addEventListener(QUESTION_PRESENTATION_EVENT, receiveQuestion);
    window.addEventListener(ATTENTION_PRESENTATION_EVENT, receiveAttention);
    return () => {
      window.removeEventListener(QUESTION_PRESENTATION_EVENT, receiveQuestion);
      window.removeEventListener(ATTENTION_PRESENTATION_EVENT, receiveAttention);
    };
  }, []);
  if (!receipt) return null;
  const busy = sameReceipt(pending, receipt);
  const undo = async () => {
    const key = `${receipt.target}:${receipt.id}:${receipt.generation}:${receipt.mutationToken}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setPending(receipt); setError(null);
    try {
      if (receipt.target === 'question') await presentInboxQuestion(receipt.id, 'restore', receipt.generation, receipt.mutationToken);
      else await presentAttentionItem(receipt.id, 'restore', receipt.generation, receipt.mutationToken);
      if (sameReceipt(latest.current, receipt)) { latest.current = null; setReceipt(null); }
    } catch (cause) {
      if (sameReceipt(latest.current, receipt)) setError((cause as { status?: number })?.status === 409
        ? 'This item changed. Open Inbox to check its current state.'
        : cause instanceof Error ? cause.message : 'Could not restore that item. Refresh Inbox to check it.');
    } finally {
      inFlight.current.delete(key);
      setPending(current => sameReceipt(current, receipt) ? null : current);
      for (const key of ATTENTION_PRESENTATION_INVALIDATE) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
  };
  return <div role="status" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-subtle px-5 py-2.5 text-small text-fg sm:px-8">
    <span className="min-w-0 flex-1">{error ?? (receipt.target === 'question'
      ? receipt.action === 'defer' ? 'Question set aside until tomorrow. The work stays paused.' : 'Question dismissed. The work stays paused.'
      : receipt.action === 'defer' ? 'Item set aside until tomorrow. Nothing was decided.' : 'Item set aside. Nothing was decided.')}</span>
    <button type="button" onClick={() => void undo()} disabled={busy} className="rounded-md px-2 py-1 font-semibold text-primary hover:bg-hover disabled:opacity-50">{busy ? 'Restoring…' : 'Undo'}</button>
    <Link to="/inbox?tab=set-aside" className="rounded-md px-2 py-1 font-medium text-muted hover:bg-hover hover:text-fg">View set aside</Link>
    <button type="button" onClick={() => { latest.current = null; setReceipt(null); }} disabled={busy} aria-label="Dismiss confirmation" className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-hover"><X size={16} aria-hidden /></button>
  </div>;
}
