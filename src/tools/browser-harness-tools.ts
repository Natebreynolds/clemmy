import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  getBrowserHarnessStatus,
  runBrowserHarnessScript,
  writeBrowserDomainSkill,
  listBrowserDomainSkills,
  startBrowserHarnessInstall,
  getInstallJob,
  runBrowserHarnessDoctor,
  runBrowserHarnessUpdate,
  openChromeRemoteDebuggingSetup,
  browserHarnessNextAction,
} from '../integrations/browser-harness.js';
import { textResult, nonWriteTextResult } from './shared.js';
import { currentToolAbortSignal } from '../runtime/tool-abort-context.js';
import { BROWSER_OPERATION_PARAMETERS } from './browser-operation-contract.js';
import { executeBrowserOperation, browserOperationProvesNoMutation } from '../integrations/browser-operation.js';

export function registerBrowserHarnessTools(server: McpServer): void {
  const descriptions = {
    browser_tabs: 'List pages in the user\'s local Chrome, with exact browser_id and target_id handles. The adapter checks the connection; no preliminary status or skill call is needed.',
    browser_open: 'Open one new blank browser tab (about:blank) in the user\'s local Chrome and return its exact browser_id and target_id. Keeps existing tabs intact. To visit a website, then use browser_navigate with this handle. No preliminary status or skill call is needed.',
    browser_read: 'Read bounded visible text, title and URL using the exact browser_id and target_id returned by browser_open or browser_tabs. Uses a fixed observation, no caller JavaScript; refuses a changed browser identity. No preliminary status or skill call is needed.',
    browser_navigate: 'Navigate the exact browser_id and target_id to an http(s) URL without embedded credentials. Returns requested and observed URLs and a receipt; refuses a changed browser identity. Does not submit forms, click buttons, send messages or execute caller scripts. No preliminary status or skill call is needed.',
  };
  for (const name of Object.keys(BROWSER_OPERATION_PARAMETERS) as Array<keyof typeof BROWSER_OPERATION_PARAMETERS>) {
    server.tool(name, descriptions[name], BROWSER_OPERATION_PARAMETERS[name], async (args: Record<string, unknown>) => {
      const result = await executeBrowserOperation(name, args, { signal: currentToolAbortSignal() });
      if (browserOperationProvesNoMutation(result)) return nonWriteTextResult('browser_not_dispatched', JSON.stringify(result));
      return textResult(JSON.stringify(result), { isError: result.ok !== true });
    });
  }
  server.tool(
    'browser_harness_setup',
    [
      'Install, update, or repair Browser Harness so browsing actually works — instead of telling the user to go and click in Settings.',
      'Call this when browser_harness_status reports a problem: not installed, an outdated version, or Chrome remote debugging not enabled.',
      'action=update upgrades in place using the harness own updater, which also restarts the daemon — this is the fix when output says "update available".',
      'action=install installs from scratch (it also pulls, but update is the right action for an existing install).',
      'action=doctor runs the harness self-check and reports what it finds.',
      'action=chrome_debugging opens the page where the user enables Chrome remote debugging — the one step that genuinely needs them.',
      'Requires approval: install runs a shell command that writes to the user machine.',
    ].join(' '),
    {
      action: z.enum(['install', 'update', 'doctor', 'chrome_debugging']).describe('install = install/update/repair; doctor = self-check; chrome_debugging = open the Chrome setup page.'),
      timeout_ms: z.number().min(10000).max(600000).optional().describe('How long to wait for an install. Default 300000 (5 min) — a cold install compiles Python deps.'),
    },
    async ({ action, timeout_ms }) => {
      if (action === 'update') {
        const result = await runBrowserHarnessUpdate();
        const status = await getBrowserHarnessStatus();
        return textResult([
          `ok: ${result.ok} · version now: ${status.version ?? 'unknown'}`,
          result.output || '(no output)',
        ].join('\n\n'), { isError: !result.ok });
      }
      if (action === 'doctor') {
        const result = await runBrowserHarnessDoctor();
        return textResult(`ok: ${result.ok}\n\n${result.output || '(no output)'}`, { isError: !result.ok });
      }
      if (action === 'chrome_debugging') {
        const result = await openChromeRemoteDebuggingSetup();
        return textResult([
          `ok: ${result.ok}`,
          'Chrome remote debugging is the one step only the user can complete.',
          'Ask them to enable it on the page that just opened, then retry the browse.',
          result.output || '',
        ].filter(Boolean).join('\n\n'), { isError: !result.ok });
      }

      // install — start the job and WAIT for it. A tool that returns "started"
      // and leaves the model to guess when it finished is how a setup step
      // becomes a stall; the caller wants a usable browser, not a job id.
      const job = startBrowserHarnessInstall();
      const deadline = Date.now() + (timeout_ms ?? 300_000);
      for (;;) {
        const current = getInstallJob(job.id);
        if (!current) return textResult('The install job disappeared before it finished. Run browser_harness_status and try again.', { isError: true });
        if (current.status !== 'running') {
          const status = await getBrowserHarnessStatus();
          return textResult([
            `install: ${current.status} (exit ${current.exitCode ?? 'unknown'})`,
            `installed: ${status.installed} · version: ${status.version ?? 'unknown'}`,
            browserHarnessNextAction(status) ?? 'Browser Harness is installed; connection must be observed by a typed browser operation.',
            current.output.slice(-4000) || '(no output)',
          ].join('\n\n'), { isError: current.status !== 'succeeded' });
        }
        if (Date.now() > deadline) {
          return textResult([
            'The install is still running past the timeout. It was NOT cancelled — check browser_harness_status shortly.',
            current.output.slice(-2000) || '(no output yet)',
          ].join('\n\n'));
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    },
  );


  server.tool(
    'browser_skill_list',
    [
      'List proposed browser playbooks saved for a site. Paths are lookup handles; read a relevant file explicitly if the task needs its guidance.',
      'A saved playbook is not a verified execution receipt and does not grant browser authority. Typed navigation and page reading need no playbook lookup.',
      'Omit `site` to see everything learned so far.',
    ].join(' '),
    {
      site: z.string().max(200).optional().describe('Host or URL, e.g. "amazon.com" or "https://app.example.com/reports".'),
    },
    async ({ site }) => {
      const skills = listBrowserDomainSkills(site);
      if (!skills.length) {
        return textResult(site
          ? `No playbook learned for ${site} yet. Do the task, then record it with browser_skill_write so the next run starts from it.`
          : 'No browser playbooks learned yet.');
      }
      return textResult(skills.map((s) => `${s.site} — ${s.task}\n  ${s.path}`).join('\n'));
    },
  );

  server.tool(
    'browser_skill_write',
    [
      'Record HOW to do a specific task on a specific site, after you actually did it successfully.',
      'This stores a proposed playbook for later explicit lookup; saving it does not attest a successful run or grant browser authority.',
      'Write it only from steps you VERIFIED worked in this session — a playbook of guesses is worse than none, because it will be trusted next time.',
      'Include the exact navigation (prefer direct URLs), the selectors or coordinates that worked, anything that did NOT work and why, and how to tell the task succeeded.',
    ].join(' '),
    {
      site: z.string().min(1).max(200).describe('Host or URL the playbook is for, e.g. "app.example.com".'),
      task: z.string().min(1).max(80).describe('Short task slug, e.g. "export-monthly-report".'),
      markdown: z.string().min(1).max(40000).describe('The playbook in markdown. Python snippets in fenced blocks, as in the shipped domain skills.'),
    },
    async ({ site, task, markdown }) => {
      const result = writeBrowserDomainSkill({ site, task, markdown });
      return textResult(result.ok
        ? `Saved proposed playbook for ${site} — ${task}\n${result.path}\nRead this file explicitly when relevant; it is not automatically loaded or a verified execution receipt.`
        : `Could not save the playbook: ${result.error}`, { isError: !result.ok });
    },
  );


  server.tool(
    'browser_harness_status',
    [
      'Check Browser Harness availability and setup state.',
      'Reports installation and a separate connection state. Typed browser_tabs/open/read/navigate check their connection themselves; do not repeat status before every operation. Use browser_harness_setup for an actual setup problem.',
    ].join(' '),
    {},
    async () => {
      const status = await getBrowserHarnessStatus();
      const next = browserHarnessNextAction(status);
      // A status that reports a problem without the action that fixes it is
      // how "browsing is broken" became a user errand. Lead with the fix.
      return textResult([
        next ? `NEXT: ${next}` : 'Browser Harness is installed. Browser connection readiness is reported separately.',
        JSON.stringify(status, null, 2),
      ].join('\n\n'));
    },
  );

  server.tool(
    'browser_harness_run',
    [
      'Run an arbitrary Browser Harness Python snippet against the user browser through the browser-harness CLI. This opaque execution is not a declared typed planning operation; use browser_open, browser_tabs, browser_navigate and browser_read for supported navigation/observation.',
      'This is for web browsing, web app testing, screenshots, scraping, uploads, downloads, and real-browser interactions.',
      'Call browser_harness_status first. Prefer new_tab(url) for first navigation so you do not overwrite the user active tab.',
      'For site-specific tasks, browser_skill_list can find proposed playbooks; read a relevant file explicitly and check its instructions against current page evidence.',
      'For the full API, read the `browser-harness` skill (skill_read) rather than guessing helper names; it documents the helpers plus per-mechanic guides for dialogs, iframes, shadow DOM, uploads, downloads, and scrolling.',
      'Useful helpers include new_tab, wait_for_load, page_info, capture_screenshot, click_at_xy, js, cdp, ensure_real_tab, and restart_daemon.',
      'Requires approval because it can interact with websites as the user.',
    ].join(' '),
    {
      code: z.string().min(1).max(12000).describe('Python code passed to browser-harness stdin. Helpers are pre-imported by browser-harness.'),
      timeout_ms: z.number().min(2000).max(120000).optional().describe('Execution timeout. Default 30000ms.'),
      bu_name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe('Optional BU_NAME namespace for a separate daemon/session; it does not create a separate local browser profile.'),
    },
    async ({ code, timeout_ms, bu_name }) => {
      const result = await runBrowserHarnessScript(code, { timeoutMs: timeout_ms, buName: bu_name });
      return textResult([
        `ok: ${result.ok}`,
        `exit_code: ${result.code ?? 'unknown'}`,
        result.output || '(no output)',
      ].join('\n\n'), { isError: !result.ok });
    },
  );
}
