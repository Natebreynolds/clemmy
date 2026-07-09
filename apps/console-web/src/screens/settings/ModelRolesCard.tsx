import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, BrainCircuit, Users, Scale, Sparkles, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Field, Select, Input } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { usePoll } from '@/lib/poll';
import {
  getSettings,
  setActiveBrain,
  patchModelRole,
  patchFusion,
  type ActiveBrain,
  type JudgeMetricsSnapshot,
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
      <div className="min-w-0 pb-1">
        <div className="flex min-w-0 items-center gap-2 text-small text-muted">
          <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate text-fg" title={resolved.modelId}>{resolved.modelId}</span>
          <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-caption text-muted">{resolved.provider}</span>
          <span className="shrink-0 text-caption text-muted">· {SOURCE_LABEL[resolved.source]}</span>
        </div>
        {resolved.inactiveBinding && (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-caption text-warning" title={resolved.inactiveBinding.reason}>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">Saved {resolved.inactiveBinding.modelId} is unavailable; using default.</span>
          </div>
        )}
      </div>
    </div>
  );
}

const JUDGE_LANE_LABEL: Record<string, string> = {
  completion: 'Completion',
  grounding: 'Write grounding',
  goal_fidelity: 'Goal fidelity',
  output_grounding: 'Numeric grounding',
  certify: 'Batch certify',
  watcher: 'Watcher',
};

function formatJudgeDuration(ms: number | undefined): string {
  const n = Math.max(0, Math.round(ms ?? 0));
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
  return `${n}ms`;
}

