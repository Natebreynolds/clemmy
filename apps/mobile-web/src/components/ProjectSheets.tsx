/**
 * The sheets a project's screen opens: who answers for what, and which
 * account the work uses.
 *
 * Each one changes the project through its own route and hands back the
 * project as the Mac now has it. None of them decides anything the Mac did
 * not: an account is bound only from the live connection list, and replacing
 * one that is already bound is asked first.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  middleTruncatePath,
  projectLocalProjectChoices,
  type ProjectAccountChoice,
  type ProjectAssignmentView,
  type ProjectConnectedApp,
  type ProjectLocalProject,
  type ProjectOverview,
  type ProjectResourceView,
} from '@clem/chat-engine';
import { listAgents, type MobileAgent } from '../lib/api';
import { haptic } from '../lib/native-bridge';
import {
  bindProjectAccount,
  linkLocalProject,
  listLocalProjects,
  listConnectedApps,
  removeProjectAgent,
  saveProjectAgent,
} from '../lib/project-api';
import { PHONE_PATH_CHARS, localProjectLinkStep, readLocalProjects } from '../lib/local-projects';
import { assignableAgents, bindableApps } from '../lib/project-detail';
import { accountBindStep, refusalWords } from '../lib/project-words';
import { Sheet } from './Sheet';

// ─── an agent in this project ─

interface AssignmentProps {
  projectId: string;
  projectName: string;
  /** The assignment being changed; null while the sheet is closed. */
  assignment: ProjectAssignmentView | null;
  onClose: () => void;
  onSaved: (overview: ProjectOverview) => void;
  onOpenAgent: (agentId: string) => void;
}

export function AssignmentSheet({ projectId, projectName, assignment, onClose, onSaved, onOpenAgent }: AssignmentProps) {
  const [responsibility, setResponsibility] = useState('');
  const [context, setContext] = useState('');
  const [shareMethods, setShareMethods] = useState(false);
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (!assignment) return;
    setResponsibility(assignment.responsibility);
    setContext(assignment.context);
    setShareMethods(assignment.shareMethods);
    setConfirmRemove(false);
    setFailure(null);
  }, [assignment?.agentId, assignment?.revision]);

  const run = async (kind: 'save' | 'remove', work: () => Promise<{ overview: ProjectOverview }>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind);
    setFailure(null);
    try {
      const { overview } = await work();
      haptic('success');
      onSaved(overview);
    } catch (err) {
      haptic('error');
      setFailure(refusalWords(err, kind === 'save' ? 'That did not save. Try again.' : 'That agent was not removed. Try again.'));
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const gone = assignment ? !assignment.available : false;

  return (
    <Sheet open={assignment !== null} onClose={onClose} title={assignment?.agentName ?? 'Agent'} aside={`in ${projectName}`}>
      {assignment ? (
        <form
          class="project-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run('save', () => saveProjectAgent(projectId, assignment.agentId, {
              responsibility: responsibility.trim(),
              context: context.trim(),
              shareMethods,
            }));
          }}
        >
          {gone ? (
            <p class="project-flag" role="note">
              This agent is no longer available, so it answers for nothing here. Remove it, or assign another agent.
            </p>
          ) : assignment.handles ? (
            <p class="project-sheet-note">{assignment.handles}</p>
          ) : null}

          {!gone ? (
            <>
              <label class="agent-field">
                <span>What it answers for here</span>
                <textarea
                  rows={2}
                  maxLength={600}
                  value={responsibility}
                  placeholder="The weekly forecast and the Monday briefing."
                  onInput={(event) => setResponsibility(event.currentTarget.value)}
                />
              </label>
              <label class="agent-field">
                <span>What it should know only here</span>
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={context}
                  placeholder="Numbers come from the pipeline sheet, not the CRM report."
                  onInput={(event) => setContext(event.currentTarget.value)}
                />
              </label>
              <label class="project-toggle">
                <input
                  type="checkbox"
                  checked={shareMethods}
                  onChange={(event) => setShareMethods(event.currentTarget.checked)}
                />
                <span>
                  <strong>Use what it learns here in its other projects</strong>
                  <small>Off keeps what it learns inside this project.</small>
                </span>
              </label>
            </>
          ) : null}

          {failure ? <p class="agent-failure" role="alert">{failure}</p> : null}

          {confirmRemove ? (
            <div class="project-confirm" role="group" aria-label="Confirm removal">
              <p>Remove {assignment.agentName} from {projectName}? Its work so far is kept.</p>
              <div class="agent-actions">
                <button
                  type="button"
                  class="btn-stop-yes"
                  disabled={busy !== null}
                  onClick={() => void run('remove', () => removeProjectAgent(projectId, assignment.agentId))}
                >
                  {busy === 'remove' ? 'Removing…' : 'Remove'}
                </button>
                <button type="button" class="btn-quiet" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Keep</button>
              </div>
            </div>
          ) : (
            <div class="agent-actions">
              {!gone ? (
                <button class="agent-save" type="submit" disabled={busy !== null}>
                  {busy === 'save' ? 'Saving…' : 'Save'}
                </button>
              ) : null}
              {!gone ? (
                <button class="agent-cancel" type="button" onClick={() => { haptic('light'); onOpenAgent(assignment.agentId); }}>
                  Open agent
                </button>
              ) : null}
              <button class="agent-delete" type="button" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
                Remove
              </button>
            </div>
          )}
        </form>
      ) : null}
    </Sheet>
  );
}

