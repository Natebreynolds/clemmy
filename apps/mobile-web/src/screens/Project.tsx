/**
 * One project, read top to bottom in the order the owner needs it: what it
 * is, what waits on them, what is moving, who answers for what, which
 * accounts the work uses, and the conversations about it.
 *
 * Everything drawn here is the project overview the Mac returned, the same
 * one the desktop reads. Every control calls the project's own route and the
 * screen settles to the overview that route answers with.
 */
import { useCallback, useRef, useState } from 'preact/hooks';
import {
  delegatedTaskFollowsLine,
  groupProjectResources,
  projectDecisionConsequence,
  projectResourceApp,
  projectDecisionSource,
  projectResourceName,
  projectResourceVerification,
  type DelegatedTask,
  type ProjectAssignmentView,
  type ProjectDecisionView,
  type ProjectOverview,
  type ProjectResourceView,
} from '@clem/chat-engine';
import { listApprovals, type ApprovalRow } from '../lib/api';
import { Decisions, relativeTime } from '../components/Approvals';
import { ChatBackButton } from '../components/ChatBackButton';
import { DelegatedTaskCard, DelegatedTaskList } from '../components/DelegatedTaskCard';
import { AccountBinderSheet, AssignAgentSheet, AssignmentSheet } from '../components/ProjectSheets';
import { ScreenNotice, type ScreenNote } from '../components/ScreenNotice';
import { haptic } from '../lib/native-bridge';
import {
  answerDelegatedTask,
  archiveProject,
  changeProject,
  getProject,
  removeProjectResource,
  restoreProject,
} from '../lib/project-api';
import { layoutProjectWork } from '../lib/project-detail';
import {
  inWords,
  projectDraftChanges,
  projectDraftFrom,
  refusalIsStale,
  refusalWords,
  type ProjectDraft,
} from '../lib/project-words';
import { useScreenData } from '../lib/use-screen-data';
import type { ChatHandoff } from './Chats';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenChat: (handoff: ChatHandoff) => void;
  onOpenRun: (runSessionId: string) => void;
  onOpenAgent: (agentId: string) => void;
  /** Where a card is decided when this screen could not read it. */
  onOpenNeedsYou: () => void;
  onDecided: () => void;
}

interface Loaded {
  overview: ProjectOverview;
  /** What Needs you lists for approval; null when it could not be read. */
  approvalCards: ApprovalRow[] | null;
}

/** How many ended tasks are listed before "Show more". */
const ENDED_SHOWN = 3;

