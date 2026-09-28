import type { RequestHandler, Router } from 'express';
import { listManagedCliJobs, sendManagedCliInput, cancelManagedCliJob } from './managed-cli-jobs.js';

/** Same authenticated user controls on desktop and device-proof mobile. These
 * routes operate existing sessions only; no endpoint accepts a shell command. */
export function registerCliSessionRoutes(router: Pick<Router, 'get' | 'post'>, guard: RequestHandler, prefix: string): void {
  router.get(`${prefix}/cli-sessions`, guard, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    if (!sessionId) { res.status(400).json({ error: 'Conversation required.' }); return; }
    res.json({ jobs: listManagedCliJobs(sessionId) });
  });
  router.post(`${prefix}/cli-sessions/:id/input`, guard, (req, res) => {
    const { sessionId, input } = req.body ?? {};
    if (typeof sessionId !== 'string' || typeof input !== 'string'
      || !sendManagedCliInput(String(req.params.id), sessionId, input)) {
      res.status(409).json({ error: 'This process cannot accept input. Refresh its status.' }); return;
    }
    res.json({ accepted: true });
  });
  router.post(`${prefix}/cli-sessions/:id/cancel`, guard, (req, res) => {
    const sessionId = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !cancelManagedCliJob(String(req.params.id), sessionId)) {
      res.status(409).json({ error: 'This process is no longer running here. Refresh its status.' }); return;
    }
    res.json({ cancelled: true });
  });
}
