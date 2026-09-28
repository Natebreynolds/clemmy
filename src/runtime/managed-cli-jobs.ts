import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { BASE_DIR } from '../config.js';
import { mergedSpawnEnv } from './spawn-env.js';
import { redactSensitiveText, isSecretLikeKey } from './security.js';
import { getToolOutputContext } from './harness/tool-output-context.js';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { invalidateCachedScan as invalidateCliScan, findSafeCliCommand } from './cli-discovery.js';

export type ManagedCliKind = 'composio' | 'github';
export type ManagedCliAction = 'install' | 'auth' | 'repair';
export type ManagedCliJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface ManagedCliJob {
  id: string;
  /** Legacy managed kind ('composio' | 'github') or a catalog id for
   *  catalog-driven auth jobs — both poll through the same jobs map. */
  kind: string;
  action: ManagedCliAction;
  title: string;
  command: string;
  status: ManagedCliJobStatus;
  output: string;
  startedAt: string;
  sessionId?: string;
  sourceUserSeq?: number;
  interactive?: boolean;
  detail?: string;
  completedAt?: string;
  exitCode?: number | null;
}

const jobs = new Map<string, ManagedCliJob>();
const processes = new Map<string, ChildProcess>();
const privateInputs = new Map<string, string[]>();
const jobDirectory = path.join(BASE_DIR, 'state', 'cli-jobs');
const bootId = randomUUID();
let spawnCli = spawn;
export function _testOnly_setCliSpawn(value?: typeof spawn): void { spawnCli = value ?? spawn; }
let resolveCli = findSafeCliCommand;
export function _testOnly_setCliResolver(value?: typeof findSafeCliCommand): void { resolveCli = value ?? findSafeCliCommand; }

/** Catalog login recipes are one executable and literal argv, never shell
 * programs. Templates require a dedicated secure flow rather than substitution
 * of a secret into a shell string or a process argument. */
function authProcess(command: string): { executable: string; argv: string[] } {
  const words = command.trim().split(/\s+/);
  if (!words.every(word => /^[A-Za-z0-9_./:=@+-]+$/.test(word))) {
    throw new Error('This CLI login recipe requires a dedicated secure setup flow; no command was started.');
  }
  const resolved = resolveCli(words[0]!);
  if (!resolved || resolved.skipped || !resolved.path) throw new Error('The configured CLI executable is unavailable.');
  return { executable: resolved.path, argv: words.slice(1) };
}

function persistJob(job: ManagedCliJob): void {
  mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(jobDirectory, `${job.id}.json`);
  // Interactive/auth bytes may contain device codes or user-entered secrets.
  // They are UI-only, process-local, and never part of a durable transcript.
  const record = { ...job, output: '', bootId };
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, file);
}

function persistUpdate(job: ManagedCliJob): void {
  try { persistJob(job); } catch {
    job.status = 'interrupted';
    job.detail = 'The process receipt could not be saved. Check its effects before retrying.';
  }
}

function stopProcess(child: ChildProcess, interactive = false): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    // Expect owns a separate child PTY group and handles TERM by stopping it.
    try { process.kill(-child.pid, interactive ? 'SIGTERM' : 'SIGKILL'); } catch { /* already exited */ }
  }
}

/** A fixed Expect adapter owns the PTY without a Node/Electron native ABI.
 * The catalog executable and argv are positional data, never Tcl source.
 * No terminal output or input is written to this helper file. */
const PTY_ADAPTER = `log_user 0
set timeout -1
fconfigure stdin -blocking 0 -buffering line
spawn -noecho -nottycopy -nottyinit {*}$argv
set child $spawn_id
proc stop_child {} {
  global child
  catch {exec /bin/kill -KILL [format "-%d" [exp_pid -i $child]]}
  catch {close -i $child}
  exit 125
}
trap stop_child {SIGTERM SIGHUP}
fileevent stdin readable {
  if {[gets stdin line] >= 0} {
    send -i $child -- "$line\\r"
  } elseif {[eof stdin]} {
    stop_child
  }
}
expect {
  -re {.+} { puts -nonewline stdout $expect_out(buffer); flush stdout; exp_continue }
  eof {
    set result [wait -i $child]
    if {[lindex $result 2] != 0 || [llength $result] > 4} { exit 125 }
    exit [lindex $result 3]
  }
}
`;

