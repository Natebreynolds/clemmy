/**
 * Share as a cartridge: the owner picks what to put in, gets one .clemplug
 * file back, and hands it to whoever installs it through the same
 * preview-and-consent door. Definitions travel; the owner's data and
 * secrets never do (plugin-export.ts says exactly what is left out).
 */
import type { Express, Request, Response } from 'express';
import { exportPlugin, readCartridgeFile, shareableInventory, type PluginExportRequest } from '../plugins/plugin-export.js';

export function registerPluginExportRoutes(app: Express, isAuthorized: (req: Request) => boolean): void {
  app.get('/api/console/plugins/export/inventory', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.json(shareableInventory()); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/api/console/plugins/export', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Partial<PluginExportRequest>;
    const request: PluginExportRequest = {
      id: typeof body.id === 'string' ? body.id.trim() : '',
      name: typeof body.name === 'string' ? body.name.trim() : '',
      ...(typeof body.version === 'string' ? { version: body.version } : {}),
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      workflows: Array.isArray(body.workflows) ? body.workflows : [],
      skills: Array.isArray(body.skills) ? body.skills : [],
      mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
      workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
    };
    try {
      const result = exportPlugin(request);
      res.status(201).json({ ...result, downloadPath: `/api/console/plugins/export/${encodeURIComponent(result.fileName)}` });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/api/console/plugins/export/:file', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const data = readCartridgeFile(String(req.params.file ?? ''));
    if (!data) { res.status(404).json({ error: 'no such cartridge' }); return; }
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${String(req.params.file)}"`);
    res.send(data);
  });
}
