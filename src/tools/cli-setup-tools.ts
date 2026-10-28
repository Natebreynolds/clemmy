import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';
import type { SafeCliProbe } from '../runtime/cli-discovery.js';

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
 * Conversational contract: install or sign in when the request needs it
 * (local work, like the shell) → report the job id and watch it with
 * job_status. An interactive sign-in still needs the user.
 */

const ACTION = z.enum(['status', 'install', 'auth', 'remember', 'job_status', 'repairs', 'repair']);

export function registerCliSetupTools(server: McpServer): void {
  server.tool('cli_inspect',
    'Read CLI health, signed-in account and its public connection origin (instance URL / hostname), the commands the CLI itself lists (its own --help, optionally for one subcommand), available repairs, or a managed job. Does not start or repeat any operation.',
    { action: z.enum(['status', 'commands', 'repairs', 'job_status']), catalogId: z.string().max(60).optional(),
      subcommand: z.string().max(40).optional()
        .describe('commands only: one subcommand word to list its own options (for example "list" or "service").'),
      jobId: z.string().max(120).optional() },
    async ({ action, catalogId, subcommand, jobId }) => {
      if (action === 'status') return statusAction(catalogId);
      if (action === 'commands') return commandsAction(catalogId, subcommand);
      if (action === 'repairs') return repairsAction(catalogId);
      return jobStatusAction(jobId);
    });

  server.tool(
    'cli_setup',
    [
      'Install, remember or re-authenticate a local CLI for the user, via the approved local paths. Actions:',
      '- For read-only diagnostics prefer cli_inspect (status | commands | repairs | job_status).',
      '- status: auth/install state of catalogId, or the connected/saved roster when catalogId is omitted.',
      `- install: install a CLI. Pass catalogId (preferred — e.g. "railway", "github") OR a raw command, which must match the install allowlist (npm install -g / ${process.platform === 'win32' ? '' : 'brew install / '}uv tool install / pipx install / pip install --user / git clone https).`,
      '- remember: add an ALREADY installed CLI to Connect → Command-line tools without reinstalling it. Pass only command, a bare executable name (no paths, arguments or shell). This checks safe executable resolution and saves its name; authentication remains unverified and no command is executed.',
      '- auth: sign a catalog CLI in again. The conversation shows its managed process and private input controls. Browser and system credential prompts remain user-owned. Never ask for a password in chat or run login through run_shell_command.',
      '- job_status: check a previously started install/auth job by id.',
      '- repairs: the bounded fixes a CLI declares for its own local configuration (for example: it is authenticated but no default account/org/project is selected, so every command fails).',
      '- repair: run one of those declared fixes. Pass catalogId, repairId and values. The argv is fixed in the catalog; values are single plain arguments, never shell.',
      'Install, auth and repair are local work on this computer: run them when the request needs them, without asking first; status, job_status and repairs are read-only. Never report that you cannot fix a tool without first checking repairs.',
    ].join('\n'),
    {
      action: ACTION.describe('What to do: status | install | auth | remember | job_status | repairs | repair.'),
      catalogId: z.string().max(60).optional()
        .describe('Catalog CLI id for status/install/auth (e.g. "railway", "netlify", "github"). See status output for ids.'),
      command: z.string().max(300).optional()
        .describe('install: a raw allowed install command. remember: one bare name of an already installed executable, with no path or arguments.'),
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
        if (action === 'status') return await statusAction(catalogId);
        if (action === 'install') return await installAction(catalogId, command, saveAs);
        if (action === 'remember') {
          if ([catalogId, saveAs, jobId, repairId, values].some(value => value !== undefined && value !== null)) {
            return textResult('remember accepts only command, the bare name of an already installed CLI. No alias, install, authentication or repair was started.');
          }
          return await rememberInstalledCliAction(command);
        }
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

/** Save only a safely resolved executable name. Metadata resolution is enough
 * for roster membership; it is never authentication or working-tool proof. */
export async function rememberInstalledCliAction(command: string | undefined, dependencies?: {
  findSafeCliCommand: (command: string) => SafeCliProbe | null;
  addSavedCli: (command: string) => string[];
}): Promise<ReturnType<typeof textResult>> {
  if (typeof command !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._+-]{0,59}$/.test(command)) {
    return textResult('remember needs one bare CLI name (up to 60 letters, numbers, underscores, dots, pluses or hyphens, starting with a letter, number or underscore). Paths, options, spaces, control characters and shell commands are refused; nothing was saved.');
  }
  const findCommand = dependencies?.findSafeCliCommand ?? (await import('../runtime/cli-discovery.js')).findSafeCliCommand;
  const safe = findCommand(command);
  if (!safe || safe.skipped || !safe.path) {
    return textResult(`Cannot remember CLI "${command}": no safely resolved installed executable was found. Nothing was saved, installed or executed.`);
  }
  const remember = dependencies?.addSavedCli ?? (await import('../runtime/saved-clis.js')).addSavedCli;
  remember(command);
  return textResult(`Installed CLI "${command}" is remembered in Connect → Command-line tools. Authentication is unverified; no sign-in, version/help probe or CLI command was run.`);
}

async function statusAction(catalogId?: string): Promise<ReturnType<typeof textResult>> {
  const { getCliHealth, getRosterHealth, cliHealthStaleNote, resolveCliHealthId } = await import('../integrations/cli-catalog/auth-health.js');
  const { findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
  const requested = catalogId?.trim();
  if (catalogId !== undefined && !requested) return textResult('status catalogId must name a CLI; omit it to inspect the whole roster.');
  const id = requested ? resolveCliHealthId(requested) : undefined;
  if (requested && !id) return textResult(`Unknown or ambiguous CLI scope ${JSON.stringify(requested)}. Use a registered catalog id or saved CLI id; no installation or authentication check was performed.`);
  // Scope before probing, not after: filtering a roster sweep still executes
  // unrelated credential checks and pays their latency.
  const roster = id ? [await getCliHealth(id)] : await getRosterHealth();
  if (roster.length === 0) {
    return textResult('The user has no connected or saved CLIs yet. Search the catalog from Connect, or use cli_setup install with a catalogId.');
  }
  const lines = roster
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((h) => {
      const entry = findCatalogEntry(h.id);
      const state = !h.installed ? 'NOT INSTALLED'
        : h.issue === 'credential_store_unavailable' ? 'CREDENTIAL STORE UNAVAILABLE — the OS could not open saved credentials; this does not prove sign-out. Ask the user to resolve the system credential prompt; do not erase credentials or repeatedly start login.'
        : h.issue === 'configuration_required' ? 'CONFIGURATION REQUIRED — select an authenticated account with a declared repair; missing defaults do not prove sign-out.'
        : h.authStatus === 'ok' ? `signed in${h.username ? ` as ${h.username}` : ''}${cliHealthStaleNote(h) ? ` (${cliHealthStaleNote(h)})` : ''}`
        : h.authStatus === 'signed_out' ? 'SIGNED OUT'
        : h.authStatus === 'error' ? 'auth check failed'
        : 'installed (auth state unknown)';
      const fix = !h.installed && entry ? ` — install: cli_setup {"action":"install","catalogId":"${h.id}"}`
        : h.authStatus === 'signed_out' && entry ? ` — fix: cli_setup {"action":"auth","catalogId":"${h.id}"}`
        : '';
      const connection = h.authStatus === 'ok' && !h.staleSince && h.username && h.connectionOrigin
        ? `; connection origin for this account: ${h.connectionOrigin}` : '';
      const commands = h.installed && h.binaryPath
        ? ` — its commands: cli_inspect {"action":"commands","catalogId":"${h.id}"}` : '';
      return `${h.id} (${h.command}): ${state}${connection}${fix}${commands}`;
    });
  return textResult(`CLI roster (${roster.length}):\n${lines.join('\n')}`);
}

const COMMANDS_HELP_MAX_CHARS = 6_000;
const COMMANDS_HELP_TTL_MS = 24 * 60 * 60_000;
const commandsHelpCache = new Map<string, { at: number; text: string }>();

/**
 * What a connected CLI can do, in its own words. A model that knows only the
 * command it already tried keeps retrying it: live 2026-10-16 a signed-in
 * hosting CLI answered "no linked project" twice and the owner was asked to
 * link one, while the same CLI's own project listing needed no link at all.
 * Runs the verified executable's `--help` (or `<subcommand> --help`) with no
 * shell; help changes nothing.
 */
async function commandsAction(catalogId?: string, subcommand?: string): Promise<ReturnType<typeof textResult>> {
  const requested = catalogId?.trim();
  if (!requested) return textResult('commands needs a catalogId; cli_inspect status lists them.');
  const sub = subcommand?.trim();
  if (sub && !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,39}$/.test(sub)) {
    return textResult('subcommand must be one plain word (letters, digits, ":", "_" or "-").');
  }
  const { getCliHealth, resolveCliHealthId } = await import('../integrations/cli-catalog/auth-health.js');
  const id = resolveCliHealthId(requested);
  if (!id) return textResult(`Unknown or ambiguous CLI scope ${JSON.stringify(requested)}.`);
  const health = await getCliHealth(id);
  if (!health.installed || !health.binaryPath) {
    return textResult(`${id} is not installed with a verified executable, so its commands cannot be listed.`);
  }
  const argv = sub ? [sub, '--help'] : ['--help'];
  const key = `${health.binaryPath}\u0000${argv.join(' ')}`;
  const cached = commandsHelpCache.get(key);
  if (cached && Date.now() - cached.at < COMMANDS_HELP_TTL_MS) return textResult(cached.text);
  const { execFile } = await import('node:child_process');
  const output = await new Promise<string>((resolve) => {
    execFile(health.binaryPath!, argv, { timeout: 8_000, maxBuffer: 256 * 1024, windowsHide: true },
      (_error, stdout, stderr) => resolve(`${String(stdout ?? '')}${stderr ? `\n${String(stderr)}` : ''}`.trim()));
  });
  if (!output) return textResult(`\`${health.command} ${argv.join(' ')}\` printed nothing.`);
  const clipped = output.length > COMMANDS_HELP_MAX_CHARS
    ? `${output.slice(0, COMMANDS_HELP_MAX_CHARS)}\n[help clipped at ${COMMANDS_HELP_MAX_CHARS} characters; ask for one subcommand]`
    : output;
  const text = `\`${health.command} ${argv.join(' ')}\`:\n${clipped}`;
  commandsHelpCache.set(key, { at: Date.now(), text });
  return textResult(text);
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
    const { startCatalogInstall } = await import('../integrations/cli-catalog/platform-install.js');
    const started = await startCatalogInstall(entry);
    if (!started.ok) return textResult(`${started.reason} Official instructions: ${started.docsUrl}`);
    const job = started.job;
    return textResult([
      `Installing ${entry.name} (${started.command}) — job ${job.id}.`,
      `Check progress with cli_setup {"action":"job_status","jobId":"${job.id}"}.`,
      entry.authCommand ? `After install, sign in: ${(entry.authHeadless || process.platform === 'darwin' || process.platform === 'win32') ? `cli_setup {"action":"auth","catalogId":"${entry.id}"}` : `the user runs \`${entry.authCommand}\` in their terminal`}.` : '',
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
  if ((!entry.authHeadless && process.platform !== 'darwin') || !entry.authCommand) {
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
    `Sign-in job for ${entry.name}: ${job.status}. ${job.detail ?? ''}`,
    ...(job.sessionId ? ['Progress stays inside this conversation. While running, the user can inspect progress, enter interactive responses, or stop it in the CLI activity card. Browser/system credential prompts still belong to the user.'] : []),
    `Job ${job.id}; check with cli_setup {"action":"job_status","jobId":"${job.id}"}.`,
  ].join('\n'));
}

async function jobStatusAction(jobId: string | undefined): Promise<ReturnType<typeof textResult>> {
  if (!jobId?.trim()) return textResult('job_status needs the jobId returned by install/auth.');
  const id = jobId.trim();
  const { getManagedCliJob } = await import('../runtime/managed-cli-jobs.js');
  const { getInstallJob } = await import('../integrations/browser-harness.js');
  const job = getManagedCliJob(id) ?? getInstallJob(id);
  if (!job) return textResult(`No install/auth job found with id "${id}". Do not assume it failed or repeat it: inspect current CLI health first.`);
  const tail = (!('action' in job) || job.action !== 'auth') && job.output ? `\n--- output tail ---\n${job.output.slice(-1500)}` : '';
  return textResult(`${job.title}: ${job.status}${job.status !== 'running' && 'exitCode' in job ? ` (exit ${String(job.exitCode)})` : ''}${'detail' in job && job.detail ? `\n${job.detail}` : ''}${tail}`);
}

/** The declared repairs a CLI carries, or every CLI's when none is named. */
async function repairsAction(catalogId: string | undefined): Promise<ReturnType<typeof textResult>> {
  const { CLI_CATALOG } = await import('../integrations/cli-catalog/catalog.js');
  const { resolveCliHealthId } = await import('../integrations/cli-catalog/auth-health.js');
  const requested = catalogId?.trim();
  const wanted = requested ? resolveCliHealthId(requested) : undefined;
  if (catalogId !== undefined && !wanted) return textResult(`Unknown or ambiguous CLI scope ${JSON.stringify(requested)}. Use a registered catalog id or saved CLI id.`);
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
