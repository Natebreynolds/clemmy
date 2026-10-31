import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Monitor, Play, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { usePendingCommit } from '@/lib/pending-commit';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { EmptyState } from '@/components/ui/EmptyState';

interface ComputerTaskRow { id: string; name: string; createdAt: string; steps: number }

/** Things Clem did on the computer, kept as steps that repeat with no AI:
 *  each target is found again by name, and a step that no longer matches
 *  stops the repeat so Clem can finish it. */
export function ComputerTasks() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['computer-tasks'], queryFn: () => api<{ tasks: ComputerTaskRow[] }>('/api/console/computer-tasks') });
  const commit = usePendingCommit('computer-tasks');
  const [busy, setBusy] = useState<{ id: string; action: 'repeat' | 'remove' } | null>(null);
  const [problem, setProblem] = useState<{ task: ComputerTaskRow; action: 'repeat' | 'remove'; text: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [said, setSaid] = useState<Record<string, string>>({});

  async function repeat(task: ComputerTaskRow) {
    const token = commit.begin();
    if (!token) return;
    setBusy({ id: task.id, action: 'repeat' }); setProblem(null); setNotice('');
    setSaid(current => ({ ...current, [task.id]: '' }));
    try {
      const result = await api<{ summary: string }>(`/api/console/computer-tasks/${encodeURIComponent(task.id)}/repeat`, { method: 'POST' });
      if (commit.owns(token)) setSaid(current => ({ ...current, [task.id]: result.summary }));
    } catch (cause) {
      if (commit.owns(token)) setProblem({ task, action: 'repeat', text: cause instanceof Error ? cause.message : 'The repeat could not be confirmed. Review the task before choosing Repeat again.' });
    } finally { if (commit.finish(token)) setBusy(null); }
  }

  async function remove(task: ComputerTaskRow) {
    const token = commit.begin();
    if (!token) return;
    setBusy({ id: task.id, action: 'remove' }); setProblem(null); setNotice('');
    try {
      await api(`/api/console/computer-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      if (!commit.owns(token)) return;
      await qc.invalidateQueries({ queryKey: ['computer-tasks'] });
      if (commit.owns(token)) setNotice(`Removed “${task.name}”.`);
    } catch (cause) {
      if (commit.owns(token)) setProblem({ task, action: 'remove', text: cause instanceof Error ? cause.message : 'It could not be removed.' });
    } finally { if (commit.finish(token)) setBusy(null); }
  }

  if (tasks.isLoading && !tasks.data) return <p className="text-small text-muted" role="status">Loading…</p>;
  if (tasks.isError && !tasks.data) return <QueryUnavailable title="Computer tasks couldn’t load" description="Try loading your saved computer tasks again." onRetry={() => void tasks.refetch()} />;
  const rows = tasks.data?.tasks ?? [];
  const feedback = <>
    {tasks.isError && <p role="status" className="text-small text-warning">Computer tasks couldn’t refresh. Showing the last loaded list. <button type="button" className="font-semibold underline" onClick={() => void tasks.refetch()}>Retry</button></p>}
    {problem && <div role="alert" className="text-small text-danger"><p>{problem.action === 'remove' ? 'Couldn’t remove' : 'Couldn’t confirm the repeat of'} “{problem.task.name}”: {problem.text}</p>{problem.action === 'remove' && <button type="button" disabled={busy !== null} className="mt-1 min-h-9 font-semibold underline" onClick={() => void remove(problem.task)}>Retry removal</button>}</div>}
    {notice && <p role="status" className="text-small text-muted">{notice}</p>}
  </>;
  if (rows.length === 0) {
    return <div className="space-y-3">{feedback}<EmptyState title={tasks.isError ? 'No tasks in the last loaded list' : 'Nothing saved yet'}
      description="After Clem does something on your computer, choose “Save to repeat without AI” under her reply." /></div>;
  }
  return (
    <div className="space-y-3">
      {feedback}
      {rows.map((task) => (
        <Card key={task.id} className="flex min-w-0 flex-wrap items-center gap-3 p-4">
          <Monitor className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium text-fg">{task.name}</p>
            <p className="text-caption text-muted">{task.steps} steps · saved {new Date(task.createdAt).toLocaleDateString()}</p>
            {said[task.id] ? <p className="mt-1 text-small text-fg" role="status">{said[task.id]}</p> : null}
          </div>
          <Button size="sm" onClick={() => void repeat(task)} disabled={busy !== null}>
            {busy?.id === task.id && busy.action === 'repeat' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Repeat
          </Button>
          <Button size="icon" variant="ghost" onClick={() => void remove(task)} disabled={busy !== null} aria-label={`Remove ${task.name}`}>
            {busy?.id === task.id && busy.action === 'remove' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
          </Button>
        </Card>
      ))}
    </div>
  );
}
