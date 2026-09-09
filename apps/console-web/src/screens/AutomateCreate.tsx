/**
 * Create a workflow WITH Clementine, watching it take shape. The conversation
 * sits beside the canvas (the Spaces build layout, owner-approved 2026-09-08):
 * the left column is the authoring chat with its activity card; the right is
 * the workflow — first the draft the model committed to in its own
 * `workflow_create` call (steps, effects, approval gates, schedule), then the
 * stored definition with its readiness once the write lands, then the
 * creation test streaming in. "Create with Clementine" used to drop you into
 * a bare chat; now you see the thing being built.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Clock, Lock, Play, Send, Eye, PenLine, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { Composer } from '@/components/chat/Composer';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { RunningTasksDrawer } from '@/components/chat/RunningTasksDrawer';
import { WorkflowHowItWorks } from '@/components/automate/WorkflowDrawer';
import { chatApprovalReply, useChat } from '@/lib/useChat';
import { getWorkflow, runWorkflow } from '@/lib/automate';
import { humanizeCron } from '@/lib/cron';
import { certificationTone } from '@/lib/workflowCertification';
import { workflowBuildFromMessages, type WorkflowBuildState, type WorkflowDraft } from '@/lib/workflow-build';
import { cn } from '@/lib/cn';

const STARTERS = [
  'Every Friday at 7, summarize my open pipeline by stage and email it to me.',
  'Each morning, list the deals with no touch in 14 days and draft a follow-up for each — ask me before anything sends.',
  'When a new lead lands in Salesforce, research the firm and add a one-line summary to the record.',
];

function statePill(state: WorkflowBuildState): { tone: Tone; label: string } {
  switch (state) {
    case 'drafting': return { tone: 'live', label: 'working out the steps' };
    case 'writing': return { tone: 'live', label: 'writing' };
    case 'testing': return { tone: 'live', label: 'test run' };
    case 'written': return { tone: 'success', label: 'saved' };
    case 'failed': return { tone: 'danger', label: 'could not save' };
    default: return { tone: 'neutral', label: 'new' };
  }
}

function EffectPill({ step }: { step: WorkflowDraft['steps'][number] }) {
  if (step.effect === 'send') return <StatusPill tone="warning"><Send className="mr-1 h-3 w-3" aria-hidden />sends externally</StatusPill>;
  if (step.effect === 'write') return <StatusPill tone="info"><PenLine className="mr-1 h-3 w-3" aria-hidden />writes</StatusPill>;
  if (step.effect === 'read') return <StatusPill tone="neutral"><Eye className="mr-1 h-3 w-3" aria-hidden />reads</StatusPill>;
  return null;
}

/** The draft as the model committed to it — before or while the write lands. */
function DraftCanvas({ draft, live }: { draft: WorkflowDraft; live: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
      <div>
        <h2 className="text-h2 text-fg">{draft.name || 'Untitled workflow'}</h2>
        {draft.description && <p className="mt-1 text-body text-muted">{draft.description}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
          {draft.schedule
            ? <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{humanizeCron(draft.schedule, draft.timezone)}</span>
            : <span>runs when you ask</span>}
          <span>{draft.steps.length} step{draft.steps.length === 1 ? '' : 's'}</span>
          {draft.steps.some((s) => s.gated) && <span className="inline-flex items-center gap-1"><Lock className="h-3.5 w-3.5" aria-hidden />asks before it sends</span>}
        </div>
      </div>
      {draft.goal && (
        <section className="rounded-md border border-border bg-surface px-4 py-3">
          <p className="text-label text-faint">Goal</p>
          <p className="text-body text-fg">{draft.goal}</p>
        </section>
      )}
      <ol className="flex flex-col">
        {draft.steps.map((step, i) => (
          <li key={step.id} className={cn('flex gap-3 rounded-md border border-border bg-surface px-4 py-3', live && 'animate-fade-in')} style={live ? { animationDelay: `${i * 60}ms` } : undefined}>
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-subtle font-mono text-caption text-muted">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body font-semibold text-fg">{step.id}</span>
                <EffectPill step={step} />
                {step.gated && <StatusPill tone="warning"><Lock className="mr-1 h-3 w-3" aria-hidden />needs approval</StatusPill>}
                {step.tool && <span className="font-mono text-caption text-faint">{step.tool}</span>}
                {step.skill && <span className="font-mono text-caption text-faint">skill · {step.skill}</span>}
              </div>
              {step.purpose && <p className="mt-0.5 text-small text-muted">{step.purpose}</p>}
              {step.dependsOn.length > 0 && <p className="mt-0.5 text-caption text-faint">after {step.dependsOn.join(', ')}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function AutomateCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const chat = useChat({ rememberAsLastSession: false });
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const seededRef = useRef(false);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  useEffect(() => { threadEndRef.current?.scrollIntoView({ block: 'end' }); }, [chat.messages]);

  // A deep link can hand in the objective; it fires once.
  useEffect(() => {
    const prompt = searchParams.get('prompt');
    if (prompt && !seededRef.current) { seededRef.current = true; void chat.send({ text: prompt }); }
  }, [searchParams, chat]);

  const build = workflowBuildFromMessages(chat.messages);
  const pill = statePill(build.state);
  const stored = useQuery({
    queryKey: ['workflow', build.writtenName],
    queryFn: () => getWorkflow(build.writtenName as string),
    enabled: Boolean(build.writtenName),
    refetchInterval: build.state === 'testing' ? 3000 : false,
  });
  const wf = stored.data;
  const cert = wf?.certification;
  const live = build.state === 'drafting' || build.state === 'writing' || build.state === 'testing';

  const start = (text: string) => { void chat.send({ text: `Create a workflow: ${text}` }); };

  return (
    <div className="flex h-full">
      <aside className="flex w-[400px] shrink-0 flex-col border-r border-border bg-subtle" aria-label="Conversation with Clementine">
        <div className="flex items-center gap-2 px-3 pb-2 pt-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/automate')} aria-label="Back to Automate">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-semibold text-fg">{build.draft?.name || 'New workflow'}</p>
            <p className="truncate text-caption text-faint">with Clementine · say what should happen, and when</p>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          {chat.messages.length === 0 ? (
            <div className="flex flex-col gap-2 px-1 pt-4">
              <p className="text-small text-muted">Describe a task you do often. Clementine works out the steps, tells you what each one reads, writes or sends, and asks before anything goes out.</p>
              {STARTERS.map((s) => (
                <button key={s} type="button" onClick={() => start(s)} className="rounded-md border border-border bg-surface px-3 py-2 text-left text-small text-fg shadow-xs transition-colors hover:border-primary/40 hover:bg-hover">
                  {s}
                </button>
              ))}
            </div>
          ) : (
            chat.messages.map((m) => (
              <ChatBubble
                key={m.id}
                message={m}
                sessionId={chat.sessionId.current ?? undefined}
                executionBusy={chat.busy}
                onExecutePlan={chat.executePlan}
                onRevisePlan={() => { chat.setComposerMode('plan'); composerRef.current?.focus(); }}
                onApprove={() => chat.send({ text: chatApprovalReply('approve', m.approval?.approvalId) })}
                onReject={() => chat.send({ text: chatApprovalReply('reject', m.approval?.approvalId) })}
              />
            ))
          )}
          <div ref={threadEndRef} />
        </div>
        <div className="border-t border-border p-2.5">
          <RunningTasksDrawer className="mb-1" composerRef={composerRef} />
          <Composer inputRef={composerRef} sessionId={chat.sessionId.current ?? undefined} busy={chat.busy} mode={chat.composerMode} onModeChange={chat.setComposerMode} activeTaskMode={chat.activeTaskMode} pendingPost={chat.pendingPost} onRetryPending={chat.retryPending} onCancelPending={chat.cancelPending} onSend={chat.send} onStop={chat.stop} placeholder="What should it do, and when?" />
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="The workflow">
        <div className="relative flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
          <h2 className="truncate text-h3 text-fg">{build.draft?.name || wf?.name || 'New workflow'}</h2>
          <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
          {cert && build.state === 'written' && <StatusPill tone={certificationTone(cert.state)}>{cert.label}</StatusPill>}
          {live && <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary/70" />}
          <div className="ml-auto flex items-center gap-1.5">
            {wf && (
              <>
                <Button variant="secondary" size="sm" disabled={cert ? !cert.canRun : false} title={cert?.summary} onClick={async () => {
                  try { await runWorkflow(wf.name); setRunNotice('Started a run — watch it in Automate.'); } catch (e) { setRunNotice((e as Error).message); }
                }}>
                  <Play className="h-4 w-4" aria-hidden /> Run once now
                </Button>
                <Button variant="secondary" size="sm" onClick={() => navigate(`/automate?workflow=${encodeURIComponent(wf.name)}`)}>
                  <ExternalLink className="h-4 w-4" aria-hidden /> Open in Automate
                </Button>
              </>
            )}
          </div>
        </div>
        {runNotice && <p className="border-b border-border bg-subtle px-4 py-2 text-small text-muted" role="status">{runNotice}</p>}
        <div className="relative min-h-0 flex-1 overflow-y-auto bg-canvas p-6">
          {wf ? (
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5">
              <div>
                <h2 className="text-h2 text-fg">{wf.name}</h2>
                {wf.description && <p className="mt-1 text-body text-muted">{wf.description}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-faint">
                  {wf.trigger?.schedule
                    ? <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{humanizeCron(wf.trigger.schedule, wf.trigger.timezone)}</span>
                    : <span>runs when you ask</span>}
                  {typeof wf.enabled === 'boolean' && <span>{wf.enabled ? 'enabled' : 'not enabled yet'}</span>}
                </div>
              </div>
              {cert && (
                <section className={cn('rounded-md border px-4 py-3', cert.canRun ? 'border-success/30 bg-success-tint' : 'border-warning/30 bg-warning-tint')}>
                  <p className="text-small font-semibold text-fg">{cert.label}</p>
                  {cert.summary && <p className="text-small text-muted">{cert.summary}</p>}
                </section>
              )}
              <WorkflowHowItWorks wf={wf} />
            </div>
          ) : build.draft ? (
            <DraftCanvas draft={build.draft} live={live} />
          ) : (
            <div className="grid h-full place-items-center text-center">
              <div>
                <p className="text-h3 text-muted">{build.state === 'drafting' ? 'Working out the steps' : 'Nothing here yet'}</p>
                <p className="mt-1 text-body text-faint">{build.state === 'drafting' ? 'The workflow appears here the moment Clementine commits to a shape.' : 'Describe the task on the left. The workflow takes shape here as she builds it.'}</p>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
