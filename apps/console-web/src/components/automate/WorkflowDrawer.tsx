import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Play, Trash2, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';
import { ScheduleEditor } from './ScheduleEditor';
import { detectedTimezone } from '@/lib/cron';
import { getWorkflow, patchWorkflow, deleteWorkflow, runWorkflow, type WorkflowDetail } from '@/lib/automate';

export function WorkflowDrawer({ name, onClose }: { name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [desc, setDesc] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [cron, setCron] = useState('');
  const [tz, setTz] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getWorkflow(name).then((d) => {
      if (!alive) return;
      setWf(d); setDesc(d.description ?? ''); setEnabled(!!d.enabled); setCron(d.trigger?.schedule ?? '');
      // Seed the tz so a scheduled time means the owner's time. Default to the
      // host zone when one isn't stored yet, so the picker shows a real value.
      setTz(d.trigger?.timezone || (d.trigger?.schedule ? detectedTimezone() : ''));
    }).catch((e) => alive && setError((e as Error).message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [name]);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['workflows'] }); };

  const save = async () => {
    setSaving(true); setError('');
    try {
      await patchWorkflow(name, {
        description: desc,
        enabled,
        ...(cron.trim() ? { triggerSchedule: cron.trim(), ...(tz ? { timezone: tz } : {}) } : { clearTriggerSchedule: true }),
      });
      setSaved(true); invalidate();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const run = async () => {
    setRunning(true); setError('');
    try { await runWorkflow(name); void qc.invalidateQueries({ queryKey: ['runs'] }); }
    catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    await deleteWorkflow(name); invalidate(); onClose();
  };

  return (
    <div className="fixed inset-0 z-[110] flex justify-end bg-black/30 animate-fade-in" onMouseDown={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-surface shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="min-w-0 flex-1 truncate text-h2 text-fg">{name}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-5 w-5" aria-hidden /></Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {loading ? <Skeleton className="h-64 w-full" /> : !wf ? (
            <p className="text-body text-danger">{error || 'Could not load this workflow.'}</p>
          ) : (
            <>
              <div className="mb-4 flex items-center gap-3 rounded-md border border-border bg-subtle px-3.5 py-3">
                <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
                <span className="text-body text-fg">{enabled ? 'On — runs on its schedule' : 'Off — won’t run automatically'}</span>
              </div>

              <label className="mb-1.5 block text-label text-fg">What it does</label>
              <Textarea value={desc} onChange={(e) => { setDesc(e.target.value); setSaved(false); }} placeholder="Describe what this workflow does…" />

              <label className="mb-1.5 mt-4 block text-label text-fg">When it runs</label>
              <ScheduleEditor value={cron} onChange={(c) => { setCron(c); setSaved(false); }}
                timezone={tz} onTimezoneChange={(z) => { setTz(z); setSaved(false); }} />

              <h3 className="mb-2 mt-5 text-h3 text-fg">Steps</h3>
              <ol className="space-y-2">
                {(wf.steps ?? []).map((s, i) => (
                  <li key={s.id || i} className="rounded-md border border-border px-3.5 py-2.5">
                    <div className="text-body font-medium text-fg">{i + 1}. {s.name || s.id || `Step ${i + 1}`}</div>
                    {s.prompt && <p className="mt-0.5 line-clamp-2 text-small text-muted">{s.prompt}</p>}
                  </li>
                ))}
                {(!wf.steps || wf.steps.length === 0) && <li className="text-body text-muted">No steps defined.</li>}
              </ol>
              <p className="mt-2 text-caption text-faint">To change the steps, ask Clementine in Chat — it'll rewrite the workflow for you.</p>

              {error && <p className="mt-3 text-small text-danger">{error}</p>}
            </>
          )}
        </div>

        {!loading && wf && (
          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved</span>}
            <Button variant="secondary" onClick={run} disabled={running}>{running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run now</Button>
            <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete workflow" title="Delete" className="ml-auto text-danger"><Trash2 className="h-4 w-4" aria-hidden /></Button>
          </div>
        )}
      </div>
    </div>
  );
}
