import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Zap, Clock, Puzzle, Play, Plus, RefreshCw, Loader2 } from 'lucide-react';
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
import {
  listWorkflows, runWorkflow, setWorkflowEnabled,
  listSkills, installSkill, checkSkillUpdates,
} from '@/lib/automate';

type Tab = 'workflows' | 'schedules' | 'skills';

export function Automate() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('workflows');

  const workflows = usePoll(['workflows'], listWorkflows, 10000);
  const skills = usePoll(['skills'], listSkills, 15000, { enabled: tab === 'skills' });

  const [busyName, setBusyName] = useState<string | null>(null);
  const [skillUrl, setSkillUrl] = useState('');
  const [installing, setInstalling] = useState(false);
  const [checking, setChecking] = useState(false);
  const [openWf, setOpenWf] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const wf = workflows.data?.workflows ?? [];
  // "Schedules" = workflows that run on a schedule. (Legacy CRON.md crons
  // were migrated to workflows; the cron file is empty now.)
  const scheduled = wf.filter((w) => w.triggerSchedule || w.trigger?.schedule);
  const sk = skills.data?.skills ?? [];

  const run = async (name: string) => {
    setBusyName(name); setNotice(null);
    try { await runWorkflow(name); void qc.invalidateQueries({ queryKey: ['runs'] }); setNotice({ tone: 'info', text: `Started "${name}" — watch it in Inbox → Activity.` }); }
    catch (e) { setNotice({ tone: 'error', text: (e as Error).message }); }
    finally { setBusyName(null); }
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
                        {(w.trigger?.schedule || w.triggerSchedule) && <span className="inline-flex items-center gap-1 text-caption text-faint"><Clock className="h-3.5 w-3.5" aria-hidden />{humanizeCron(w.trigger?.schedule || w.triggerSchedule, w.trigger?.timezone)}</span>}
                        {typeof w.stepCount === 'number' && <span className="text-caption text-faint">{w.stepCount} steps</span>}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="secondary" disabled={busyName === w.name} onClick={() => run(w.name)}>
                          {busyName === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run
                        </Button>
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
                    {w.description && <p className="mb-3 line-clamp-2 flex-1 text-small text-muted">{w.description}</p>}
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" disabled={busyName === w.name} onClick={() => run(w.name)}>
                        {busyName === w.name ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run now
                      </Button>
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
              : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {sk.map((s) => (
                    <Card key={s.name} className="p-5">
                      <h3 className="mb-1 text-h3 text-fg">{s.name}</h3>
                      <p className="line-clamp-3 text-body text-muted">{s.description || 'No description.'}</p>
                    </Card>
                  ))}
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
