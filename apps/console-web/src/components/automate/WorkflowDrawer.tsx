import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Play, Trash2, Check, Loader2, Activity, AlertTriangle, Database, FileText, Gauge, GitBranch, KeyRound, Layers2, Radio, Send, ShieldCheck, Wrench, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { ScheduleEditor } from './ScheduleEditor';
import { detectedTimezone } from '@/lib/cron';
import { cn } from '@/lib/cn';
import { certPrimaryAction, certificationActionLabel, certificationTone, workflowCertificationCounts, workflowPrimaryAction } from '@/lib/workflowCertification';
import { getWorkflow, patchWorkflow, deleteWorkflow, runWorkflow, setWorkflowEnabled, type WorkflowCertification, type WorkflowDetail, type WorkflowResourceBinding, type WorkflowResourceBindingReport, type WorkflowResourceProposalStatus } from '@/lib/automate';

function engineToneClasses(tone: Tone) {
  switch (tone) {
    case 'success': return 'border-success/30 bg-success-tint text-success';
    case 'info': return 'border-info/30 bg-info-tint text-info';
    case 'warning': return 'border-warning/30 bg-warning-tint text-warning';
    case 'danger': return 'border-danger/30 bg-danger-tint text-danger';
    case 'live': return 'border-primary/30 bg-primary-tint text-primary';
    case 'neutral': return 'border-border bg-surface text-muted';
  }
}

function dryRunTone(verdict?: string): Tone {
  if (verdict === 'ready') return 'success';
  if (verdict === 'needs_inputs') return 'warning';
  if (verdict === 'blocked') return 'danger';
  return 'neutral';
}

function resourceProposalTone(status?: WorkflowResourceProposalStatus): Tone {
  if (status === 'bound' || status === 'optional') return 'success';
  if (status === 'needs_connection') return 'warning';
  if (status === 'needs_surface' || status === 'needs_selector') return 'info';
  if (status === 'unsupported') return 'danger';
  return 'neutral';
}

function EngineMetric({ icon: Icon, label, value, tone = 'neutral' }: { icon: LucideIcon; label: string; value: string; tone?: Tone }) {
  return (
    <div className={cn('min-w-0 rounded-md border px-3 py-2', engineToneClasses(tone))}>
      <div className="mb-1 flex items-center gap-1.5 text-caption font-semibold">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate text-small font-semibold">{value}</div>
    </div>
  );
}

