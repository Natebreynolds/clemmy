import type { Express, Request } from 'express';
import { renderConsoleHtml } from './console.js';
import { WEBHOOK_SECRET } from '../config.js';

/**
 * Mounts the new Console dashboard at /console.
 *
 * The existing /dashboard route in webhook.ts is left untouched —
 * Run Control Center keeps working. /console is the new parallel
 * surface with its own visual language, growing toward the goal of
 * "manage your agent, workflows, skills, and all local/external tools."
 *
 * Auth piggy-backs on the same isAuthorized check the rest of the
 * dashboard routes use. Future console-specific endpoints (workflow
 * studio chat, project picker actions, etc.) register here too.
 */
export function registerConsoleRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
): void {
  app.get('/console', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    res.type('html').send(renderConsoleHtml(queryToken));
  });

  // Reserved namespace for future console-specific endpoints. The
  // initial Activity Pulse panel reuses /api/dashboard and /api/runs,
  // both of which already exist on the main webhook server.
}
