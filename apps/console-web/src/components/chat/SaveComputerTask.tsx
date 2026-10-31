import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Repeat } from 'lucide-react';
import { api } from '@/lib/api';
import { usePendingCommit } from '@/lib/pending-commit';
import { COMPUTER_TASKS_HREF } from '@/lib/computer-tasks-navigation';

type SaveState = { scope: string } & ({ kind: 'idle' | 'busy' } | { kind: 'done' | 'error'; text: string });

/** Keep this exact accepted task as repeatable steps; a failed save remains retryable. */
export function SaveComputerTask({ source }: { source: { sessionId: string; sourceUserSeq: number } }) {
  const qc = useQueryClient();
  const scope = JSON.stringify([source.sessionId, source.sourceUserSeq]);
  const commit = usePendingCommit(scope);
  const owner = useRef<string | null>(scope);
  useLayoutEffect(() => {
    owner.current = scope;
    return () => { if (owner.current === scope) owner.current = null; };
  }, [scope]);
  const [state, setState] = useState<SaveState>({ scope, kind: 'idle' });
  const shown = state.scope === scope ? state : { scope, kind: 'idle' as const };
  async function save() {
    if (owner.current !== scope) return;
    const token = commit.begin();
    if (!token) return;
    setState({ scope, kind: 'busy' });
    try {
      const result = await api<{ task: { name: string } }>('/api/console/computer-tasks', { method: 'POST', body: JSON.stringify(source) });
      if (!commit.owns(token)) return;
      void qc.invalidateQueries({ queryKey: ['computer-tasks'] });
      setState({ scope, kind: 'done', text: `Saved as “${result.task.name}”. Repeat it with no AI.` });
    } catch (cause) {
      if (commit.owns(token)) setState({ scope, kind: 'error', text: cause instanceof Error ? cause.message : 'It could not be saved.' });
    } finally { commit.finish(token); }
  }
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
    {shown.kind === 'done' ? <>
      <p className="text-muted" role="status">{shown.text}</p>
      <Link to={COMPUTER_TASKS_HREF} className="inline-flex min-h-9 items-center rounded-sm font-semibold text-primary hover:underline">Open Computer tasks</Link>
    </> : <>
      {shown.kind === 'error' && <p className="basis-full text-danger" role="alert">{shown.text}</p>}
      <button type="button" onClick={() => void save()} disabled={shown.kind === 'busy'}
        className="inline-flex min-h-9 w-fit items-center gap-1.5 rounded-sm font-semibold text-primary hover:underline disabled:opacity-60">
        {shown.kind === 'busy' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Repeat className="h-3.5 w-3.5" aria-hidden />}
        {shown.kind === 'busy' ? 'Saving…' : shown.kind === 'error' ? 'Retry save' : 'Save to repeat without AI'}
      </button>
    </>}
  </div>;
}
