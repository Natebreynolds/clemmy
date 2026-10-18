/** A fact linked from one task opens by identity, without mounting Memory's
 * overview queries. All mutations stay owned by this mounted record. */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Brain } from 'lucide-react';
import { humanToolLabel } from '@clem/chat-engine';
import { Page } from '@/components/Page';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { ScopeChip } from './ScopeChip';
import { forgetFact, getFactDetail, restoreFact, updateFact, type Fact } from '@/lib/memory';
import { memoryFactHref } from '@/lib/memory-fact-links';
import { assertExactFactAction, assertMemoryChange, correctedFactId, exactFactState, expectedMemorySnapshot, memoryDetailReadError, type ExactFactAction } from '@/lib/memory-fact-detail';

type ReadState = { kind: 'loading' | 'missing' | 'unauthenticated' | 'unavailable' } | { kind: 'ready'; fact: Fact };

export function ExactMemoryDetail({ factId }: { factId: number | null }) {
  if (factId === null) return (
    <Page title="Memory" width="reading">
      <MemoryBackLink />
      <h2 className="mt-5 text-h2 font-semibold text-fg">This memory link isn’t valid</h2>
      <p className="mt-2 text-body text-muted">Open the memory from the reply again, or browse your saved memories.</p>
    </Page>
  );
  return <ExactMemoryRecord key={factId} factId={factId} />;
}

function MemoryBackLink() {
  return <Link to="/memory" className="inline-flex min-h-9 items-center gap-1.5 rounded-sm text-small font-medium text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" aria-hidden />All memory</Link>;
}

function shownDate(value: string | null | undefined): string | null {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;
}

