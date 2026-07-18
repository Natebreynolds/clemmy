/**
 * Provider-neutral execution truth for `run_shell_command`.
 *
 * The model still receives the familiar rendered stdout/stderr string, but the
 * harness must not infer safety from that prose.  In particular, a package
 * runner can fail while resolving/materializing a CLI before the provider CLI
 * ever starts, while a provider CLI can exit non-zero after a remote write may
 * already have landed.  Those cases need opposite retry/artifact treatment.
 */
import { classifyShellProviderFailure } from './shell-provider-outcome-adapters.js';

export type ShellExecutionPhase =
  | 'resolve'
  | 'materialize'
  | 'provider_execution'
  | 'complete';

export type ShellDispatchState =
  | 'not_applicable'
  | 'not_started'
  | 'unknown'
  | 'acknowledged';

export type ShellEffectState = 'none' | 'possible' | 'committed';

export type ShellExecutionErrorKind =
  | 'command_not_found'
  | 'permission_denied'
  | 'package_materialization_failed'
  | 'timeout'
  | 'nonzero_exit'
  | 'provider_precondition_rejected'
  | 'spawn_failed';

export interface ShellExecutionOutcome {
  phase: ShellExecutionPhase;
  dispatch: ShellDispatchState;
  effect: ShellEffectState;
  externalMutation: boolean;
  exitCode?: number | null;
  errorKind?: ShellExecutionErrorKind;
  executable?: string;
  providerAdapterId?: string;
}

export interface ClassifyShellExecutionInput {
  command: string;
  externalMutation: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  spawnErrorCode?: string;
}

const PACKAGE_RUNNER_RE = /(?:^|[;&|\n]\s*)(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:npx(?:\s|$)|npm\s+exec(?:\s|$)|pnpm\s+(?:dlx|exec)(?:\s|$)|yarn\s+dlx(?:\s|$)|bunx(?:\s|$))/i;
const PACKAGE_MANAGER_FATAL_RE = /(?:^|\n)\s*(?:npm\s+(?:err!|error)|pnpm(?:\s+err!?|:)|yarn\s+error|error:\s*(?:eacces|eexist|erofs|enotempty)).*(?:eacces|eexist|erofs|enotempty|permission denied|cache|cacache|could not determine executable|failed to (?:download|extract|install|resolve))/is;
const COMMAND_NOT_FOUND_RE = /(?:command not found|(?:^|\n)\s*[^:\n]+:\s+not found\b)/i;

/** Shared structural predicate for the classifier and its model recovery hint. */
export function isPackageRunnerMaterializationFailure(command: string, stderr: string): boolean {
  return PACKAGE_RUNNER_RE.test(command) && PACKAGE_MANAGER_FATAL_RE.test(stderr);
}

