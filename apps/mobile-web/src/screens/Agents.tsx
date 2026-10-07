import { modelDisplayName } from '@clem/chat-engine';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useBackGesture, withDepthTransition } from '../lib/back-gesture';
import {
  createAgent,
  deleteAgent,
  listAgents,
  updateAgent,
  type MobileAgent,
  type MobileAgentsResponse,
} from '../lib/api';
import { ScreenNotice } from '../components/ScreenNotice';
import { haptic } from '../lib/native-bridge';
import { useScreenData } from '../lib/use-screen-data';
import { AgentDetail } from './AgentDetail';
import { usePendingCommit } from '../lib/pending-commit';

/**
 * Named agents — a person's own standing helpers.
 *
 * An agent is a name plus the skills and workflows it leans on. Messaging one
 * is an ordinary turn whose starting context was chosen in advance instead of
 * rediscovered every time, so this screen never implies it can do something a
 * plain message could not.
 */
interface Props {
  onMessage: (agent: MobileAgent) => void;
  /** An agent addressed by the URL or by another screen. */
  initialAgentId?: string | null;
  /** Keeps the URL in step with the agent that is open. */
  onAgentChange?: (agentId: string | null) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenRun?: (runSessionId: string) => void;
  onOpenNeedsYou?: () => void;
  /** Bumped by the header's "+" door: make a new agent. */
  createRequest?: number;
}

