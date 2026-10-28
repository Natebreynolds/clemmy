/** The pictures a tool saw, served to the chat that owns them. */
import type { Express, Request, Response } from 'express';
import { chatMediaFile } from '../runtime/chat-media.js';

export function registerChatMediaRoutes(app: Express, isAuthorized: (req: Request) => boolean): void {
  app.get('/api/console/chat-media/:sessionId/:id', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const file = chatMediaFile(String(req.params.sessionId ?? ''), String(req.params.id ?? ''));
    if (!file) { res.status(404).json({ error: 'not found' }); return; }
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file);
  });
}