function commandExecutable(command: string): string | undefined {
  const first = command.trim().match(/^(?:env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)?(?:sudo\s+)?([^\s;&|]+)/)?.[1];
  return first?.replace(/^['"]|['"]$/g, '');
}

/**
 * Classify one completed/failed shell process without claiming knowledge the
 * harness does not have.  Only local failures with strong structural evidence
 * are `not_started`; every non-zero external mutation after the provider CLI
 * may have run remains `unknown`/`possible`.
 */
export function classifyShellExecutionOutcome(input: ClassifyShellExecutionInput): ShellExecutionOutcome {
  const stdout = input.stdout ?? '';
  const stderr = input.stderr ?? '';
  const combined = `${stdout}\n${stderr}`;
  const executable = commandExecutable(input.command);

  if (input.spawnErrorCode) {
    const permission = input.spawnErrorCode === 'EACCES' || input.spawnErrorCode === 'EPERM';
    return {
      phase: 'resolve',
      dispatch: 'not_started',
      effect: 'none',
      externalMutation: input.externalMutation,
      errorKind: permission ? 'permission_denied' : 'spawn_failed',
      executable,
    };
  }

  if (input.timedOut) {
    return {
      phase: 'provider_execution',
      dispatch: input.externalMutation ? 'unknown' : 'not_applicable',
      effect: input.externalMutation ? 'possible' : 'none',
      externalMutation: input.externalMutation,
      errorKind: 'timeout',
      executable,
    };
  }

  const exitCode = input.exitCode ?? null;
  if (exitCode !== 0) {
    // A package runner's own fatal error, before it launched the requested CLI,
    // is local materialization failure.  Require empty stdout plus a package-
    // manager-prefixed fatal shape; arbitrary provider stderr mentioning npm or
    // a cache remains conservatively unknown.
    if (!stdout.trim() && isPackageRunnerMaterializationFailure(input.command, stderr)) {
      return {
        phase: 'materialize',
        dispatch: 'not_started',
        effect: 'none',
        externalMutation: input.externalMutation,
        exitCode,
        errorKind: 'package_materialization_failed',
        executable,
      };
    }
    // Shell lookup failures conventionally exit 126/127. Do not let ordinary
    // provider stderr such as "record not found" become no-dispatch evidence.
    if (!stdout.trim() && (exitCode === 126 || exitCode === 127) && COMMAND_NOT_FOUND_RE.test(combined)) {
      return {
        phase: 'resolve',
        dispatch: 'not_started',
        effect: 'none',
        externalMutation: input.externalMutation,
        exitCode,
        errorKind: 'command_not_found',
        executable,
      };
    }
    const providerEvidence = input.externalMutation
      ? classifyShellProviderFailure({ command: input.command, exitCode, stdout, stderr })
      : null;
    if (providerEvidence) {
      return {
        phase: providerEvidence.phase,
        dispatch: providerEvidence.dispatch,
        effect: providerEvidence.effect,
        externalMutation: true,
        exitCode,
        errorKind: providerEvidence.errorKind,
        executable,
        providerAdapterId: providerEvidence.adapterId,
      };
    }
    return {
      phase: input.externalMutation ? 'provider_execution' : 'complete',
      dispatch: input.externalMutation ? 'unknown' : 'not_applicable',
      effect: input.externalMutation ? 'possible' : 'none',
      externalMutation: input.externalMutation,
      exitCode,
      errorKind: 'nonzero_exit',
      executable,
    };
  }

  return {
    phase: 'complete',
    dispatch: input.externalMutation ? 'acknowledged' : 'not_applicable',
    // A zero exit is provider acknowledgement, not independent read-back proof.
    // Artifact extraction/verification is the layer allowed to promote commit.
    effect: input.externalMutation ? 'possible' : 'none',
    externalMutation: input.externalMutation,
    exitCode,
    executable,
  };
}

interface StoredOutcome {
  outcome: ShellExecutionOutcome;
  at: number;
}

const OUTCOME_TTL_MS = 10 * 60 * 1000;
const MAX_OUTCOMES = 1_000;
const outcomesByCallId = new Map<string, StoredOutcome>();

function pruneOutcomes(now = Date.now()): void {
  for (const [callId, stored] of outcomesByCallId) {
    if (now - stored.at > OUTCOME_TTL_MS) outcomesByCallId.delete(callId);
  }
  while (outcomesByCallId.size > MAX_OUTCOMES) {
    const oldest = outcomesByCallId.keys().next().value as string | undefined;
    if (!oldest) break;
    outcomesByCallId.delete(oldest);
  }
}

/** Record internal execution truth without exposing it in the model-visible text. */
export function recordShellExecutionOutcome(callId: string | undefined, outcome: ShellExecutionOutcome): void {
  if (!callId) return;
  pruneOutcomes();
  outcomesByCallId.delete(callId);
  outcomesByCallId.set(callId, { outcome, at: Date.now() });
}

/** One call result owns one outcome; consume it at the harness settlement edge. */
export function takeShellExecutionOutcome(callId: string | undefined): ShellExecutionOutcome | undefined {
  if (!callId) return undefined;
  pruneOutcomes();
  const stored = outcomesByCallId.get(callId);
  outcomesByCallId.delete(callId);
  return stored?.outcome;
}

export function _resetShellExecutionOutcomesForTests(): void {
  outcomesByCallId.clear();
}
