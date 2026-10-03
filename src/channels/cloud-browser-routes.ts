import type { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { BrowserbaseServiceError, getBrowserbaseService } from '../integrations/browserbase.js';
import { getSession } from '../runtime/harness/eventlog.js';

const conversation = z.string().min(1).max(256);
const resourceId = z.string().min(1).max(128);
const version = z.number().int().min(0);
const owned = { conversationId: conversation, expectedVersion: version };

/** Both first-party surfaces supply their existing auth + device-proof guard.
 * Credentials and live URLs are never appended to events or provider errors.
 * This API controls a browser resource; it cannot invent completion or resume
 * execution authority for an old task. */
export function registerCloudBrowserRoutes(
  router: Pick<Router, 'get' | 'post'>, guard: RequestHandler, prefix: string,
  dependencies: { service?: ReturnType<typeof getBrowserbaseService>; hasConversation?: (id: string) => boolean } = {},
): void {
  const service = () => dependencies.service ?? getBrowserbaseService();
  const hasConversation = dependencies.hasConversation ?? (id => Boolean(getSession(id)));
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
  const bound = (req: Request, schema: z.ZodType, query = false) => {
    const value = schema.parse(query ? req.query : req.body);
    if (value && typeof value === 'object' && 'conversationId' in value
      && !hasConversation(String(value.conversationId))) throw new Error('missing_conversation');
    if (req.params.id) resourceId.parse(req.params.id);
    return value;
  };
  const handler = (run: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res) => {
    try { await run(req, res); }
    catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ error: 'Check the browser request and try again.', code: 'invalid_request' }); return; }
      if (error instanceof BrowserbaseServiceError) {
        // Only the adapter's sanitized class may cross; never serialize raw
        // HTTP bodies, API keys, websocket endpoints or stack traces.
        res.status(error.effect === 'uncertain' ? 503 : 409).json({ error: error.message, code: error.code, effect: error.effect });
        return;
      }
      res.status(404).json({ error: 'This browser is unavailable in this conversation. Refresh its status.', code: 'browser_unavailable' });
    }
  };
  const path = `${prefix}/cloud-browser`;
  router.get(`${path}/status`, guard, noStore, handler(async (_req, res) => { res.json(await service().status()); }));
  router.post(`${path}/configuration`, guard, noStore, handler(async (req, res) => {
    const input = z.strictObject({ apiKey: z.string().min(1).max(4096).optional(), projectId: z.string().min(1).max(128),
      idleSeconds: z.number().int().min(60).max(21600).optional(), sessionTimeoutSeconds: z.number().int().min(60).max(21600).optional() }).parse(req.body);
    res.json(await service().configure(input));
  }));
  router.get(`${path}/resources`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ conversationId: conversation }), true) as { conversationId: string };
    res.json({ resources: await service().list(input.conversationId) });
  }));
  router.post(`${path}/resources`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ conversationId: conversation, requestId: z.string().min(1).max(128), recording: z.boolean().optional() })) as { conversationId: string; requestId: string; recording?: boolean };
    res.json({ resource: await service().create(input) });
  }));
  router.get(`${path}/resources/:id`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ conversationId: conversation }), true) as { conversationId: string };
    res.json({ resource: await service().get(String(req.params.id), input.conversationId) });
  }));
  router.post(`${path}/resources/:id/view`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ ...owned, viewerLeaseId: z.uuid(), targetId: z.string().min(1).max(128).optional() })) as { conversationId: string; expectedVersion: number; viewerLeaseId: string; targetId?: string };
    res.json(await service().view(String(req.params.id), input.conversationId, input));
  }));
  router.post(`${path}/resources/:id/recover`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ ...owned, providerSessionId: z.uuid() })) as { conversationId: string; expectedVersion: number; providerSessionId: string };
    res.json({ resource: await service().resolveUnknownCreate(String(req.params.id), input.conversationId, input) });
  }));
  router.post(`${path}/resources/:id/detach`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ conversationId: conversation, viewerLeaseId: z.uuid() })) as { conversationId: string; viewerLeaseId: string };
    res.json({ resource: await service().detach(String(req.params.id), input.conversationId, input) });
  }));
  router.post(`${path}/resources/:id/control`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ ...owned, controller: z.enum(['human', 'agent']) })) as { conversationId: string; expectedVersion: number; controller: 'human' | 'agent' };
    res.json({ resource: await service().control(String(req.params.id), input.conversationId, input) });
  }));
  router.post(`${path}/resources/:id/input`, guard, noStore, handler(async (req, res) => {
    const input = bound(req, z.strictObject({ ...owned, viewerLeaseId: z.uuid(), targetId: z.string().min(1).max(128), text: z.string().min(1).max(4096).optional(),
      key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']).optional() })
      .refine(v => (v.text !== undefined) !== (v.key !== undefined))) as { conversationId: string; expectedVersion: number; viewerLeaseId: string; targetId: string; text?: string; key?: string };
    res.json(await service().humanInput(String(req.params.id), input.conversationId, input));
  }));
  for (const action of ['stop', 'touch'] as const) {
    router.post(`${path}/resources/:id/${action}`, guard, noStore, handler(async (req, res) => {
      const input = bound(req, z.strictObject(owned)) as { conversationId: string; expectedVersion: number };
      res.json({ resource: await service()[action](String(req.params.id), input.conversationId, input) });
    }));
  }
}
