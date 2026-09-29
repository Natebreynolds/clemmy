/**
 * Which project a conversation works in, as the composer's project chip
 * shows it.
 *
 * It follows the agent chip's rules exactly (lib/conversation-agent): the
 * chip can change at any time, the server learns of the choice just before
 * the next message goes out, and a reply still running keeps the project it
 * started in. The call is repeated before every message: it is a no-op when
 * nothing changed, and it keeps the chip true after another device moved the
 * same conversation.
 */
import { useCallback, useRef, useState } from 'react';
import { apiErrorCode, refusalText, setConversationProject, type ConversationProject } from './projects';

export interface ProjectAddressedMessage {
  /** A brand-new conversation opens inside this project. */
  projectId?: string;
  /** The project the message is sent into: its name, null for none. */
  projectName?: string | null;
}

export function useConversationProject(initial: ConversationProject | null, opts?: { onMoved?: () => void }) {
  const [chosen, setChosen] = useState<ConversationProject | null>(initial);
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const onMoved = opts?.onMoved;

  const choose = useCallback((project: ConversationProject | null) => {
    chosenRef.current = project;
    setChosen(project);
  }, []);

  /** Apply the choice to `sessionId` (null = the conversation is not created
   *  yet) and say which project the outgoing message is sent into. */
  const prepare = useCallback(async (sessionId: string | null, busy: boolean): Promise<ProjectAddressedMessage> => {
    if (busy) return {};
    const project = chosenRef.current;
    if (!sessionId) return project ? { projectId: project.id, projectName: project.name } : { projectName: null };
    try {
      const result = await setConversationProject(sessionId, project?.id ?? null);
      if (result.changed) onMoved?.();
      // The server's answer is where the reply actually works; the chip follows it.
      if ((result.projectId ?? null) !== (project?.id ?? null)) {
        setChosen(result.projectId ? { id: result.projectId, name: result.projectName ?? '' } : null);
      }
      return { projectName: result.projectName };
    } catch (error) {
      // A conversation that takes no project (a Space dock), or a service
      // that has no projects yet, still takes a plain message; only a real
      // choice it cannot honor stops the send.
      const status = (error as { status?: number }).status;
      if (!project && (status === 409 || status === 404)) return {};
      // The project was archived or removed since it was chosen: the chip
      // lets go of it, and the send stops so the message is not sent
      // somewhere the owner did not mean.
      const code = apiErrorCode(error);
      if (project && (code === 'PROJECT_NOT_FOUND' || code === 'PROJECT_ARCHIVED')) {
        chosenRef.current = null;
        setChosen(null);
        throw new Error(`${project.name} is ${code === 'PROJECT_ARCHIVED' ? 'archived' : 'no longer there'}, so this was not sent. Send it again to continue without a project.`);
      }
      throw new Error(refusalText(error, 'The project could not be applied, so this was not sent.'));
    }
  }, [onMoved]);

  return { chosen, choose, prepare };
}
