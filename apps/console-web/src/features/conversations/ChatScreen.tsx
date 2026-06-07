import { Outlet } from 'react-router-dom';
import { ConversationSidebar } from './list/ConversationSidebar';

/**
 * Layout for the Chat experience: the conversation rail (always visible)
 * beside the active conversation. The index route renders the new-chat hero
 * (the existing <Chat/> screen); /chat/:sessionId renders a reopened
 * conversation. Both flow through the <Outlet/>.
 */
export function ChatScreen() {
  return (
    <div className="flex h-full min-h-0 animate-fade-in">
      <ConversationSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  );
}
