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
import { getWatches, patchWatch, tickWatch, type WatchStatus } from '@/lib/settings';

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

function ago(iso?: string): string {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins)) return iso;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const WATCH_KIND_LABEL: Record<string, string> = {
  cancelled: 'Cancelled',
  removed: 'Removed',
  conflict: 'Double-booked',
  invite_unanswered: 'Reply needed',
  moved: 'Moved',
  starting_soon: 'Starting soon',
};

/**
 * Watches — background heartbeats on a contract: read on a cadence, detect
 * changes deterministically, raise ONE item per meaningful change, and let
 * Jev veto only the low-signal ones. This card answers "what is it for, when
 * did it last look, what did it find, what is open" and offers the controls.
 */
function WatchesPanel() {
  const qc = useQueryClient();
  const watches = usePoll(['watches'], getWatches, 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastTick, setLastTick] = useState<string | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['watches'] }); void qc.invalidateQueries({ queryKey: ['command-center'] }); };
  const toggle = async (w: WatchStatus, enabled: boolean) => {
    setBusy(w.id);
    try { await patchWatch(w.id, { enabled }); refresh(); } finally { setBusy(null); }
  };
  const checkNow = async (w: WatchStatus) => {
    setBusy(w.id);
    try {
      const r = await tickWatch(w.id);
      setLastTick(r.tick.summary);
      refresh();
    } catch (e) {
      setLastTick(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };
  const list = watches.data?.watches ?? [];
  return (
    <>
      <h3 className="mb-2 mt-4 text-h3 text-fg">Watches</h3>
      <p className="mb-2 text-caption text-muted">A watch reads on a cadence, notices what changed, and raises one item per change that needs you. It runs whether or not proactive work is on, and it never acts on your behalf.</p>
      {watches.isLoading && list.length === 0 ? <Skeleton className="h-16 w-full" /> : list.map((w) => (
        <div key={w.id} className="border-t border-border py-3 first:border-t-0" data-testid={`watch-${w.id}`}>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-body font-medium text-fg">{w.title}</div>
              <div className="text-caption text-muted">{w.purpose}</div>
            </div>
            <Switch checked={w.enabled} onChange={(v) => { void toggle(w, v); }} label={w.title} />
          </div>
          <div className="mt-2 grid gap-1 text-caption text-muted sm:grid-cols-2">
            <div>Every {w.cadenceMinutes} min{w.quietHoursActive ? ' · quiet hours now' : ''}{w.connectedOperations.length === 0 ? ' · no calendar connected' : ''}</div>
            <div>Last check: {ago(w.lastTickAt)}{w.running ? ' · checking…' : ''}</div>
            <div className="sm:col-span-2">
              Last finding: {w.lastFinding ? w.lastFinding.summary : 'none yet'}
              {w.lastError ? <span className="text-danger"> · {w.lastError.reason}</span> : null}
            </div>
            <div className="sm:col-span-2">
              {w.metrics.ticks} checks · {w.metrics.quietTicks} quiet · {w.metrics.itemsProduced} items · {w.metrics.itemsAcknowledged} seen by you · {w.metrics.itemsRetired} resolved on their own · {w.metrics.modelCalls} Jev calls ({w.metrics.modelVetoes} judged routine) · {w.metrics.duplicatesSuppressed} duplicates held back
            </div>
          </div>
          {w.openItems.length > 0 && (
            <ul className="mt-2 space-y-1 text-caption text-fg">
              {w.openItems.slice(0, 6).map((item) => (
                <li key={item.key}>
                  <span className="font-medium">{WATCH_KIND_LABEL[item.kind] ?? item.kind}:</span> {item.subject}
                  {item.acknowledgedAt ? <span className="text-muted"> · seen</span> : null}
                </li>
              ))}
              {w.openItems.length > 6 && <li className="text-muted">+{w.openItems.length - 6} more</li>}
            </ul>
          )}
          <div className="mt-2 flex items-center gap-3">
            <Button variant="secondary" onClick={() => { void checkNow(w); }} disabled={busy === w.id}>{busy === w.id ? 'Checking…' : 'Check now'}</Button>
            {lastTick && <span className="text-caption text-muted">{lastTick}</span>}
          </div>
        </div>
      ))}
    </>
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

          <WatchesPanel />

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
