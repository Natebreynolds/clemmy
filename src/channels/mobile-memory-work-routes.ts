import type { RequestHandler, Router } from 'express';
import { isMemoryWorkEventId, readMemoryWork, undoMemoryWork } from '../memory/memory-work-read.js';

/**
 * Memory at work for the phone: the same snapshot and undo the desktop's
 * `/api/console/memory/work` serves, behind the phone's session check.
 * Router-relative paths (the router is mounted at `/m`).
 */
export function registerMobileMemoryWorkRoutes(
  router: Router,
  requireMobileSession: RequestHandler,
): void {
  router.get('/api/memory/work', requireMobileSession, (_req, res) => {
    try {
      res.json(readMemoryWork());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/memory/work/:id/undo', requireMobileSession, (req, res) => {
    const id = String(req.params.id ?? '');
    if (!isMemoryWorkEventId(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      res.json(undoMemoryWork(id));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
