import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, BrainCircuit, Users, Scale } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Field, Select } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import {
  getSettings,
  setActiveBrain,
  patchModelRole,
  type ActiveBrain,
  type ResolvedRole,
} from '@/lib/settings';

const SOURCE_LABEL: Record<ResolvedRole['source'], string> = {
  default: 'default',
  settings: 'set here',
  'chat-rule': 'from chat',
  session: 'this session',
};

function RoleRow({
  icon: Icon,
  label,
  hint,
  resolved,
  children,
}: {
  icon: typeof Users;
  label: string;
  hint: string;
  resolved: ResolvedRole;
  children: (id: string) => React.ReactNode;
}) {
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[1fr_1.2fr] sm:gap-4">
      <Field label={label} hint={hint}>{children}</Field>
      <div className="flex items-center gap-2 pb-1 text-small text-muted">
        <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="text-fg">{resolved.modelId}</span>
        <span className="rounded bg-canvas px-1.5 py-0.5 text-caption text-muted">{resolved.provider}</span>
        <span className="text-caption text-muted">· {SOURCE_LABEL[resolved.source]}</span>
      </div>
    </div>
  );
}

export function ModelRolesCard() {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const mr = settings.data?.modelRoles;
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (settings.isLoading || !mr) return <Card className="p-5"><Skeleton className="h-44 w-full" /></Card>;

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['settings'] }); };
  const flat = mr.available.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.provider })));
  const connected = (prov: string) => mr.available.some((p) => p.provider === prov);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null); setSaved(null);
    try { await fn(); setSaved(key); refresh(); }
    catch (err) {
      const e = err as { status?: number; body?: { needsLogin?: boolean }; message?: string };
      setError(e?.body?.needsLogin || e?.status === 409
        ? 'Switching to Claude needs a Claude (Max/Pro) login first — sign in under “Claude login”, then try again.'
        : (e?.message ?? String(err)));
    } finally { setBusy(null); }
  };

  const onBrain = (v: ActiveBrain) => run('brain', () => setActiveBrain(v));
  const onRole = (role: 'worker' | 'judge', v: string) =>
    run(role, () => patchModelRole(v === '__default__' ? { role, clear: true } : { role, modelId: v }));

  return (
    <Card className="p-5">
      <h3 className="mb-1 text-h3 text-fg">Models — who does what</h3>
      <p className="mb-4 text-small text-muted">
        Pick the active brain provider and which connected models serve workers and judge/checker.
        You can also just tell Clementine in chat — “use DeepSeek for the workers”,
        “make the judge Opus”. Applies on the next message; no restart.
      </p>

      <div className="space-y-3">
        <RoleRow icon={BrainCircuit} label="Brain" hint="Runs every turn (a provider login switch)." resolved={mr.roles.brain}>
          {(id) => (
            <Select id={id} disabled={busy === 'brain'}
              value={mr.activeBrain === 'claude_oauth' ? 'claude_oauth' : 'codex_oauth'}
              onChange={(e) => onBrain(e.target.value as ActiveBrain)}>
              <option value="codex_oauth" disabled={!connected('codex')}>Codex — GPT-5.x{connected('codex') ? '' : ' (not connected)'}</option>
              <option value="claude_oauth" disabled={!connected('claude')}>Claude — Opus{connected('claude') ? '' : ' (not connected)'}</option>
            </Select>
          )}
        </RoleRow>

        <RoleRow icon={Users} label="Workers" hint="Delegated run_worker / grunt labor." resolved={mr.roles.worker}>
          {(id) => (
            <Select id={id} disabled={busy === 'worker'} value={mr.roles.worker.source === 'default' ? '__default__' : mr.roles.worker.modelId}
              onChange={(e) => onRole('worker', e.target.value)}>
              <option value="__default__">Default (follow the brain)</option>
              {flat.map((m) => <option key={`w-${m.provider}-${m.id}`} value={m.id}>{m.label} · {m.provider}</option>)}
            </Select>
          )}
        </RoleRow>

        <RoleRow icon={Scale} label="Judge / checker" hint="Verifies the fusion turn." resolved={mr.roles.judge}>
          {(id) => (
            <Select id={id} disabled={busy === 'judge'} value={mr.roles.judge.source === 'default' ? '__default__' : mr.roles.judge.modelId}
              onChange={(e) => onRole('judge', e.target.value)}>
              <option value="__default__">Default</option>
              {flat.map((m) => <option key={`j-${m.provider}-${m.id}`} value={m.id}>{m.label} · {m.provider}</option>)}
            </Select>
          )}
        </RoleRow>
      </div>

      <div className="mt-4 flex items-center gap-3">
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved — applies on the next message</span>}
        {error && <span className="text-small text-danger">{error}</span>}
        {mr.available.length === 0 && <span className="text-small text-muted">No models connected yet — log in under Claude login / Codex / Model backend below.</span>}
      </div>
    </Card>
  );
}
