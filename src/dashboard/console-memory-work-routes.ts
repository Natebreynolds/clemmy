import type { Express, Request, Response } from 'express';
import { isMemoryWorkEventId, readMemoryWork, undoMemoryWork } from '../memory/memory-work-read.js';

/**
 * Memory at work for the desktop: what the background memory jobs are doing,
 * which model served them and what they kept, polled by the Memory tab. The
 * phone door (`/m/api/memory/work`) serves the same snapshot from the same
 * function. Undo turns off what one run learned, or brings back what it faded.
 */
export function registerConsoleMemoryWorkRoutes(
  app: Express,
  deps: { isAuthorized: (req: Request) => boolean },
): void {
  app.get('/api/console/memory/work', (req: Request, res: Response) => {
    if (!deps.isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(readMemoryWork());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/memory/work/:id/undo', (req: Request, res: Response) => {
    if (!deps.isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = String(req.params.id ?? '');
    if (!isMemoryWorkEventId(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      res.json(undoMemoryWork(id));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
