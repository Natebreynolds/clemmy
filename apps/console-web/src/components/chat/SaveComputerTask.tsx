import { useState } from 'react';
import { Repeat } from 'lucide-react';
import { api } from '@/lib/api';

/** Under a reply where Clem used the computer: keep what she did as steps
 *  that repeat with no AI. A task that cannot repeat faithfully says why. */
export function SaveComputerTask({ source }: { source: { sessionId: string; sourceUserSeq: number } }) {
  const [state, setState] = useState<{ kind: 'idle' | 'busy' } | { kind: 'done'; text: string }>({ kind: 'idle' });
  async function save() {
    setState({ kind: 'busy' });
    try {
      const result = await api<{ task: { name: string } }>('/api/console/computer-tasks', { method: 'POST', body: JSON.stringify(source) });
      setState({ kind: 'done', text: `Saved as “${result.task.name}”. Repeat it from Automations → Computer tasks, with no AI.` });
    } catch (cause) {
      setState({ kind: 'done', text: cause instanceof Error ? cause.message : 'It could not be saved.' });
    }
  }
  if (state.kind === 'done') return <p className="text-caption text-muted" role="status">{state.text}</p>;
  return (
    <button type="button" onClick={() => void save()} disabled={state.kind === 'busy'}
      className="inline-flex w-fit items-center gap-1.5 text-caption font-semibold text-primary hover:underline disabled:opacity-60">
      <Repeat className="h-3.5 w-3.5" aria-hidden /> Save to repeat without AI
    </button>
  );
}
