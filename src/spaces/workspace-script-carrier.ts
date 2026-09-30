/** Host execution for one sealed, saved source script. This is deliberately
 * not a model tool or arbitrary shell/argv executor. The workflow kernel owns
 * consent, the I/O claim and the durable result; this carrier owns the child. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync,
  unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { currentWorkflowV3CallAttestation, readWorkflowV3CallAuthority } from '../runtime/harness/accepted-turn-call-authority.js';
import { currentDispatchLease, isDispatchLeaseCurrent } from '../runtime/harness/dispatch-lease.js';
import { canonicalArgumentDigestOf } from '../runtime/harness/resolved-call-authority.js';
import { hostPreDispatchRefusal } from '../runtime/harness/host-pre-dispatch-refusal.js';
import { DEFAULT_MAX_OUTPUT_BYTES, electronNodeEnv, interpreterFor, scrubbedChildEnv,
  spawnSandboxedScript } from '../runtime/sandboxed-script.js';
import { currentToolAbortSignal } from '../runtime/tool-abort-context.js';
import { savedSourceCallConsentIsCurrent } from '../runtime/harness/saved-source-consent.js';
import { SPACES_DIR, resolveInSpace, runnerFilenameError, spaceStore } from './store.js';
import { canonicalWorkspaceJson } from './workspace-set-data-contract.js';
import { WORKSPACE_SCRIPT_OPERATION, workspaceScriptArguments, type WorkspaceScriptArguments } from './workspace-script-contract.js';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const refuse = (message: string): never => { throw hostPreDispatchRefusal(message); };

function savedDeclaration(input: Pick<WorkspaceScriptArguments, 'slug' | 'source_id' | 'cause'>) {
  const space = spaceStore.get(input.slug);
  if (!space || space.status === 'archived' || space.manifestErrors?.length
    || (input.cause === 'scheduled' && space.status !== 'active')) {
    return refuse('Saved source is unavailable or no longer active for this occurrence.');
  }
  const sources = space.dataSources.filter(row => row.id === input.source_id);
  const source = sources[0];
  if (sources.length !== 1 || !source?.runner || source.cliArgv?.length || source.composioSlug?.trim()) {
    return refuse('Saved source must declare exactly one script executor.');
  }
  const error = runnerFilenameError(source.runner);
  if (error) return refuse(error);
  return { source, digest: sha(canonicalWorkspaceJson(source)) };
}

function readEntrypoint(slug: string, runner: string) {
  // resolveInSpace is lexical. Refuse symlinked roots/data/entrypoints as well:
  // a saved source may execute only the file in its own private data directory.
  const directory = resolveInSpace(slug, 'data');
  const root = path.dirname(directory);
  const expectedRoot = path.join(realpathSync(SPACES_DIR), slug);
  if (realpathSync(root) !== expectedRoot || realpathSync(directory) !== path.join(expectedRoot, 'data')) {
    return refuse('Saved script directory escapes its Workspace.');
  }
  const target = path.join(directory, runner);
  if (realpathSync(target) !== path.join(expectedRoot, 'data', runner)) {
    return refuse('Saved script entrypoint must not be a symlink.');
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > DEFAULT_MAX_OUTPUT_BYTES) {
      return refuse('Saved script entrypoint must be a bounded regular file.');
    }
    const bytes = readFileSync(fd);
    return { directory, bytes, mode: stat.mode, digest: sha(bytes) };
  } finally { closeSync(fd); }
}

/** Capture exact arguments before requesting consent. The caller must supply
 * its durable occurrence; neither retries nor process restarts invent one. */
export function captureWorkspaceScriptArguments(input: {
  slug: string; source_id: string; occurrence_id: string; cause: 'manual' | 'scheduled';
}): WorkspaceScriptArguments {
  const base = workspaceScriptArguments.parse({ ...input, source_digest: '0'.repeat(64), script_sha256: '0'.repeat(64) });
  const saved = savedDeclaration(base);
  const entry = readEntrypoint(base.slug, saved.source.runner!);
  return { ...base, source_digest: saved.digest, script_sha256: entry.digest };
}

/** Revalidation is read-only and deliberately public to the source scheduler. */
export function validateWorkspaceScriptArguments(input: WorkspaceScriptArguments): void {
  const args = workspaceScriptArguments.parse(input);
  const saved = savedDeclaration(args);
  if (saved.digest !== args.source_digest) refuse('Saved source declaration changed after consent.');
  if (readEntrypoint(args.slug, saved.source.runner!).digest !== args.script_sha256) {
    refuse('Saved script contents changed after consent.');
  }
}

