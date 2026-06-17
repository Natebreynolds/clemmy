import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Cpu, Scale, Users, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, setActiveBrain, patchFusion, type FusionMode, type FusionStrategy, type ActiveBrain } from '@/lib/settings';

type FormState = { brain: ActiveBrain; mode: FusionMode; judge: 'claude' | 'codex'; strategy: FusionStrategy };

const MODES: { id: FusionMode; label: string; icon: typeof Cpu; blurb: string }[] = [
  { id: 'off', label: 'Single brain', icon: Cpu, blurb: 'Your primary flagship answers every turn. The default.' },
  { id: 'high', label: 'High-stakes only', icon: Scale, blurb: 'Both flagships debate the consequential turns; a judge reconciles. Recommended.' },
  { id: 'all', label: 'Every turn', icon: Users, blurb: 'Both flagships debate every turn — most accurate, but 2-3× tokens & latency.' },
];

export function FusionForm() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const fusion = settings.data?.fusion;
  const activeBrain = settings.data?.activeBrain;
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (fusion && !form) {
      setForm({
        brain: activeBrain === 'claude_oauth' ? 'claude_oauth' : 'codex_oauth',
        mode: fusion.mode,
        judge: fusion.judge,
        strategy: fusion.strategy ?? 'debate',
      });
    }
  }, [fusion, activeBrain, form]);

  if (settings.isLoading || !form || !fusion) return <Card className="p-5"><Skeleton className="h-40 w-full" /></Card>;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); setSaved(false); setError(null); };

  const brains = fusion.brainsAvailable;
  const bothPresent = brains.claude && brains.codex;
  const willDebateButCant = form.mode !== 'off' && !bothPresent;
  const activeMode = MODES.find((m) => m.id === form.mode)!;

  const save = async () => {
    setSaving(true); setError(null);
    try {
      // Primary brain first (it preflights the Claude token and may error with a
      // sign-in prompt), then the live fusion mode/judge.
      await setActiveBrain(form.brain);
      await patchFusion({ mode: form.mode, judge: form.judge, strategy: form.strategy });
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Fusion — multi-model</h3>
      <p className="mb-3 text-small text-muted">
        Pick your flagship, or run both in tandem. In fusion mode the two flagships
        collaborate on the turns that matter — higher accuracy where it counts.
        Applies live on the next message; no restart.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { setForm({ brain: 'codex_oauth', mode: 'high', judge: 'claude', strategy: 'verify' }); setSaved(false); setError(null); }}
        >
          Use “Codex drives, Claude checks” (recommended)
        </Button>
        <span className="text-caption text-muted">Cheapest: Codex runs the bulk; Claude verifies the key turns.</span>
      </div>

      <div className="mb-4 grid gap-x-4 sm:grid-cols-2">
        <Field label="Primary brain" hint="Runs every single-model turn, and is the fallback when fusion can't run.">{(id) => (
          <Select id={id} value={form.brain} onChange={(e) => set('brain', e.target.value as ActiveBrain)}>
            <option value="codex_oauth">Codex — GPT-5.x</option>
            <option value="claude_oauth">Claude — Opus</option>
          </Select>
        )}</Field>
        <Field label="Judge / checker" hint="The brain that reconciles drafts (debate) or verifies the executor's draft (verify).">{(id) => (
          <Select id={id} value={form.judge} onChange={(e) => set('judge', e.target.value as 'claude' | 'codex')}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </Select>
        )}</Field>
        <Field label="Strategy" hint="verify = executor drafts, checker refines (2 calls, cheaper). debate = both draft + judge (3 calls).">{(id) => (
          <Select id={id} value={form.strategy} onChange={(e) => set('strategy', e.target.value as FusionStrategy)}>
            <option value="verify">verify — one drafts, the other checks (cheaper)</option>
            <option value="debate">debate — both draft, a judge reconciles</option>
          </Select>
        )}</Field>
      </div>

      {/* Fusion mode picker */}
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = form.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => set('mode', m.id)}
              className={'flex items-start gap-2 rounded-lg border p-3 text-left transition-colors cursor-pointer ' + (active ? 'border-primary bg-primary-tint' : 'border-border hover:border-primary')}
            >
              <Icon className={'mt-0.5 h-4 w-4 shrink-0 ' + (active ? 'text-primary' : 'text-muted')} aria-hidden />
              <span className={'text-label ' + (active ? 'text-fg' : 'text-muted')}>{m.label}</span>
            </button>
          );
        })}
      </div>

      <div className="mb-4 rounded-lg border border-border bg-canvas p-3">
        <p className="text-small text-muted"><span className="text-fg">How this works:</span> {activeMode.blurb}</p>
        <ul className="mt-2 space-y-0.5 text-caption text-muted">
          <li>{brains.claude ? '🟢' : '⚪️'} Claude (Max/Pro) login → {brains.claude ? 'connected' : 'not connected'}</li>
          <li>{brains.codex ? '🟢' : '⚪️'} Codex login → {brains.codex ? 'connected' : 'not connected'}</li>
          <li>{fusion.active ? '⚡️ Fusion ACTIVE — both flagships debating' : (fusion.mode !== 'off' ? '◦ fusion configured but inactive (a flagship login is missing)' : '○ single brain')}</li>
        </ul>
      </div>

      {willDebateButCant && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning bg-warning-tint p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-caption text-muted">
            Fusion needs BOTH a Claude (Max/Pro) and a Codex login. Until the missing one is connected, Clementine runs single-brain on your primary — no error, just no debate.
          </p>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save fusion'}</Button>
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved — applies on the next message</span>}
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </Card>
  );
}
