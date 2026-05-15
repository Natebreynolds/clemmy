import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getBrowserHarnessStatus,
  runBrowserHarnessScript,
} from '../integrations/browser-harness.js';
import { textResult } from './shared.js';

export function registerBrowserHarnessTools(server: McpServer): void {
  server.tool(
    'browser_harness_status',
    [
      'Check Browser Harness availability and setup state.',
      'Use this before browser automation. If missing, tell the user to install it from Console -> Integrations -> Browser Harness.',
    ].join(' '),
    {},
    async () => {
      const status = await getBrowserHarnessStatus();
      return textResult(JSON.stringify(status, null, 2));
    },
  );

  server.tool(
    'browser_harness_run',
    [
      'Run a Browser Harness Python snippet against the user browser through the browser-harness CLI.',
      'This is for web browsing, web app testing, screenshots, scraping, uploads, downloads, and real-browser interactions.',
      'Call browser_harness_status first. Prefer new_tab(url) for first navigation so you do not overwrite the user active tab.',
      'Useful helpers include new_tab, wait_for_load, page_info, capture_screenshot, click_at_xy, js, cdp, ensure_real_tab, and restart_daemon.',
      'Requires approval because it can interact with websites as the user.',
    ].join(' '),
    {
      code: z.string().min(1).max(12000).describe('Python code passed to browser-harness stdin. Helpers are pre-imported by browser-harness.'),
      timeout_ms: z.number().min(2000).max(120000).optional().describe('Execution timeout. Default 30000ms.'),
      bu_name: z.string().min(1).max(80).optional().describe('Optional BU_NAME namespace for an isolated daemon/session.'),
    },
    async ({ code, timeout_ms, bu_name }) => {
      const result = await runBrowserHarnessScript(code, { timeoutMs: timeout_ms, buName: bu_name });
      return textResult([
        `ok: ${result.ok}`,
        `exit_code: ${result.code ?? 'unknown'}`,
        result.output || '(no output)',
      ].join('\n\n'));
    },
  );
}