function JudgeMetrics({ metrics }: { metrics?: JudgeMetricsSnapshot }) {
  const total = metrics?.total;
  const lanes = (metrics?.lanes ?? []).filter((lane) => lane.calls > 0);
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1.2fr] sm:gap-4">
      <div className="hidden sm:block" aria-hidden />
      <div className="min-w-0 text-caption text-muted">
        {!total?.calls ? (
          <p>No judge calls recorded since daemon start.</p>
        ) : (
          <>
            <p>
              Since daemon start: <span className="text-fg">{total.calls}</span> calls,
              avg <span className="text-fg">{formatJudgeDuration(total.avgMs)}</span>,
              max <span className="text-fg">{formatJudgeDuration(total.maxMs)}</span>,
              cap <span className="text-fg">{formatJudgeDuration(metrics?.timeoutMs)}</span>.
              {(total.timeouts > 0 || total.errors > 0 || total.invalid > 0) && (
                <> {total.timeouts} timeout, {total.errors} error, {total.invalid} invalid.</>
              )}
              {(total.blocked > 0 || total.advisory > 0) && (
                <> {total.blocked} blocked, {total.advisory} advisory.</>
              )}
            </p>
            {lanes.length > 0 && (
              <p className="mt-0.5 truncate" title={lanes.map((lane) => `${JUDGE_LANE_LABEL[lane.lane] ?? lane.lane}: ${lane.calls} calls, avg ${formatJudgeDuration(lane.avgMs)}`).join(' · ')}>
                {lanes
                  .sort((a, b) => b.calls - a.calls)
                  .slice(0, 3)
                  .map((lane) => `${JUDGE_LANE_LABEL[lane.lane] ?? lane.lane}: ${lane.calls} @ ${formatJudgeDuration(lane.avgMs)}`)
                  .join(' · ')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function ModelRolesCard({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient();
  const settings = usePoll(['settings'], getSettings, 0);
  const mr = settings.data?.modelRoles;
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newIntent, setNewIntent] = useState('');
  const [newIntentModel, setNewIntentModel] = useState('');

  if (settings.isLoading || !mr) {
    const sk = <Skeleton className="h-44 w-full" />;
    return embedded ? sk : <Card className="p-5">{sk}</Card>;
  }

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['settings'] }); };
  const workerOptions = mr.roleOptions?.worker ?? mr.available;
  const workerFlat = workerOptions.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.provider })));
  // The judge picker offers the SAME connected models as the worker (the backend
  // accepts role:'judge' with any connected model); "Automatic" stays the default.
  const judgeOptions = mr.roleOptions?.judge ?? mr.available;
  const judgeFlat = judgeOptions.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.provider })));
  const connected = (prov: string) => mr.available.some((p) => p.provider === prov);

  // ── Second opinion (fusion) — one user-facing judge path. The resolved Judge
  // row says WHO checks; this switch says WHETHER it verifies the brain's draft.
  const fusion = settings.data?.fusion;
  const judgeMetrics = settings.data?.judgeMetrics;
  const secondOpinionOn = Boolean(fusion && fusion.mode !== 'off');
  const fusionWhen: 'high' | 'all' = fusion?.mode === 'all' ? 'all' : 'high';
  const onSecondOpinion = (on: boolean) =>
    run('fusion', () => patchFusion({ mode: on ? fusionWhen : 'off', strategy: 'verify' }));
  const onFusionWhen = (when: 'high' | 'all') =>
    run('fusion', () => patchFusion({ mode: when, strategy: 'verify' }));
  // Verify with the judge == the brain is a self-check (no real second opinion).
  const judgeSameAsBrain = mr.roles.judge.provider === mr.roles.brain.provider && mr.roles.judge.modelId === mr.roles.brain.modelId;

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

  // The option value is the unique selector: a BYO model is `api_key:<modelId>`,
  // Codex is `codex_oauth:<id>`, Claude is `claude_oauth:<id>` (so any connected
  // model can be the brain). A bare value (no `:`) is the plain auth-mode.
  const onBrain = (value: string) => run('brain', () =>
    value.startsWith('api_key:') ? setActiveBrain('api_key', value.slice('api_key:'.length))
      : value.startsWith('codex_oauth:') ? setActiveBrain('codex_oauth', value.slice('codex_oauth:'.length))
        : value.startsWith('claude_oauth:') ? setActiveBrain('claude_oauth', value.slice('claude_oauth:'.length))
          : setActiveBrain(value as ActiveBrain));
  const onRole = (role: 'worker' | 'judge', v: string) =>
    run(role, () => patchModelRole(v === '__default__' ? { role, clear: true } : { role, modelId: v }));

  // Task-specific (intent-scoped) worker routing — e.g. "design" → Claude. Reads
  // the same bindings the chat tool writes; routes only workers tagged with that
  // intent.
  const workerIntents = mr.bindings.filter((b) => b.role === 'worker' && b.whenIntent);
  const modelLabel = (id: string) => workerFlat.find((m) => m.id === id)?.label ?? id;
  const modelProvider = (id: string) => workerFlat.find((m) => m.id === id)?.provider;
  const onAddIntent = () => {
    const intent = newIntent.trim();
    if (!intent || !newIntentModel) return;
    run('intent-add', async () => {
      await patchModelRole({ role: 'worker', modelId: newIntentModel, whenIntent: intent });
      setNewIntent(''); setNewIntentModel('');
    });
  };
  const onRemoveIntent = (whenIntent: string) =>
    run(`intent-rm-${whenIntent}`, () => patchModelRole({ role: 'worker', whenIntent, clear: true }));

  const body = (
    <>
      {!embedded && (
        <>
          <h3 className="mb-1 text-h3 text-fg">Models — who does what</h3>
          <p className="mb-4 text-small text-muted">
            Pick the active brain provider and which connected models serve workers and
            the judge/checker (used for completion checks, write gates, and Second opinion).
            Leave the judge on “Automatic” for a fast different-family check, or pick a
            stronger model. Applies on the next message; no restart.
          </p>
        </>
      )}

      <div className="space-y-3">
        <RoleRow icon={BrainCircuit} label="Brain" hint="Orchestrates every turn — Codex, Claude, or a BYO model (all-in)." resolved={mr.roles.brain}>
          {(id) => (
            <Select id={id} disabled={busy === 'brain'}
              value={mr.effectiveBrainValue ?? mr.effectiveBrain ?? (mr.activeBrain === 'claude_oauth' ? 'claude_oauth' : 'codex_oauth')}
              onChange={(e) => onBrain(e.target.value)}>
              {(mr.brainOptions ?? [
                { id: 'codex_oauth' as ActiveBrain, value: 'codex_oauth', label: 'Codex — GPT-5.x', available: connected('codex') },
                { id: 'claude_oauth' as ActiveBrain, value: 'claude_oauth', label: 'Claude — Opus', available: connected('claude') },
              ]).map((o) => (
                <option key={o.value} value={o.value} disabled={!o.available}>{o.label}{o.available ? '' : ' (not connected)'}</option>
              ))}
            </Select>
          )}
        </RoleRow>

        <RoleRow icon={Users} label="Workers" hint="Delegated run_worker / grunt labor." resolved={mr.roles.worker}>
          {(id) => (
            <Select id={id} disabled={busy === 'worker'} value={mr.roles.worker.source === 'default' ? '__default__' : mr.roles.worker.modelId}
              onChange={(e) => onRole('worker', e.target.value)}>
              <option value="__default__">Default (follow the brain)</option>
              {workerFlat.map((m) => <option key={`w-${m.provider}-${m.id}`} value={m.id}>{m.label} · {m.provider}</option>)}
            </Select>
          )}
        </RoleRow>

        <RoleRow icon={Scale} label="Judge / checker" hint="Checks completion, write-boundary gates, and Second opinion. “Automatic” auto-picks a fast different model family; pick a specific model to override (e.g. a stronger judge)." resolved={mr.roles.judge}>
          {(id) => (
            <Select id={id} disabled={busy === 'judge'} value={mr.roles.judge.source === 'default' ? '__default__' : mr.roles.judge.modelId}
              onChange={(e) => onRole('judge', e.target.value)}>
              <option value="__default__">Automatic (different family, fast)</option>
              {judgeFlat.map((m) => <option key={`j-${m.provider}-${m.id}`} value={m.id}>{m.label} · {m.provider}</option>)}
            </Select>
          )}
        </RoleRow>
        <JudgeMetrics metrics={judgeMetrics} />

        {/* Second opinion — whether the one judge above checks the brain's draft. */}
        <div className="rounded-lg border border-border bg-canvas p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 text-label text-fg">
              <Switch checked={secondOpinionOn} disabled={busy === 'fusion'} onChange={onSecondOpinion} label="Second opinion" />
              <span>Second opinion</span>
            </div>
            {secondOpinionOn && (
              <Select className="h-8 w-auto" disabled={busy === 'fusion'} value={fusionWhen}
                onChange={(e) => onFusionWhen(e.target.value as 'high' | 'all')}>
                <option value="high">High-stakes turns</option>
                <option value="all">Every turn (extra call)</option>
              </Select>
            )}
          </div>
          <p className="mt-1.5 text-caption text-muted">
            {secondOpinionOn
              ? 'The brain drafts once, then the judge above verifies and refines the answer before delivery.'
              : 'The brain answers directly. Write-boundary and completion judges still run when the harness needs them.'}
            {' '}{fusion?.active
              ? <span className="text-success">Active now.</span>
              : (secondOpinionOn && <span className="text-warning">Configured but inactive — the judge is not available yet.</span>)}
          </p>
          {secondOpinionOn && judgeSameAsBrain && (
            <p className="mt-1 flex items-center gap-1.5 text-caption text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              The judge is the same model as the brain, so this adds little value. Connect another model family or reset a custom judge.
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <div className="mb-1 flex items-center gap-2 text-label text-fg">
          <Sparkles className="h-4 w-4 text-muted" aria-hidden /> Task-specific routing
        </div>
        <p className="mb-3 text-caption text-muted">
          Send a kind of task to a specific model — e.g. <span className="text-fg">design</span> or{' '}
          <span className="text-fg">writing</span> to Claude. Used when a worker is tagged with that intent
          (or just say it in chat: “use Claude for design”).
        </p>

        {workerIntents.length > 0 && (
          <ul className="mb-3 space-y-1.5">
            {workerIntents.map((b) => (
              <li key={`wi-${b.whenIntent}`} className="flex min-w-0 items-center gap-2 text-small">
                <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-caption text-fg">{b.whenIntent}</span>
                <span className="text-muted" aria-hidden>→</span>
                <span className="truncate text-fg" title={b.modelId}>{modelLabel(b.modelId)}</span>
                {modelProvider(b.modelId) && <span className="shrink-0 text-caption text-muted">· {modelProvider(b.modelId)}</span>}
                <button type="button"
                  className="ml-auto shrink-0 rounded p-1 text-muted hover:text-danger disabled:opacity-50"
                  disabled={busy === `intent-rm-${b.whenIntent}`}
                  onClick={() => onRemoveIntent(b.whenIntent as string)}
                  aria-label={`Remove ${b.whenIntent} routing`}>
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2">
          <Input className="h-9 max-w-[8rem]" placeholder="design" value={newIntent}
            onChange={(e) => setNewIntent(e.target.value)} aria-label="Task intent" />
          <span className="text-muted" aria-hidden>→</span>
          <Select className="h-9 min-w-0" value={newIntentModel}
            onChange={(e) => setNewIntentModel(e.target.value)} aria-label="Model for this intent">
            <option value="">Pick a model…</option>
            {workerFlat.map((m) => <option key={`wi-opt-${m.provider}-${m.id}`} value={m.id}>{m.label} · {m.provider}</option>)}
          </Select>
          <button type="button"
            className="h-9 shrink-0 rounded-md border border-border px-3 text-small text-fg hover:border-primary disabled:opacity-50"
            disabled={busy === 'intent-add' || !newIntent.trim() || !newIntentModel}
            onClick={onAddIntent}>
            Add
          </button>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved — applies on the next message</span>}
        {error && <span className="text-small text-danger">{error}</span>}
        {mr.available.length === 0 && <span className="text-small text-muted">No models connected yet — add one under “Connected models” below, or sign in to Codex / Claude.</span>}
      </div>
    </>
  );
  return embedded ? body : <Card className="p-5">{body}</Card>;
}