export async function executeReviewedWorkspaceScript(input: WorkspaceScriptArguments) {
  const args = workspaceScriptArguments.parse(input);
  const owner = currentWorkflowV3CallAttestation();
  const lease = currentDispatchLease();
  if (!owner || !lease || owner.operationId !== WORKSPACE_SCRIPT_OPERATION
    || owner.effect !== 'admin' || owner.accountId !== 'local_registry:host'
    || owner.canonicalArgumentDigest !== canonicalArgumentDigestOf(input)
    || owner.runOccurrenceId !== args.occurrence_id
    || lease.sessionId !== owner.sessionId || lease.sourceUserSeq !== owner.sourceEventSeq
    || lease.acceptedTaskId !== owner.authorityRootId || lease.logicalToolCallId !== owner.logicalCallId) {
    return refuse('Saved script requires its exact workflow call authority and dispatch lease.');
  }
  const current = () => {
    if (!isDispatchLeaseCurrent(lease)) return false;
    const source = spaceStore.get(args.slug)?.dataSources.find(source => source.id === args.source_id);
    if (!source || !savedSourceCallConsentIsCurrent(owner.sessionId, owner.logicalCallId,
      source.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone)) return false;
    const root = readWorkflowV3CallAuthority(owner.activationId);
    return root.status === 'ok' && root.authority.state === 'open'
      && root.authority.authorityDigest === owner.authorityDigest
      && root.authority.revision === owner.authorityRevision;
  };
  if (!current()) return refuse('Saved script execution authority is no longer current.');

  let snapshot: string | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined;
  try {
    let saved: ReturnType<typeof savedDeclaration>;
    let entry: ReturnType<typeof readEntrypoint>;
    try {
      saved = savedDeclaration(args);
      if (saved.digest !== args.source_digest) refuse('Saved source declaration changed after consent.');
      entry = readEntrypoint(args.slug, saved.source.runner!);
      if (entry.digest !== args.script_sha256) refuse('Saved script contents changed after consent.');
      const candidate = path.join(entry.directory, `.clementine-entry-${randomUUID()}${path.extname(saved.source.runner!)}`);
      // Run the approved bytes, not the mutable original path. Dependencies,
      // CLIs, network and credentials remain live; this is not an OS sandbox.
      writeFileSync(candidate, entry.bytes, { flag: 'wx', mode: (entry.mode & 0o111) ? 0o500 : 0o400 });
      snapshot = candidate;
    } catch (error) {
      return refuse(`Saved script was not started: ${error instanceof Error ? error.message : String(error)}`);
    }
    const env = scrubbedChildEnv({ CLEMENTINE_SPACE_SLUG: args.slug });
    const interpreter = interpreterFor(snapshot, env.PATH);
    if (!interpreter) return refuse('No installed interpreter can execute this saved script.');
    // Recheck after snapshot preparation, immediately before spawning.
    if (!current() || savedDeclaration(args).digest !== args.source_digest) {
      return refuse('Saved source or execution authority changed before dispatch.');
    }
    const stop = new AbortController();
    monitor = setInterval(() => {
      try { if (!current()) stop.abort(); }
      catch { stop.abort(); }
    }, 100);
    monitor.unref();
    const configuredTimeout = Number(process.env.SPACE_RUNNER_TIMEOUT_MS);
    const outcome = await spawnSandboxedScript({
      command: interpreter.command, args: interpreter.args, cwd: entry.directory,
      env: { ...env, ...electronNodeEnv(interpreter.command, interpreter.isElectron) },
      stdinPayload: JSON.stringify({ slug: args.slug, runner: saved.source.runner }),
      timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 5 * 60_000,
      signal: currentToolAbortSignal() ? AbortSignal.any([stop.signal, currentToolAbortSignal()!]) : stop.signal,
    });
    if (!outcome.spawned && outcome.launchError) return refuse(`Saved script could not start: ${outcome.launchError.message}`);
    if (!outcome.spawned && outcome.aborted) return refuse('Saved script was cancelled before launch.');
    if (outcome.launchError || outcome.aborted || outcome.timedOut || outcome.overflowed || outcome.code !== 0) {
      // Do not call this zero-body: a started script may already have effects.
      throw new Error(`Saved script execution did not complete (exit=${outcome.code}, signal=${outcome.signal}, cancelled=${outcome.aborted}, timeout=${outcome.timedOut}, outputOverflow=${outcome.overflowed}). Its effects are uncertain; it will not be redispatched.`);
    }
    let data: unknown;
    try { data = JSON.parse(outcome.stdout); }
    catch { throw new Error('Saved script exited but did not return one JSON document. Effects are uncertain; it will not be redispatched.'); }
    // Output is untrusted data. Only the host can describe the process result;
    // script-authored receipt/authority/complete fields cannot escape data.
    return { version: 1, kind: 'workspace_script_result', workspaceId: args.slug,
      sourceId: args.source_id, occurrenceId: args.occurrence_id,
      declarationDigest: args.source_digest, scriptDigest: args.script_sha256,
      outputDigest: sha(outcome.stdout), process: { exitCode: 0 }, data };
  } finally {
    if (monitor) clearInterval(monitor);
    if (snapshot) { try { unlinkSync(snapshot); } catch { /* never mask the process outcome */ } }
  }
}
