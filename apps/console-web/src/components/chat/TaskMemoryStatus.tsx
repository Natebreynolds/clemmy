/** Current memory subwork beneath its original reply. The answer and terminal
 * above remain historical; checking here never resends the request. */
import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getTaskMemoryStatus, memoryWorkLinks, memoryWorkPresentation, watchTaskMemoryStatus, type MemoryReadState } from '@/lib/task-memory-status';

export function TaskMemoryStatus({ sessionId, sourceUserSeq }: { sessionId: string; sourceUserSeq: number }) {
  return <MemoryStatusForSource key={JSON.stringify([sessionId, sourceUserSeq])} sessionId={sessionId} sourceUserSeq={sourceUserSeq} />;
}

function MemoryStatusForSource({ sessionId, sourceUserSeq }: { sessionId: string; sourceUserSeq: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [tabVisible, setTabVisible] = useState(() => typeof document !== 'undefined' && document.visibilityState !== 'hidden');
  const [state, setState] = useState<MemoryReadState>({ phase: 'loading', paused: false });
  const reader = useRef<ReturnType<typeof watchTaskMemoryStatus> | null>(null);
  const deadline = useRef<number | null>(null);
  useEffect(() => {
    const visibility = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', visibility);
    const node = container.current;
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting))) : null;
    if (node && observer) observer.observe(node);
    else setInView(true);
    return () => { document.removeEventListener('visibilitychange', visibility); observer?.disconnect(); };
  }, []);
  useEffect(() => {
    if (!inView || !tabVisible) return;
    if (deadline.current === null) deadline.current = Date.now() + 60_000;
    const active = watchTaskMemoryStatus({ read: (signal) => getTaskMemoryStatus(sessionId, sourceUserSeq, signal), onState: setState, deadline: deadline.current });
    reader.current = active;
    return () => { active.dispose(); if (reader.current === active) reader.current = null; };
  }, [sessionId, sourceUserSeq, inView, tabVisible]);
  return (
    <div ref={container} className="mt-3 min-w-0 max-w-full border-t border-border pt-3">
      <TaskMemoryStatusContent state={state} onCheck={() => reader.current?.check()} />
    </div>
  );
}

/** Controlled preview and shared presentation for full details: no reads of
 * its own, no implicit Continue and no write or default-scope action. */
export function TaskMemoryStatusContent({ state, onCheck }: { state: MemoryReadState; onCheck?: () => void }) {
  const stale = state.phase === 'error';
  const loading = state.phase === 'loading';
  const current = state.value;
  const presentation = memoryWorkPresentation(current?.memory ?? null);
  const title = stale ? 'Couldn’t check the memory result' : loading ? 'Checking this memory request…' : presentation.title;
  const links = !stale && !loading && current ? memoryWorkLinks(current.memory) : [];
  return (
    <section className="min-w-0 max-w-full text-small" aria-label="Current memory request status" aria-busy={state.phase === 'loading'}>
      <div className="flex min-w-0 items-start gap-2">
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="break-words font-medium text-fg [overflow-wrap:anywhere]" role="status">{title}</p>
          <p className="break-words text-caption text-muted [overflow-wrap:anywhere]">
            {stale ? 'The last status may be out of date. Check again to read the current result; this won’t repeat the request.'
              : loading ? 'Reading the current status without repeating the request.' : presentation.detail}
          </p>
          {current && !stale && !loading && <p className="text-caption text-muted">Memory work only. The reply above shows how the original turn ended.</p>}
          {!stale && state.paused && <p className="text-caption text-muted">Automatic checks paused. Check status whenever you’re ready.</p>}
          {links.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1">
            {links.map(({ id, href }, index) => <Link key={id} to={href} className="inline-flex min-h-9 items-center rounded-sm text-caption font-medium text-primary-ink underline underline-offset-4 hover:text-primary-ink-hover">{links.length === 1 ? 'View this memory' : `View memory ${index + 1}`}</Link>)}
          </div>}
          {onCheck && <button type="button" onClick={onCheck} disabled={state.phase === 'loading'} className="inline-flex min-h-9 max-w-full items-center rounded-sm text-caption font-semibold text-primary-ink underline underline-offset-4 hover:text-primary-ink-hover disabled:cursor-wait disabled:opacity-60">Check status</button>}
        </div>
      </div>
    </section>
  );
}
