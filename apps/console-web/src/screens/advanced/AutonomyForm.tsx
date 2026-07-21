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
import { listSendTrust, addSendTrust, revokeSendTrust } from '@/lib/settings';

/**
 * Trusted send recipients — the ONE bounded way to cut approval clicks toward
 * full autonomy. A send auto-proceeds only when EVERY recipient is in a trusted
 * domain/address here; anything else (an out-of-scope cc, a mass-send, a new
 * channel) still asks. Managed here by the human so there's no self-grant path.
 */
function SendTrustPanel() {
  const qc = useQueryClient();
  const grants = usePoll(['send-trust'], listSendTrust, 0);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['send-trust'] });

  const add = async () => {
    const raw = value.trim().toLowerCase();
    if (!raw) return;
    // A token with an @ before a dot is an exact address; otherwise treat it as
    // a recipient domain ("acme.com" or "@acme.com").
    const isAddress = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw);
    setBusy(true); setError(null);
    try {
      await addSendTrust(isAddress ? { recipients: [raw], note: note.trim() || undefined } : { domains: [raw.replace(/^@/, '')], note: note.trim() || undefined });
      setValue(''); setNote(''); refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add — enter a recipient domain or a full email address.');
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => { try { await revokeSendTrust(id); } finally { refresh(); } };

  const rows = grants.data?.grants ?? [];
  const max = grants.data?.maxRecipients ?? 20;

  return (
    <div className="mt-5">
      <h3 className="mb-1 text-h3 text-fg">Trusted send recipients</h3>
      <p className="mb-3 text-caption text-muted">
        Sends where <em>every</em> recipient is trusted go out without asking. Anything else still waits for you —
        including a send to more than {max} people, which always asks. Revoke any time; every auto-send is still logged.
      </p>
      {rows.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {rows.map((g) => (
            <div key={g.id} className="flex items-center gap-3 rounded-md border border-border bg-subtle px-3 py-2">
              <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-body text-fg">
                {(g.domains ?? []).map((d) => `@${d}`).concat(g.recipients ?? []).join(', ')}
                {g.toolkits?.length ? <span className="text-muted"> · {g.toolkits.join(', ')}</span> : null}
                {g.note ? <span className="text-faint"> — {g.note}</span> : null}
              </span>
              <button type="button" onClick={() => remove(g.id)} className="shrink-0 text-caption text-danger hover:underline cursor-pointer">Revoke</button>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <Field label="Domain or email">{(id) => <Input id={id} placeholder="acme.com or ceo@acme.com" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />}</Field>
        <Field label="Note (optional)">{(id) => <Input id={id} placeholder="my team" value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <Button variant="secondary" onClick={add} disabled={busy || !value.trim()}>{busy ? 'Adding…' : 'Trust'}</Button>
      </div>
      {error && <div className="mt-1 text-caption text-danger">{error}</div>}
    </div>
  );
}

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
            <Field label="Approvals" hint="Auto-approve: Clem plans, confirms once, then completes the task — including the sends that plan named and anyone you trust below. A send she didn't plan, a blast to many people, or an untrusted recipient still checks with you. Approve: she confirms before every change.">{(id) => (
              <Select
                id={id}
                value={form.autoApproveScope === 'strict' || form.autoApproveScope === 'balanced' ? 'strict'
                  : form.autoApproveScope === 'workspace' ? 'workspace' : 'yolo'}
                onChange={(e) => set('autoApproveScope', e.target.value as Policy['autoApproveScope'])}
              >
                <option value="yolo">Auto-approve — approve the plan once, then Clem runs it (recommended)</option>
                <option value="strict">Approve — check with me before each change</option>
                {/* Legacy power-user scope: shown ONLY when it's the stored value,
                    so it round-trips truthfully instead of silently reading as
                    Auto-approve and getting rewritten to yolo on the next save. */}
                {form.autoApproveScope === 'workspace' && (
                  <option value="workspace">Workspace — auto-approve inside your workspace folders (legacy)</option>
                )}
              </Select>
            )}</Field>
            <Field label="Proactive check-in (minutes)" hint="How often Clementine proactively checks in / starts helpful work on its own. (Separate from the run-loop heartbeat under Run limits.)">{(id) => <Input id={id} type="number" min={1} max={60} value={form.checkInMinutes ?? ''} onChange={(e) => set('checkInMinutes', Number(e.target.value))} />}</Field>
          </div>

          <h3 className="mb-1 mt-4 text-h3 text-fg">Quiet hours</h3>
          <ToggleRow label="Enable quiet hours" desc="Stay quiet during these times." checked={!!form.quietHoursEnabled} onChange={(v) => set('quietHoursEnabled', v)} />
          {form.quietHoursEnabled && (
            <div className="grid gap-x-4 pt-3 sm:grid-cols-2">
              <Field label="From">{(id) => <Input id={id} type="time" value={form.quietHoursStart ?? ''} onChange={(e) => set('quietHoursStart', e.target.value)} />}</Field>
              <Field label="To">{(id) => <Input id={id} type="time" value={form.quietHoursEnd ?? ''} onChange={(e) => set('quietHoursEnd', e.target.value)} />}</Field>
            </div>
          )}

          <SendTrustPanel />

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