export function Agents({ onMessage, initialAgentId, onAgentChange, onOpenProject, onOpenRun, onOpenNeedsYou, createRequest }: Props) {
  const [editing, setEditing] = useState<MobileAgent | 'new' | null>(null);
  // Only a request made while this screen is open starts one.
  const seenCreate = useRef(createRequest);
  useEffect(() => {
    if (createRequest === seenCreate.current) return;
    seenCreate.current = createRequest;
    setEditing('new');
  }, [createRequest]);
  // An agent's own screen is depth under the list; its editor is depth under that.
  const [viewingId, setViewingId] = useState<string | null>(initialAgentId ?? null);
  useBackGesture(viewingId !== null, () => { setViewingId(null); onAgentChange?.(null); });
  useEffect(() => { setViewingId(initialAgentId ?? null); }, [initialAgentId]);
  useBackGesture(editing !== null, () => setEditing(null));
  const view = (agentId: string | null): void => {
    withDepthTransition(() => {
      setViewingId(agentId);
      onAgentChange?.(agentId);
    });
    if (agentId) document.querySelector('.app-main')?.scrollTo({ top: 0 });
  };
  const { data, loading, error, offline, refresh } = useScreenData<MobileAgentsResponse>(
    listAgents,
    { intervalMs: 20_000, disabled: editing !== null },
  );
  const agents = data?.agents ?? [];
  const available = data?.available ?? { skills: [], workflows: [] };

  if (editing) {
    return (
      <AgentEditor
        key={editing === 'new' ? 'new' : editing.id}
        agent={editing === 'new' ? null : editing}
        available={available}
        onClose={() => { setEditing(null); void refresh(); }}
      />
    );
  }

  if (loading && agents.length === 0) {
    return <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>;
  }
  if ((error || offline) && agents.length === 0) {
    return <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} />;
  }

  if (viewingId) {
    const viewing = agents.find((agent) => agent.id === viewingId);
    if (viewing) {
      return (
        <AgentDetail
          key={viewing.id}
          agent={viewing}
          onBack={() => { view(null); void refresh(); }}
          onMessage={onMessage}
          onEdit={(agent) => setEditing(agent)}
          onOpenProject={onOpenProject}
          onOpenRun={onOpenRun}
          onOpenNeedsYou={onOpenNeedsYou}
        />
      );
    }
    // Deleted here or on the desktop while its screen was open.
    return (
      <div class="empty">
        <p class="empty-title">That agent is no longer here</p>
        <p class="empty-body">It was deleted or replaced. Your other agents are on the list.</p>
        <button class="login-repair" type="button" onClick={() => view(null)}>Back to agents</button>
      </div>
    );
  }

  return (
    <div class="screen-pad">
      {agents.length === 0 ? (
        <p class="agent-empty">
          No agents yet. An agent is a name plus the skills and workflows it should reach for
          first — useful when you ask for the same kind of thing often.
        </p>
      ) : null}

      <ul class="agent-list">
        {agents.map((agent) => (
          <li key={agent.id} class="agent-card">
            <button
              class="agent-card-main"
              type="button"
              aria-label={`Open ${agent.name}`}
              onClick={() => { haptic('light'); view(agent.id); }}
            >
              <span class="agent-name">{agent.name}</span>
              {agent.handles ? <span class="agent-desc">{agent.handles}</span> : null}
              <span class="agent-pins">
                {agent.skills.length > 0 ? <span>{agent.skills.length} skills</span> : null}
                {agent.workflows.length > 0 ? <span>{agent.workflows.length} workflows</span> : null}
                {agent.model ? <span title={agent.model}>{modelDisplayName(agent.model)}</span> : null}
              </span>
            </button>
            {/* Messaging was the row's own tap before an agent had a screen of
                its own; it stays one tap away. Editing lives on that screen. */}
            <button
              class="agent-edit"
              type="button"
              aria-label={`Message ${agent.name}`}
              onClick={() => { haptic('light'); onMessage(agent); }}
            >
              Message
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentEditor({ agent, available, onClose }: {
  agent: MobileAgent | null;
  available: { skills: string[]; workflows: string[] };
  onClose: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [handles, setHandles] = useState(agent?.handles ?? '');
  const [instructions, setInstructions] = useState(agent?.instructions ?? '');
  const [skills, setSkills] = useState<string[]>(agent?.skills ?? []);
  const [workflows, setWorkflows] = useState<string[]>(agent?.workflows ?? []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const commit = usePendingCommit(agent?.id ?? 'new');
  const close = () => { if (!commit.pending) onClose(); };

  const toggle = (list: string[], set: (next: string[]) => void, value: string) => {
    haptic('light');
    set(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  };

  const save = async () => {
    if (!name.trim()) return;
    const token = commit.begin();
    if (!token) return;
    setBusy(true);
    setFailure(null);
    try {
      if (agent) {
        await updateAgent(agent.id, { name, handles, instructions, skills, workflows });
      } else {
        await createAgent({ name, handles, instructions, skills, workflows });
      }
      if (commit.owns(token)) { haptic('light'); onClose(); }
    } catch (err) {
      if (!commit.owns(token)) return;
      // Say what actually happened. A duplicate name is a normal thing to hit.
      const message = String((err as Error)?.message ?? err);
      setFailure(/409|name_taken/.test(message)
        ? 'You already have an agent with that name.'
        : message);
    } finally {
      if (commit.finish(token)) setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent) return;
    const token = commit.begin();
    if (!token) return;
    setBusy(true);
    try {
      await deleteAgent(agent.id);
      if (commit.owns(token)) { haptic('light'); onClose(); }
    } catch (err) {
      if (commit.owns(token)) setFailure(String((err as Error)?.message ?? err));
    } finally {
      if (commit.finish(token)) setBusy(false);
    }
  };

  return (
    <div class="screen-pad agent-editor">
      <fieldset disabled={busy} aria-busy={busy} style={{ margin: 0, padding: 0, border: 0, minWidth: 0, display: 'grid', gap: 'var(--sp-3)' }}>
      <label class="agent-field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          placeholder="Sales Desk"
          maxLength={64}
          onInput={(event) => setName((event.target as HTMLInputElement).value)}
        />
      </label>

      <label class="agent-field">
        <span>What it handles</span>
        <textarea
          value={handles}
          rows={2}
          maxLength={500}
          placeholder="Pipeline questions and renewal prep."
          onInput={(event) => setHandles((event.target as HTMLTextAreaElement).value)}
        />
      </label>

      <label class="agent-field">
        <span>Standing instructions</span>
        <textarea
          value={instructions}
          rows={4}
          maxLength={20000}
          placeholder="Check the pipeline sheet before answering. Flag any renewal inside 30 days."
          onInput={(event) => setInstructions((event.target as HTMLTextAreaElement).value)}
        />
      </label>

      <AgentPinGroup
        title="Skills"
        empty="No skills installed yet."
        options={available.skills}
        selected={skills}
        onToggle={(value) => toggle(skills, setSkills, value)}
      />
      <AgentPinGroup
        title="Workflows"
        empty="No workflows yet."
        options={available.workflows}
        selected={workflows}
        onToggle={(value) => toggle(workflows, setWorkflows, value)}
      />
      </fieldset>

      {failure ? <p class="agent-failure">{failure}</p> : null}

      <div class="agent-actions">
        <button class="agent-save" type="button" disabled={!name.trim() || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : agent ? 'Save' : 'Create agent'}
        </button>
        <button class="agent-cancel" type="button" disabled={busy} onClick={close}>Cancel</button>
        {agent ? (
          <button class="agent-delete" type="button" disabled={busy} onClick={() => void remove()}>
            Delete
          </button>
        ) : null}
      </div>
    </div>
  );
}

function AgentPinGroup({ title, empty, options, selected, onToggle }: {
  title: string;
  empty: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <section class="agent-pin-group">
      <h3>{title}</h3>
      {options.length === 0 ? (
        <p class="agent-empty">{empty}</p>
      ) : (
        <div class="agent-pin-row">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              class={`agent-pin${selected.includes(option) ? ' on' : ''}`}
              aria-pressed={selected.includes(option)}
              onClick={() => onToggle(option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
