/**
 * "What Clem can see": the owner's watches, what each found and learned, and
 * the two things the owner tells a watch (how its items reach them, and rules
 * in their own words). Pausing, resuming and running a watch use the ordinary
 * workflow routes; a watch is a workflow.
 */
import type { Express, Request, Response } from 'express';
import { addHeartbeatRule, removeHeartbeatRule, setHeartbeatNotify } from '../agents/heartbeat-contracts.js';
import { listWatchViews, watchIdFor } from '../agents/watches.js';

type IsAuthorized = (req: Request) => boolean;

const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,199}$/;

async function knownWatch(slug: string): Promise<boolean> {
  return SLUG.test(slug) && (await listWatchViews()).some((view) => view.slug === slug);
}

export function registerWatchRoutes(app: Express, isAuthorized: IsAuthorized): void {
  app.get('/api/console/watches', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ watches: await listWatchViews() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/console/watches/:slug/notify', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = String(req.params.slug ?? '');
    const mode = req.body?.mode;
    if (mode !== 'quiet' && mode !== 'push') { res.status(400).json({ error: 'mode must be quiet or push' }); return; }
    if (!(await knownWatch(slug))) { res.status(404).json({ error: 'no such watch' }); return; }
    const contract = setHeartbeatNotify(watchIdFor(slug), mode);
    res.json({ notify: contract.notify });
  });

  app.post('/api/console/watches/:slug/rules', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = String(req.params.slug ?? '');
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!(await knownWatch(slug))) { res.status(404).json({ error: 'no such watch' }); return; }
    const result = addHeartbeatRule(watchIdFor(slug), text, 'owner');
    if (!result.ok) {
      const words = {
        empty: 'Write the rule in a few words.',
        too_long: 'That rule is too long. Say it in a sentence or two.',
        too_many: 'This watch has as many rules as it can hold. Remove one first.',
        duplicate: 'This watch already has that rule.',
      } as const;
      res.status(400).json({ error: words[result.reason] });
      return;
    }
    res.json({ rules: result.contract.rules.map((rule) => ({ id: rule.id, text: rule.text })) });
  });

  app.delete('/api/console/watches/:slug/rules/:ruleId', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = String(req.params.slug ?? '');
    if (!(await knownWatch(slug))) { res.status(404).json({ error: 'no such watch' }); return; }
    const contract = removeHeartbeatRule(watchIdFor(slug), String(req.params.ruleId ?? ''));
    if (!contract) { res.status(404).json({ error: 'no such rule' }); return; }
    res.json({ rules: contract.rules.map((rule) => ({ id: rule.id, text: rule.text })) });
  });
}