function interactiveAdapter(): string {
  const file = path.join(jobDirectory, `pty-${createHash('sha256').update(PTY_ADAPTER).digest('hex')}.exp`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, PTY_ADAPTER, { mode: 0o600 });
  renameSync(temporary, file);
  return file;
}

/**
 * Auth flows open a browser and wait on a callback; a flow that
 * unexpectedly prompts for TTY input instead would hang the zsh child
 * forever (stdin is ignored). The hard timeout is the safety net that
 * turns a mis-flagged `authHeadless` entry into a visible failed job
 * rather than a zombie process.
 */
const AUTH_JOB_TIMEOUT_MS = 5 * 60_000;

function truncate(text: string): string {
  return text.length > 40_000 ? text.slice(text.length - 40_000) : text;
}

function commandFor(kind: ManagedCliKind, action: ManagedCliAction): { title: string; command: string; args: string[] } {
  if (kind === 'composio') {
    if (action === 'install') {
      return {
        title: 'Install Composio CLI',
        command: 'curl -fsSL https://composio.dev/install | bash',
        args: ['-lc', 'curl -fsSL https://composio.dev/install | bash'],
      };
    }
    return {
      title: action === 'repair' ? 'Repair Composio CLI auth' : 'Composio CLI login',
      command: 'composio login',
      args: ['-lc', 'composio login'],
    };
  }

  if (action === 'install') {
    return {
      title: 'Install GitHub CLI',
      command: 'brew install gh',
      args: ['-lc', 'brew install gh'],
    };
  }
  if (action === 'repair') {
    return {
      title: 'Repair GitHub CLI auth',
      command: 'gh auth refresh -h github.com -s repo -s read:org -s workflow',
      args: ['-lc', 'gh auth refresh -h github.com -s repo -s read:org -s workflow'],
    };
  }
  return {
    title: 'GitHub CLI login',
    command: 'gh auth login -h github.com --web -s repo -s read:org -s workflow',
    args: ['-lc', 'gh auth login -h github.com --web -s repo -s read:org -s workflow'],
  };
}

interface RunJobSpec {
  kind: string;
  action: ManagedCliAction;
  title: string;
  command: string;
  args: string[];
  timeoutMs?: number;
  interactive?: boolean;
  executable?: string;
  argv?: string[];
  onSuccess?: () => Promise<boolean>;
}

