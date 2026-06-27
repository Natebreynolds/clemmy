import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Zap, Clock, Puzzle, Play, Plus, RefreshCw, Loader2, Trash2, ChevronDown, ExternalLink } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { statusTone } from '@/lib/inbox';
import { humanizeCron } from '@/lib/cron';
import { WorkflowDrawer } from '@/components/automate/WorkflowDrawer';
import { cn } from '@/lib/cn';
import {
  listWorkflows, retryWorkflowFailedItems, runWorkflow, setWorkflowEnabled,
  listSkills, installSkill, checkSkillUpdates, getSkill, deleteSkill, updateSkill,
  type SkillRow, type WorkflowRow,
} from '@/lib/automate';
import {
  getAgentSystemMetrics,
  type AgentSystemRecommendation,
  type AgentSystemTrendSnapshot,
  type CoordinationPolicySnapshot,
  type LoopInterventionSnapshot,
  type LoopIssueCause,
  type WorkflowLearningSnapshot,
} from '@/lib/advanced';

type Tab = 'workflows' | 'schedules' | 'skills';

function recommendationTone(severity: AgentSystemRecommendation['severity']): Tone {
  if (severity === 'critical') return 'danger';
  if (severity === 'warn') return 'warning';
  return 'info';
}

function interventionTone(status: LoopInterventionSnapshot['status']): Tone {
  if (status === 'productive') return 'success';
  if (status === 'watch') return 'warning';
  if (status === 'thrashing') return 'danger';
  return 'neutral';
}

function learningTone(status: WorkflowLearningSnapshot['status']): Tone {
  if (status === 'compounding') return 'success';
  if (status === 'watch') return 'warning';
  if (status === 'stale') return 'danger';
  return 'neutral';
}

function coordinationTone(status: CoordinationPolicySnapshot['status']): Tone {
  if (status === 'expand') return 'success';
  if (status === 'repair' || status === 'constrain') return 'danger';
  if (status === 'learn') return 'info';
  return 'warning';
}

function fanoutPostureTone(posture: CoordinationPolicySnapshot['fanoutPosture']): Tone {
  if (posture === 'allow') return 'success';
  if (posture === 'soft') return 'info';
  if (posture === 'constrain') return 'warning';
  return 'danger';
}

function trendTone(status: AgentSystemTrendSnapshot['status']): Tone {
  if (status === 'improving') return 'success';
  if (status === 'regressing') return 'danger';
  if (status === 'stable') return 'warning';
  return 'neutral';
}