// ─── assigning an agent that exists ─

interface AssignProps {
  open: boolean;
  projectId: string;
  assigned: ReadonlyArray<{ agentId: string; available: boolean }>;
  onClose: () => void;
  onSaved: (overview: ProjectOverview) => void;
}

export function AssignAgentSheet({ open, projectId, assigned, onClose, onSaved }: AssignProps) {
  const [agents, setAgents] = useState<MobileAgent[] | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [picked, setPicked] = useState<MobileAgent | null>(null);
  const [responsibility, setResponsibility] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAgents(null);
    setLoadFailure(null);
    setPicked(null);
    setResponsibility('');
    setFailure(null);
    listAgents()
      .then((result) => { if (!cancelled) setAgents(result.agents); })
      .catch((err) => { if (!cancelled) setLoadFailure(refusalWords(err, 'Could not load your agents.')); });
    return () => { cancelled = true; };
  }, [open]);

  const assign = async () => {
    if (!picked || lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const { overview } = await saveProjectAgent(projectId, picked.id, { responsibility: responsibility.trim() });
      haptic('success');
      onSaved(overview);
    } catch (err) {
      haptic('error');
      setFailure(refusalWords(err, 'That agent was not assigned. Try again.'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const choices = agents ? assignableAgents(agents, assigned) : [];

  return (
    <Sheet open={open} onClose={onClose} title={picked ? picked.name : 'Assign an agent'} class="sheet-compact">
      {picked ? (
        <form class="project-form" onSubmit={(event) => { event.preventDefault(); void assign(); }}>
          {picked.handles ? <p class="project-sheet-note">{picked.handles}</p> : null}
          <label class="agent-field">
            <span>What it answers for here</span>
            <textarea
              rows={2}
              maxLength={600}
              value={responsibility}
              placeholder="The weekly forecast and the Monday briefing."
              onInput={(event) => setResponsibility(event.currentTarget.value)}
            />
          </label>
          {failure ? <p class="agent-failure" role="alert">{failure}</p> : null}
          <div class="agent-actions">
            <button class="agent-save" type="submit" disabled={busy}>{busy ? 'Assigning…' : 'Assign'}</button>
            <button class="agent-cancel" type="button" disabled={busy} onClick={() => { setPicked(null); setFailure(null); }}>Back</button>
          </div>
        </form>
      ) : loadFailure ? (
        <p class="agent-failure" role="alert">{loadFailure}</p>
      ) : agents === null ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
      ) : choices.length === 0 ? (
        <p class="project-sheet-note">
          {agents.length === 0
            ? 'You have no agents yet. Make one on the Agents screen, then assign it here.'
            : 'Every agent you have is already assigned to this project.'}
        </p>
      ) : (
        <ul class="agent-pick-list">
          {choices.map((agent) => (
            <li key={agent.id}>
              <button type="button" onClick={() => { haptic('light'); setPicked(agent); }}>
                <span class="agent-name">{agent.name}</span>
                {agent.handles ? <span class="agent-desc">{agent.handles}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

// ─── binding a connected account ─

type BinderStep =
  | { at: 'apps' }
  | { at: 'accounts'; toolkit: string; app: string; accounts: ProjectAccountChoice[] }
  | { at: 'not_connected'; app: string }
  | { at: 'conflict'; toolkit: string; app: string; account: ProjectAccountChoice | null; bound: string };

interface BinderProps {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onSaved: (overview: ProjectOverview) => void;
}

export function AccountBinderSheet({ open, projectId, onClose, onSaved }: BinderProps) {
  const [apps, setApps] = useState<ProjectConnectedApp[] | null>(null);
  const [step, setStep] = useState<BinderStep>({ at: 'apps' });
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setApps(null);
    setStep({ at: 'apps' });
    setFailure(null);
    setBusy(null);
    // One read: every app with an account connected right now, and its accounts.
    listConnectedApps()
      .then((result) => { if (!cancelled) setApps(bindableApps(result.apps)); })
      .catch((err) => {
        if (cancelled) return;
        setApps([]);
        setFailure(refusalWords(err, 'Could not load your connected apps.'));
      });
    return () => { cancelled = true; };
  }, [open]);

  /** Bind, and let the Mac's refusal say what to ask next. */
  const bind = async (toolkit: string, app: string, account: ProjectAccountChoice | null, replace = false) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(account?.accountId ?? toolkit);
    setFailure(null);
    try {
      const { overview } = await bindProjectAccount(projectId, {
        toolkit,
        ...(account ? { accountId: account.accountId } : {}),
        ...(replace ? { replace: true } : {}),
      });
      haptic('success');
      onSaved(overview);
    } catch (err) {
      const next = accountBindStep(err);
      if (next.step === 'choose') setStep({ at: 'accounts', toolkit, app, accounts: next.accounts });
      else if (next.step === 'not_connected') setStep({ at: 'not_connected', app });
      else if (next.step === 'conflict') setStep({ at: 'conflict', toolkit, app, account, bound: next.bound.label });
      else { haptic('error'); setFailure(next.message); }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  /** One app picked: its only account is bound, or the owner picks one of several. */
  const pickApp = (app: ProjectConnectedApp) => {
    haptic('light');
    setFailure(null);
    if (app.accounts.length === 1) void bind(app.toolkit, app.name, app.accounts[0]!);
    else setStep({ at: 'accounts', toolkit: app.toolkit, app: app.name, accounts: app.accounts });
  };

  const title = step.at === 'apps' ? 'Add an account' : step.app;

  return (
    <Sheet open={open} onClose={onClose} title={title} class="sheet-compact">
      {step.at === 'apps' ? (
        apps === null ? (
          <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
        ) : apps.length === 0 ? (
          failure ? null : <p class="project-sheet-note">No apps are connected yet. Connect one on your computer, then add its account here.</p>
        ) : (
          <>
            <p class="project-sheet-note">Which app does this project use?</p>
            <ul class="agent-pick-list">
              {apps.map((app) => (
                <li key={app.toolkit}>
                  <button type="button" disabled={busy !== null} onClick={() => pickApp(app)}>
                    <span class="agent-name">{app.name}</span>
                    <span class="agent-desc">
                      {busy === app.accounts[0]?.accountId && app.accounts.length === 1
                        ? 'Adding…'
                        : app.accounts.length === 1 ? app.accounts[0]!.label : `${app.accounts.length} accounts connected`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : step.at === 'accounts' ? (
        <>
          <p class="project-sheet-note">Which {step.app} account?</p>
          <ul class="agent-pick-list">
            {step.accounts.map((account) => (
              <li key={account.accountId}>
                <button type="button" disabled={busy !== null} onClick={() => void bind(step.toolkit, step.app, account)}>
                  <span class="agent-name">{account.label}</span>
                  {busy === account.accountId ? <span class="agent-desc">Adding…</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" class="link-btn" disabled={busy !== null} onClick={() => { setStep({ at: 'apps' }); setFailure(null); }}>Choose another app</button>
        </>
      ) : step.at === 'not_connected' ? (
        <>
          <p class="project-sheet-note">
            No {step.app} account is connected right now. Connect it on your computer, then add it here.
          </p>
          <button type="button" class="link-btn" onClick={() => { setStep({ at: 'apps' }); setFailure(null); }}>Choose another app</button>
        </>
      ) : (
        <div class="project-confirm" role="group" aria-label="Confirm replacing the account">
          <p>
            This project already uses {step.bound} for {step.app}.
            {step.account ? ` Replace it with ${step.account.label}?` : ' Replace it?'}
          </p>
          <div class="agent-actions">
            <button
              type="button"
              class="agent-save"
              disabled={busy !== null}
              onClick={() => void bind(step.toolkit, step.app, step.account, true)}
            >
              {busy !== null ? 'Replacing…' : 'Replace'}
            </button>
            <button type="button" class="agent-cancel" disabled={busy !== null} onClick={onClose}>Keep {step.bound}</button>
          </div>
        </div>
      )}
      {failure ? <p class="agent-failure" role="alert">{failure}</p> : null}
    </Sheet>
  );
}

// ─── linking a local project ─

interface LocalProjectProps {
  open: boolean;
  projectId: string;
  /** What the project uses now, so a linked local project is not offered again. */
  resources: readonly ProjectResourceView[];
  onClose: () => void;
  onSaved: (overview: ProjectOverview, name: string) => void;
}

/**
 * The Mac's own roster of local projects. A folder that is not on it is never
 * linked, so the sheet offers only what the Mac listed, and a refusal is
 * answered with the list the Mac sent back.
 */
export function LocalProjectSheet({ open, projectId, resources, onClose, onSaved }: LocalProjectProps) {
  const [roster, setRoster] = useState<ProjectLocalProject[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRoster(null);
    setNote(null);
    setFailure(null);
    setBusy(null);
    listLocalProjects()
      .then((result) => { if (!cancelled) setRoster(readLocalProjects(result.localProjects)); })
      .catch((err) => {
        if (cancelled) return;
        setRoster([]);
        setFailure(refusalWords(err, 'Could not read the local projects on your computer. Try again.'));
      });
    return () => { cancelled = true; };
  }, [open]);

  const link = async (localProject: ProjectLocalProject) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(localProject.path);
    setNote(null);
    setFailure(null);
    haptic('light');
    try {
      const { overview } = await linkLocalProject(projectId, localProject.path);
      haptic('success');
      onSaved(overview, localProject.name);
    } catch (err) {
      const next = localProjectLinkStep(err);
      if (next.step === 'failed') {
        haptic('error');
        setFailure(refusalWords(err, `${localProject.name} was not linked. Try again.`));
      } else {
        // Nothing was linked. The Mac said what can be chosen; that is the list now.
        setNote(next.text);
        if (next.localProjects.length > 0) setRoster(next.localProjects);
      }
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const choices = roster ? projectLocalProjectChoices(roster, resources) : [];

  return (
    <Sheet open={open} onClose={onClose} title="Link a local project">
      {roster === null ? (
        <div role="status" aria-live="polite">
          <p class="project-sheet-note">Looking through the code folders on your computer. This can take a few seconds the first time.</p>
          <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
        </div>
      ) : (
        <>
          {note ? <p class="project-sheet-note" role="status">{note}</p> : null}
          {failure ? <p class="agent-failure" role="alert">{failure}</p> : null}
          {choices.length === 0 && !failure ? (
            <p class="project-sheet-note">
              No local projects are on your computer's list yet. Add a code folder in Connect on your computer, then link it here.
            </p>
          ) : (
            <ul class="agent-pick-list">
              {choices.map(({ localProject, linked }) => (
                <li key={localProject.path}>
                  <button
                    type="button"
                    class={linked ? 'is-linked' : undefined}
                    disabled={linked || busy !== null}
                    aria-label={linked ? `${localProject.name}, already linked` : `Link ${localProject.name}`}
                    onClick={() => void link(localProject)}
                  >
                    <span class="pick-top">
                      <span class="agent-name">{localProject.name}</span>
                      {linked ? <span class="chip chip-project">Linked</span> : null}
                    </span>
                    <span class="agent-desc project-path" title={localProject.path}>
                      {busy === localProject.path ? 'Linking…' : middleTruncatePath(localProject.path, PHONE_PATH_CHARS)}
                    </span>
                    {!linked && !localProject.git ? <span class="agent-desc">Coding work cannot run here yet.</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Sheet>
  );
}
