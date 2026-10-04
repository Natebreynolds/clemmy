import { CompletionReviewControl } from './CompletionReviewControl';
import { ClaudeLoginForm } from './ClaudeLoginForm';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, Check, ChevronRight, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { judgeFallbackChoices, judgeFallbackValue, PROVIDER_LABEL, ROLE_WORDS, useModelRoles } from '@/lib/model-roles';
import { QUICK_ROLE_WORDS, memoryModelUnavailableText, memoryRoleAutomaticText, modelDisplayName } from '@clem/chat-engine';
import { memoryTimeFormat } from '@/lib/memory-work';
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
  calendar_watch: 'Calendar watch',
  revision: 'Revision check',
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
              {(total.fastDecisions ?? 0) > 0 && (
                <> {total.fastDecisions} fast.</>
              )}
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
  // The Memory tab's "Change" lands on the memory row. The row exists only once
  // the settings read lands, after the page's own hash scroll has run.
  const { hash } = useLocation();
  const memoryRowReady = Boolean(mr?.roles.memory);
  const [memoryLanded, setMemoryLanded] = useState(false);
  useEffect(() => {
    if (hash !== '#memory-model' || !memoryRowReady) return;
    document.getElementById('memory-model')?.scrollIntoView({ block: 'center' });
    // A short wash says "this is the row you came for", then lets go.
    setMemoryLanded(true);
    const timer = window.setTimeout(() => setMemoryLanded(false), 2_400);
    return () => window.clearTimeout(timer);
  }, [hash, memoryRowReady]);
  if (r.loading || !mr) return <Skeleton className="h-44 w-full" />;
  const settings = r.settings;
  const busy = r.busy;
  const workerFlat = r.workers;
  const judgeFlat = r.judges;
  const writerFlat = r.writers;
  const fallback = mr.judgeFallback;
  const fallbackChoices = judgeFallbackChoices(mr);
  const fallbackUnavailable = fallback?.mode === 'model'
    && fallbackChoices.some((model) => model.id === (fallback.modelId ?? '') && !model.available);
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
  // A chosen writer reviewed by its own family grades its own work. BYO family
  // is the endpoint, which this page cannot see, so only name the clear cases.
  const writer = mr.roles.writer;
  const judgeSharesWriterFamily = Boolean(writer && writer.source !== 'default' && writer.provider !== 'byo'
    && mr.roles.judge.provider === writer.provider);
  // "Keeps your memory": Settings-only, shown when the daemon knows the role.
  // Automatic names the memory route's OWN model (never the checker's); a
  // chosen model that is gone leaves learning waiting, and the row says so.
  const memory = mr.roles.memory;
  const memoryFlat = r.memories;
  const memoryPick = memory?.source === 'default' ? null : (memory?.modelId || memory?.inactiveBinding?.modelId || null);
  const memoryMissingPick = memoryPick && !memoryFlat.some((m) => m.id === memoryPick) ? memoryPick : null;
  // The memory route never substitutes a pick: an unavailable pick means
  // learning waits (the daemon then names no model).
  const memoryWaits = Boolean(memory?.inactiveBinding && !memory.modelId);
  // "Quick checks": Settings-only, shown when the daemon knows the role.
  const quick = mr.roles.quick;
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
    // One control column for every role, so Brain, Workers and Judge line up
    // (an `auto` column sized each row to its own select).
    <div className="grid grid-cols-1 items-center gap-2 border-t border-border px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] sm:gap-4">
      <div className="min-w-0">
        <div className="text-body font-semibold text-fg">{label}</div>
        <div className="text-small text-muted">{hint}</div>
        {note}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:justify-end [&>select]:w-full">{control}</div>
    </div>
  );
  // Warn only when something else answers. The live brain binding is
  // "inactive" whenever the active-brain switch owns the choice — even when
  // both name the same model, which read "Saved grok-4.6 is unavailable" over
  // a grok-4.6 brain.
  const inactive = (role: 'brain' | 'worker' | 'judge' | 'writer' | 'quick') => {
    const resolved = mr.roles[role];
    return resolved?.inactiveBinding && resolved.inactiveBinding.modelId !== resolved.modelId && (
      <div className="mt-1 flex items-center gap-1.5 text-caption text-warning" title={resolved.inactiveBinding.reason}>
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">Your pick, {modelDisplayName(resolved.inactiveBinding.modelId)}, isn’t available, so {modelDisplayName(resolved.modelId)} is used instead.</span>
      </div>
    );
  };
  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {row(ROLE_WORDS.brain.title, ROLE_WORDS.brain.hint,
          <Select disabled={busy === 'brain'} value={r.brainValue} onChange={(e) => void r.onBrain(e.target.value)} aria-label="Model that does the work">
            {r.brains.map((o) => <option key={o.value} value={o.value} disabled={!o.available}>{o.label}{o.note ? ` (${o.note})` : ''}</option>)}
          </Select>, inactive('brain'))}
        {row(ROLE_WORDS.worker.title, ROLE_WORDS.worker.hint,
          <Select disabled={busy === 'worker'} value={mr.roles.worker.source === 'default' ? '__default__' : mr.roles.worker.modelId} onChange={(e) => void r.onRole('worker', e.target.value)} aria-label="Model that helps in parallel">
            <option value="__default__">Same model that does the work</option>
            {workerFlat.map((m) => <option key={`w-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
          </Select>, inactive('worker'))}
        {writer && row(ROLE_WORDS.writer.title, ROLE_WORDS.writer.hint,
          <Select disabled={busy === 'writer'} value={writer.source === 'default' ? '__default__' : writer.modelId} onChange={(e) => void r.onRole('writer', e.target.value)} aria-label="Model that writes the final answer">
            <option value="__default__">Same model that does the work</option>
            {writerFlat.map((m) => <option key={`wr-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
          </Select>,
          <>
            {inactive('writer')}
            {judgeSharesWriterFamily && (
              <div className="mt-1 flex items-center gap-1.5 text-caption text-warning"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />The checker is from the same family as the writer, so it reviews its own family’s work. Pick a checker from another family.</div>
            )}
          </>)}
        {row(ROLE_WORDS.judge.title, ROLE_WORDS.judge.hint,
          <Select disabled={busy === 'judge'} value={mr.roles.judge.source === 'default' ? '__default__' : mr.roles.judge.modelId} onChange={(e) => void r.onRole('judge', e.target.value)} aria-label="Model that checks the work">
            <option value="__default__">Automatic · a fast model from another provider</option>
            {judgeFlat.map((m) => <option key={`j-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
          </Select>,
          <>
            {inactive('judge')}
            {/* The owner connected a typed fast checker, watched it serve real
                verdicts, and found nothing about it on the page that claims to
                say "who checks". It is deliberately NOT a dropdown option: it
                answers FIRST and the selected judge backstops it, so offering
                it as a peer choice would let someone remove their own backstop
                without being told. Naming the arrangement is the honest fix.
                Shown only once it has actually served — a count from the
                ledger, never a claim that it is configured. */}
            {(judgeMetrics?.total?.fastDecisions ?? 0) > 0 && (
              <div className="mt-1 text-caption text-muted">
                A fast checker answered first on{' '}
                <span className="text-fg">{judgeMetrics?.total?.fastDecisions}</span>{' '}
                {judgeMetrics?.total?.fastDecisions === 1 ? 'check' : 'checks'} — this model backstops it.
              </div>
            )}
            {secondOpinionOn && judgeSameAsBrain && (
              <div className="mt-1 flex items-center gap-1.5 text-caption text-warning"><AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />The checker is the same model that does the work, so a second opinion adds little.</div>
            )}
          </>)}
        {fallback && row(ROLE_WORDS.fallback.title, ROLE_WORDS.fallback.hint,
          <Select disabled={busy !== null} value={judgeFallbackValue(fallback)} onChange={(event) => void r.onJudgeFallback(event.target.value)} aria-label="Backup checker model" aria-describedby="judge-fallback-note">
            <option value="automatic">Automatic</option>
            <option value="off">No fallback</option>
            {fallbackChoices.map((model) => <option key={`jf-${model.provider}-${model.id}`} value={`model:${model.id}`} disabled={!model.available}>{model.label}{model.provider ? ` · ${PROVIDER_LABEL[model.provider] ?? model.provider}` : ''}{!model.available ? ' (unavailable)' : ''}</option>)}
          </Select>,
          <div id="judge-fallback-note" className={`mt-1 text-caption ${fallbackUnavailable ? 'text-warning' : 'text-muted'}`} role={busy === 'judge-fallback' ? 'status' : undefined}>
            {busy === 'judge-fallback' ? 'Saving…' : fallbackUnavailable
              ? `Your saved choice is unavailable. ${fallback.reason || 'Connect it again or choose another fallback.'}`
              : fallback.mode === 'off' ? 'The checker reviews without a backup.' : 'Applies to new requests.'}
          </div>)}
        {memory && (
          <div
            id="memory-model"
            className={cn('grid scroll-mt-24 grid-cols-1 items-center gap-2 border-t border-border px-4 py-3 transition-colors duration-slow sm:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] sm:gap-4', memoryLanded && 'bg-primary-tint')}
          >
            <div className="min-w-0">
              <div className="text-body font-semibold text-fg">{ROLE_WORDS.memory.title}</div>
              <div className="text-small text-muted">{ROLE_WORDS.memory.hint}</div>
              {memory.source === 'default' && (
                <div className="mt-1 text-caption text-muted">{memoryRoleAutomaticText(memory.follows ?? null, memory.modelId || null)}</div>
              )}
              {memoryWaits && memory.inactiveBinding && (
                <div className="mt-1 flex items-center gap-1.5 text-caption text-warning" title={memory.inactiveBinding.reason}>
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0">Your pick, {modelDisplayName(memory.inactiveBinding.modelId)}, isn’t available, so learning waits until it is back. Nothing is lost.</span>
                </div>
              )}
              {!memoryWaits && memory.unavailable && (
                // Automatic with nothing that can serve, or a pick that is out
                // of quota or backing off: the same reason the Memory tab gives.
                <div className="mt-1 flex items-center gap-1.5 text-caption text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0">{memoryModelUnavailableText(memory.unavailable, memory.modelId ? modelDisplayName(memory.modelId) : null, memoryTimeFormat(Date.now()))}</span>
                </div>
              )}
              <Link to="/memory" className="mt-1 inline-block text-caption font-semibold text-primary hover:underline">See it at work in Memory</Link>
            </div>
            <div className="flex min-w-0 items-center gap-2 sm:justify-end [&>select]:w-full">
              <Select disabled={busy === 'memory'} value={memoryPick ?? '__default__'} onChange={(e) => void r.onRole('memory', e.target.value)} aria-label="Model that keeps your memory">
                <option value="__default__">Automatic{memory.source === 'default' && memory.modelId ? ` · ${modelDisplayName(memory.modelId)}` : ''}</option>
                {memoryFlat.map((m) => <option key={`m-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
                {memoryMissingPick && <option value={memoryMissingPick}>{modelDisplayName(memoryMissingPick)}{memoryWaits ? ' (unavailable)' : ''}</option>}
              </Select>
            </div>
          </div>
        )}
        {quick && row(ROLE_WORDS.quick.title, ROLE_WORDS.quick.hint,
          <Select disabled={busy === 'quick'} value={quick.source === 'default' ? '__default__' : quick.modelId} onChange={(e) => void r.onRole('quick', e.target.value)} aria-label="Model for quick checks">
            <option value="__default__">{QUICK_ROLE_WORDS.automatic}{quick.source === 'default' && quick.modelId ? ` · ${modelDisplayName(quick.modelId)}` : ''}</option>
            {r.quicks.map((m) => <option key={`q-${m.provider}-${m.id}`} value={m.id}>{m.label} · {PROVIDER_LABEL[m.provider] ?? m.provider}</option>)}
          </Select>, inactive('quick'))}
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
            {/* Second opinion no longer has a control of its own: the judge and
                the fast checker cover what it re-checked. Anyone who still has
                it on keeps a way to turn it off. */}
            {secondOpinionOn && (
              <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
                <span>Second opinion is on: a second model family re-checks {fusionWhen === 'all' ? 'everything' : 'consequential work'}.</span>
                <button type="button" className="rounded-md border border-border px-2 py-0.5 text-caption text-fg hover:border-primary disabled:opacity-50" disabled={busy === 'fusion'} onClick={() => void onFusion('off')}>Turn off</button>
              </div>
            )}
            {boundedFusionAttempts > 0 && (
              <p className="text-caption text-muted">Recent second opinions: {fusion?.health?.accepted ?? 0} accepted unchanged · {fusion?.health?.corrected ?? 0} corrected · {fusion?.health?.safeFallbacks ?? 0} safely kept the draft.</p>
            )}
            <LastVerificationLine enabled={secondOpinionOn} />
            <JudgeMetrics metrics={judgeMetrics} />
          </div>
        </details>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-small">
        {r.saved && <span className="inline-flex items-center gap-1 text-success"><Check className="h-4 w-4" aria-hidden /> {r.saved === 'memory' ? 'Saved — the next memory job uses it' : 'Saved — applies on the next message'}</span>}
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
