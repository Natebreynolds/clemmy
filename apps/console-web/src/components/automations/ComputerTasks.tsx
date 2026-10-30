import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Monitor, Play, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

interface ComputerTaskRow { id: string; name: string; createdAt: string; steps: number }

/** Things Clem did on the computer, kept as steps that repeat with no AI:
 *  each target is found again by name, and a step that no longer matches
 *  stops the repeat so Clem can finish it. */
export function ComputerTasks() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['computer-tasks'], queryFn: () => api<{ tasks: ComputerTaskRow[] }>('/api/console/computer-tasks') });
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});

  async function repeat(task: ComputerTaskRow) {
    setBusy(task.id);
    try {
      const result = await api<{ summary: string }>(`/api/console/computer-tasks/${encodeURIComponent(task.id)}/repeat`, { method: 'POST' });
      setSaid((current) => ({ ...current, [task.id]: result.summary }));
    } catch (cause) {
      setSaid((current) => ({ ...current, [task.id]: cause instanceof Error ? cause.message : 'It could not run.' }));
    } finally { setBusy(null); }
  }

  async function remove(task: ComputerTaskRow) {
    setBusy(task.id);
    try {
      await api(`/api/console/computer-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['computer-tasks'] });
    } finally { setBusy(null); }
  }

  if (tasks.isLoading) return <p className="text-small text-muted" role="status">Loading…</p>;
  const rows = tasks.data?.tasks ?? [];
  if (rows.length === 0) {
    return <EmptyState title="Nothing saved yet"
      description="After Clem does something on your computer, choose “Save to repeat without AI” under her reply." />;
  }
  return (
    <div className="space-y-3">
      {rows.map((task) => (
        <Card key={task.id} className="flex min-w-0 flex-wrap items-center gap-3 p-4">
          <Monitor className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium text-fg">{task.name}</p>
            <p className="text-caption text-muted">{task.steps} steps · saved {new Date(task.createdAt).toLocaleDateString()}</p>
            {said[task.id] ? <p className="mt-1 text-small text-fg" role="status">{said[task.id]}</p> : null}
          </div>
          <Button size="sm" onClick={() => void repeat(task)} disabled={busy !== null}>
            {busy === task.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Repeat
          </Button>
          <Button size="icon" variant="ghost" onClick={() => void remove(task)} disabled={busy !== null} aria-label={`Remove ${task.name}`}>
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </Card>
      ))}
    </div>
  );
}
