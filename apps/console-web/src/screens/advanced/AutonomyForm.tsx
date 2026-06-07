import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, patchPolicy, type Policy } from '@/lib/settings';

function ToggleRow({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 border-t border-border py-3 first:border-t-0">
      <div className="flex-1">
        <div className="text-body font-medium text-fg">{label}</div>
        <div className="text-caption text-muted">{desc}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

export function AutonomyForm() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const [form, setForm] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data?.proactivity?.policy && !form) setForm({ ...settings.data.proactivity.policy });
  }, [settings.data, form]);

  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); setSaved(false); };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try { await patchPolicy(form); setSaved(true); void qc.invalidateQueries({ queryKey: ['settings'] }); void qc.invalidateQueries({ queryKey: ['command-center'] }); }
    finally { setSaving(false); }
  };

  return (
    <Page title="Autonomy" subtitle="When Clementine acts on its own" width="reading">
      {settings.isLoading ? <Card className="p-5"><Skeleton className="h-72 w-full" /></Card> : !form ? (
        <Card className="p-5 text-body text-muted">Couldn't load settings.{' '}
          <button type="button" onClick={() => settings.refetch()} className="text-primary hover:underline cursor-pointer">Try again</button>
        </Card>
      ) : (
        <Card className="p-5">
          <ToggleRow label="Proactive work" desc="Let Clementine start helpful work without being asked." checked={!!form.enabled} onChange={(v) => set('enabled', v)} />

          <div className="grid gap-x-4 pt-4 sm:grid-cols-2">
            <Field label="Mode">{(id) => (
              <Select id={id} value={form.mode ?? 'balanced'} onChange={(e) => set('mode', e.target.value as Policy['mode'])}>
                <option value="watch">Watch — observe and notify</option>
                <option value="balanced">Balanced</option>
                <option value="hands_on">Hands-on — drive forward</option>
              </Select>
            )}</Field>
            <Field label="Auto-approve scope" hint="What Clementine can do without asking.">{(id) => (
              <Select id={id} value={form.autoApproveScope ?? 'strict'} onChange={(e) => set('autoApproveScope', e.target.value as Policy['autoApproveScope'])}>
                <option value="strict">Strict — ask before any action</option>
                <option value="balanced">Balanced</option>
                <option value="workspace">Workspace — auto inside your folders</option>
                <option value="yolo">YOLO — auto everywhere (careful)</option>
              </Select>
            )}</Field>
            <Field label="Check in every (minutes)">{(id) => <Input id={id} type="number" min={1} value={form.checkInMinutes ?? ''} onChange={(e) => set('checkInMinutes', Number(e.target.value))} />}</Field>
          </div>

          <h3 className="mb-1 mt-4 text-h3 text-fg">Quiet hours</h3>
          <ToggleRow label="Enable quiet hours" desc="Stay quiet during these times." checked={!!form.quietHoursEnabled} onChange={(v) => set('quietHoursEnabled', v)} />
          {form.quietHoursEnabled && (
            <div className="grid gap-x-4 pt-3 sm:grid-cols-2">
              <Field label="From">{(id) => <Input id={id} type="time" value={form.quietHoursStart ?? ''} onChange={(e) => set('quietHoursStart', e.target.value)} />}</Field>
              <Field label="To">{(id) => <Input id={id} type="time" value={form.quietHoursEnd ?? ''} onChange={(e) => set('quietHoursEnd', e.target.value)} />}</Field>
            </div>
          )}

          <h3 className="mb-2 mt-4 text-h3 text-fg">What Clementine is allowed to do</h3>
          <ToggleRow label="Use connected apps" desc="Gmail, Calendar, Slack, etc." checked={!!form.allowComposioActions} onChange={(v) => set('allowComposioActions', v)} />
          <ToggleRow label="Control the computer" desc="Run commands and use the browser." checked={!!form.allowComputerActions} onChange={(v) => set('allowComputerActions', v)} />
          <ToggleRow label="Reach out on Discord" desc="Proactive check-ins via Discord." checked={!!form.allowDiscordCheckIns} onChange={(v) => set('allowDiscordCheckIns', v)} />
          <ToggleRow label="Require approval to run workflows" desc="Confirm before a workflow executes." checked={!!form.requireWorkflowApprovalForExecution} onChange={(v) => set('requireWorkflowApprovalForExecution', v)} />

          <div className="mt-5 flex items-center gap-3">
            <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved</span>}
          </div>
        </Card>
      )}
    </Page>
  );
}
