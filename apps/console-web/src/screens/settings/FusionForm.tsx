import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Cpu, Scale, Users, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getSettings, patchFusion, type FusionMode, type FusionStrategy } from '@/lib/settings';

type FormState = { mode: FusionMode; judge: 'claude' | 'codex'; strategy: FusionStrategy };

const MODES: { id: FusionMode; label: string; icon: typeof Cpu; blurb: string }[] = [
  { id: 'off', label: 'Single brain', icon: Cpu, blurb: 'Your primary flagship answers every turn. The default.' },
  { id: 'high', label: 'High-stakes only', icon: Scale, blurb: 'Both flagships debate the consequential turns; a judge reconciles. Recommended.' },
  { id: 'all', label: 'Every turn', icon: Users, blurb: 'Both flagships debate every turn — most accurate, but 2-3× tokens & latency.' },
];

export function FusionForm({ embedded = false }: { embedded?: boolean } = {}) {
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
        mode: fusion.mode,
        judge: fusion.judge,
        strategy: fusion.strategy ?? 'debate',
      });
    }
  }, [fusion, form]);

  if (settings.isLoading || !form || !fusion) {
    const sk = <Skeleton className="h-40 w-full" />;
    return embedded ? sk : <Card className="p-5">{sk}</Card>;
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { setForm((f) => (f ? { ...f, [k]: v } : f)); setSaved(false); setError(null); };

  const brains = fusion.brainsAvailable;
  const bothPresent = brains.claude && brains.codex;
  const willDebateButCant = form.mode !== 'off' && !bothPresent;
  // In verify, the executor IS the primary brain; a judge == primary means the
  // brain checks itself (no second opinion) — warn so it isn't set by accident.
  const primaryBrainKind = activeBrain === 'claude_oauth' ? 'claude' : 'codex';
  const effectiveJudge = fusion.judgeRole;
  const effectiveJudgeProvider = effectiveJudge?.source === 'default' ? form.judge : (effectiveJudge?.provider ?? form.judge);
  const verifySelfCheck = form.mode !== 'off' && form.strategy === 'verify' && effectiveJudgeProvider !== 'byo' && effectiveJudgeProvider === primaryBrainKind;
  // Strategy-aware description (the mode sets WHEN; the strategy sets HOW).
  const howItWorks = form.mode === 'off'
    ? 'Single brain — no second model is consulted.'
    : `${form.mode === 'high' ? 'On high-stakes turns, ' : 'On every turn, '}${
        form.strategy === 'verify'
          ? 'the executor (primary brain) drafts and the checker verifies/refines the answer (2 calls).'
          : 'both flagships draft independently and a judge reconciles them (3 calls).'
      }`;

  const save = async () => {
    // The primary brain is owned by the routing rows above (a single source of
    // truth); fusion only persists WHEN the second model joins and HOW.
    setSaving(true); setError(null);
    try {
      const res = await patchFusion({ mode: form.mode, judge: form.judge, strategy: form.strategy });
      setSaved(true);
      // Resync from the authoritative server snapshot (it coerces values).
      if (res?.fusion) {
        setForm((f) => (f ? { ...f, mode: res.fusion.mode, judge: res.fusion.judge, strategy: res.fusion.strategy } : f));
      }
      void qc.invalidateQueries({ queryKey: ['settings'] });
    } catch (err) {
      setError(`Fusion mode/judge did NOT save: ${(err as Error)?.message ?? String(err)}. Click Save again.`);
    } finally {
      setSaving(false);
    }
  };

  const body = (
    <>
      <h3 className="mb-1 text-h3 text-fg">Fusion — multi-model</h3>
      <p className="mb-3 text-small text-muted">
        Run both flagships in tandem on the turns that matter — higher accuracy where it counts.
        The primary brain is set above in the routing rows; here you choose <em>when</em> the second
        model joins and <em>how</em> they collaborate. Applies live on the next message; no restart.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { setForm({ mode: 'high', judge: 'claude', strategy: 'verify' }); setSaved(false); setError(null); }}
        >
          Use recommended (high-stakes · verify · Claude checks)
        </Button>
        <span className="text-caption text-muted">Your primary brain runs the bulk; the checker verifies the key turns.</span>
      </div>

      <div className="mb-4 grid gap-x-4 sm:grid-cols-2">
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
        <p className="text-small text-muted"><span className="text-fg">How this works:</span> {howItWorks}</p>
        <ul className="mt-2 space-y-0.5 text-caption text-muted">
          <li>{brains.claude ? '🟢' : '⚪️'} Claude (Max/Pro) login → {brains.claude ? 'connected' : 'not connected'}</li>
          <li>{brains.codex ? '🟢' : '⚪️'} Codex login → {brains.codex ? 'connected' : 'not connected'}</li>
          <li>{fusion.active ? '⚡️ Fusion ACTIVE — both flagships debating' : (fusion.mode !== 'off' ? '◦ fusion configured but inactive (a flagship login is missing)' : '○ single brain')}</li>
          {effectiveJudge && (
            <li>Effective judge → {effectiveJudge.modelId} ({effectiveJudge.provider}, {effectiveJudge.source === 'default' ? 'default' : 'pinned'})</li>
          )}
        </ul>
      </div>

      {effectiveJudge?.provider === 'byo' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning bg-warning-tint p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-caption text-muted">
            The judge is pinned to <span className="text-fg">{effectiveJudge.modelId}</span> in the routing rows above. The selector here only changes the Claude/Codex default; clear the judge role there to use it again.
          </p>
        </div>
      )}

      {willDebateButCant && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning bg-warning-tint p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-caption text-muted">
            Fusion needs BOTH a Claude (Max/Pro) and a Codex login. Until the missing one is connected, Clementine runs single-brain on your primary — no error, just no debate.
          </p>
        </div>
      )}

      {verifySelfCheck && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning bg-warning-tint p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p className="text-caption text-muted">
            In <span className="text-fg">verify</span>, the checker should be the <em>other</em> brain — right now the {primaryBrainKind === 'claude' ? 'Claude' : 'Codex'} primary would be checking its own work (no second opinion). Set Judge/checker to the other model.
          </p>
        </div>
      )}

      <div className="mt-2 flex items-center gap-3">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save fusion'}</Button>
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved — applies on the next message</span>}
        {error && <span className="text-small text-danger">{error}</span>}
      </div>
    </>
  );
  return embedded ? body : <Card className="p-5">{body}</Card>;
}
