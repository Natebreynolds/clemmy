/**
 * /home lands on the briefing. There used to be two homes — this screen and
 * the chat's empty state — rendering the same panes from the same data. The
 * briefing at /chat now honors the Home layout (pane order, hidden panes,
 * quick actions), so this route only redirects; the Customize sheet still
 * edits the one record both used to read.
 */
import { Navigate } from 'react-router-dom';

export function Home() {
  return <Navigate to="/chat" replace state={{ newChat: Date.now() }} />;
}
