import type { Express, Request } from 'express';
import {
  clemMcpConnection, connectOtherApp, disconnectOtherApp, otherAppState, otherApps,
} from '../integrations/other-apps-connect.js';

/** Other apps on this computer that can hand Clementine work, and the tap
 *  that adds her to one (or takes her out again). */
export function registerConsoleOtherAppsRoutes(app: Express, deps: { isAuthorized: (req: Request) => boolean }): void {
  app.get('/api/console/other-apps', (req, res) => {
    if (!deps.isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const connection = clemMcpConnection();
    res.json({
      available: Boolean(connection),
      // For any other MCP client: the same launch the taps below write.
      connection,
      apps: connection ? otherApps().map((other) => ({ id: other.id, name: other.name, state: otherAppState(other, connection), after: other.after })) : [],
    });
  });

  app.post('/api/console/other-apps/:id/:action', (req, res) => {
    if (!deps.isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const other = otherApps().find((candidate) => candidate.id === req.params.id);
    const action = req.params.action;
    if (!other || (action !== 'connect' && action !== 'disconnect')) { res.status(404).json({ error: 'unknown app or action' }); return; }
    const connection = clemMcpConnection();
    if (!connection) { res.status(409).json({ error: 'This build of Clementine cannot be launched by other apps.' }); return; }
    try {
      const done = action === 'connect' ? connectOtherApp(other, connection) : disconnectOtherApp(other);
      if (!done.ok) { res.status(409).json({ error: done.reason }); return; }
      res.json({ ok: true, state: otherAppState(other, connection), after: action === 'connect' ? other.after : null });
    } catch (error) {
      res.status(500).json({ error: `${other.name}'s settings could not be written: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
}
