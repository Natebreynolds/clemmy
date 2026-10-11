/**
 * Projects: the durable bodies of work, the same records the desktop shows.
 *
 * The list answers one look: what each project is, who works on it, how much
 * is moving, and whether anything in it waits on the owner. A project is
 * depth: opening one registers the back gesture and writes its id to the URL,
 * so a link, a reload and a swipe all land where the owner actually is.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  arrangeProjects,
  projectAgentsLine,
  projectNeedsYouLabel,
  projectWorkLine,
  type ProjectSummary,
} from '@clem/chat-engine';
import { Sheet } from '../components/Sheet';
import { ScreenNotice } from '../components/ScreenNotice';
import { useBackGesture, withDepthTransition } from '../lib/back-gesture';
import { haptic } from '../lib/native-bridge';
import { createProject, listProjects } from '../lib/project-api';
import { inWords, refusalWords } from '../lib/project-words';
import { useScreenData } from '../lib/use-screen-data';
import type { ChatHandoff } from './Chats';
import { Project } from './Project';

interface Props {
  /** A project addressed by the URL: a link, a reload, or another screen. */
  initialProjectId?: string | null;
  /** Keeps the URL in step with what is open. */
  onProjectChange?: (projectId: string | null) => void;
  onOpenChat: (handoff: ChatHandoff) => void;
  onOpenRun: (runSessionId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenSpace: (spaceId: string) => void;
  onOpenNeedsYou: () => void;
  /** A decision was settled here, so the Needs-you count is read again. */
  onDecided: () => void;
  /** Bumped by the header's "+" door: start a new project. */
  createRequest?: number;
}

export function Projects({ initialProjectId, onProjectChange, onOpenChat, onOpenRun, onOpenAgent, onOpenSpace, onOpenNeedsYou, onDecided, createRequest }: Props) {
  const [openId, setOpenId] = useState<string | null>(initialProjectId ?? null);
  useBackGesture(openId !== null, () => { setOpenId(null); onProjectChange?.(null); });
  // The URL is the source of truth for which project is open.
  useEffect(() => { setOpenId(initialProjectId ?? null); }, [initialProjectId]);

  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  // Only a request made while this screen is open starts one.
  const seenCreate = useRef(createRequest);
  useEffect(() => {
    if (createRequest === seenCreate.current) return;
    seenCreate.current = createRequest;
    setCreating(true);
  }, [createRequest]);
  const { data, loading, error, offline, refresh } = useScreenData(
    async () => {
      try {
        return await listProjects({ archived: showArchived });
      } catch (err) {
        throw inWords(err, 'Could not load your projects.');
      }
    },
    { intervalMs: 15_000, disabled: openId !== null, resourceKey: `projects:${showArchived ? 'all' : 'active'}` },
  );

  const show = (projectId: string | null): void => {
    withDepthTransition(() => {
      setOpenId(projectId);
      onProjectChange?.(projectId);
    });
    if (projectId) document.querySelector('.app-main')?.scrollTo({ top: 0 });
  };

  if (openId) {
    return (
      <Project
        key={openId}
        projectId={openId}
        onBack={() => { show(null); void refresh(); }}
        onOpenChat={onOpenChat}
        onOpenRun={onOpenRun}
        onOpenAgent={onOpenAgent}
        onOpenSpace={onOpenSpace}
        onOpenNeedsYou={onOpenNeedsYou}
        onDecided={onDecided}
      />
    );
  }

  const projects = data?.projects ?? [];
  const { active, archived } = arrangeProjects(projects);

  return (
    <div>
      <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={projects.length > 0} />

      {loading && projects.length === 0 ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
      ) : null}

      {!loading && !error && !offline && active.length === 0 ? (
        <div class="empty">
          <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
          <p class="empty-title">No projects yet</p>
          <p class="empty-body">
            A project keeps one body of work together: what it is for, who answers for what, and every conversation about it.
          </p>
        </div>
      ) : null}

      <div class="stack">
        {active.map((project, i) => (
          <ProjectRow key={project.id} project={project} index={i} onOpen={() => { haptic('light'); show(project.id); }} />
        ))}
      </div>

      {showArchived && archived.length > 0 ? (
        <>
          <h2 class="section-head pane-head project-list-head">Archived</h2>
          <div class="stack">
            {archived.map((project, i) => (
              <ProjectRow key={project.id} project={project} index={i} onOpen={() => { haptic('light'); show(project.id); }} />
            ))}
          </div>
        </>
      ) : null}
      {showArchived && !loading && data && archived.length === 0 ? <p class="section-empty">Nothing is archived.</p> : null}

      {data ? (
        <div class="today-foot">
          <button type="button" onClick={() => { haptic('light'); setShowArchived((v) => !v); }}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        </div>
      ) : null}

      <NewProjectSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(projectId) => { setCreating(false); show(projectId); }}
      />
    </div>
  );
}

function ProjectRow({ project, index, onOpen }: { project: ProjectSummary; index: number; onOpen: () => void }) {
  const needs = project.status === 'archived' ? null : projectNeedsYouLabel(project);
  return (
    <button
      type="button"
      class={`card card-tap rise project-row${needs ? ' project-row-needs' : ''}`}
      style={{ '--i': index }}
      onClick={onOpen}
    >
      <span class="min-w-0 project-row-text">
        <span class="project-row-top">
          <span class="card-title-sm truncate">{project.name}</span>
          {needs ? <span class="chip chip-needs">{needs}</span> : null}
        </span>
        {project.purpose ? <span class="project-row-purpose">{project.purpose}</span> : null}
        <span class="card-when">
          {project.status === 'archived' ? 'Archived' : `${projectAgentsLine(project, 2)} · ${projectWorkLine(project)}`}
        </span>
      </span>
      <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
    </button>
  );
}

function NewProjectSheet({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setPurpose('');
    setFailure(null);
  }, [open]);

  const create = async () => {
    if (!name.trim() || lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const { overview } = await createProject({
        name: name.trim(),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      });
      haptic('success');
      onCreated(overview.project.id);
    } catch (err) {
      haptic('error');
      setFailure(refusalWords(err, 'The project was not created. Try again.'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New project" class="sheet-compact">
      <form class="project-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label class="agent-field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            maxLength={80}
            placeholder="Weekly sales"
            enterkeyhint="next"
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label class="agent-field">
          <span>What it is for (optional)</span>
          <textarea
            rows={2}
            value={purpose}
            maxLength={600}
            placeholder="Keep the forecast current and brief me every Monday."
            onInput={(event) => setPurpose(event.currentTarget.value)}
          />
        </label>
        {failure ? <p class="agent-failure" role="alert">{failure}</p> : null}
        <div class="agent-actions">
          <button class="agent-save" type="submit" disabled={!name.trim() || busy}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
          <button class="agent-cancel" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