function runJob(spec: RunJobSpec): ManagedCliJob {
  const owner = getToolOutputContext();
  if (spec.interactive && (!owner?.sessionId || !owner.sourceUserSeq || !owner.callId)) {
    throw new Error('Interactive sign-in needs an accepted conversation request. Start it from chat so its input and Stop controls stay with you.');
  }
  const id = owner?.sessionId && owner.sourceUserSeq && owner.callId
    ? `cli-${createHash('sha256').update(JSON.stringify([owner.sessionId, owner.sourceUserSeq, owner.callId, spec.kind, spec.action, spec.command])).digest('hex')}`
    : `cli-${randomUUID()}`;
  const existing = getManagedCliJob(id);
  if (existing) return existing; // a replay observes; it never repeats the process
  if (spec.interactive && process.platform !== 'darwin') throw new Error('Interactive CLI sessions are not supported on this host.');
  const job: ManagedCliJob = { id, kind: spec.kind, action: spec.action, title: spec.title,
    command: spec.command, status: 'running', output: '', startedAt: new Date().toISOString(),
    ...(owner?.sessionId ? { sessionId: owner.sessionId, sourceUserSeq: owner.sourceUserSeq } : {}),
    ...(spec.interactive ? { interactive: true } : {}),
    detail: spec.action === 'auth' ? 'Complete the sign-in prompt. Connection verification follows.' : 'Running on your connected computer.',
  };
  persistJob(job); // durable identity before any physical dispatch
  jobs.set(id, job);
  const win32 = process.platform === 'win32';
  const command = spec.interactive ? '/usr/bin/expect' : spec.executable ?? (win32 ? (process.env.ComSpec || 'cmd.exe') : '/bin/zsh');
  const env = Object.fromEntries(Object.entries(mergedSpawnEnv()).filter(([key]) => !isSecretLikeKey(key)
    && !['BASH_ENV', 'ENV', 'ZDOTDIR'].includes(key)));
  let child: ChildProcess;
  try {
    const args = spec.interactive ? ['-f', interactiveAdapter(), spec.executable!, ...(spec.argv ?? [])]
      : spec.executable ? spec.argv ?? [] : win32 ? ['/d', '/s', '/c', spec.args.at(-1) ?? ''] : spec.args;
    child = spawnCli(command, args, { cwd: BASE_DIR, env,
      detached: !win32, stdio: [spec.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  } catch (error) {
    job.status = 'failed'; job.detail = redactSensitiveText(String(error));
    job.completedAt = new Date().toISOString(); persistUpdate(job); return job;
  }
  processes.set(id, child);
  const timer = setTimeout(() => {
    if (job.status !== 'running') return;
    job.status = 'interrupted';
    job.detail = 'The process exceeded its time limit. Check the connection before trying again; effects may already have occurred.';
    persistUpdate(job);
    stopProcess(child, spec.interactive);
  }, spec.timeoutMs ?? AUTH_JOB_TIMEOUT_MS);
  timer.unref();
  let rawOutput = '';
  const append = (chunk: string) => {
    let next = rawOutput + chunk;
    for (const secret of privateInputs.get(id) ?? []) next = next.split(secret).join('[private input]');
    // Redact before truncating so the retained window cannot start halfway
    // through a previously echoed private response.
    rawOutput = truncate(next);
    let safe = rawOutput;
    for (const secret of privateInputs.get(id) ?? []) {
      // A CLI may echo input across arbitrary chunks. Hold partial trailing
      // matches so polling cannot reveal a prefix before the next chunk arrives.
      for (let length = Math.min(secret.length - 1, safe.length); length > 0; length -= 1) {
        if (safe.endsWith(secret.slice(0, length))) { safe = safe.slice(0, -length); break; }
      }
    }
    job.output = redactSensitiveText(safe);
  };
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream?.on('data', (chunk: Buffer) => append(decoder.write(chunk)));
    stream?.on('end', () => append(decoder.end()));
  }
  child.on('error', error => {
    clearTimeout(timer); processes.delete(id);
    job.status = 'failed'; job.detail = redactSensitiveText(error.message); job.completedAt = new Date().toISOString();
    persistUpdate(job);
  });
  child.on('close', async (code, signal) => {
    clearTimeout(timer); processes.delete(id);
    privateInputs.delete(id); rawOutput = '';
    job.exitCode = code; job.completedAt = new Date().toISOString();
    if (job.status !== 'running') { persistUpdate(job); return; }
    if (code !== 0 || signal) {
      job.status = 'failed'; job.detail = `Process ended${signal ? ` (${signal})` : ` with exit ${code}`}. No successful connection is claimed.`;
    } else {
      let verified = true;
      if (spec.onSuccess) {
        try { verified = await spec.onSuccess(); } catch { verified = false; }
      }
      if (job.status !== 'running') { persistUpdate(job); return; }
      job.status = verified ? 'succeeded' : 'failed';
      job.detail = verified ? (spec.action === 'auth' ? 'Connection verified.' : 'Command completed.')
        : 'The command exited, but the connection could not be verified. Check CLI health before retrying.';
      invalidateCliScan();
    }
    persistUpdate(job);
  });
  return job;
}

export function startManagedCliJob(kind: ManagedCliKind, action: ManagedCliAction): ManagedCliJob {
  const spec = commandFor(kind, action);
  return runJob({ kind, action, ...spec,
    ...(action !== 'install' ? { ...authProcess(spec.command), onSuccess: () => verifyCatalogAuth(kind) } : {}) });
}

async function verifyCatalogAuth(id: string): Promise<boolean> {
  const { invalidateCliHealth, getCliHealth } = await import('../integrations/cli-catalog/auth-health.js');
  invalidateCliHealth(id);
  const health = await getCliHealth(id, { force: true });
  return health.authStatus === 'ok' && !health.staleSince && !health.lastProbeError && !health.issue;
}

/**
 * One-click sign-in for a catalog CLI. The command comes ONLY from the
 * catalog — callers pass an id, never a command string, so the route adds
 * zero command-string injection surface. Interactive macOS jobs use a managed
 * pseudo-terminal; browser/device-code jobs use the existing noninteractive path.
 */
export async function startCatalogAuthJob(catalogId: string): Promise<ManagedCliJob> {
  const { findCatalogEntry } = await import('../integrations/cli-catalog/catalog.js');
  const entry = findCatalogEntry(catalogId);
  if (!entry) throw new Error(`Unknown catalog CLI: ${catalogId}`);
  if (!entry.authCommand) {
    throw new Error(`${entry.name} requires an interactive sign-in — run \`${entry.authCommand ?? `${entry.command} login`}\` in your terminal (see ${entry.authDocsUrl}).`);
  }
  return runJob({
    kind: entry.id,
    action: 'auth',
    title: `Sign in to ${entry.name}`,
    command: entry.authCommand,
    ...authProcess(entry.authCommand),
    args: ['-lc', entry.authCommand],
    timeoutMs: AUTH_JOB_TIMEOUT_MS,
    interactive: !entry.authHeadless,
    onSuccess: () => verifyCatalogAuth(entry.id),
  });
}

export function getManagedCliJob(id: string): ManagedCliJob | undefined {
  const active = jobs.get(id);
  if (active) return active;
  if (!/^cli-[a-f0-9-]+$/.test(id)) return undefined;
  try {
    const record = JSON.parse(readFileSync(path.join(jobDirectory, `${id}.json`), 'utf8')) as ManagedCliJob & { bootId: string };
    if (record.id !== id) return undefined;
    const { bootId: ownerBoot, ...job } = record;
    if (job.status === 'running' && ownerBoot !== bootId) {
      job.status = 'interrupted';
      job.detail = 'Clem restarted while this process was running. Its effects are unconfirmed; check connection health before starting another.';
    }
    return job;
  } catch { return undefined; }
}

/** Test seam: legacy command specs are pinned byte-for-byte. */
export const _testOnly_commandFor = commandFor;

export function listManagedCliJobs(sessionId: string): ManagedCliJob[] {
  if (!sessionId) return [];
  let files: string[] = [];
  try { files = readdirSync(jobDirectory); } catch { return []; }
  return files.filter(file => file.endsWith('.json')).flatMap(file => {
    const job = getManagedCliJob(file.slice(0, -5));
    return job?.sessionId === sessionId ? [job] : [];
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** UI-only input: never exposed as a model tool or retained in a transcript. */
export function sendManagedCliInput(id: string, sessionId: string, input: string): boolean {
  const job = jobs.get(id);
  const child = processes.get(id);
  if (!job || job.sessionId !== sessionId || job.status !== 'running' || !job.interactive
    || (!child?.stdin?.writable || child.stdin.writableNeedDrain) || typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 511
    || /[\x00-\x08\x0b-\x1f\x7f]/.test(input) || /[\r\n]/.test(input)) return false;
  if (input) privateInputs.set(id, [...(privateInputs.get(id) ?? []), input]);
  try {
    child!.stdin!.write(`${input}\n`);
  } catch { return false; }
  return true;
}

export function cancelManagedCliJob(id: string, sessionId: string): boolean {
  const job = jobs.get(id); const child = processes.get(id);
  if (!job || job.sessionId !== sessionId || job.status !== 'running' || !child) return false;
  job.status = 'cancelled'; job.detail = 'Stopped by you. Any effects already performed remain; they will not be retried automatically.';
  persistUpdate(job); stopProcess(child, job.interactive); return true;
}
