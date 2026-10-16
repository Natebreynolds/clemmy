import { workflowConversationSlugFromSessionId } from '@clem/chat-engine';
import { getChatSession, isMissingChatSessionRoot } from './api';

/** Stable scoped roots are created on the first message. An unavailable
 * transcript is never a new conversation: only an actual 404 is empty. */
export async function loadMobileChatHistory(sessionId: string): Promise<Awaited<ReturnType<typeof getChatSession>> | null> {
  try {
    return await getChatSession(sessionId);
  } catch (error) {
    if (isMissingChatSessionRoot(error, sessionId)
      && (sessionId.startsWith('space-') || workflowConversationSlugFromSessionId(sessionId) !== null)) return null;
    throw error;
  }
}
