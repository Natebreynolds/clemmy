import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Chat } from './screens/Chat';
import { ChatScreen } from './features/conversations/ChatScreen';
import { ConversationThread } from './features/conversations/chat/ConversationThread';
import { Inbox } from './screens/Inbox';
import { BackgroundTasks } from './screens/BackgroundTasks';
import { Goals } from './screens/Goals';
import { Automate } from './screens/Automate';
import { Connect } from './screens/Connect';
import { Memory } from './screens/Memory';
import { Meetings } from './screens/Meetings';
import { Workspaces } from './screens/Workspaces';
import { WorkspaceView } from './screens/WorkspaceView';
import { Agents } from './screens/Agents';
import { Advanced } from './screens/Advanced';
import { Settings } from './screens/Settings';
import { Help } from './screens/Help';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/console">
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/chat" replace />} />

            <Route path="/chat" element={<ChatScreen />}>
              <Route index element={<Chat />} />
              <Route path=":sessionId" element={<ConversationThread />} />
            </Route>
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/tasks" element={<BackgroundTasks />} />
            <Route path="/goals" element={<Goals />} />
            <Route path="/automate" element={<Automate />} />
            <Route path="/connect" element={<Connect />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/meetings" element={<Meetings />} />
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="/workspaces/:id" element={<WorkspaceView />} />
            <Route path="/agents" element={<Agents />} />

            <Route path="/advanced" element={<Navigate to="/advanced/usage" replace />} />
            <Route path="/advanced/usage" element={<Advanced />} />
            <Route path="/advanced/tools" element={<Advanced />} />
            <Route path="/advanced/diagnostics" element={<Advanced />} />
            <Route path="/advanced/budgets" element={<Advanced />} />
            <Route path="/advanced/autonomy" element={<Advanced />} />
            <Route path="/advanced/evolution" element={<Advanced />} />
            <Route path="/advanced/developer" element={<Advanced />} />

            <Route path="/settings" element={<Settings />} />
            <Route path="/help" element={<Help />} />

            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