function LoopGuidance({
  recommendations,
  issueCauses,
  interventions,
  learning,
  coordination,
  trend,
}: {
  recommendations: AgentSystemRecommendation[];
  issueCauses: LoopIssueCause[];
  interventions?: LoopInterventionSnapshot;
  learning?: WorkflowLearningSnapshot;
  coordination?: CoordinationPolicySnapshot;
  trend?: AgentSystemTrendSnapshot;
}) {
  if (recommendations.length === 0 && issueCauses.length === 0 && !interventions && !learning && !coordination && !trend) return null;
  return (
    <Card className="mb-5 p-4">
      <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
        <Zap className="h-3.5 w-3.5" aria-hidden /> Loop guidance
      </div>
      {trend && (
        <div className="mb-3 rounded-md border border-border bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-small font-semibold text-fg">Agent-system trend</div>
              <p className="mt-1 text-small text-muted">{trend.recommendation}</p>
            </div>
            <StatusPill tone={trendTone(trend.status)}>
              {trend.status}{trend.recent.length > 0 ? ` · ${trend.recent[trend.recent.length - 1]?.healthScore}/100` : ''}
            </StatusPill>
          </div>
          <div className="flex flex-wrap gap-2 text-caption">
            {trend.signals.slice(0, 4).map((signal) => (
              <span key={signal} className="rounded-full bg-subtle px-2 py-0.5 text-muted">{signal}</span>
            ))}
          </div>
        </div>
      )}
      {coordination && (
        <div className="mb-3 rounded-md border border-border bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-small font-semibold text-fg">Coordination policy</div>
              <p className="mt-1 text-small text-muted">{coordination.nextAction}</p>
            </div>
            <StatusPill tone={coordinationTone(coordination.status)}>
              {coordination.mode} · {coordination.confidence}/100
            </StatusPill>
            <StatusPill tone={fanoutPostureTone(coordination.fanoutPosture)}>
              fanout {coordination.fanoutPosture}
            </StatusPill>
            <StatusPill tone={coordination.recommendedWorkerWaveSize >= 8 ? 'success' : coordination.recommendedWorkerWaveSize > 0 ? 'info' : 'danger'}>
              wave {coordination.recommendedWorkerWaveSize}
            </StatusPill>
          </div>
          {coordination.guardrails.length > 0 && (
            <div className="flex flex-wrap gap-2 text-caption">
              {coordination.guardrails.slice(0, 3).map((guardrail) => (
                <span key={guardrail} className="rounded-full bg-warning-tint px-2 py-0.5 text-warning">{guardrail}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {interventions && (
        <div className="mb-3 rounded-md border border-border bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-small font-semibold text-fg">Intervention effectiveness</div>
              <p className="mt-1 text-small text-muted">{interventions.recommendation}</p>
            </div>
            <StatusPill tone={interventionTone(interventions.status)}>
              {interventions.score}/100 · {interventions.status}
            </StatusPill>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Retry pressure</div>
              <div className="text-small font-semibold text-fg">{interventions.retryPressurePct}%</div>
            </div>
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Self-heal clean</div>
              <div className="text-small font-semibold text-fg">{interventions.selfHeal.clean}/{interventions.selfHeal.runs}</div>
            </div>
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Goal satisfied</div>
              <div className="text-small font-semibold text-fg">{interventions.goalRepursuit.satisfied}/{interventions.goalRepursuit.runs}</div>
            </div>
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Failed items</div>
              <div className="text-small font-semibold text-fg">{interventions.forEachRecovery.failed}</div>
            </div>
          </div>
          {(interventions.risks.length > 0 || interventions.strengths.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2 text-caption">
              {interventions.risks.slice(0, 3).map((risk) => (
                <span key={risk} className="rounded-full bg-warning-tint px-2 py-0.5 text-warning">{risk}</span>
              ))}
              {interventions.strengths.slice(0, 2).map((strength) => (
                <span key={strength} className="rounded-full bg-success-tint px-2 py-0.5 text-success">{strength}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {learning && (
        <div className="mb-3 rounded-md border border-border bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-small font-semibold text-fg">Workflow learning</div>
              <p className="mt-1 text-small text-muted">{learning.recommendation}</p>
            </div>
            <StatusPill tone={learningTone(learning.status)}>
              {learning.recallHitRatePct}% recall · {learning.status}
            </StatusPill>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Patterns</div>
              <div className="text-small font-semibold text-fg">{learning.patternCount}</div>
            </div>
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Clean samples</div>
              <div className="text-small font-semibold text-fg">{learning.totalCleanPatternRuns}</div>
            </div>
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Recall hits</div>
              <div className="text-small font-semibold text-fg">{learning.recallHits}/{learning.recentRecallSamples}</div>
            </div>
            <div className="rounded-md bg-subtle p-2">
              <div className="text-caption text-faint">Remembered</div>
              <div className="text-small font-semibold text-fg">{learning.remembers}</div>
            </div>
          </div>
          {learning.topPatterns.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2 text-caption">
              {learning.topPatterns.slice(0, 3).map((pattern) => (
                <span key={pattern.workflowSlug} className="rounded-full bg-info-tint px-2 py-0.5 text-info" title={`${pattern.stepCount} steps · ${pattern.toolCount} tools`}>
                  {pattern.workflowName} · {pattern.successCount}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {issueCauses.length > 0 && (
        <div className="mb-3 grid gap-2 lg:grid-cols-3">
          {issueCauses.slice(0, 3).map((cause) => (
            <div key={cause.key} className="rounded-md border border-border bg-subtle p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-small font-semibold text-fg" title={cause.label}>{cause.label}</span>
                <StatusPill tone="warning">{cause.count}</StatusPill>
              </div>
              <p className="truncate text-caption text-faint" title={cause.sources.join(', ')}>
                {cause.sources.join(', ')}
              </p>
            </div>
          ))}
        </div>
      )}
      {recommendations.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {recommendations.slice(0, 4).map((rec) => (
            <div key={rec.id} className="rounded-md border border-border bg-surface p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <StatusPill tone={recommendationTone(rec.severity)}>{rec.target}</StatusPill>
                <span className="text-small font-semibold text-fg">{rec.title}</span>
              </div>
              <p className="text-small text-muted">{rec.detail}</p>
              <p className="mt-1 text-caption text-faint">{rec.action}</p>
              <Link
                to={rec.href}
                className="mt-2 inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-small font-semibold text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
              >
                {rec.cta}
                <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function Automate() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('workflows');

  const workflows = usePoll(['workflows'], listWorkflows, 10000);
  const skills = usePoll(['skills'], listSkills, 15000, { enabled: tab === 'skills' });
  const systemQ = usePoll(['agent-system-metrics'], getAgentSystemMetrics, 15000, { enabled: tab !== 'skills' });

  const [busyName, setBusyName] = useState<string | null>(null);
  const [skillUrl, setSkillUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busyRecovery, setBusyRecovery] = useState<string | null>(null);
  const [openWf, setOpenWf] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const wf = workflows.data?.workflows ?? [];
  // "Schedules" = workflows that run on a schedule. (Legacy CRON.md crons
  // were migrated to workflows; the cron file is empty now.)
  const scheduled = wf.filter((w) => w.triggerSchedule || w.trigger?.schedule);
  const sk = skills.data?.skills ?? [];
  const loopRecommendations = (systemQ.data?.recommendations ?? []).filter((rec) => rec.kind === 'loop');
  const loopIssueCauses = systemQ.data?.loops.issueCauses ?? [];
  const loopInterventions = systemQ.data?.loops.interventions;
  const workflowLearning = systemQ.data?.loops.learning;
  const coordination = systemQ.data?.coordination;
  const trend = systemQ.data?.trend;

  const run = async (name: string) => {
    setBusyName(name); setNotice(null);
    try { await runWorkflow(name); void qc.invalidateQueries({ queryKey: ['runs'] }); setNotice({ tone: 'info', text: `Started "${name}" — watch it in Inbox → Activity.` }); }
    catch (e) { setNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setBusyName(null); }
  };
  const retryFailed = async (workflow: WorkflowRow) => {
    if (!workflow.lastRunId) return;
    const stepIds = workflow.lastRunFailedItemStepIds ?? [];
    setBusyRecovery(workflow.name); setNotice(null);
    try {
      const result = await retryWorkflowFailedItems(workflow.name, workflow.lastRunId, stepIds.length === 1 ? stepIds[0] : undefined);
      setNotice({ tone: result.ok ? 'info' : 'error', text: result.message });
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['agent-system-metrics'] });
    } catch (e) {
      setNotice({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusyRecovery(null);
    }
  };
  const toggle = async (name: string, enabled: boolean) => {
    try { await setWorkflowEnabled(name, enabled); } finally { void qc.invalidateQueries({ queryKey: ['workflows'] }); }
  };
  const install = async () => {
    if (!skillUrl.trim()) return;
    setInstalling(true); setNotice(null);
    try { await installSkill(skillUrl.trim()); setSkillUrl(''); setNotice({ tone: 'info', text: 'Installing skill — it will appear here shortly.' }); }
    catch (e) { setNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setInstalling(false); setTimeout(() => void qc.invalidateQueries({ queryKey: ['skills'] }), 1500); }
  };
  const checkUpdates = async () => {
    setChecking(true); setNotice(null);
    try {
      const r = await checkSkillUpdates() as { updatesAvailable?: number; checked?: number } | undefined;
      const n = r?.updatesAvailable ?? 0;
      setNotice({ tone: 'info', text: n > 0 ? `${n} skill update${n === 1 ? '' : 's'} available.` : 'All skills are up to date.' });
      void qc.invalidateQueries({ queryKey: ['skills'] });
    } catch (e) { setNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setChecking(false); }
  };

  const tabs: { key: Tab; label: string; icon: typeof Zap }[] = [
    { key: 'workflows', label: 'Workflows', icon: Zap },
    { key: 'schedules', label: 'Schedules', icon: Clock },
    { key: 'skills', label: 'Skills', icon: Puzzle },
  ];

  return (
    <Page
      title="Automate"
      subtitle="Workflows, schedules, and skills"
      actions={<Button onClick={() => navigate('/chat')}><Plus className="h-4 w-4" aria-hidden /> Create with Clementine</Button>}
    >
      <div className="mb-5 flex gap-1 border-b border-border">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={cn('inline-flex items-center gap-2 border-b-2 px-3 py-2.5 text-body font-medium transition-colors cursor-pointer -mb-px',
                active ? 'border-primary text-fg' : 'border-transparent text-muted hover:text-fg')}>
              <Icon className="h-4 w-4" aria-hidden /> {t.label}
            </button>
          );
        })}
      </div>

      {notice && (
        <p className={cn('mb-4 rounded-md border px-3 py-2 text-small',
          notice.tone === 'error' ? 'border-danger/40 bg-danger-tint text-danger' : 'border-border bg-subtle text-muted')}>
          {notice.text}
        </p>
      )}

      {tab !== 'skills' && (
        <LoopGuidance
          recommendations={loopRecommendations}
          issueCauses={loopIssueCauses}
          interventions={loopInterventions}
          learning={workflowLearning}
          coordination={coordination}
          trend={trend}
        />
      )}

      {tab === 'workflows' && (
        workflows.isLoading
          ? <CardGridSkeleton />
          : wf.length === 0
            ? <EmptyState title="Let's automate something" description="Tell me a task you do often and I'll set it up for you." action={<Button onClick={() => navigate('/chat')}><Plus className="h-4 w-4" aria-hidden /> Create with Clementine</Button>} />
            : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {wf.map((w) => {
                  const tone = statusTone(w.lastRunStatus ?? undefined);
                  return (
                    <Card key={w.name} className="flex flex-col p-5">
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <button type="button" onClick={() => setOpenWf(w.name)} className="min-w-0 flex-1 text-left text-h3 text-fg hover:text-primary cursor-pointer">
                          {w.name}
                        </button>
                        <Switch checked={!!w.enabled} onChange={(v) => toggle(w.name, v)} label={`Enable ${w.name}`} />
                      </div>
                      <button type="button" onClick={() => setOpenWf(w.name)} className="mb-3 line-clamp-3 flex-1 text-left text-body text-muted hover:text-fg cursor-pointer">{w.description || 'No description yet.'}</button>
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        {w.lastRunStatus && <StatusPill tone={tone.tone}>{tone.label}</StatusPill>}
                        {(w.lastRunFailedItemCount ?? 0) > 0 && <StatusPill tone="warning">{w.lastRunFailedItemCount} failed item{w.lastRunFailedItemCount === 1 ? '' : 's'}</StatusPill>}
                        {(w.trigger?.schedule || w.triggerSchedule) && <span className="inline-flex items-center gap-1 text-caption text-faint"><Clock className="h-3.5 w-3.5" aria-hidden />{humanizeCron(w.trigger?.schedule || w.triggerSchedule, w.trigger?.timezone)}</span>}
                        {typeof w.stepCount === 'number' && <span className="text-caption text-faint">{w.stepCount} steps</span>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" disabled={busyName === w.name} onClick={() => run(w.name)}>
                          {busyName === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run
                        </Button>
                        {(w.lastRunFailedItemCount ?? 0) > 0 && w.lastRunId && (
                          <Button size="sm" variant="secondary" disabled={busyRecovery === w.name} onClick={() => retryFailed(w)}>
                            {busyRecovery === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Retry failed
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setOpenWf(w.name)}>Open</Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
      )}

      {tab === 'schedules' && (
        workflows.isLoading
          ? <CardGridSkeleton />
          : scheduled.length === 0
            ? <EmptyState title="No schedules yet" description="Recurring jobs (like a morning briefing) show up here. Ask Clementine to set one up." action={<Button onClick={() => navigate('/chat')}><Plus className="h-4 w-4" aria-hidden /> Create with Clementine</Button>} />
            : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {scheduled.map((w) => (
                  <Card key={w.name} className="flex flex-col p-5">
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <button type="button" onClick={() => setOpenWf(w.name)} className="min-w-0 flex-1 text-left text-h3 text-fg hover:text-primary cursor-pointer">{w.name}</button>
                      <Switch checked={!!w.enabled} onChange={(v) => toggle(w.name, v)} label={`Enable ${w.name}`} />
                    </div>
                    <div className="mb-3 flex items-center gap-1.5 text-body text-primary">
                      <Clock className="h-4 w-4" aria-hidden />
                      <span>{humanizeCron(w.trigger?.schedule || w.triggerSchedule, w.trigger?.timezone)}</span>
                    </div>
                    {(w.lastRunFailedItemCount ?? 0) > 0 && (
                      <div className="mb-3"><StatusPill tone="warning">{w.lastRunFailedItemCount} failed item{w.lastRunFailedItemCount === 1 ? '' : 's'}</StatusPill></div>
                    )}
                    {w.description && <p className="mb-3 line-clamp-2 flex-1 text-small text-muted">{w.description}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" disabled={busyName === w.name} onClick={() => run(w.name)}>
                        {busyName === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run now
                      </Button>
                      {(w.lastRunFailedItemCount ?? 0) > 0 && w.lastRunId && (
                        <Button size="sm" variant="secondary" disabled={busyRecovery === w.name} onClick={() => retryFailed(w)}>
                          {busyRecovery === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Retry failed
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setOpenWf(w.name)}>Open</Button>
                    </div>
                  </Card>
                ))}
              </div>
      )}

      {tab === 'skills' && (
        <div className="space-y-5">
          <Card className="p-5">
            <h3 className="mb-1 text-h3 text-fg">Add a skill</h3>
            <p className="mb-3 text-body text-muted">Paste a GitHub repo URL to install a skill.</p>
            <div className="flex gap-2">
              <input
                value={skillUrl}
                onChange={(e) => setSkillUrl(e.target.value)}
                placeholder="https://github.com/owner/skill"
                aria-label="GitHub repo URL"
                className="h-11 flex-1 rounded-md border border-border bg-canvas px-3 text-body text-fg outline-none focus:border-primary"
              />
              <Button onClick={install} disabled={installing || !skillUrl.trim()}>
                {installing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add
              </Button>
            </div>
          </Card>

          <div className="flex items-center justify-between">
            <h3 className="text-h3 text-fg">Installed skills</h3>
            <Button variant="ghost" size="sm" onClick={checkUpdates} disabled={checking}>{checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Check for updates</Button>
          </div>

          {skills.isLoading
            ? <CardGridSkeleton />
            : sk.length === 0
              ? <EmptyState title="No skills installed" description="Skills give Clementine new abilities. Add one above to get started." />
              : <div className="space-y-3">
                  {sk.map((s) => <SkillCard key={s.name} skill={s} onChanged={() => void qc.invalidateQueries({ queryKey: ['skills'] })} />)}
                </div>}
        </div>
      )}

      {openWf && <WorkflowDrawer key={openWf} name={openWf} onClose={() => setOpenWf(null)} />}
    </Page>
  );
}

function CardGridSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
    </div>
  );
}

function SkillCard({ skill, onChanged }: { skill: SkillRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['skill', skill.name], queryFn: () => getSkill(skill.name), enabled: open });

  const remove = async () => { setBusy('remove'); try { await deleteSkill(skill.name); onChanged(); } finally { setBusy(null); } };
  const update = async () => { setBusy('update'); try { await updateSkill(skill.name); setTimeout(onChanged, 1500); } finally { setBusy(null); } };

  const badge = (label: string) => <span className="rounded-full bg-subtle px-2 py-0.5 text-caption text-muted">{label}</span>;

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <Puzzle className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-h3 text-fg">{skill.displayName || skill.name}</h3>
            {skill.source?.updateAvailable && <StatusPill tone="warning">Update available</StatusPill>}
            {skill.hasScripts && badge('scripts')}
            {skill.hasReferences && badge('references')}
            {skill.hasSrc && badge('src')}
          </div>
          <p className={cn('mt-1 text-body text-muted', !open && 'line-clamp-2')}>{skill.description || 'No description.'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {skill.source?.updateAvailable && (
            <Button size="sm" variant="secondary" disabled={busy === 'update'} onClick={update}>
              {busy === 'update' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Update
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label={`Remove ${skill.name}`} title="Remove skill" disabled={busy === 'remove'} onClick={remove} className="text-danger">
            {busy === 'remove' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
      </div>

      <button type="button" onClick={() => setOpen((v) => !v)}
        className="mt-2 inline-flex items-center gap-1 text-caption font-semibold text-primary hover:underline cursor-pointer">
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        {open ? 'Hide skill' : 'Read full skill'}
      </button>

      {open && (
        <div className="mt-2">
          {detail.isLoading ? <Skeleton className="h-48 w-full" />
            : detail.isError ? <p className="text-small text-danger">Couldn't load this skill.</p>
            : (
              <>
                {detail.data?.source?.repo && (
                  <a href={detail.data.source.repo} target="_blank" rel="noopener noreferrer" className="mb-2 inline-flex items-center gap-1 text-caption text-primary hover:underline">
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden /> {detail.data.source.repo}
                  </a>
                )}
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-subtle p-3 font-mono text-caption text-fg">{detail.data?.body || '(empty)'}</pre>
              </>
            )}
        </div>
      )}
    </Card>
  );
}
