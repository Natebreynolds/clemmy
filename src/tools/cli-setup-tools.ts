import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';

/**
 * `cli_setup` — chat-side install + re-auth for the user's CLI roster.
 *
 * Closes the dead-end where the model could DETECT a missing or
 * signed-out CLI (check_capability, stderr annotations, workflow
 * readiness) but had no sanctioned path to fix it beyond pasting a brew
 * command into run_shell_command. Every effect routes through the same
 * validated runners the Connect screen uses:
 *   - installs: validateInstallCommand → startApprovedInstallCommand
 *     (allowlist: npm -g / brew / uv tool / pipx / pip --user /
 *     git clone https — no sudo, no metacharacters)
 *   - auth: startCatalogAuthJob for verified-headless catalog entries;
 *     interactive logins open the user's Terminal with the login already
 *     running (terminal-handoff.ts) — the daemon itself NEVER spawns
 *     them (its runner has no TTY; they would hang).
 *
 * Conversational contract: offer → one approval → execute → report the
 * job id and watch it with job_status.
 */

const ACTION = z.enum(['status', 'install', 'auth', 'job_status', 'repairs', 'repair']);

export function registerCliSetupTools(server: McpServer): void {
  server.tool(
    'cli_setup',
    [
      'Install or re-authenticate a local CLI for the user, via the approved runners. Actions:',
      '- status: auth/install state of every CLI the user has connected or saved (their roster).',
      '- install: install a CLI. Pass catalogId (preferred — e.g. "railway", "github") OR a raw command, which must match the install allowlist (npm install -g / brew install / uv tool install / pipx install / pip install --user / git clone https).',
      '- auth: sign a catalog CLI in again. Browser-based flows run as a background job; interactive logins open the user\'s Terminal with the login already running (tell them to finish the prompts there). Never run a login through run_shell_command yourself.',
      '- job_status: check a previously started install/auth job by id.',
      '- repairs: the bounded fixes a CLI declares for its own local configuration (for example: it is authenticated but no default account/org/project is selected, so every command fails).',
      '- repair: run one of those declared fixes. Pass catalogId, repairId and values. The argv is fixed in the catalog; values are single plain arguments, never shell.',
      'Ask the user before install/auth (one approval covers the whole fix); status, job_status and repairs are read-only. Run a repair when the user agrees to it — never report that you cannot fix a tool without first checking repairs.',
    ].join('\n'),
    {
      action: ACTION.describe('What to do: status | install | auth | job_status.'),
      catalogId: z.string().max(60).optional()
        .describe('Catalog CLI id for install/auth (e.g. "railway", "netlify", "github"). See status output for ids.'),
      command: z.string().max(300).optional()
        .describe('install only: a raw install command when the CLI is not in the catalog. Validated against the allowlist server-side.'),
      saveAs: z.string().max(60).optional()
        .describe('install with a raw command: bare binary name to remember on the user\'s roster after success.'),
      jobId: z.string().max(120).optional()
        .describe('job_status only: the id returned by install/auth.'),
      repairId: z.string().max(120).optional()
        .describe('repair only: the declared repair id, exactly as the repairs action reports it.'),
      values: z.record(z.string(), z.string().max(200)).optional()
        .describe('repair only: one plain value per declared argument, for example {"org":"user@example.com"}.'),
    },
    async ({ action, catalogId, command, saveAs, jobId, repairId, values }) => {
      try {
        if (action === 'status') return await statusAction();
        if (action === 'install') return await installAction(catalogId, command, saveAs);
        if (action === 'auth') return await authAction(catalogId);
        if (action === 'repairs') return await repairsAction(catalogId);
        if (action === 'repair') {
          const plain: Record<string, string> = {};
          for (const [key, value] of Object.entries(values ?? {})) plain[key] = String(value);
          return await repairAction(catalogId, repairId, plain);
        }
        return await jobStatusAction(jobId);
      } catch (err) {
        return textResult(`cli_setup ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

async function statusAction(): Promise<ReturnType<typeof textResult>> {
  const { getRosterHealth, cliHealthStaleNote } = await import('../integrations/cli-catalog/auth-health.js');
  const { findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
  const roster = await getRosterHealth();
  if (roster.length === 0) {
    return textResult('The user has no connected or saved CLIs yet. Search the catalog from Connect, or use cli_setup install with a catalogId.');
  }
  const lines = roster
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((h) => {
      const entry = findCatalogEntry(h.id);
      const state = !h.installed ? 'NOT INSTALLED'
        : h.authStatus === 'ok' ? `signed in${h.username ? ` as ${h.username}` : ''}${cliHealthStaleNote(h) ? ` (${cliHealthStaleNote(h)})` : ''}`
        : h.authStatus === 'signed_out' ? 'SIGNED OUT'
        : h.authStatus === 'error' ? 'auth check failed'
        : 'installed (auth state unknown)';
      const fix = !h.installed && entry ? ` — install: cli_setup {"action":"install","catalogId":"${h.id}"}`
        : h.authStatus === 'signed_out' && entry ? ` — fix: cli_setup {"action":"auth","catalogId":"${h.id}"}`
        : '';
      return `${h.id} (${h.command}): ${state}${fix}`;
    });
  return textResult(`CLI roster (${roster.length}):\n${lines.join('\n')}`);
}

async function installAction(
  catalogId: string | undefined,
  command: string | undefined,
  saveAs: string | undefined,
): Promise<ReturnType<typeof textResult>> {
  const { validateInstallCommand, startApprovedInstallCommand } = await import('../integrations/browser-harness.js');
  if (catalogId) {
    const { findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
    const entry = findCatalogEntry(catalogId.trim());
    if (!entry) return textResult(`Unknown catalog CLI "${catalogId}". Use cli_setup status for known ids, or pass a raw install command.`);
    const job = startApprovedInstallCommand(entry.installCommand, `Install ${entry.name}`, { cliCatalogId: entry.id });
    return textResult([
      `Installing ${entry.name} (${entry.installCommand}) — job ${job.id}.`,
      `Check progress with cli_setup {"action":"job_status","jobId":"${job.id}"}.`,
      entry.authCommand ? `After install, sign in: ${entry.authHeadless ? `cli_setup {"action":"auth","catalogId":"${entry.id}"}` : `the user runs \`${entry.authCommand}\` in their terminal`}.` : '',
    ].filter(Boolean).join('\n'));
  }
  if (!command?.trim()) return textResult('install needs a catalogId or a raw install command.');
  const verdict = validateInstallCommand(command.trim());
  if (!verdict.ok) return textResult(`That install command was refused: ${verdict.error}`);
  if (saveAs && !/^[A-Za-z0-9._+-]{1,60}$/.test(saveAs.trim())) {
    return textResult('saveAs must be a bare CLI name (letters, numbers, . _ + -).');
  }
  const job = startApprovedInstallCommand(
    verdict.normalized,
    `Install via ${verdict.normalized.split(/\s+/)[0]}`,
    saveAs?.trim() ? { savedCli: saveAs.trim() } : undefined,
  );
  return textResult(`Install started — job ${job.id}. Check progress with cli_setup {"action":"job_status","jobId":"${job.id}"}.`);
}

async function authAction(catalogId: string | undefined): Promise<ReturnType<typeof textResult>> {
  if (!catalogId?.trim()) return textResult('auth needs a catalogId (see cli_setup status).');
  const { findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
  const entry = findCatalogEntry(catalogId.trim());
  if (!entry) return textResult(`Unknown catalog CLI "${catalogId}". Use cli_setup status for known ids.`);
  if (!entry.authHeadless || !entry.authCommand) {
    // Interactive login — the daemon's job runner has no TTY, so we hand
    // the flow to a REAL Terminal window the user owns: open it with the
    // login already running, then watch the auth probe for the flip.
    const { openTerminalAuthSession } = await import('../runtime/terminal-handoff.js');
    const handoff = await openTerminalAuthSession(entry.id);
    if (handoff.ok) {
      return textResult([
        `${handoff.message}`,
        `Tell the user: a Terminal window just opened running \`${handoff.command}\` — finish the prompts there.`,
        'You will see parked work resume automatically once the sign-in lands; no need to poll.',
      ].join('\n'));
    }
    return textResult([
      `${entry.name} needs an interactive sign-in that only the user can complete, and the Terminal hand-off was not available: ${handoff.message}`,
      `Docs: ${entry.authDocsUrl}`,
      'They can also do this from Connect → Command-line tools.',
    ].join('\n'));
  }
  const { startCatalogAuthJob } = await import('../runtime/managed-cli-jobs.js');
  const job = await startCatalogAuthJob(entry.id);
  return textResult([
    `Sign-in started for ${entry.name} — a browser window should open on the user's machine; they finish there.`,
    `Job ${job.id}; check with cli_setup {"action":"job_status","jobId":"${job.id}"}.`,
  ].join('\n'));
}

