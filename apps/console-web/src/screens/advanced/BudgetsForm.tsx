import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, patchBudget, type BudgetSettings } from '@/lib/settings';
import { cn } from '@/lib/cn';

const PRESETS: { key: NonNullable<BudgetSettings['preset']>; label: string; desc: string }[] = [
  { key: 'standard', label: 'Standard', desc: 'Quick tasks, asks often' },
  { key: 'long', label: 'Long', desc: 'Bigger jobs, keeps going' },
  { key: 'unlimited', label: 'Unlimited', desc: 'Supervised, runs far' },
];

export function BudgetsForm() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const [form, setForm] = useState<BudgetSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Live values are nested under runtimeBudget.settings (snapshot shape).
    const b = settings.data?.runtimeBudget?.settings;
    if (b && !form) {
      setForm({ preset: b.preset, maxConversationSteps: b.maxConversationSteps, maxConversationWallMinutes: b.maxConversationWallMinutes, maxTurns: b.maxTurns, toolCallsPerTurn: b.toolCallsPerTurn, checkInMinutes: b.checkInMinutes, autoContinueOnLimit: b.autoContinueOnLimit });
    }
  }, [settings.data, form]);

  const applyPreset = async (preset: NonNullable<BudgetSettings['preset']>) => {
    await patchBudget({ preset });
    setForm(null); // reseed from server defaults
    void qc.invalidateQueries({ queryKey: ['settings'] });
  };

  const set = <K extends keyof BudgetSettings>(k: K, v: BudgetSettings[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); setSaved(false); };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await patchBudget({ maxConversationSteps: form.maxConversationSteps, maxConversationWallMinutes: form.maxConversationWallMinutes, maxTurns: form.maxTurns, toolCallsPerTurn: form.toolCallsPerTurn, checkInMinutes: form.checkInMinutes, autoContinueOnLimit: form.autoContinueOnLimit });
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } finally { setSaving(false); }
  };

  return (
    <Page title="Run limits" subtitle="How far a run goes before it pauses or stops" width="reading">
      {settings.isLoading ? <Card className="p-5"><Skeleton className="h-64 w-full" /></Card> : !form ? (
        <Card className="p-5 text-body text-muted">Couldn't load settings.{' '}
          <button type="button" onClick={() => settings.refetch()} className="text-primary hover:underline cursor-pointer">Try again</button>
        </Card>
      ) : (
        <Card className="p-5">
          <h3 className="mb-1 text-h3 text-fg">Work mode</h3>
          <p className="mb-3 text-small text-muted">Pick a preset, then fine-tune below if you like.</p>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            {PRESETS.map((p) => (
              <button key={p.key} type="button" onClick={() => applyPreset(p.key)}
                className={cn('rounded-md border px-4 py-3 text-left transition-colors cursor-pointer',
                  form.preset === p.key ? 'border-primary bg-primary-tint' : 'border-border hover:bg-hover')}>
                <div className={cn('text-body font-semibold', form.preset === p.key ? 'text-primary' : 'text-fg')}>{p.label}</div>
                <div className="text-caption text-muted">{p.desc}</div>
              </button>
            ))}
          </div>

          <h3 className="mb-1 text-h3 text-fg">Cap how far a run can go</h3>
          <p className="mb-3 text-small text-muted">Hard limits — a run stops (or checks in) when it hits any of these, whatever the preset. Lower them to keep runs short; raise them to let a big job (e.g. scraping + enriching 100 leads) finish without pausing.</p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="Max steps (whole run)" hint="Total tool calls across the run before it pauses — the main cap for long, multi-item jobs.">{(id) => <Input id={id} type="number" min={1} value={form.maxConversationSteps ?? ''} onChange={(e) => set('maxConversationSteps', e.target.value === '' ? undefined : Number(e.target.value))} />}</Field>
            <Field label="Max run time (minutes)" hint="Wall-clock cutoff for the whole run. 0 = no time cap.">{(id) => <Input id={id} type="number" min={0} value={form.maxConversationWallMinutes ?? ''} onChange={(e) => set('maxConversationWallMinutes', e.target.value === '' ? undefined : Number(e.target.value))} />}</Field>
            <Field label="Max turns" hint="Conversation turns before pausing.">{(id) => <Input id={id} type="number" min={1} value={form.maxTurns ?? ''} onChange={(e) => set('maxTurns', e.target.value === '' ? undefined : Number(e.target.value))} />}</Field>
            <Field label="Tool calls per turn" hint="Cap within a single turn.">{(id) => <Input id={id} type="number" min={1} value={form.toolCallsPerTurn ?? ''} onChange={(e) => set('toolCallsPerTurn', e.target.value === '' ? undefined : Number(e.target.value))} />}</Field>
            <Field label="Check in every (minutes)">{(id) => <Input id={id} type="number" min={1} value={form.checkInMinutes ?? ''} onChange={(e) => set('checkInMinutes', e.target.value === '' ? undefined : Number(e.target.value))} />}</Field>
          </div>
          <div className="mb-5 flex items-center gap-3">
            <Switch checked={!!form.autoContinueOnLimit} onChange={(v) => set('autoContinueOnLimit', v)} label="Auto-continue on limit" />
            <span className="text-body text-fg">Keep going automatically when a limit is hit</span>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved</span>}
          </div>
        </Card>
      )}
    </Page>
  );
}
