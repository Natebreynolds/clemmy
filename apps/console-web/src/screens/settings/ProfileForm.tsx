import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { timezoneOptions } from '@/lib/cron';
import { getSettings, patchProfile, type UserProfile } from '@/lib/settings';

export function ProfileForm() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const [form, setForm] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (settings.data?.profile && !form) setForm({ ...settings.data.profile });
  }, [settings.data, form]);

  const set = <K extends keyof UserProfile>(k: K, v: UserProfile[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setSaved(false);
  };

  const save = async () => {
    if (!form) return;
    setSaving(true); setError('');
    try {
      await patchProfile(form);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['context'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };

  if (settings.isLoading) return <Card className="p-5"><Skeleton className="h-64 w-full" /></Card>;
  if (!form) return (
    <Card className="p-5 text-body text-muted">
      Couldn't load your profile.{' '}
      <button type="button" onClick={() => settings.refetch()} className="text-primary hover:underline cursor-pointer">Try again</button>
    </Card>
  );

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Profile</h3>
      <p className="mb-4 text-small text-muted">Tell Clementine how you'd like to be treated. It reads this on every turn.</p>

      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Preferred name">{(id) => <Input id={id} value={form.preferredName ?? ''} onChange={(e) => set('preferredName', e.target.value)} placeholder="What should I call you?" />}</Field>
        <Field label="Role">{(id) => <Input id={id} value={form.role ?? ''} onChange={(e) => set('role', e.target.value)} placeholder="e.g. Founder, Coach" />}</Field>
        <Field label="Timezone">{(id) => (
          <Select id={id} value={form.timezone ?? ''} onChange={(e) => set('timezone', e.target.value)}>
            <option value="">Use system default</option>
            {timezoneOptions().map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </Select>
        )}</Field>
        <Field label="Tone">{(id) => (
          <Select id={id} value={form.communicationTone ?? 'balanced'} onChange={(e) => set('communicationTone', e.target.value as UserProfile['communicationTone'])}>
            <option value="terse">Concise</option>
            <option value="balanced">Balanced</option>
            <option value="verbose">Detailed</option>
          </Select>
        )}</Field>
        <Field label="Formality">{(id) => (
          <Select id={id} value={form.formality ?? 'professional'} onChange={(e) => set('formality', e.target.value as UserProfile['formality'])}>
            <option value="casual">Casual</option>
            <option value="professional">Professional</option>
            <option value="formal">Formal</option>
          </Select>
        )}</Field>
        <Field label="Urgency tolerance" hint="How readily Clementine should interrupt you.">{(id) => (
          <Select id={id} value={form.urgencyTolerance ?? 'normal'} onChange={(e) => set('urgencyTolerance', e.target.value as UserProfile['urgencyTolerance'])}>
            <option value="low">Low — only when important</option>
            <option value="normal">Normal</option>
            <option value="high">High — keep me posted</option>
          </Select>
        )}</Field>
        <Field label="Working hours start">{(id) => <Input id={id} type="time" value={form.workingHoursStart ?? ''} onChange={(e) => set('workingHoursStart', e.target.value)} />}</Field>
        <Field label="Working hours end">{(id) => <Input id={id} type="time" value={form.workingHoursEnd ?? ''} onChange={(e) => set('workingHoursEnd', e.target.value)} />}</Field>
      </div>
      <Field label="Notes" hint="Anything else Clementine should keep in mind.">{(id) => <Textarea id={id} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />}</Field>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved</span>}
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </Card>
  );
}