async function jobStatusAction(jobId: string | undefined): Promise<ReturnType<typeof textResult>> {
  if (!jobId?.trim()) return textResult('job_status needs the jobId returned by install/auth.');
  const id = jobId.trim();
  const { getManagedCliJob } = await import('../runtime/managed-cli-jobs.js');
  const { getInstallJob } = await import('../integrations/browser-harness.js');
  const job = getManagedCliJob(id) ?? getInstallJob(id);
  if (!job) return textResult(`No install/auth job found with id "${id}" (jobs do not survive a daemon restart — start a fresh one if needed).`);
  const tail = job.output ? `\n--- output tail ---\n${job.output.slice(-1500)}` : '';
  return textResult(`${job.title}: ${job.status}${job.status !== 'running' && 'exitCode' in job ? ` (exit ${String(job.exitCode)})` : ''}${tail}`);
}

/** The declared repairs a CLI carries, or every CLI's when none is named. */
async function repairsAction(catalogId: string | undefined): Promise<ReturnType<typeof textResult>> {
  const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');
  const wanted = catalogId?.trim().toLowerCase();
  const entries = CLI_CATALOG.filter((entry) => (entry.repairs?.length ?? 0) > 0
    && (!wanted || entry.id === wanted));
  if (entries.length === 0) {
    return textResult(wanted
      ? `"${wanted}" declares no repairs. Its own status read (if it has one) still tells you what is wrong.`
      : 'No catalog CLI declares a repair yet.');
  }
  const lines = entries.flatMap((entry) => (entry.repairs ?? []).map((repair) => [
    `- ${entry.id} · ${repair.id} — ${repair.title}`,
    `  ${repair.description}`,
    `  values: ${repair.arguments.map((argument) => `${argument.name}${argument.required ? '' : ' (optional)'} — ${argument.description}`).join('; ') || 'none'}`,
    repair.diagnosis ? `  check first with: ${repair.diagnosis}` : '',
  ].filter(Boolean).join('\n')));
  return textResult([
    'Declared CLI repairs (bounded argv fixed in the catalog):',
    ...lines,
    'Run one with cli_setup {action:"repair", catalogId, repairId, values}.',
  ].join('\n'));
}

