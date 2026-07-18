import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Zap, Clock, Puzzle, Play, Plus, RefreshCw, Loader2, Trash2, ChevronDown, ExternalLink, Activity, GitBranch, Send, Wrench, Gauge, X, FileText, Target, CheckCircle2, AlertTriangle, Radio, type LucideIcon } from 'lucide-react';
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
import { certificationTone, workflowCertificationCounts, workflowPrimaryAction } from '@/lib/workflowCertification';
import {
  checkRunAgainstGoal, getRunWorkspace, listWorkflowRuns,
  listWorkflows, retryWorkflowFailedItems, runWorkflow, setWorkflowEnabled,
  listSkills, installSkill, checkSkillUpdates, getSkill, deleteSkill, updateSkill,
  type RunWorkspace, type SkillRow, type WorkflowRow, type WorkflowRunRecord,
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
  // Collapsed by default: this is OPERATOR diagnostics (health scores, repair
  // loops, retry pressure) — useful, but it must not be the first thing a user
  // wades through to reach their workflows. One quiet summary line, expandable.
  const [open, setOpen] = useState(false);
  if (recommendations.length === 0 && issueCauses.length === 0 && !interventions && !learning && !coordination && !trend) return null;
  const attention = (coordination ? 1 : 0) + issueCauses.length + recommendations.length;
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-5 flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-left transition-colors hover:bg-subtle cursor-pointer"
      >
        <Zap className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        <span className="text-caption font-semibold uppercase tracking-wide text-faint">System health</span>
        {trend && (
          <StatusPill tone={trendTone(trend.status)}>
            {trend.status}{trend.recent.length > 0 ? ` · ${trend.recent[trend.recent.length - 1]?.healthScore}/100` : ''}
          </StatusPill>
        )}
        <span className="min-w-0 flex-1 truncate text-caption text-muted">
          {attention > 0 ? `${attention} thing${attention === 1 ? '' : 's'} worth a look` : 'All quiet'}
        </span>
        <span className="shrink-0 text-caption text-faint">details</span>
      </button>
    );
  }
  return (
    <Card className="mb-5 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
          <Zap className="h-3.5 w-3.5" aria-hidden /> System health
        </div>
        <button type="button" onClick={() => setOpen(false)} className="text-caption text-faint transition-colors hover:text-muted cursor-pointer">hide</button>
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

function relativeRunTime(iso?: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatBytes(bytes?: number): string {
  const n = bytes ?? 0;
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}KB`;
}

function goalObjective(goal: string | null): string | null {
  if (!goal) return null;
  const lines = goal.split('\n').map((line) => line.trim()).filter(Boolean);
  const header = lines.findIndex((line) => line.toLowerCase().startsWith('# run goal'));
  return (header >= 0 ? lines[header + 1] : lines.find((line) => !line.startsWith('#'))) ?? null;
}

function WorkflowEngineStrip({ workflow, onOpen }: { workflow: WorkflowRow; onOpen: () => void }) {
  const cert = workflow.certification;
  if (!cert) return null;
  const counts = workflowCertificationCounts(cert);
  const resourceCount = workflow.resourceCount ?? Object.keys(workflow.resources ?? {}).length;
  const resourceTone: Tone = counts.resourceGaps > 0 ? 'info' : resourceCount > 0 ? 'success' : 'neutral';
  const missingTone: Tone = counts.missingInputs > 0 ? 'warning' : 'success';
  const authorTone: Tone = counts.blockers > 0 ? 'danger' : counts.readinessGaps > 0 ? 'info' : 'success';
  const effectTone: Tone = counts.sends > 0 ? 'warning' : counts.writes > 0 ? 'info' : 'success';
  const phases: Array<{ label: string; value: string; tone: Tone; Icon: LucideIcon }> = [
    { label: 'Bindings', value: counts.resourceGaps > 0 ? `${counts.resourceGaps} needed` : resourceCount > 0 ? `${resourceCount} bound` : 'none', tone: resourceTone, Icon: Puzzle },
    { label: 'Inputs', value: counts.missingInputs > 0 ? `${counts.missingInputs} missing` : 'set', tone: missingTone, Icon: Gauge },
    { label: 'Plan', value: `${counts.waves} wave${counts.waves === 1 ? '' : 's'}`, tone: authorTone, Icon: GitBranch },
    { label: 'Dry-run', value: cert.dryRun?.verdict?.replace('_', ' ') ?? 'unknown', tone: dryRunTone(cert.dryRun?.verdict), Icon: Activity },
    { label: 'Tools', value: counts.tools > 0 ? `${counts.tools} linked` : 'local', tone: counts.blockers > 0 ? 'danger' : 'success', Icon: Wrench },
    { label: 'Effects', value: `${counts.sends + counts.writes} external`, tone: effectTone, Icon: Send },
  ];

  return (
    <button
      type="button"
      onClick={onOpen}
      className="mb-3 w-full rounded-md border border-border bg-subtle p-3 text-left transition-colors hover:border-primary cursor-pointer"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <StatusPill tone={certificationTone(cert.state)}>{cert.label}</StatusPill>
        {cert.executionMode && cert.executionMode !== 'empty' && (
          <span title="Steps that run as code (a direct tool call or script) are free every run; AI steps carry the reasoning cost.">
            <StatusPill tone={cert.executionMode === 'agentless' ? 'success' : cert.executionMode === 'agent' ? 'warning' : 'info'}>
              {cert.executionMode === 'agentless' ? '⚡ runs as code · no AI cost'
                : cert.executionMode === 'agent' ? 'AI every step'
                : `${cert.dryRun?.codeSteps ?? 0}/${cert.dryRun?.stepCount ?? 0} steps as code`}
            </StatusPill>
          </span>
        )}
        {(cert.codifyCandidateCount ?? 0) > 0 && (
          <span title={`Token savings on the table — these mechanical steps could run as free code:\n${(cert.codifyCandidates ?? []).map((c) => `• ${c.stepId}${c.tool ? ` (${c.tool})` : ''}`).join('\n')}`}>
            <StatusPill tone="info">💡 {cert.codifyCandidateCount} step{cert.codifyCandidateCount === 1 ? '' : 's'} could be free code</StatusPill>
          </span>
        )}
        <span className="text-caption text-faint">{counts.parallelWaves}/{counts.waves} parallel waves</span>
        {resourceCount > 0 && <span className="text-caption text-faint">{resourceCount} resources</span>}
        <span className="text-caption text-faint">{counts.tools} tools</span>
        {(counts.sends + counts.writes) > 0 && <span className="text-caption text-faint">{counts.sends + counts.writes} external effects</span>}
      </div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:grid-cols-6">
        {phases.map(({ label, value, tone, Icon }) => (
          <div key={label} className={cn('min-w-0 rounded-sm border px-2 py-1.5', engineToneClasses(tone))}>
            <div className="flex items-center gap-1">
              <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate text-caption font-semibold">{label}</span>
            </div>
            <div className="truncate text-caption opacity-80">{value}</div>
          </div>
        ))}
      </div>
    </button>
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
  const [openRun, setOpenRun] = useState<{ workflow: string; runId?: string } | null>(null);
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
    try {
      const queued = await runWorkflow(name) as { id?: string } | undefined;
      void qc.invalidateQueries({ queryKey: ['runs'] });
      void qc.invalidateQueries({ queryKey: ['wf-runs', name] });
      setOpenRun({ workflow: name, runId: queued?.id });
      setNotice({ tone: 'info', text: `Started "${name}".` });
    }
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
                  const canRun = !w.certification || w.certification.canRun;
                  return (
                    <Card key={w.name} className="flex flex-col p-5">
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <button type="button" onClick={() => setOpenWf(w.name)} className="min-w-0 flex-1 text-left text-h3 text-fg hover:text-primary cursor-pointer">
                          {w.name}
                        </button>
                        <Switch checked={!!w.enabled} onChange={(v) => toggle(w.name, v)} label={`Enable ${w.name}`} />
                      </div>
                      <button type="button" onClick={() => setOpenWf(w.name)} className="mb-3 line-clamp-3 flex-1 text-left text-body text-muted hover:text-fg cursor-pointer">{w.description || 'No description yet.'}</button>
                      <WorkflowEngineStrip workflow={w} onOpen={() => setOpenWf(w.name)} />
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        {w.lastRunStatus && <StatusPill tone={tone.tone}>{tone.label}</StatusPill>}
                        {(w.lastRunFailedItemCount ?? 0) > 0 && <StatusPill tone="warning">{w.lastRunFailedItemCount} failed item{w.lastRunFailedItemCount === 1 ? '' : 's'}</StatusPill>}
                        {(w.trigger?.schedule || w.triggerSchedule) && <span className="inline-flex items-center gap-1 text-caption text-faint"><Clock className="h-3.5 w-3.5" aria-hidden />{humanizeCron(w.trigger?.schedule || w.triggerSchedule, w.trigger?.timezone)}</span>}
                        {typeof w.stepCount === 'number' && <span className="text-caption text-faint">{w.stepCount} steps</span>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" disabled={busyName === w.name || !canRun} title={!canRun ? w.certification?.summary : undefined} onClick={() => run(w.name)}>
                          {busyName === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run
                        </Button>
                        {(w.lastRunFailedItemCount ?? 0) > 0 && w.lastRunId && (
                          <Button size="sm" variant="secondary" disabled={busyRecovery === w.name} onClick={() => retryFailed(w)}>
                            {busyRecovery === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Retry failed
                          </Button>
                        )}
                        {w.lastRunId && (
                          <Button size="sm" variant="ghost" onClick={() => setOpenRun({ workflow: w.name, runId: w.lastRunId ?? undefined })}>
                            <FileText className="h-4 w-4" aria-hidden /> View run
                          </Button>
                        )}
                        <Button size="sm" variant={canRun ? 'ghost' : 'secondary'} onClick={() => setOpenWf(w.name)}>{canRun ? 'Open' : workflowPrimaryAction(w.certification)}</Button>
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
                {scheduled.map((w) => {
                  const canRun = !w.certification || w.certification.canRun;
                  return (
                    <Card key={w.name} className="flex flex-col p-5">
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <button type="button" onClick={() => setOpenWf(w.name)} className="min-w-0 flex-1 text-left text-h3 text-fg hover:text-primary cursor-pointer">{w.name}</button>
                        <Switch checked={!!w.enabled} onChange={(v) => toggle(w.name, v)} label={`Enable ${w.name}`} />
                      </div>
                      <div className="mb-3 flex items-center gap-1.5 text-body text-primary">
                        <Clock className="h-4 w-4" aria-hidden />
                        <span>{humanizeCron(w.trigger?.schedule || w.triggerSchedule, w.trigger?.timezone)}</span>
                      </div>
                      <WorkflowEngineStrip workflow={w} onOpen={() => setOpenWf(w.name)} />
                      {(w.lastRunFailedItemCount ?? 0) > 0 && (
                        <div className="mb-3"><StatusPill tone="warning">{w.lastRunFailedItemCount} failed item{w.lastRunFailedItemCount === 1 ? '' : 's'}</StatusPill></div>
                      )}
                      {w.description && <p className="mb-3 line-clamp-2 flex-1 text-small text-muted">{w.description}</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" disabled={busyName === w.name || !canRun} title={!canRun ? w.certification?.summary : undefined} onClick={() => run(w.name)}>
                          {busyName === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run now
                        </Button>
                        {(w.lastRunFailedItemCount ?? 0) > 0 && w.lastRunId && (
                          <Button size="sm" variant="secondary" disabled={busyRecovery === w.name} onClick={() => retryFailed(w)}>
                            {busyRecovery === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Retry failed
                          </Button>
                        )}
                        {w.lastRunId && (
                          <Button size="sm" variant="ghost" onClick={() => setOpenRun({ workflow: w.name, runId: w.lastRunId ?? undefined })}>
                            <FileText className="h-4 w-4" aria-hidden /> View run
                          </Button>
                        )}
                        <Button size="sm" variant={canRun ? 'ghost' : 'secondary'} onClick={() => setOpenWf(w.name)}>{canRun ? 'Open' : workflowPrimaryAction(w.certification)}</Button>
                      </div>
                    </Card>
                  );
                })}
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
      {openRun && <RunWorkspaceDrawer workflow={openRun.workflow} initialRunId={openRun.runId} onClose={() => setOpenRun(null)} />}
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

function RunWorkspaceDrawer({
  workflow,
  initialRunId,
  onClose,
}: {
  workflow: string;
  initialRunId?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(initialRunId);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [showAllCriteria, setShowAllCriteria] = useState(false);
  const runsQ = useQuery({
    queryKey: ['wf-runs', workflow],
    queryFn: () => listWorkflowRuns(workflow, 25),
    refetchInterval: 4000,
  });
  const runs: WorkflowRunRecord[] = runsQ.data?.runs ?? [];

  useEffect(() => {
    if (selectedRunId && runs.some((run) => run.id === selectedRunId)) return;
    if (runs[0]?.id) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId]);

  const workspaceQ = useQuery({
    queryKey: ['run-workspace', workflow, selectedRunId],
    queryFn: () => getRunWorkspace(workflow, selectedRunId as string),
    enabled: Boolean(selectedRunId),
    refetchInterval: 4000,
  });
  const workspace: RunWorkspace | undefined = workspaceQ.data;
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const selectedTone = statusTone(selectedRun?.status);

  const runChecker = async () => {
    if (!selectedRunId) return;
    setChecking(true);
    setCheckError(null);
    try {
      await checkRunAgainstGoal(workflow, selectedRunId);
      void qc.invalidateQueries({ queryKey: ['run-workspace', workflow, selectedRunId] });
    } catch (e) {
      // Surface the failure instead of silently stopping the spinner — the
      // check was swallowing errors, leaving the user staring at nothing.
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 160);
      setCheckError(reason || 'unknown error');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex justify-end bg-black/30 animate-fade-in" onMouseDown={onClose}>
      <div className="flex h-full w-full max-w-5xl flex-col bg-surface shadow-lg" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Radio className="h-5 w-5 shrink-0 text-live" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-h2 text-fg">{workflow}</h2>
            <p className="truncate text-caption text-faint">Runs and work products</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-5 w-5" aria-hidden /></Button>
        </div>

        <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="min-h-0 border-b border-border md:border-b-0 md:border-r">
            <div className="border-b border-border px-4 py-3 text-label text-muted">Recent runs</div>
            <div className="max-h-full overflow-y-auto p-2">
              {runsQ.isLoading ? <Skeleton className="h-32 w-full" /> : runs.length === 0 ? (
                <EmptyState title="No runs yet" className="py-10" />
              ) : runs.map((run) => {
                const tone = statusTone(run.status);
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelectedRunId(run.id)}
                    className={cn('mb-1 w-full rounded-md px-2.5 py-2 text-left transition-colors', selectedRunId === run.id ? 'bg-subtle' : 'hover:bg-subtle/60')}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-small font-medium text-fg">{run.id.slice(0, 22)}</span>
                      <StatusPill tone={tone.tone}>{tone.label}</StatusPill>
                    </div>
                    <div className="mt-1 truncate text-caption text-faint">
                      {relativeRunTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}
                      {run.source ? ` · ${run.source}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto p-5">
            {!selectedRunId ? <EmptyState title="Pick a run" />
              : workspaceQ.isLoading ? <Skeleton className="h-72 w-full" />
              : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-subtle px-4 py-3">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <StatusPill tone={selectedTone.tone}>{selectedTone.label}</StatusPill>
                        {selectedRun?.needsAttention && <StatusPill tone="warning">Needs attention</StatusPill>}
                        <span className="text-caption text-faint">{selectedRunId}</span>
                      </div>
                      {selectedRun?.error && <p className="text-small text-danger">{selectedRun.error}</p>}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Button size="sm" variant="secondary" onClick={runChecker} disabled={checking || !workspace}>
                        {checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />} Check goal
                      </Button>
                      {checkError && (
                        <span className="max-w-xs text-right text-caption text-danger">Check failed — {checkError}. Try again.</span>
                      )}
                    </div>
                  </div>

                  {workspace?.goal && (
                    <section className="rounded-md border border-border bg-surface px-4 py-3">
                      <div className="mb-1 flex items-center gap-1.5 text-label text-muted">
                        <Target className="h-4 w-4" aria-hidden /> Goal
                      </div>
                      <p className="text-body text-fg">{goalObjective(workspace.goal) ?? workspace.goal}</p>
                    </section>
                  )}

                  {workspace?.checker && (
                    <section className={cn('rounded-md border px-4 py-3', workspace.checker.pass ? 'border-success/30 bg-success-tint' : 'border-warning/30 bg-warning-tint')}>
                      <div className="mb-2 flex items-center gap-2">
                        {workspace.checker.pass ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> : <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />}
                        <span className={cn('text-small font-semibold', workspace.checker.pass ? 'text-success' : 'text-warning')}>{workspace.checker.summary}</span>
                      </div>
                      <div className="grid gap-1.5">
                        {(showAllCriteria ? workspace.checker.perCriterion : workspace.checker.perCriterion.slice(0, 6)).map((criterion) => (
                          <div key={criterion.criterion} className="flex gap-2 text-caption text-muted">
                            <span className={criterion.pass ? 'text-success' : 'text-warning'}>{criterion.pass ? 'Pass' : 'Review'}</span>
                            <span className="min-w-0 flex-1">{criterion.criterion}</span>
                          </div>
                        ))}
                      </div>
                      {workspace.checker.perCriterion.length > 6 && (
                        <button
                          type="button"
                          onClick={() => setShowAllCriteria((v) => !v)}
                          className="mt-2 inline-flex items-center gap-1 text-caption font-semibold text-primary hover:underline cursor-pointer"
                        >
                          {showAllCriteria ? 'Show fewer' : `+${workspace.checker.perCriterion.length - 6} more`}
                        </button>
                      )}
                    </section>
                  )}

                  <section>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-h3 text-fg">Work Products</h3>
                      <span className="text-caption text-faint">{workspace?.artifacts.length ?? 0} files · {formatBytes(workspace?.totalBytes)}</span>
                    </div>
                    {!workspace || workspace.artifacts.length === 0 ? (
                      <EmptyState title="No work products" description="This run has not written artifacts to its shared workspace yet." className="rounded-md border border-border py-12" />
                    ) : (
                      <div className="grid gap-2">
                        {workspace.artifacts.map((artifact) => (
                          <div key={`${artifact.agent}:${artifact.tool}:${artifact.path}`} className="rounded-md border border-border bg-surface px-4 py-3">
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 shrink-0 text-faint" aria-hidden />
                              <span className="min-w-0 flex-1 truncate text-small font-semibold text-fg">{artifact.agent}</span>
                              <span className="shrink-0 text-caption text-faint">{formatBytes(artifact.bytes)}</span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-small text-muted">{artifact.summary}</p>
                            <div className="mt-2 flex flex-wrap gap-1.5 text-caption text-faint">
                              <span className="rounded-sm bg-subtle px-2 py-0.5">{artifact.tool}</span>
                              <span className="min-w-0 truncate rounded-sm bg-subtle px-2 py-0.5">{artifact.path}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              )}
          </main>
        </div>
      </div>
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
            {skill.supersededBy && <StatusPill tone="neutral">Retired → {skill.supersededBy}</StatusPill>}
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