export function Project({ projectId, onBack, onOpenChat, onOpenRun, onOpenAgent, onOpenNeedsYou, onDecided }: Props) {
  const load = useCallback(async (): Promise<Loaded> => {
    try {
      const { overview } = await getProject(projectId);
      let approvalCards: ApprovalRow[] | null = [];
      // Read only when this project waits on an approval, and never allowed
      // to fail the project: without it an approval simply gets no button.
      if (overview.decisions.some((decision) => decision.kind === 'approval' && decision.approvalId)) {
        approvalCards = await listApprovals()
          .then((result) => result.approvals.filter((row) => row.status === 'pending'))
          .catch(() => null);
      }
      return { overview, approvalCards };
    } catch (err) {
      throw inWords(err, 'Could not load this project.');
    }
  }, [projectId]);
  const { data, loading, error, offline, refresh } = useScreenData(load, { intervalMs: 8_000, resourceKey: `project:${projectId}` });

  // A change answers with the project as it now stands. It is shown at once
  // and gives way to the next read, so the screen never waits on a second
  // round trip to show what the owner just did.
  const [settled, setSettled] = useState<{ overview: ProjectOverview; over: Loaded | null } | null>(null);
  const overview = settled && settled.over === data ? settled.overview : data?.overview ?? null;
  const settle = (next: ProjectOverview) => {
    setSettled({ overview: next, over: data });
    void refresh();
  };

  const [note, setNote] = useState<ScreenNote | null>(null);
  const [editing, setEditing] = useState(false);
  const [assignment, setAssignment] = useState<ProjectAssignmentView | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [binding, setBinding] = useState(false);
  const [endedOpen, setEndedOpen] = useState(false);

  /** A decision settled here settles it everywhere: read the project and the count again. */
  const decided = (text?: string) => {
    if (text) setNote({ tone: 'success', text });
    void refresh();
    onDecided();
  };

  const project = overview?.project ?? null;
  const archived = project?.status === 'archived';
  const layout = overview
    ? layoutProjectWork({ tasks: overview.tasks, decisions: overview.decisions, approvalCards: data?.approvalCards ?? null })
    : null;
  const cards = layout ? layout.approvals.flatMap((row) => (row.card ? [row.card] : [])) : [];
  // A card this screen could not read is decided on Needs you, not guessed at here.
  const unread = layout ? layout.approvals.flatMap((row) => (row.card ? [] : [row.decision])) : [];
  const asked = layout ? layout.asked : [];
  const follows = (task: DelegatedTask) => delegatedTaskFollowsLine(task, overview?.tasks ?? []);
  const listedTasks = new Set((overview?.tasks ?? []).map((task) => task.taskId));
  const resources = overview ? groupProjectResources(overview.resources) : [];

  return (
    <div class="workflow-detail project-detail">
      <div class="chat-header">
        <ChatBackButton onClick={onBack} />
        <h2 class="chat-title">{project?.name ?? 'Project'}</h2>
        {project && !editing ? (
          <button type="button" class="btn-quiet" onClick={() => { haptic('light'); setNote(null); setEditing(true); }}>Edit</button>
        ) : null}
      </div>

      <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={Boolean(overview)} note={note} />
      {loading && !overview ? <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div> : null}

      {overview && project && layout ? (
        <div class="project-sections">
          {editing ? (
            <ProjectEditor
              overview={overview}
              onCancel={() => setEditing(false)}
              onSaved={(next, text) => { setEditing(false); setNote({ tone: 'success', text }); settle(next); }}
            />
          ) : (
            <section class="project-about" aria-label="What this project is">
              {archived ? <p class="project-flag" role="note">Archived. Nothing new starts here until you restore it.</p> : null}
              <p class={`project-purpose${project.purpose ? '' : ' is-empty'}`}>
                {project.purpose || 'No purpose written yet. Tap Edit to say what this project is for.'}
              </p>
              {project.goals.length > 0 ? (
                <>
                  <h3 class="project-sub">Goals</h3>
                  <ul class="project-goals">
                    {project.goals.map((goal) => <li key={goal}>{goal}</li>)}
                  </ul>
                </>
              ) : null}
              {project.context ? (
                <>
                  <h3 class="project-sub">Always keep in mind</h3>
                  <p class="project-context">{project.context}</p>
                </>
              ) : null}
            </section>
          )}

          {!archived ? (
            <section aria-labelledby="project-needs">
              <h2 id="project-needs" class="section-head">
                Needs you
                {layout.waiting > 0 ? <span class="section-count">{layout.waiting}</span> : null}
              </h2>
              {layout.waiting === 0 ? <p class="section-empty">Nothing here is waiting on you.</p> : (
                <div class="task-list">
                  {layout.questions.map((task) => (
                    <DelegatedTaskCard key={task.taskId} task={task} follows={follows(task)} listed={listedTasks} hideProject onChanged={() => decided()} onOpenRun={onOpenRun} />
                  ))}
                  {layout.looseQuestions.map((decision) => (
                    <LooseQuestion key={decision.taskId ?? decision.questionId ?? decision.askedAt} decision={decision} onAnswered={decided} />
                  ))}
                  <Decisions
                    approvals={cards}
                    plans={[]}
                    workspaceChoosers={[]}
                    onResolved={(message) => decided(message)}
                    onReply={(sessionId, draft) => onOpenChat({ sessionId, draft })}
                    // This screen is the project; the card need not say so again.
                    projectOf={() => null}
                  />
                  {unread.map((decision) => (
                    <article key={decision.approvalId ?? decision.askedAt} class="inbox-card inbox-attention-card">
                      <div class="inbox-card-meta">
                        <span class="urgent">Approval</span>
                        <time dateTime={decision.askedAt}>{relativeTime(decision.askedAt)}</time>
                      </div>
                      <h2>{decision.detail || decision.title}</h2>
                      <p class="inbox-card-body">{projectDecisionSource(decision)}</p>
                      <div class="inbox-card-actions">
                        <button type="button" class="btn-reply" onClick={() => { haptic('light'); onOpenNeedsYou(); }}>Decide in Needs you</button>
                      </div>
                    </article>
                  ))}
                  {asked.map((decision) => (
                    <article key={`${decision.sessionId}:${decision.askedAt}`} class="inbox-card inbox-attention-card">
                      <div class="inbox-card-meta">
                        <span class="urgent">Asked in conversation</span>
                        <time dateTime={decision.askedAt}>{relativeTime(decision.askedAt)}</time>
                      </div>
                      <h2>{decision.detail || decision.title}</h2>
                      <p class="inbox-card-body">{projectDecisionSource(decision)}</p>
                      {/* No buttons here, so no promise about what a button does. */}
                      <p class="inbox-card-fine">{projectDecisionConsequence(decision)}</p>
                      <div class="inbox-card-actions">
                        <button type="button" class="btn-reply" onClick={() => { haptic('light'); onOpenChat({ sessionId: decision.sessionId }); }}>
                          Answer in the conversation
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          <section aria-labelledby="project-work">
            <h2 id="project-work" class="section-head">Current work</h2>
            <DelegatedTaskList
              tasks={layout.current}
              known={overview.tasks}
              empty={layout.questions.length > 0 ? undefined : 'No work is running in this project.'}
              hideProject
              onChanged={() => void refresh()}
              onOpenRun={onOpenRun}
            />
            {layout.ended.length > 0 ? (
              <>
                <h3 class="project-sub">Earlier</h3>
                <DelegatedTaskList
                  tasks={endedOpen ? layout.ended : layout.ended.slice(0, ENDED_SHOWN)}
                  known={overview.tasks}
                  hideProject
                  onChanged={() => void refresh()}
                  onOpenRun={onOpenRun}
                />
                {layout.ended.length > ENDED_SHOWN ? (
                  <button type="button" class="link-btn" aria-expanded={endedOpen} onClick={() => setEndedOpen(!endedOpen)}>
                    {endedOpen ? 'Show fewer' : `Show ${layout.ended.length - ENDED_SHOWN} more`}
                  </button>
                ) : null}
              </>
            ) : null}
          </section>

          <section aria-labelledby="project-agents">
            <h2 id="project-agents" class="section-head">Agents</h2>
            {overview.agents.length === 0 ? (
              <p class="section-empty">No agent is assigned. Clem handles this project herself.</p>
            ) : (
              <div class="home-card">
                {overview.agents.map((row) => (
                  <button
                    key={row.agentId}
                    type="button"
                    class="home-row home-row-tap project-line"
                    onClick={() => { haptic('light'); setAssignment(row); }}
                  >
                    <span class="project-line-text">
                      <span class="project-line-title">{row.agentName}</span>
                      <span class="project-line-sub">
                        {!row.available
                          ? 'No longer available'
                          : row.responsibility || row.handles || 'Nothing written about what it answers for here'}
                      </span>
                    </span>
                    {!row.available ? <span class="chip chip-gone">Unavailable</span> : null}
                    <Chevron />
                  </button>
                ))}
              </div>
            )}
            {!archived ? (
              <button type="button" class="project-add" onClick={() => { haptic('light'); setAssigning(true); }}>Assign an agent</button>
            ) : null}
          </section>

          <section aria-labelledby="project-resources">
            <h2 id="project-resources" class="section-head">Accounts and resources</h2>
            {resources.length === 0 ? (
              <p class="section-empty">Nothing is attached. Add the account this project's work should use.</p>
            ) : resources.map((group) => (
              <div key={group.kind} class="project-group">
                <h3 class="project-sub">{group.label}</h3>
                <div class="home-card">
                  {group.items.map((resource) => (
                    <ResourceRow
                      key={resource.id}
                      resource={resource}
                      onRemoved={(next) => { setNote({ tone: 'success', text: `${projectResourceName(resource)} removed from this project.` }); settle(next); }}
                    />
                  ))}
                </div>
              </div>
            ))}
            {!archived ? (
              <button type="button" class="project-add" onClick={() => { haptic('light'); setBinding(true); }}>Add an account</button>
            ) : null}
          </section>

          <section aria-labelledby="project-chats">
            <h2 id="project-chats" class="section-head">Conversations</h2>
            {overview.conversations.length === 0 ? (
              <p class="section-empty">No conversation has worked in this project yet.</p>
            ) : (
              <div class="home-card">
                {overview.conversations.map((conversation) => (
                  <button
                    key={conversation.sessionId}
                    type="button"
                    class="home-row home-row-tap project-line"
                    onClick={() => {
                      haptic('light');
                      onOpenChat({ sessionId: conversation.sessionId, title: conversation.title ?? undefined });
                    }}
                  >
                    <span class="project-line-text">
                      <span class="project-line-title">{conversation.title || 'Untitled'}</span>
                      <span class="project-line-sub">
                        {[
                          conversation.agentName,
                          conversation.current ? '' : 'Worked here earlier',
                          relativeTime(conversation.updatedAt),
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <Chevron />
                  </button>
                ))}
              </div>
            )}
            {!archived ? (
              <button
                type="button"
                class="project-add"
                onClick={() => { haptic('light'); onOpenChat({ projectId: project.id, projectName: project.name }); }}
              >
                New conversation in this project
              </button>
            ) : null}
          </section>
        </div>
      ) : null}

      {project ? (
        <>
          <AssignmentSheet
            projectId={project.id}
            projectName={project.name}
            assignment={assignment}
            onClose={() => setAssignment(null)}
            onSaved={(next) => { setAssignment(null); settle(next); }}
            onOpenAgent={(agentId) => { setAssignment(null); onOpenAgent(agentId); }}
          />
          <AssignAgentSheet
            open={assigning}
            projectId={project.id}
            assigned={overview?.agents ?? []}
            onClose={() => setAssigning(false)}
            onSaved={(next) => { setAssigning(false); settle(next); }}
          />
          <AccountBinderSheet
            open={binding}
            projectId={project.id}
            onClose={() => setBinding(false)}
            onSaved={(next) => { setBinding(false); setNote({ tone: 'success', text: 'Account added to this project.' }); settle(next); }}
          />
        </>
      ) : null}
    </div>
  );
}

function Chevron() {
  return (
    <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/** What it is, as a form. Saves only what changed. */
function ProjectEditor({ overview, onCancel, onSaved }: {
  overview: ProjectOverview;
  onCancel: () => void;
  onSaved: (overview: ProjectOverview, receipt: string) => void;
}) {
  const project = overview.project;
  const [draft, setDraft] = useState<ProjectDraft>(() => projectDraftFrom(project));
  const [busy, setBusy] = useState<'save' | 'archive' | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);
  const archived = project.status === 'archived';

  const run = async (kind: 'save' | 'archive', work: () => Promise<{ overview: ProjectOverview }>, receipt: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setFailure(null);
    try {
      const result = await work();
      haptic('success');
      onSaved(result.overview, receipt);
    } catch (err) {
      haptic('error');
      setFailure(refusalWords(err, 'That did not save. Try again.'));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const save = () => {
    const patch = projectDraftChanges(project, draft);
    if (!patch) { onCancel(); return; }
    void run('save', () => changeProject(project.id, patch), 'Saved.');
  };
  const set = (field: keyof ProjectDraft) => (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    const value = event.currentTarget.value;
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return (
    <form class="project-form" aria-label="Edit this project" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <label class="agent-field">
        <span>Name</span>
        <input type="text" value={draft.name} maxLength={80} disabled={archived} onInput={set('name')} />
      </label>
      <label class="agent-field">
        <span>What it is for</span>
        <textarea rows={2} value={draft.purpose} maxLength={600} disabled={archived} onInput={set('purpose')} />
      </label>
      <label class="agent-field">
        <span>Goals, one per line</span>
        <textarea rows={3} value={draft.goals} maxLength={2000} disabled={archived} onInput={set('goals')} />
      </label>
      <label class="agent-field">
        <span>Always keep in mind</span>
        <textarea
          rows={4}
          value={draft.context}
          maxLength={8000}
          disabled={archived}
          placeholder="What anyone working here should know before they start."
          onInput={set('context')}
        />
      </label>

      {failure ? <p class="agent-failure" role="alert">{failure}</p> : null}

      {confirmArchive ? (
        <div class="project-confirm" role="group" aria-label="Confirm archiving">
          <p>Archive {project.name}? Its work and conversations are kept, and nothing new starts in it until you restore it.</p>
          <div class="agent-actions">
            <button
              type="button"
              class="btn-stop-yes"
              disabled={busy !== null}
              onClick={() => void run('archive', () => archiveProject(project.id), 'Archived.')}
            >
              {busy === 'archive' ? 'Archiving…' : 'Archive'}
            </button>
            <button type="button" class="btn-quiet" disabled={busy !== null} onClick={() => setConfirmArchive(false)}>Keep it open</button>
          </div>
        </div>
      ) : (
        <div class="agent-actions">
          {archived ? (
            <button
              type="button"
              class="agent-save"
              disabled={busy !== null}
              onClick={() => void run('archive', () => restoreProject(project.id), 'Restored.')}
            >
              {busy === 'archive' ? 'Restoring…' : 'Restore project'}
            </button>
          ) : (
            <button class="agent-save" type="submit" disabled={busy !== null || !draft.name.trim()}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          )}
          <button class="agent-cancel" type="button" disabled={busy !== null} onClick={onCancel}>Cancel</button>
          {!archived ? (
            <button class="agent-delete" type="button" disabled={busy !== null} onClick={() => setConfirmArchive(true)}>Archive</button>
          ) : null}
        </div>
      )}
    </form>
  );
}

/** One thing the project uses, with whether it was checked and a way to take it off. */
function ResourceRow({ resource, onRemoved }: {
  resource: ProjectResourceView;
  onRemoved: (overview: ProjectOverview) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);
  const checked = projectResourceVerification(resource);
  const name = projectResourceName(resource);
  // The app as a person writes it, in the words the desktop uses.
  const app = projectResourceApp(resource) || null;

  const remove = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const { overview } = await removeProjectResource(resource.projectId, resource.id);
      haptic('success');
      onRemoved(overview);
    } catch (err) {
      haptic('error');
      setFailure(refusalWords(err, 'That was not removed. Try again.'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <div class="home-row project-line project-resource">
      <span class="project-line-text">
        <span class="project-line-title">{name}</span>
        <span class="project-line-sub">
          {app}
          {checked ? (
            <span class={`project-check${checked.verified ? ' is-verified' : ''}`}>
              {app ? ' · ' : ''}
              {checked.verified ? `Verified ${relativeTime(resource.verifiedAt ?? '')}` : 'Not verified'}
            </span>
          ) : null}
          {!checked && resource.ref && resource.ref !== name ? resource.ref : null}
        </span>
        {failure ? <span class="inbox-inline-error" role="alert">{failure}</span> : null}
      </span>
      {confirming ? (
        <span class="project-resource-confirm" role="group" aria-label={`Remove ${name}`}>
          <button type="button" class="btn-stop-yes" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : 'Remove'}</button>
          <button type="button" class="btn-quiet" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
        </span>
      ) : (
        <button type="button" class="link-btn project-resource-remove" aria-label={`Remove ${name}`} onClick={() => { haptic('light'); setConfirming(true); }}>
          Remove
        </button>
      )}
    </div>
  );
}

/** A question whose task the overview did not carry: answered through the task all the same. */
function LooseQuestion({ decision, onAnswered }: {
  decision: ProjectDecisionView;
  onAnswered: (receipt?: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  const submit = async () => {
    const text = answer.trim().slice(0, 4_000);
    if (!text || !decision.taskId || lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await answerDelegatedTask(decision.taskId, text);
      haptic('success');
      onAnswered('Answer sent.');
    } catch (err) {
      if (refusalIsStale(err)) {
        haptic('light');
        onAnswered(refusalWords(err));
      } else {
        haptic('error');
        setFailure(refusalWords(err, 'Your answer was not sent. Try again.'));
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <article class="inbox-card inbox-question-card" aria-busy={busy}>
      <div class="inbox-card-meta">
        <span class="urgent">Question</span>
        <time dateTime={decision.askedAt}>{relativeTime(decision.askedAt)}</time>
      </div>
      <h2>{decision.detail || decision.title}</h2>
      <p class="inbox-card-fine">{projectDecisionSource(decision)}</p>
      <form class="inbox-reply" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea
          rows={2}
          maxLength={4000}
          value={answer}
          disabled={busy}
          aria-label={`Answer ${decision.owner || 'Clem'}`}
          placeholder={`Answer ${decision.owner || 'Clem'}…`}
          onInput={(event) => setAnswer(event.currentTarget.value)}
        />
        <div class="inbox-card-actions">
          <button class="btn-approve" type="submit" disabled={busy || !answer.trim()}>{busy ? 'Sending…' : 'Send answer'}</button>
        </div>
      </form>
      {failure ? <p class="inbox-inline-error" role="alert">{failure}</p> : null}
    </article>
  );
}
