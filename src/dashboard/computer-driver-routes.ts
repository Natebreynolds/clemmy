/**
 * Connect → Your computer: turn the driver on (download into Clem's tools,
 * connect, start her private daemon), open the system's permission pages,
 * and reconnect, from the console. Every call here is the owner's own setup
 * move on their own machine; the driver's actions in apps come later,
 * through Clem's tool contract, never through these routes.
 */
import { execFile } from 'node:child_process';
import type { Express, Request, Response } from 'express';
import { clearAutonomyAgentCache } from '../agents/autonomy-v2.js';
import { getInstallJob, startAsyncInstallJob } from '../integrations/browser-harness.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  COMPUTER_DRIVER_DOWNLOAD, askDriver, computerDriverEnv, computerDriverPath, computerDriverServer, computerDriverSocketPath, computerDriverStatus, lastActedWindow, realComputerDriverPath, startComputerDriverHost,
} from '../integrations/computer-driver.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import { installToolDownload } from '../runtime/clem-tools.js';
import { discoverMcpServers, loadUserMcpServers, saveUserMcpServers } from '../runtime/mcp-config.js';
import { invalidateConfiguredMcpServers } from '../runtime/mcp-servers.js';

const PERMISSION_PAGES = [
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
];

/** Register the driver as Clem's server and keep her daemon for it alive. */
async function connectComputerDriver(binary: string): Promise<void> {
  const current = loadUserMcpServers();
  const server = computerDriverServer(binary);
  saveUserMcpServers({ ...current, [server.name]: server });
  await invalidateConfiguredMcpServers();
  clearAutonomyAgentCache();
  startComputerDriverHost({ binary, servers: discoverMcpServers() });
}

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
      const job = startAsyncInstallJob({
        title: 'Turn on your computer for Clem',
        command: 'download cua-driver',
        metadata: { capability: 'computer-driver' },
        run: async (log) => {
          const result = await installToolDownload({ id: 'cua-driver', recipe: COMPUTER_DRIVER_DOWNLOAD, log });
          await connectComputerDriver(result.links[0]);
          log('Connected to Clem. If macOS asks whether Clementine may control this computer or record the screen, allow it.');
        },
      });
      res.json({ job });
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
    if (process.platform !== 'darwin') { res.status(501).json({ error: 'Permission settings do not open from Clem on this computer.' }); return; }
    if (!computerDriverPath()) { res.status(409).json({ error: 'Your computer is not turned on for Clem yet.' }); return; }
    // The grants belong to the desktop app; the system's own pages are where
    // the owner gives them. Nothing is granted from here.
    if (process.platform === 'darwin') {
      for (const page of PERMISSION_PAGES) {
        await new Promise<void>((resolve) => execFile('open', [page], () => resolve()));
      }
    }
    res.json({ output: 'Find Clementine in Accessibility and in Screen & System Audio Recording and switch it on.', status: await computerDriverStatus(discoverMcpServers()) });
  });
  // What the screen looks like now, through the driver's own capture: the
  // chat's live view of the computer. A read; nothing on the screen changes.
  // Asked over the driver's own command line on Clem's private socket, since
  // the model's tool path needs a turn to settle against and this is not one.
  app.get('/api/console/computer-driver/screen', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const status = await computerDriverStatus(discoverMcpServers());
    if (!status.screenViewAvailable || !status.path) { res.status(409).json({ error: 'The computer view is not available. Check the computer connection in Apps & devices.' }); return; }
    const file = path.join(os.tmpdir(), `clem-screen-${process.pid}-${Date.now()}.png`);
    // The chat's view follows the window Clem last acted in, since the
    // driver works in windows behind the owner's; the whole display otherwise.
    const session = typeof req.query.session === 'string' ? req.query.session.slice(0, 120) : '';
    let target: { pid: number; windowId: number } | null = null;
    if (session) { try { target = lastActedWindow(listEvents(session, { types: ['tool_called', 'tool_returned'] })); } catch { target = null; } }
    const call = target
      // The view wants the picture, not the accessibility tree: the smallest
      // read the driver allows answers in about a second instead of twenty.
      ? ['call', 'get_window_state', JSON.stringify({ pid: target.pid, window_id: target.windowId, max_elements: 1, timeout_ms: 500 }), '--socket', computerDriverSocketPath(), '--screenshot-out-file', file]
      : ['call', 'get_desktop_state', '--socket', computerDriverSocketPath(), '--screenshot-out-file', file];
    try {
      // A window capture answers in a few seconds; the whole display takes the
      // driver longer (measured 20 to 30 s on a Retina display).
      let answer = await askDriver(realComputerDriverPath(status.path), call, target ? 20_000 : 45_000, computerDriverEnv());
      if (target && !existsSync(file)) {
        // The window is gone; fall back to the display rather than show nothing.
        answer = await askDriver(realComputerDriverPath(status.path), ['call', 'get_desktop_state', '--socket', computerDriverSocketPath(), '--screenshot-out-file', file], 45_000, computerDriverEnv());
      }
      if (!existsSync(file)) {
        const said = (answer ?? '').trim().slice(0, 300);
        res.status(503).json({ error: said ? `The driver answered without a picture: ${said}` : 'The driver did not answer in time. If macOS has not allowed Screen Recording for Clementine yet, allow it in System Settings.' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.type('png').send(readFileSync(file));
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      rmSync(file, { force: true });
    }
  });
  app.post('/api/console/computer-driver/connect', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const binary = computerDriverPath();
    if (!binary) { res.status(409).json({ error: 'Your computer is not turned on for Clem yet.' }); return; }
    try {
      await connectComputerDriver(binary);
      res.status(201).json({ status: await computerDriverStatus(discoverMcpServers()) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
