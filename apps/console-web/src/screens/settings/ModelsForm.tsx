import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, patchModels, type ModelTriple } from '@/lib/settings';

const TIERS: { key: keyof ModelTriple; label: string; hint: string }[] = [
  { key: 'fast', label: 'Fast', hint: 'Quick, cheap replies' },
  { key: 'primary', label: 'Primary', hint: 'Everyday work' },
  { key: 'deep', label: 'Deep', hint: 'Hard reasoning' },
];

export function ModelsForm() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const snap = settings.data?.models;
  const [form, setForm] = useState<ModelTriple | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { if (snap?.models && !form) setForm({ ...snap.models }); }, [snap, form]);

  if (settings.isLoading) return <Card className="p-5"><Skeleton className="h-40 w-full" /></Card>;
  if (!form || !snap) return (
    <Card className="p-5 text-body text-muted">Couldn't load model settings.{' '}
      <button type="button" onClick={() => settings.refetch()} className="text-primary hover:underline cursor-pointer">Try again</button>
    </Card>
  );

  // Build the option list: presets + any current value not already listed.
  const optionIds = new Set(snap.presets.map((p) => p.id));
  const set = (k: keyof ModelTriple, v: string) => { setForm((f) => (f ? { ...f, [k]: v } : f)); setSaved(false); };

  const save = async () => {
    setSaving(true);
    try { await patchModels(form); setSaved(true); void qc.invalidateQueries({ queryKey: ['settings'] }); }
    finally { setSaving(false); }
  };
  const reset = async () => {
    setSaving(true);
    try { await patchModels(snap.defaults); setForm({ ...snap.defaults }); setSaved(true); void qc.invalidateQueries({ queryKey: ['settings'] }); }
    finally { setSaving(false); }
  };

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Models</h3>
      <p className="mb-4 text-small text-muted">Which model Clementine uses for each kind of work.</p>
      <div className="grid gap-x-4 sm:grid-cols-3">
        {TIERS.map((t) => (
          <Field key={t.key} label={t.label} hint={t.hint}>{(id) => (
            <Select id={id} value={form[t.key]} onChange={(e) => set(t.key, e.target.value)}>
              {snap.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              {!optionIds.has(form[t.key]) && <option value={form[t.key]}>{form[t.key]} (custom)</option>}
            </Select>
          )}</Field>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save models'}</Button>
        <Button variant="ghost" size="sm" onClick={reset} disabled={saving}>Reset to defaults</Button>
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved</span>}
      </div>
    </Card>
  );
}
