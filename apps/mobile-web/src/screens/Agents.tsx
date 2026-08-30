import { useState } from 'preact/hooks';
import { useBackGesture } from '../lib/back-gesture';
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

/**
 * Named agents — a person's own standing helpers.
 *
 * An agent is a name plus the skills and workflows it leans on. Messaging one
 * is an ordinary turn whose starting context was chosen in advance instead of
 * rediscovered every time, so this screen never implies it can do something a
 * plain message could not.
 */
export function Agents({ onMessage }: { onMessage: (agent: MobileAgent) => void }) {
  const [editing, setEditing] = useState<MobileAgent | 'new' | null>(null);
  useBackGesture(editing !== null, () => setEditing(null));
  const { data, loading, error, offline, refresh } = useScreenData<MobileAgentsResponse>(
    listAgents,
    { intervalMs: 20_000, disabled: editing !== null },
  );
  const agents = data?.agents ?? [];
  const available = data?.available ?? { skills: [], workflows: [] };

  if (editing) {
    return (
      <AgentEditor
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

  return (
    <div class="screen-pad">
      <button
        class="agent-new"
        type="button"
        onClick={() => { haptic('light'); setEditing('new'); }}
      >
        + New agent
      </button>

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
              onClick={() => { haptic('light'); onMessage(agent); }}
            >
              <span class="agent-name">{agent.name}</span>
              {agent.description ? <span class="agent-desc">{agent.description}</span> : null}
              <span class="agent-pins">
                {agent.skills.length > 0 ? <span>{agent.skills.length} skills</span> : null}
                {agent.workflows.length > 0 ? <span>{agent.workflows.length} workflows</span> : null}
                {agent.model ? <span>{agent.model}</span> : null}
              </span>
            </button>
            <button
              class="agent-edit"
              type="button"
              aria-label={`Edit ${agent.name}`}
              onClick={() => { haptic('light'); setEditing(agent); }}
            >
              Edit
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
  const [description, setDescription] = useState(agent?.description ?? '');
  const [skills, setSkills] = useState<string[]>(agent?.skills ?? []);
  const [workflows, setWorkflows] = useState<string[]>(agent?.workflows ?? []);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = (list: string[], set: (next: string[]) => void, value: string) => {
    haptic('light');
    set(list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
  };

  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      if (agent) {
        await updateAgent(agent.id, { name, description, skills, workflows });
      } else {
        await createAgent({ name, description, skills, workflows });
      }
      haptic('light');
      onClose();
    } catch (err) {
      // Say what actually happened. A duplicate name is a normal thing to hit.
      const message = String((err as Error)?.message ?? err);
      setFailure(/409|name_taken/.test(message)
        ? 'You already have an agent with that name.'
        : message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!agent || busy) return;
    setBusy(true);
    try {
      await deleteAgent(agent.id);
      haptic('light');
      onClose();
    } catch (err) {
      setFailure(String((err as Error)?.message ?? err));
      setBusy(false);
    }
  };

  return (
    <div class="screen-pad agent-editor">
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
          value={description}
          rows={3}
          maxLength={500}
          placeholder="Pipeline questions and renewal prep."
          onInput={(event) => setDescription((event.target as HTMLTextAreaElement).value)}
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

      {failure ? <p class="agent-failure">{failure}</p> : null}

      <div class="agent-actions">
        <button class="agent-save" type="button" disabled={!name.trim() || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : agent ? 'Save' : 'Create agent'}
        </button>
        <button class="agent-cancel" type="button" onClick={onClose}>Cancel</button>
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