function WorkflowEnginePanel({
  certification,
  stepCount,
  resources = {},
  resourceBinding,
}: {
  certification?: WorkflowCertification;
  stepCount: number;
  resources?: Record<string, WorkflowResourceBinding>;
  resourceBinding?: WorkflowResourceBindingReport;
}) {
  if (!certification) return null;
  const counts = workflowCertificationCounts(certification);
  const dryRun = certification.dryRun;
  const waves = dryRun?.waves ?? [];
  const steps = dryRun?.steps ?? [];
  const resourceEntries = Object.values(resources);
  const proposalByResource = new Map((resourceBinding?.proposals ?? []).map((proposal) => [proposal.resourceId, proposal]));
  const resourceGaps = certification.resourceGaps ?? [];
  const tools = dryRun?.effects?.toolsTouched ?? dryRun?.toolsTouched ?? [];
  const sends = dryRun?.effects?.sends ?? [];
  const writes = dryRun?.effects?.writes ?? [];
  const missingInputs = [...(certification.missingRunInputs ?? []), ...(certification.missingTestInputs ?? [])];
  const blockers = certification.blockingReasons ?? [];
  const gaps = certification.readinessGaps ?? [];
  const advisories = certification.contractAdvisories ?? [];
  const effectTone: Tone = counts.sends > 0 ? 'warning' : counts.writes > 0 ? 'info' : 'success';
  const resourceTone: Tone = resourceGaps.length > 0 ? 'info' : resourceEntries.length > 0 ? 'success' : 'neutral';
  const phases: Array<{ label: string; value: string; tone: Tone; Icon: LucideIcon }> = [
    { label: 'Bindings', value: resourceGaps.length > 0 ? `${resourceGaps.length} needed` : resourceEntries.length > 0 ? `${resourceEntries.length} bound` : 'none', tone: resourceTone, Icon: Database },
    { label: 'Inputs', value: missingInputs.length > 0 ? `${missingInputs.length} missing` : 'set', tone: missingInputs.length > 0 ? 'warning' : 'success', Icon: KeyRound },
    { label: 'Plan', value: `${counts.waves || 0} waves`, tone: counts.blockers > 0 ? 'danger' : 'success', Icon: GitBranch },
    { label: 'Dry-run', value: dryRun?.verdict?.replace('_', ' ') ?? 'unknown', tone: dryRunTone(dryRun?.verdict), Icon: Activity },
    { label: 'Tools', value: tools.length > 0 ? `${tools.length} touched` : 'local', tone: counts.blockers > 0 ? 'danger' : 'success', Icon: Wrench },
    { label: 'Effects', value: `${counts.sends + counts.writes} external`, tone: effectTone, Icon: Send },
    { label: 'Runtime', value: workflowPrimaryAction(certification), tone: certificationTone(certification.state), Icon: Radio },
  ];

  return (
    <section className="mt-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-h3 text-fg">Engine</h3>
        <StatusPill tone={certificationTone(certification.state)}>{certification.label}</StatusPill>
      </div>
      <div className="rounded-md border border-border bg-subtle p-3">
        <p className="mb-3 text-small text-muted">{certification.summary}</p>

        <div className="grid gap-2 sm:grid-cols-3">
          <EngineMetric icon={Layers2} label="Steps" value={`${stepCount}`} tone="neutral" />
          <EngineMetric icon={Database} label="Resources" value={resourceEntries.length > 0 ? `${resourceEntries.length} bound` : 'none'} tone={resourceTone} />
          <EngineMetric icon={GitBranch} label="Waves" value={`${counts.parallelWaves}/${counts.waves} parallel`} tone={counts.waves > 1 ? 'info' : 'neutral'} />
          <EngineMetric icon={Wrench} label="Tools" value={tools.length > 0 ? tools.slice(0, 2).join(', ') : 'none'} tone={counts.blockers > 0 ? 'danger' : tools.length > 0 ? 'success' : 'neutral'} />
          <EngineMetric icon={Database} label="Reads" value={`${counts.reads}`} tone="neutral" />
          <EngineMetric icon={FileText} label="Writes" value={`${counts.writes}`} tone={counts.writes > 0 ? 'info' : 'neutral'} />
          <EngineMetric icon={Send} label="Sends" value={`${counts.sends}`} tone={counts.sends > 0 ? 'warning' : 'neutral'} />
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {phases.map(({ label, value, tone, Icon }) => (
            <div key={label} className={cn('min-w-0 rounded-md border px-3 py-2', engineToneClasses(tone))}>
              <div className="flex items-center gap-1.5 text-caption font-semibold">
                <Icon className={cn('h-3.5 w-3.5 shrink-0', label === 'Runtime' && certification.canRun && 'animate-breathe')} aria-hidden />
                <span className="truncate">{label}</span>
              </div>
              <div className="truncate text-caption opacity-80">{value}</div>
            </div>
          ))}
        </div>

        {resourceEntries.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-label text-fg">Resources</div>
            <div className="grid gap-1.5">
              {resourceEntries.slice(0, 6).map((resource) => (
                <div key={resource.id} className="rounded-md border border-border bg-surface px-3 py-2">
                  <div className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <div className="truncate text-small font-semibold text-fg">{resource.label || resource.id}</div>
                        {proposalByResource.get(resource.id) && (
                          <StatusPill tone={resourceProposalTone(proposalByResource.get(resource.id)?.status)}>
                            {proposalByResource.get(resource.id)?.status?.replace(/_/g, ' ')}
                          </StatusPill>
                        )}
                      </div>
                      <div className="truncate text-caption text-faint">{resource.kind}</div>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="max-w-full truncate rounded-sm bg-subtle px-2 py-0.5 text-caption text-muted">
                        {resource.toolkit || resource.tool || resource.cli || resource.mcpServer || 'surface pending'}
                      </span>
                      <span className="max-w-full truncate rounded-sm bg-subtle px-2 py-0.5 text-caption text-muted">
                        {resource.resourceId || resource.url || resource.name || resource.account || resource.connectionId || 'selector pending'}
                      </span>
                    </div>
                  </div>
                  {proposalByResource.get(resource.id)?.summary && (
                    <p className="mt-2 text-caption text-muted">{proposalByResource.get(resource.id)?.summary}</p>
                  )}
                  {proposalByResource.get(resource.id)?.recommended && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-caption">
                      <span className="rounded-sm bg-info-tint px-2 py-0.5 text-info">
                        {proposalByResource.get(resource.id)?.recommended?.label} · {proposalByResource.get(resource.id)?.recommended?.status}
                      </span>
                      {proposalByResource.get(resource.id)?.recommended?.accountLabel && (
                        <span className="rounded-sm bg-subtle px-2 py-0.5 text-muted">
                          {proposalByResource.get(resource.id)?.recommended?.accountLabel}
                        </span>
                      )}
                    </div>
                  )}
                  {(proposalByResource.get(resource.id)?.nextActions.length ?? 0) > 0 && (
                    <div className="mt-2 text-caption text-faint">{proposalByResource.get(resource.id)?.nextActions[0]}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {waves.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-label text-fg">Waves</div>
            <div className="space-y-1.5">
              {waves.slice(0, 6).map((wave) => (
                <div key={wave.index} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                  <span className="shrink-0 text-caption font-semibold text-faint">W{wave.index}</span>
                  <div className="min-w-0 flex-1 truncate text-caption text-muted">{wave.stepIds.join(' -> ')}</div>
                  {wave.parallel && <StatusPill tone="info">parallel</StatusPill>}
                </div>
              ))}
            </div>
          </div>
        )}

        {steps.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 text-label text-fg">Trace</div>
            <div className="space-y-1.5">
              {steps.slice(0, 8).map((step) => (
                <div key={step.stepId} className="grid gap-1 rounded-md border border-border bg-surface px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <div className="min-w-0">
                    <div className="truncate text-small font-semibold text-fg">{step.stepId}</div>
                    <div className="truncate text-caption text-faint">{step.label || step.executor || 'step'}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-sm bg-subtle px-2 py-0.5 text-caption text-muted">{step.executor || 'model'}</span>
                    <span className="rounded-sm bg-subtle px-2 py-0.5 text-caption text-muted">{step.effect || 'internal'}</span>
                    {step.gated && <StatusPill tone="warning">approval</StatusPill>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {(sends.length > 0 || writes.length > 0 || counts.approvals > 0) && (
          <div className="mt-3 grid gap-2">
            {sends.slice(0, 4).map((effect) => (
              <div key={`send-${effect.stepId}`} className="rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-small text-warning">
                <span className="font-semibold">{effect.stepId}</span> · {effect.detail}
              </div>
            ))}
            {writes.slice(0, 4).map((effect) => (
              <div key={`write-${effect.stepId}`} className="rounded-md border border-info/30 bg-info-tint px-3 py-2 text-small text-info">
                <span className="font-semibold">{effect.stepId}</span> · {effect.detail}
              </div>
            ))}
            {counts.approvals > 0 && (
              <div className="rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-small text-warning">
                {counts.approvals} approval gate{counts.approvals === 1 ? '' : 's'}
              </div>
            )}
          </div>
        )}

        {(resourceGaps.length > 0 || missingInputs.length > 0 || blockers.length > 0 || gaps.length > 0 || advisories.length > 0) && (
          <div className="mt-3 grid gap-2">
            {resourceGaps.length > 0 && <IssueList icon={Database} tone="info" title="Resource bindings" items={resourceGaps} />}
            {missingInputs.length > 0 && <IssueList icon={Gauge} tone="warning" title="Missing inputs" items={missingInputs} />}
            {blockers.length > 0 && <IssueList icon={AlertTriangle} tone="danger" title="Blockers" items={blockers} />}
            {gaps.length > 0 && <IssueList icon={ShieldCheck} tone="info" title="Readiness" items={gaps.map((gap) => gap.stepId ? `${gap.stepId}: ${gap.question}` : gap.question)} />}
            {advisories.length > 0 && <IssueList icon={Activity} tone="warning" title="Advisories" items={advisories} />}
          </div>
        )}

        {certification.nextActions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {certification.nextActions.map((action) => (
              <StatusPill key={action} tone={certificationTone(certification.state)}>{certificationActionLabel(action)}</StatusPill>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function IssueList({ icon: Icon, tone, title, items }: { icon: LucideIcon; tone: Tone; title: string; items: string[] }) {
  return (
    <div className={cn('rounded-md border px-3 py-2', engineToneClasses(tone))}>
      <div className="mb-1 flex items-center gap-1.5 text-caption font-semibold">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {title}
      </div>
      <ul className="space-y-1">
        {items.slice(0, 4).map((item) => <li key={item} className="text-small">{item}</li>)}
      </ul>
    </div>
  );
}

// Prettify a model id for humans: claude-sonnet-5 → Sonnet, claude-opus-4-8 →
// Opus, gpt-5.4 → GPT-5.4, glm-5.2 → GLM-5.2.
function shortModel(id?: string | null): string {
  if (!id) return 'AI';
  const m = id.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('fable')) return 'Fable';
  if (m.startsWith('gpt')) return id.toUpperCase().replace('GPT', 'GPT-').replace('GPT--', 'GPT-');
  return id;
}

// First sentence of a step prompt, as a plain-English one-liner.
function plainStepPurpose(prompt?: string): string {
  if (!prompt) return '';
  const firstSentence = prompt.trim().split(/(?<=[.!?])\s/)[0] ?? prompt.trim();
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 157)}…` : firstSentence;
}

type DryRunTraceStep = NonNullable<NonNullable<WorkflowCertification['dryRun']>['steps']>[number];

// A readable, deterministic "here's what this does" view built entirely from the
// workflow definition + dry-run trace (no LLM). Accurate by construction: the
// impact strip and per-step effects come from the same trace the runner uses.
function WorkflowHowItWorks({ wf }: { wf: WorkflowDetail }) {
  const steps = wf.steps ?? [];
  if (steps.length === 0) return null;
  const trace = new Map<string, DryRunTraceStep>((wf.certification?.dryRun?.steps ?? []).map((s) => [s.stepId, s]));
  const fx = wf.certification?.dryRun?.effectCounts;

  const runBadge = (t?: DryRunTraceStep) => {
    const ex = t?.executor ?? 'model';
    if (ex === 'call') return <StatusPill tone="success">⚡ direct call{t?.touches?.tools?.[0] ? ` · ${t.touches.tools[0]}` : ''}</StatusPill>;
    if (ex === 'deterministic') return <StatusPill tone="success">📜 script</StatusPill>;
    if (ex === 'skill') return <StatusPill tone="info">🧩 skill</StatusPill>;
    return <StatusPill tone="info">🤖 AI · {shortModel(t?.model)}</StatusPill>;
  };
  const effectBadge = (t?: DryRunTraceStep) => {
    if (!t) return null;
    if (t.effect === 'external_send') return <StatusPill tone="warning">⚠️ sends externally</StatusPill>;
    if (t.effect === 'external_write') return <StatusPill tone="info">✍️ writes</StatusPill>;
    return null;
  };

  return (
    <section className="mb-5">
      <h3 className="mb-2 text-h3 text-fg">How it works</h3>
      {fx && (fx.sends + fx.writes + fx.approvals) > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-caption text-muted">Real-world impact:</span>
          {fx.writes > 0 && <StatusPill tone="info">✍️ writes to {fx.writes} place{fx.writes === 1 ? '' : 's'}</StatusPill>}
          {fx.sends > 0 && <StatusPill tone="warning">⚠️ sends {fx.sends} externally</StatusPill>}
          {fx.approvals > 0 && <StatusPill tone="warning">🔒 {fx.approvals} approval{fx.approvals === 1 ? '' : 's'}</StatusPill>}
        </div>
      )}
      <ol>
        {steps.map((s, i) => {
          const t = trace.get(s.id ?? '');
          const purpose = plainStepPurpose(s.prompt) || t?.label || '';
          const uses = t?.reads?.length ? `uses ${t.reads.join(', ')}` : '';
          const produces = t?.emits ? `produces ${t.emits}` : '';
          return (
            <li key={s.id || i}>
              <div className="rounded-md border border-border bg-surface p-3">
                <div className="flex items-start gap-2.5">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-caption font-semibold text-primary">{i + 1}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-body font-medium text-fg">{s.name || s.id || `Step ${i + 1}`}</span>
                      {runBadge(t)}
                      {effectBadge(t)}
                      {t?.gated && <StatusPill tone="warning">🔒 needs approval</StatusPill>}
                    </div>
                    {purpose && <p className="mt-1 text-small text-muted">{purpose}</p>}
                    {(uses || produces) && (
                      <p className="mt-1 text-caption text-faint">{[uses, produces].filter(Boolean).join(' · ')}</p>
                    )}
                  </div>
                </div>
              </div>
              {i < steps.length - 1 && <div className="ml-[1.4rem] h-3 w-px bg-border" aria-hidden />}
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-caption text-faint">To change the steps, ask Clementine in Chat — it'll rewrite the workflow for you.</p>
    </section>
  );
}

export function WorkflowDrawer({ name, onClose }: { name: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [desc, setDesc] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [cron, setCron] = useState('');
  const [tz, setTz] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getWorkflow(name).then((d) => {
      if (!alive) return;
      setWf(d); setDesc(d.description ?? ''); setEnabled(!!d.enabled); setCron(d.trigger?.schedule ?? '');
      // Seed the tz so a scheduled time means the owner's time. Default to the
      // host zone when one isn't stored yet, so the picker shows a real value.
      setTz(d.trigger?.timezone || (d.trigger?.schedule ? detectedTimezone() : ''));
    }).catch((e) => alive && setError((e as Error).message)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [name]);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['workflows'] }); };

  const save = async () => {
    setSaving(true); setError('');
    try {
      await patchWorkflow(name, {
        description: desc,
        enabled,
        ...(cron.trim() ? { triggerSchedule: cron.trim(), ...(tz ? { timezone: tz } : {}) } : { clearTriggerSchedule: true }),
      });
      setSaved(true); invalidate();
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const run = async () => {
    setRunning(true); setError('');
    try { await runWorkflow(name); void qc.invalidateQueries({ queryKey: ['runs'] }); }
    catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };
  // Certification-driven primary action. `enable` uses the set-enabled route
  // (which queues a creation test when one is needed), then refetches so the
  // certification state + next step update in place. `guide` scrolls the
  // operator to the details they need to fill in.
  const activate = async () => {
    setRunning(true); setError('');
    try {
      await setWorkflowEnabled(name, true);
      const fresh = await getWorkflow(name);
      setWf(fresh); setEnabled(!!fresh.enabled); invalidate();
    } catch (e) { setError((e as Error).message); }
    finally { setRunning(false); }
  };
  const scrollToEngine = () => document.getElementById('wf-engine-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const primary = certPrimaryAction(wf?.certification);
  const runPrimary = () => {
    if (!primary) return run();
    if (primary.kind === 'run') return run();
    if (primary.kind === 'enable') return activate();
    return scrollToEngine();
  };
  const remove = async () => {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    await deleteWorkflow(name); invalidate(); onClose();
  };

  return (
    <div className="fixed inset-0 z-[110] flex justify-end bg-black/30 animate-fade-in" onMouseDown={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col bg-surface shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="min-w-0 flex-1 truncate text-h2 text-fg">{name}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-5 w-5" aria-hidden /></Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {loading ? <Skeleton className="h-64 w-full" /> : !wf ? (
            <p className="text-body text-danger">{error || 'Could not load this workflow.'}</p>
          ) : (
            <>
              <div className="mb-4 flex items-center gap-3 rounded-md border border-border bg-subtle px-3.5 py-3">
                <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
                <span className="text-body text-fg">{enabled ? 'On — runs on its schedule' : 'Off — won’t run automatically'}</span>
              </div>

              <label className="mb-1.5 block text-label text-fg">What it does</label>
              <Textarea value={desc} onChange={(e) => { setDesc(e.target.value); setSaved(false); }} placeholder="Describe what this workflow does…" />

              <label className="mb-1.5 mt-4 block text-label text-fg">When it runs</label>
              <ScheduleEditor value={cron} onChange={(c) => { setCron(c); setSaved(false); }}
                timezone={tz} onTimezoneChange={(z) => { setTz(z); setSaved(false); }} />

              <WorkflowHowItWorks wf={wf} />

              <div id="wf-engine-panel">
                <WorkflowEnginePanel certification={wf.certification} stepCount={wf.steps?.length ?? 0} resources={wf.resources} resourceBinding={wf.resourceBinding} />
              </div>

              {error && <p className="mt-3 text-small text-danger">{error}</p>}
            </>
          )}
        </div>

        {!loading && wf && (
          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            {primary && (
              <Button onClick={runPrimary} disabled={running || saving} title={wf?.certification?.summary}>
                {running && primary.kind !== 'guide' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  : primary.kind === 'run' ? <Play className="h-4 w-4" aria-hidden />
                  : primary.kind === 'enable' ? <ShieldCheck className="h-4 w-4" aria-hidden />
                  : null}
                {primary.label}
              </Button>
            )}
            <Button variant={primary ? 'secondary' : 'primary'} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            {saved && <span className="inline-flex items-center gap-1 text-small text-success"><Check className="h-4 w-4" aria-hidden /> Saved</span>}
            {primary?.kind !== 'run' && (
              <Button variant="secondary" onClick={run} disabled={running}>{running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run now</Button>
            )}
            <Button variant="ghost" size="icon" onClick={remove} aria-label="Delete workflow" title="Delete" className="ml-auto text-danger"><Trash2 className="h-4 w-4" aria-hidden /></Button>
          </div>
        )}
      </div>
    </div>
  );
}