function ExactMemoryRecord({ factId }: { factId: number }) {
  const navigate = useNavigate();
  const [state, setState] = useState<ReadState>({ kind: 'loading' });
  const [readVersion, setReadVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<ExactFactAction | null>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [changeBlocked, setChangeBlocked] = useState(false);
  const keepDraftOnRead = useRef(false);
  const alive = useRef(false);
  const actionOwned = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); if (alive.current) setState({ kind: 'unavailable' }); }, 20_000);
    setState({ kind: 'loading' });
    if (!keepDraftOnRead.current) setEditing(false);
    void getFactDetail(factId, controller.signal)
      .then((fact) => { if (!controller.signal.aborted) {
        setState({ kind: 'ready', fact }); setChangeBlocked(false);
        if (!keepDraftOnRead.current) setDraft(fact.content);
        keepDraftOnRead.current = false;
      } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ kind: memoryDetailReadError(error) }); })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [factId, readVersion]);

  const readAgain = () => { keepDraftOnRead.current = editing; setActionError(''); setReadVersion((version) => version + 1); };
  const change = async (action: ExactFactAction) => {
    if (actionOwned.current || changeBlocked || state.kind !== 'ready') return;
    actionOwned.current = true;
    setBusy(action);
    setActionError('');
    setNotice('');
    try {
      assertExactFactAction(state.fact, action);
      // The server compares this exact displayed snapshot atomically with
      // the write. A changed memory is never silently accepted or retried.
      const expected = expectedMemorySnapshot(state.fact);
      if (action === 'correct') {
        const result = await updateFact(factId, { content: draft.trim() }, expected);
        const successor = correctedFactId(result);
        if (!alive.current) return;
        setEditing(false);
        if (successor !== factId) navigate(memoryFactHref(successor)!);
        else { setNotice('This memory already matches your correction.'); readAgain(); }
      } else {
        const result = action === 'forget' ? await forgetFact(factId, expected) : await restoreFact(factId, expected);
        assertMemoryChange(result);
        if (!alive.current) return;
        setNotice(action === 'forget' ? 'Forgotten. This memory is now inactive.' : 'Restored. This memory is active again.');
        readAgain();
      }
    } catch (error: unknown) {
      if (alive.current) {
        setChangeBlocked(true);
        if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
          keepDraftOnRead.current = action === 'correct';
          setActionError(`This memory changed while you were viewing it.${action === 'correct' ? ' Your correction is kept below.' : ''} Review the current record before making another change.`);
          setReadVersion((version) => version + 1);
        } else setActionError('The change wasn’t confirmed. Read the memory again before trying another change.');
      }
    } finally {
      actionOwned.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const fact = state.kind === 'ready' ? state.fact : null;
  const status = fact ? exactFactState(fact) : null;
  const successorHref = status?.successorId && status.successorId !== factId ? memoryFactHref(status.successorId) : null;
  const created = shownDate(fact?.createdAt);
  const updated = shownDate(fact?.updatedAt);
  return (
    <Page title="Memory" width="reading">
      <MemoryBackLink />
      {state.kind === 'loading' && <div className="mt-5 space-y-3" role="status"><span className="sr-only">Reading this memory…</span><Skeleton className="h-5 w-40" /><Skeleton className="h-24 w-full" /></div>}
      {(state.kind === 'missing' || state.kind === 'unauthenticated' || state.kind === 'unavailable') && (
        <div className="mt-5">
          <h2 className="text-h2 font-semibold text-fg">{state.kind === 'missing' ? 'This memory wasn’t found' : state.kind === 'unauthenticated' ? 'Clementine needs to reconnect' : 'Couldn’t read this memory'}</h2>
          <p className="mt-2 text-body text-muted">{state.kind === 'missing' ? 'The original record may no longer be retained. No replacement has been opened.' : state.kind === 'unauthenticated' ? 'Reconnect or reopen Clementine, then read this memory again.' : 'Your local service may be busy or reconnecting. You can try reading it again.'}</p>
          <Button variant="secondary" className="mt-4" onClick={readAgain}>Read again</Button>
        </div>
      )}
      {fact && status && (
        <article className="mt-5 min-w-0 space-y-6">
          <header className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-small text-muted"><Brain className="h-4 w-4" aria-hidden /><span>{fact.kind === 'feedback' ? 'Saved preference' : fact.kind === 'constraint' ? 'Saved instruction' : 'Saved memory'}</span>{fact.scope ? <ScopeChip scope={fact.scope} /> : <span>Scope not recorded</span>}</div>
            <h2 className="text-h2 font-semibold text-fg">{status.label}</h2>
            <p className="text-small text-muted">{status.description}</p>
            {successorHref && <Link to={successorHref} className="inline-flex min-h-9 items-center gap-1.5 rounded-sm font-semibold text-primary-ink underline underline-offset-4 hover:text-primary-ink-hover">View updated memory<ArrowRight className="h-4 w-4" aria-hidden /></Link>}
          </header>
          {editing ? (
            <section className="space-y-3" aria-label="Correct this memory">
              <div className="space-y-1.5">
                <h3 className="text-small font-semibold text-fg">Current saved memory</h3>
                <p className="whitespace-pre-wrap break-words text-small text-muted [overflow-wrap:anywhere]">{fact.content}</p>
              </div>
              <label htmlFor={`memory-correction-${factId}`} className="block text-small font-semibold text-fg">What should Clem remember instead?</label>
              <Textarea id={`memory-correction-${factId}`} value={draft} onChange={(event) => setDraft(event.target.value)} rows={5} maxLength={800} disabled={Boolean(busy)} />
              <p className="text-caption text-muted">A correction keeps this original record and opens the updated memory. {draft.length}/800 characters.</p>
              <div className="flex flex-wrap gap-2"><Button disabled={Boolean(busy) || changeBlocked || !status.editable || !draft.trim() || draft.trim() === fact.content || draft.length > 800} onClick={() => void change('correct')}>{busy === 'correct' ? 'Saving…' : 'Save correction'}</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={() => { setEditing(false); setDraft(fact.content); }}>Cancel</Button></div>
            </section>
          ) : <p className="whitespace-pre-wrap break-words text-body-lg text-fg [overflow-wrap:anywhere]">{fact.content}</p>}
          {!editing && (status.editable || status.restorable) && (
            <div className="flex flex-wrap gap-2">
              {status.editable && <><Button disabled={Boolean(busy) || changeBlocked} onClick={() => { setEditing(true); setDraft(fact.content); }}>Correct memory</Button><Button variant="ghost" disabled={Boolean(busy) || changeBlocked} onClick={() => void change('forget')}>{busy === 'forget' ? 'Forgetting…' : 'Forget'}</Button></>}
              {status.restorable && <Button variant="secondary" disabled={Boolean(busy) || changeBlocked} onClick={() => void change('restore')}>{busy === 'restore' ? 'Restoring…' : 'Restore memory'}</Button>}
            </div>
          )}
          {actionError && <div className="space-y-2" role="alert"><p className="text-small text-danger">{actionError}</p><Button variant="secondary" disabled={Boolean(busy)} onClick={readAgain}>Read again</Button></div>}
          {notice && <p className="text-small text-muted" role="status">{notice}</p>}
          <section className="space-y-3 border-t border-border pt-5" aria-label="Where this memory came from">
            <h3 className="text-body font-semibold text-fg">Where it came from</h3>
            {fact.derivedFrom?.tool && <p className="break-words text-small text-muted [overflow-wrap:anywhere]">Learned from a tool result: {humanToolLabel(fact.derivedFrom.tool)}</p>}
            {fact.evidence?.length ? <ul className="space-y-4">{fact.evidence.map((source, index) => <li key={`${source.episodeId}:${index}`} className="space-y-1"><p className="text-caption text-muted">Saved source {index + 1}{shownDate(source.occurredAt) ? ` · ${shownDate(source.occurredAt)}` : ''}</p><blockquote className="whitespace-pre-wrap break-words text-small text-fg [overflow-wrap:anywhere]">{source.excerpt || 'The source excerpt is no longer retained.'}</blockquote></li>)}</ul> : <p className="text-small text-muted">No source excerpt is retained for this memory.</p>}
            {(created || updated) && <p className="text-caption text-muted">{created ? `Saved ${created}` : ''}{created && updated ? ' · ' : ''}{updated ? `Last changed ${updated}` : ''}</p>}
          </section>
        </article>
      )}
    </Page>
  );
}
