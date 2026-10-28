/**
 * Connect → Your computer: install Cua Driver, grant it its permissions, and
 * register it as Clem's MCP server, from the console. Every call here is the
 * owner's own setup move on their own machine; the driver's actions in apps
 * come later, through Clem's tool contract, never through these routes.
 */
import type { Express, Request, Response } from 'express';
import { clearAutonomyAgentCache } from '../agents/autonomy-v2.js';
import { getInstallJob, startRecipeInstallJob } from '../integrations/browser-harness.js';
import {
  COMPUTER_DRIVER_INSTALL_NEEDS, COMPUTER_DRIVER_INSTALL_COMMAND, askDriver, computerDriverPath, computerDriverServer, computerDriverStatus,
} from '../integrations/computer-driver.js';
import { discoverMcpServers, loadUserMcpServers, saveUserMcpServers } from '../runtime/mcp-config.js';
import { invalidateConfiguredMcpServers } from '../runtime/mcp-servers.js';

export function registerComputerDriverRoutes(app: Express, isAuthorized: (req: Request) => boolean): void {
  app.get('/api/console/computer-driver', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await computerDriverStatus(discoverMcpServers()));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post('/api/console/computer-driver/install', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json({ job: startRecipeInstallJob({ title: 'Install Cua Driver', command: COMPUTER_DRIVER_INSTALL_COMMAND, needs: COMPUTER_DRIVER_INSTALL_NEEDS, metadata: { capability: 'computer-driver' } }) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get('/api/console/computer-driver/install/:id', (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const job = getInstallJob(String(req.params.id ?? ''));
    if (!job) { res.status(404).json({ error: 'install job not found' }); return; }
    res.json({ job });
  });
  app.post('/api/console/computer-driver/permissions', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const binary = computerDriverPath();
    if (!binary) { res.status(409).json({ error: 'Cua Driver is not installed yet.' }); return; }
    // Opens the system's own permission prompts; nothing is granted from here.
    const output = await askDriver(binary, ['permissions', 'grant'], 60_000);
    res.json({ output: output ?? '', status: await computerDriverStatus(discoverMcpServers()) });
  });
  app.post('/api/console/computer-driver/connect', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const binary = computerDriverPath();
    if (!binary) { res.status(409).json({ error: 'Cua Driver is not installed yet.' }); return; }
    try {
      const current = loadUserMcpServers();
      const server = computerDriverServer(binary);
      saveUserMcpServers({ ...current, [server.name]: server });
      await invalidateConfiguredMcpServers();
      clearAutonomyAgentCache();
      res.status(201).json({ status: await computerDriverStatus(discoverMcpServers()) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
