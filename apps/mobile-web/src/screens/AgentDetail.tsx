/**
 * One agent: what it handles, how it is told to work, where it is assigned
 * and what it owns right now.
 *
 * The agent's own record is the one the list already read; its assignments
 * and tasks are one more read, the same view the desktop shows. Instructions
 * and skills are read here and changed in the editor, so this screen can be
 * looked at without any risk of changing the agent by accident.
 */
import { useState } from 'preact/hooks';
import type { AgentAssignments } from '@clem/chat-engine';
import type { MobileAgent } from '../lib/api';
import { ChatBackButton } from '../components/ChatBackButton';
import { DelegatedTaskList } from '../components/DelegatedTaskCard';
import { ScreenNotice } from '../components/ScreenNotice';
import { haptic } from '../lib/native-bridge';
import { getAgentWork } from '../lib/project-api';
import { inWords } from '../lib/project-words';
import { useScreenData } from '../lib/use-screen-data';

interface Props {
  agent: MobileAgent;
  onBack: () => void;
  onMessage: (agent: MobileAgent) => void;
  onEdit: (agent: MobileAgent) => void;
  onOpenProject?: (projectId: string) => void;
  onOpenRun?: (runSessionId: string) => void;
  onOpenNeedsYou?: () => void;
}

/** Instructions longer than this open on a tap instead of filling the screen. */
const INSTRUCTIONS_SHOWN = 420;
const OUTCOMES_SHOWN = 3;

export function AgentDetail({ agent, onBack, onMessage, onEdit, onOpenProject, onOpenRun, onOpenNeedsYou }: Props) {
  const { data, loading, error, offline, refresh } = useScreenData<AgentAssignments>(
    async () => {
      try {
        return (await getAgentWork(agent.id)).work;
      } catch (err) {
        throw inWords(err, 'Could not load what this agent is working on.');
      }
    },
    { intervalMs: 10_000, resourceKey: `agent:${agent.id}` },
  );
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [outcomesOpen, setOutcomesOpen] = useState(false);

  const instructions = agent.instructions.trim();
  const long = instructions.length > INSTRUCTIONS_SHOWN;
  const shownInstructions = long && !instructionsOpen ? `${instructions.slice(0, INSTRUCTIONS_SHOWN).trimEnd()}…` : instructions;
  const leansOn = [...agent.skills, ...agent.workflows];

  return (
    <div class="workflow-detail project-detail">
      <div class="chat-header">
        <ChatBackButton onClick={onBack} />
        <h2 class="chat-title">{agent.name}</h2>
        <button type="button" class="btn-quiet" onClick={() => { haptic('light'); onEdit(agent); }}>Edit</button>
      </div>

      <div class="project-sections">
        <section class="project-about" aria-label="What this agent handles">
          <p class={`project-purpose${agent.handles ? '' : ' is-empty'}`}>
            {agent.handles || 'Nothing written yet about what this agent handles.'}
          </p>
          <button type="button" class="home-btn home-btn-primary agent-message" onClick={() => { haptic('light'); onMessage(agent); }}>
            Message {agent.name}
          </button>
        </section>

        <section aria-labelledby="agent-instructions">
          <h2 id="agent-instructions" class="section-head">Instructions</h2>
          {instructions ? (
            <>
              <p class="project-context">{shownInstructions}</p>
              {long ? (
                <button type="button" class="link-btn" aria-expanded={instructionsOpen} onClick={() => setInstructionsOpen(!instructionsOpen)}>
                  {instructionsOpen ? 'Show less' : 'Show all'}
                </button>
              ) : null}
            </>
          ) : <p class="section-empty">No standing instructions. It works the way Clem does.</p>}
          {leansOn.length > 0 ? (
            <>
              <h3 class="project-sub">Reaches for first</h3>
              <div class="agent-pins agent-pins-read">
                {agent.skills.map((skill) => <span key={`s-${skill}`}>{skill}</span>)}
                {agent.workflows.map((workflow) => <span key={`w-${workflow}`}>{workflow}</span>)}
              </div>
            </>
          ) : null}
        </section>

        <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={Boolean(data)} />
        {loading && !data ? <div class="skeleton-stack" aria-hidden="true"><i /><i /></div> : null}

        {data ? (
          <>
            <section aria-labelledby="agent-projects">
              <h2 id="agent-projects" class="section-head">Projects</h2>
              {data.projects.length === 0 ? (
                <p class="section-empty">Not assigned to a project. Assign it from a project's screen.</p>
              ) : (
                <div class="home-card">
                  {data.projects.map((row) => {
                    const body = (
                      <>
                        <span class="project-line-text">
                          <span class="project-line-title">{row.projectName}</span>
                          <span class="project-line-sub">
                            {[
                              row.responsibility || 'Nothing written about what it answers for there',
                              row.activeTasks > 0 ? `${row.activeTasks} active` : '',
                            ].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        {onOpenProject ? (
                          <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        ) : null}
                      </>
                    );
                    return onOpenProject ? (
                      <button
                        key={row.projectId}
                        type="button"
                        class="home-row home-row-tap project-line"
                        onClick={() => { haptic('light'); onOpenProject(row.projectId); }}
                      >
                        {body}
                      </button>
                    ) : <div key={row.projectId} class="home-row project-line">{body}</div>;
                  })}
                </div>
              )}
            </section>

            <section aria-labelledby="agent-work">
              <h2 id="agent-work" class="section-head">Current tasks</h2>
              <DelegatedTaskList
                tasks={data.currentTasks}
                known={[...data.currentTasks, ...data.recentOutcomes]}
                empty="It owns no work right now."
                hideOwner
                onChanged={() => void refresh()}
                onOpenRun={onOpenRun}
                onOpenNeedsYou={onOpenNeedsYou}
              />
            </section>

            {data.recentOutcomes.length > 0 ? (
              <section aria-labelledby="agent-outcomes">
                <h2 id="agent-outcomes" class="section-head">Recent outcomes</h2>
                <DelegatedTaskList
                  tasks={outcomesOpen ? data.recentOutcomes : data.recentOutcomes.slice(0, OUTCOMES_SHOWN)}
                  known={[...data.currentTasks, ...data.recentOutcomes]}
                  hideOwner
                  onChanged={() => void refresh()}
                  onOpenRun={onOpenRun}
                />
                {data.recentOutcomes.length > OUTCOMES_SHOWN ? (
                  <button type="button" class="link-btn" aria-expanded={outcomesOpen} onClick={() => setOutcomesOpen(!outcomesOpen)}>
                    {outcomesOpen ? 'Show fewer' : `Show ${data.recentOutcomes.length - OUTCOMES_SHOWN} more`}
                  </button>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
