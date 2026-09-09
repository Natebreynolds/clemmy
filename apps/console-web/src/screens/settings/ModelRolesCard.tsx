import { CompletionReviewControl } from './CompletionReviewControl';
import { ClaudeLoginForm } from './ClaudeLoginForm';
import { useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PROVIDER_LABEL, useModelRoles } from '@/lib/model-roles';
import { Field, Select, Input } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { getRecentFusionTraces, fusionOutcomeLabel } from '@/lib/fusion';
import { relativeTime } from '@/lib/inbox';
import {
  patchCodexRescueModel,
  patchModelRole,
  patchFusion,
  type JudgeMetricsSnapshot,
} from '@/lib/settings';

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

export function ModelRolesCard({ sessionId }: { sessionId?: string } = {}) {
  const r = useModelRoles({ sessionId });
  const mr = r.mr;
  const [newIntent, setNewIntent] = useState('');
  const [newIntentModel, setNewIntentModel] = useState('');
  if (r.loading || !mr) return <Skeleton className="h-44 w-full" />;
  const settings = r.settings;
  const busy = r.busy;
  const workerFlat = r.workers;
  const judgeFlat = r.judges;
  const codexRescue = settings?.models?.codexRescue;
  const codexRescueOptions = [...(mr.available.find((p) => p.provider === 'codex')?.models ?? [])];
  if (codexRescue?.configured && !codexRescueOptions.some((model) => model.id === codexRescue.modelId)) {
    codexRescueOptions.push({ id: codexRescue.modelId, label: `${codexRescue.modelId} (saved)` });
  }
  const discovery = mr.discovery;
  const discoveryProviders = discovery ? Object.values(discovery.providers) : [];
  const discoveryDegraded = discoveryProviders.some((provider) => provider.phase === 'degraded');
  const discoveryMessage = discovery?.refreshing
    ? 'Refreshing model catalogs. Saved routes stay active meanwhile.'
    : discoveryDegraded
      ? 'A model catalog refresh is degraded. Using last-known models; retrying automatically.'
      : discoveryProviders.some((provider) => provider.phase === 'ready')
        ? `Live catalogs · OpenAI ${discovery?.providers.openai.modelCount ?? 0} · Claude ${discovery?.providers.anthropic.modelCount ?? 0}`
        : 'Waiting for provider catalog credentials; presets and saved routes remain available.';

  const fusion = settings?.fusion;
  const judgeMetrics = settings?.judgeMetrics;
  const secondOpinionOn = Boolean(fusion && fusion.mode !== 'off');
  const fusionWhen: 'off' | 'high' | 'all' = !secondOpinionOn ? 'off' : fusion?.mode === 'all' ? 'all' : 'high';
  const boundedFusionAttempts = (fusion?.health?.accepted ?? 0) + (fusion?.health?.corrected ?? 0) + (fusion?.health?.safeFallbacks ?? 0);
  const onFusion = (when: 'off' | 'high' | 'all') => r.run('fusion', () => patchFusion({ mode: when, strategy: 'verify' }));
  const judgeSameAsBrain = mr.roles.judge.provider === mr.roles.brain.provider && mr.roles.judge.modelId === mr.roles.brain.modelId;
  const onCodexRescue = (value: string) => r.run('codex-rescue', () => patchCodexRescueModel(value === '__primary__' ? { clear: true } : { modelId: value }));
  const workerIntents = mr.bindings.filter((b) => b.role === 'worker' && b.whenIntent);
  const modelLabel = (id: string) => workerFlat.find((m) => m.id === id)?.label ?? id;
  const onAddIntent = () => {
    const intent = newIntent.trim();
    if (!intent || !newIntentModel) return;
    void r.run('intent-add', async () => {
      await patchModelRole({ role: 'worker', modelId: newIntentModel, whenIntent: intent });
      setNewIntent(''); setNewIntentModel('');
    });
  };
  const onRemoveIntent = (whenIntent: string) => r.run(`intent-rm-${whenIntent}`, () => patchModelRole({ role: 'worker', whenIntent, clear: true }));

  const row = (label: string, hint: string, control: React.ReactNode, note?: React.ReactNode) => (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 border-t border-border px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <div className="text-body font-semibold text-fg">{label}</div>
        <div className="text-small text-muted">{hint}</div>
        {note}
      </div>
      <div className="flex min-w-0 max-w-[60%] items-center gap-2">{control}</div>
    </div>
  );
  const inactive = (role: 'brain' | 'worker' | 'judge') => mr.roles[role].inactiveBinding && (
    <div className="mt-1 flex items-center gap-1.5 text-caption text-warning" title={mr.roles[role].inactiveBinding?.reason}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">Saved {mr.roles[role].inactiveBinding?.modelId} is unavailable; using the default.</span>
    </div>
  );
  const seg = (value: string, options: Array<[string, string]>, onPick: (v: string) => void, disabled: boolean) => (
    <div role="group" className="inline-flex rounded-full bg-subtle p-0.5">
      {options.map(([v, label]) => (
        <button key={v} type="button" disabled={disabled} aria-pressed={value === v} onClick={() => onPick(v)}
          className={cn('rounded-full px-3 py-1 text-small font-semibold transition-colors disabled:opacity-60', value === v ? 'bg-surface text-fg shadow-xs' : 'text-muted hover:text-fg')}>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {row('Brain', 'Answers you and plans the work',
          <Select disabled={busy === 'brain'} value={r.brainValue} onChange={(e) => void r.onBrain(e.target.value)} aria-label="Brain model">
            {r.brains.map((o) => <option key={o.value} value={o.value} disabled={!o.available}>{o.label}{o.note ? ` (${o.note})` : ''}</option>)}
          </Select>, inactive('brain'))}
        {row('Workers', 'Parallel helpers on fan-out steps',
          <Select disabled={busy === 'worker'} value={mr.roles.worker.source === 'default' ? '__default__' : mr.roles.worker.modelId} onChange={(e) => void r.onRole('worker', e.target.value)} aria-label="Workers model">
            <option value="__default__">Follow the brain</option>
            {workerFlat.map((m) => <option key={`w-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
          </Select>, inactive('worker'))}
        {row('Judge', 'Checks finished work before it is called done',
          <Select disabled={busy === 'judge'} value={mr.roles.judge.source === 'default' ? '__default__' : mr.roles.judge.modelId} onChange={(e) => void r.onRole('judge', e.target.value)} aria-label="Judge model">
            <option value="__default__">Automatic · different family, fast</option>
            {judgeFlat.map((m) => <option key={`j-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
          </Select>,
          <>
            {inactive('judge')}
            {secondOpinionOn && judgeSameAsBrain && (
              <div className="mt-1 flex items-center gap-1.5 text-caption text-warning"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />The judge is the same model as the brain, so a second opinion adds little.</div>
            )}
          </>)}
        {row('Second opinion', 'A different family re-checks consequential work',
          seg(fusionWhen, [['off', 'Off'], ['high', 'Consequential'], ['all', 'Everything']], (v) => void onFusion(v as 'off' | 'high' | 'all'), busy === 'fusion'),
          fusion?.active ? <div className="mt-1 text-caption text-success">Active now.</div>
            : secondOpinionOn ? <div className="mt-1 text-caption text-warning">Configured but inactive — the judge is not available yet.</div> : null)}
        <details className="group border-t border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-small text-muted hover:text-fg">
            <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden />
            Rescue model, routing by task, completion review, judge numbers
            <span className="ml-auto text-caption text-faint">Advanced</span>
          </summary>
          <div className="space-y-4 border-t border-border bg-canvas px-4 py-4">
            {discovery && (
              <div className={cn('flex items-start gap-2 text-caption', discoveryDegraded ? 'text-warning' : 'text-muted')}>
                <Sparkles className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', discovery.refreshing && 'animate-pulse text-primary')} aria-hidden />
                <span>{discoveryMessage}</span>
              </div>
            )}
            {codexRescue && (
              <Field label="Codex rescue" hint="Last-resort Codex model when an all-in BYO brain fails before producing content.">
                {(id) => (
                  <Select id={id} disabled={busy === 'codex-rescue'} value={codexRescue.configured ? codexRescue.modelId : '__primary__'} onChange={(event) => void onCodexRescue(event.target.value)}>
                    <option value="__primary__">Follow Codex primary ({codexRescue.inheritedModelId})</option>
                    {codexRescueOptions.map((model) => <option key={`rescue-${model.id}`} value={model.id}>{model.label}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <div>
              <div className="mb-1 text-label text-fg">Routing by task</div>
              <p className="mb-2 text-caption text-muted">Send a kind of work to a specific model — “design” to Claude. Or just say it in chat.</p>
              {workerIntents.length > 0 && (
                <ul className="mb-2 space-y-1.5">
                  {workerIntents.map((b) => (
                    <li key={`wi-${b.whenIntent}`} className="flex min-w-0 items-center gap-2 text-small">
                      <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-caption text-fg">{b.whenIntent}</span>
                      <span className="text-muted" aria-hidden>→</span>
                      <span className="truncate text-fg" title={b.modelId}>{modelLabel(b.modelId)}</span>
                      <button type="button" className="ml-auto shrink-0 rounded p-1 text-muted hover:text-danger disabled:opacity-50" disabled={busy === `intent-rm-${b.whenIntent}`} onClick={() => void onRemoveIntent(b.whenIntent as string)} aria-label={`Remove ${b.whenIntent} routing`}>
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <Input className="h-9 max-w-[8rem]" placeholder="design" value={newIntent} onChange={(e) => setNewIntent(e.target.value)} aria-label="Task intent" />
                <span className="text-muted" aria-hidden>→</span>
                <Select className="h-9 min-w-0" value={newIntentModel} onChange={(e) => setNewIntentModel(e.target.value)} aria-label="Model for this intent">
                  <option value="">Pick a model…</option>
                  {workerFlat.map((m) => <option key={`wi-opt-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
                </Select>
                <button type="button" className="h-9 shrink-0 rounded-md border border-border px-3 text-small text-fg hover:border-primary disabled:opacity-50" disabled={busy === 'intent-add' || !newIntent.trim() || !newIntentModel} onClick={onAddIntent}>Add</button>
              </div>
            </div>
            <CompletionReviewControl />
            {boundedFusionAttempts > 0 && (
              <p className="text-caption text-muted">Recent second opinions: {fusion?.health?.accepted ?? 0} accepted unchanged · {fusion?.health?.corrected ?? 0} corrected · {fusion?.health?.safeFallbacks ?? 0} safely kept the draft.</p>
            )}
            <LastVerificationLine enabled={secondOpinionOn} />
            <JudgeMetrics metrics={judgeMetrics} />
          </div>
        </details>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-small">
        {r.saved && <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> Saved — applies on the next message</span>}
        {r.error && <span className="text-danger">{r.error}</span>}
        {mr.available.length === 0 && <span className="text-muted">No models connected yet — sign in or add a key under Connected.</span>}
      </div>
      {r.claudeSignInFor && <div className="mt-3"><ClaudeLoginForm embedded /></div>}
    </div>
  );
}

/** The most recent REAL verification from the durable fusion trace — shown
 *  only when second-opinion is on and a trace exists, so the UI never claims
 *  "verified" beyond what actually ran. One lazy fetch; no polling. */
function LastVerificationLine({ enabled }: { enabled: boolean }) {
  const traces = usePoll(['fusion-traces'], () => getRecentFusionTraces(1), 0, { enabled });
  const last = traces.data?.[0];
  if (!enabled || !last) return null;
  return (
    <p className="mt-1 text-caption text-muted">
      Last verification: the judge {fusionOutcomeLabel(last.outcome)}
      {last.judge ? ` · ${last.judge.replace(/^[a-z]+:/, '')}` : ''}
      {last.ts ? ` · ${relativeTime(last.ts)}` : ''}
      {typeof last.durationMs === 'number' ? ` · ${(last.durationMs / 1000).toFixed(1)}s` : ''}
    </p>
  );
}
