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
import { textResult } from './shared.js';

export function registerBrowserHarnessTools(server: McpServer): void {
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
        ].join('\n\n'));
      }
      if (action === 'doctor') {
        const result = await runBrowserHarnessDoctor();
        return textResult(`ok: ${result.ok}\n\n${result.output || '(no output)'}`);
      }
      if (action === 'chrome_debugging') {
        const result = await openChromeRemoteDebuggingSetup();
        return textResult([
          `ok: ${result.ok}`,
          'Chrome remote debugging is the one step only the user can complete.',
          'Ask them to enable it on the page that just opened, then retry the browse.',
          result.output || '',
        ].filter(Boolean).join('\n\n'));
      }

      // install — start the job and WAIT for it. A tool that returns "started"
      // and leaves the model to guess when it finished is how a setup step
      // becomes a stall; the caller wants a usable browser, not a job id.
      const job = startBrowserHarnessInstall();
      const deadline = Date.now() + (timeout_ms ?? 300_000);
      for (;;) {
        const current = getInstallJob(job.id);
        if (!current) return textResult('The install job disappeared before it finished. Run browser_harness_status and try again.');
        if (current.status !== 'running') {
          const status = await getBrowserHarnessStatus();
          return textResult([
            `install: ${current.status} (exit ${current.exitCode ?? 'unknown'})`,
            `installed: ${status.installed} · version: ${status.version ?? 'unknown'}`,
            browserHarnessNextAction(status) ?? 'Browser Harness is ready.',
            current.output.slice(-4000) || '(no output)',
          ].join('\n\n'));
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
      'List the browser playbooks already learned for a site — the steps that WORKED on a previous verified run.',
      'Call this before browser_harness_run on any site you have visited before. Re-deriving navigation that is already recorded is the most common way a browse burns turns.',
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
      'This is the memory that makes browsing reliable: the harness reads these playbooks itself on the next visit, so recorded steps are reused instead of re-derived.',
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
        ? `Saved playbook for ${site} — ${task}\n${result.path}\nThe harness will load this automatically on the next visit to ${site}.`
        : `Could not save the playbook: ${result.error}`);
    },
  );


  server.tool(
    'browser_harness_status',
    [
      'Check Browser Harness availability and setup state.',
      'Use this before browser automation. If missing, tell the user to install it from Console -> Integrations -> Browser Harness.',
    ].join(' '),
    {},
    async () => {
      const status = await getBrowserHarnessStatus();
      const next = browserHarnessNextAction(status);
      // A status that reports a problem without the action that fixes it is
      // how "browsing is broken" became a user errand. Lead with the fix.
      return textResult([
        next ? `NEXT: ${next}` : 'Browser Harness is ready.',
        JSON.stringify(status, null, 2),
      ].join('\n\n'));
    },
  );

  server.tool(
    'browser_harness_run',
    [
      'Run a Browser Harness Python snippet against the user browser through the browser-harness CLI.',
      'This is for web browsing, web app testing, screenshots, scraping, uploads, downloads, and real-browser interactions.',
      'Call browser_harness_status first. Prefer new_tab(url) for first navigation so you do not overwrite the user active tab.',
      'FIRST: call browser_skill_list for this site. A playbook from a previous verified run tells you the exact steps that already worked — start there instead of re-deriving navigation.',
      'For the full API, read the `browser-harness` skill (skill_read) rather than guessing helper names; it documents the helpers plus per-mechanic guides for dialogs, iframes, shadow DOM, uploads, downloads, and scrolling.',
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
