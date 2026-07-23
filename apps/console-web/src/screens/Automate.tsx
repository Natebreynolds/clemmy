import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Zap, Clock, Puzzle, Play, Plus, RefreshCw, Loader2, Trash2, ChevronDown, ExternalLink, X, FileText, Target, CheckCircle2, AlertTriangle, Radio } from 'lucide-react';
import { Page } from '@/components/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { StatusPill } from '@/components/ui/StatusPill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePoll } from '@/lib/poll';
import { statusTone } from '@/lib/inbox';
import { humanizeCron } from '@/lib/cron';
import { WorkflowDrawer } from '@/components/automate/WorkflowDrawer';
import { cn } from '@/lib/cn';
import { workflowCardStatus, workflowPrimaryAction } from '@/lib/workflowCertification';
import {
  checkRunAgainstGoal, getRunWorkspace, listWorkflowRuns,
  listWorkflows, retryWorkflowFailedItems, runWorkflow, setWorkflowEnabled,
  listSkills, installSkill, checkSkillUpdates, getSkill, deleteSkill, updateSkill,
  type RunWorkspace, type SkillRow, type WorkflowRow, type WorkflowRunRecord,
} from '@/lib/automate';
import { getAgentSystemMetrics } from '@/lib/advanced';

type Tab = 'workflows' | 'skills';
type WorkflowFilter = 'all' | 'scheduled' | 'manual';


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

export function Automate() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('workflows');
  const [filter, setFilter] = useState<WorkflowFilter>('all');

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
  // The old Schedules tab duplicated these same cards; a schedule is now a
  // property of the workflow (meta line + filter chip), not a second surface.
  const isScheduled = (w: WorkflowRow) => Boolean(w.triggerSchedule || w.trigger?.schedule);
  const visibleWf = filter === 'all' ? wf : wf.filter((w) => (filter === 'scheduled' ? isScheduled(w) : !isScheduled(w)));
  const sk = skills.data?.skills ?? [];
  // The old operator-telemetry panel ("repair-loop 94/100", "fanout block",
  // "19/100 thrashing") lives in Advanced → Evolution, which renders this same
  // metrics feed in full. Automate shows one plain sentence, and only when
  // something actually needs a human.
  const repairCount = (systemQ.data?.recommendations ?? [])
    .filter((rec) => rec.kind === 'loop' && (rec.severity === 'warn' || rec.severity === 'critical')).length;

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
    { key: 'skills', label: 'Skills', icon: Puzzle },
  ];

  return (
    <Page
      title="Automate"
      subtitle="Workflows and skills"
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

      {tab === 'workflows' && repairCount > 0 && (
        <Link
          to="/advanced/evolution"
          className="mb-4 flex items-center gap-2 rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-small text-warning transition-colors hover:border-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {repairCount} thing{repairCount === 1 ? '' : 's'} need{repairCount === 1 ? 's' : ''} repair — details in Advanced
          </span>
          <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
        </Link>
      )}

      {tab === 'workflows' && (
        workflows.isLoading
          ? <CardGridSkeleton />
          : wf.length === 0
            ? <EmptyState title="Let's automate something" description="Tell me a task you do often and I'll set it up for you." action={<Button onClick={() => navigate('/chat')}><Plus className="h-4 w-4" aria-hidden /> Create with Clementine</Button>} />
            : (
              <>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {([['all', 'All'], ['scheduled', 'Scheduled'], ['manual', 'Manual']] as Array<[WorkflowFilter, string]>).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setFilter(key)}
                      className={cn('rounded-full border px-3 py-1 text-small font-medium transition-colors cursor-pointer',
                        filter === key ? 'border-primary bg-primary-tint text-primary' : 'border-border text-muted hover:text-fg')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {visibleWf.length === 0
                  ? <EmptyState title={filter === 'scheduled' ? 'No scheduled workflows' : 'No manual workflows'} description="Ask Clementine to set one up." />
                  : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {visibleWf.map((w) => {
                      const isBroken = w.health?.status === 'broken';
                      const canRun = (!w.certification || w.certification.canRun) && !isBroken;
                      const status = workflowCardStatus(w);
                      const schedule = w.trigger?.schedule || w.triggerSchedule;
                      const lastRunAgo = relativeRunTime(w.lastRunAt);
                      return (
                        <Card key={w.name} className="flex flex-col p-5">
                          <div className="mb-2 flex items-start justify-between gap-3">
                            <button type="button" onClick={() => setOpenWf(w.name)} className="min-w-0 flex-1 text-left text-h3 text-fg hover:text-primary cursor-pointer">
                              {w.name}
                            </button>
                            <Switch checked={!!w.enabled} onChange={(v) => toggle(w.name, v)} label={`Enable ${w.name}`} />
                          </div>
                          <button type="button" onClick={() => setOpenWf(w.name)} className="mb-3 line-clamp-3 flex-1 text-left text-body text-muted hover:text-fg cursor-pointer">{w.description || 'No description yet.'}</button>
                          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                            {status && (
                              // A pill about the last run opens that run; anything else opens the workflow.
                              <button
                                type="button"
                                title={status.detail}
                                onClick={() => (status.aboutLastRun && w.lastRunId ? setOpenRun({ workflow: w.name, runId: w.lastRunId }) : setOpenWf(w.name))}
                                className="cursor-pointer"
                              >
                                <StatusPill tone={status.tone}>{status.label}</StatusPill>
                              </button>
                            )}
                            <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
                              {typeof w.stepCount === 'number' && <span>{w.stepCount} step{w.stepCount === 1 ? '' : 's'}</span>}
                              {schedule && <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{humanizeCron(schedule, w.trigger?.timezone)}</span>}
                              {w.lastRunId && lastRunAgo && (
                                <button type="button" onClick={() => setOpenRun({ workflow: w.name, runId: w.lastRunId ?? undefined })} className="cursor-pointer underline-offset-2 hover:text-fg hover:underline">
                                  last run {lastRunAgo}
                                </button>
                              )}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {canRun ? (
                              <Button size="sm" variant="secondary" disabled={busyName === w.name} onClick={() => run(w.name)}>
                                {busyName === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run
                              </Button>
                            ) : (
                              <Button size="sm" variant="secondary" title={w.certification?.summary} onClick={() => setOpenWf(w.name)}>
                                {workflowPrimaryAction(w.certification)}
                              </Button>
                            )}
                            {(w.lastRunFailedItemCount ?? 0) > 0 && w.lastRunId && (
                              <Button size="sm" variant="secondary" disabled={busyRecovery === w.name} onClick={() => retryFailed(w)}>
                                {busyRecovery === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Retry failed
                              </Button>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>}
              </>
            )
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
