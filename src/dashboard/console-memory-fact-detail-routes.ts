import type { Express, Request } from 'express';
import { getFactWithEvidence } from '../memory/facts.js';
import { withScopeViews } from '../projects/memory-scope-views.js';

/** The owner's exact saved memory, including inactive and replaced records.
 * Reading a historical preference never follows its replacement or changes it. */
export function registerConsoleMemoryFactDetailRoutes(
  app: Express,
  deps: { isAuthorized: (req: Request) => boolean },
): void {
  app.get('/api/console/memory/facts/:id/detail', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const raw = String(req.params.id ?? '');
    const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ error: 'A valid memory ID is required.' }); return;
    }
    try {
      const retained = getFactWithEvidence(id);
      if (!retained) { res.status(404).json({ error: 'This saved memory was not found.' }); return; }
      const fact = withScopeViews([retained])[0];
      res.json({ fact });
    } catch {
      // Persistence diagnostics can contain paths or saved content. Keep those
      // out of an owner-facing error while allowing a simple retry.
      res.status(500).json({ error: 'This saved memory is temporarily unavailable.' });
    }
  });
}