/** Run one declared repair. The catalog owns the argv; this only substitutes
 *  named values and spawns the resolved executable directly — never a shell. */
async function repairAction(
  catalogId: string | undefined,
  repairId: string | undefined,
  values: Record<string, string>,
): Promise<ReturnType<typeof textResult>> {
  const { declaredCliRepair, resolveDeclaredCliRepairArgv } = await import('../integrations/cli-catalog/catalog.js');
  const declared = declaredCliRepair(catalogId, repairId);
  if (!declared) {
    return textResult(`No declared repair "${repairId ?? ''}" for CLI "${catalogId ?? ''}". Call cli_setup {action:"repairs"} for the exact ids.`);
  }
  const argv = resolveDeclaredCliRepairArgv(declared.repair, values);
  if (!argv.ok) return textResult(`${declared.repair.id} was not run — ${argv.error}`);
  const { findSafeCliCommand } = await import('../runtime/cli-discovery.js');
  const safe = findSafeCliCommand(declared.entry.command);
  if (!safe || safe.skipped || !safe.path) {
    return textResult(`${declared.entry.command} is not installed on this machine, so ${declared.repair.id} cannot run. Install it first with cli_setup {action:"install"}.`);
  }
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout, stderr } = await run(safe.path, argv.argv, {
      timeout: declared.repair.limits.timeoutMs,
      maxBuffer: declared.repair.limits.maxStdoutBytes + declared.repair.limits.maxStderrBytes,
      windowsHide: true,
    });
    const output = [stdout, stderr].map((part) => part.trim()).filter(Boolean).join('\n').slice(0, declared.repair.limits.maxStdoutBytes);
    return textResult([
      `${declared.repair.title} — done: ${declared.entry.command} ${argv.argv.join(' ')}`,
      output || '(the command printed nothing, which this CLI does on success)',
      declared.repair.diagnosis ? `Confirm it with ${declared.repair.diagnosis}.` : '',
    ].filter(Boolean).join('\n'));
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const detail = [failure.stdout, failure.stderr, failure.message]
      .map((part) => (part ?? '').trim()).filter(Boolean).join('\n').slice(0, declared.repair.limits.maxStderrBytes);
    return textResult(`${declared.repair.title} failed: ${declared.entry.command} ${argv.argv.join(' ')}\n${detail}`);
  }
}
