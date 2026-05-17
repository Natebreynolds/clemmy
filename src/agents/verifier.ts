import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  listEvents,
  EVENT_TYPES,
  type EventType,
} from '../runtime/harness/eventlog.js';

/**
 * Verifier — deterministic-by-default.
 *
 * The Verifier is the ONLY role permitted to emit `step_verified` in
 * the harness. Most verification kinds are pure code (no LLM call):
 *
 *   file_exists      — fs.statSync
 *   file_contains    — fs.readFileSync + .includes(expected)
 *   shell_exit_zero  — child_process.spawn with timeout
 *   tool_returns     — scan event log for tool_returned event
 *   event_emitted    — scan event log for the named event type
 *   user_confirms    — scan event log for approval_resolved or
 *                      matching user_input_received
 *
 * Only fuzzy kinds (future: `output_matches_intent`) escalate to a
 * read-only LLM agent. This module ships the deterministic dispatcher;
 * the LLM fallback lives behind the same interface in a later slice.
 */

export const VerificationKindSchema = z.enum([
  'file_exists',
  'file_contains',
  'shell_exit_zero',
  'tool_returns',
  'event_emitted',
  'user_confirms',
]);
export type VerificationKind = z.infer<typeof VerificationKindSchema>;

export const VerificationSchema = z.object({
  kind: VerificationKindSchema,
  /** path / regex / command / tool name / event type — interpretation depends on kind. */
  spec: z.string(),
  /** Optional comparison target — file content substring, expected exit text, etc. */
  expected: z.string().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

export const VerifierResultSchema = z.object({
  passed: z.boolean(),
  kind: VerificationKindSchema,
  /** Human-readable evidence string; safe to include in `step_verified.data`. */
  evidence: z.string(),
});
export type VerifierResult = z.infer<typeof VerifierResultSchema>;

export interface VerifierContext {
  sessionId: string;
  /** cwd for shell_exit_zero. Defaults to process.cwd(). */
  cwd?: string;
  /** Timeout for shell verifications. Defaults to 30s. */
  shellTimeoutMs?: number;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set<string>(EVENT_TYPES);

/** Single entrypoint — dispatches on verification.kind and returns a result. */
export async function runVerifier(
  verification: Verification,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  switch (verification.kind) {
    case 'file_exists':
      return verifyFileExists(verification);
    case 'file_contains':
      return verifyFileContains(verification);
    case 'shell_exit_zero':
      return verifyShellExitZero(verification, ctx);
    case 'tool_returns':
      return verifyToolReturns(verification, ctx);
    case 'event_emitted':
      return verifyEventEmitted(verification, ctx);
    case 'user_confirms':
      return verifyUserConfirms(verification, ctx);
    default: {
      const exhaustive: never = verification.kind;
      throw new Error(`unhandled verification kind: ${exhaustive as string}`);
    }
  }
}

// ---------- file_exists ----------

function verifyFileExists(v: Verification): VerifierResult {
  try {
    const stats = statSync(v.spec);
    return {
      passed: true,
      kind: 'file_exists',
      evidence: `${v.spec} exists (${stats.size} bytes, modified ${stats.mtime.toISOString()})`,
    };
  } catch (err) {
    return {
      passed: false,
      kind: 'file_exists',
      evidence: `${v.spec} does not exist: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------- file_contains ----------

function verifyFileContains(v: Verification): VerifierResult {
  const expected = v.expected ?? '';
  if (!existsSync(v.spec)) {
    return {
      passed: false,
      kind: 'file_contains',
      evidence: `file does not exist: ${v.spec}`,
    };
  }
  try {
    const content = readFileSync(v.spec, 'utf-8');
    const preview = expected.slice(0, 40) + (expected.length > 40 ? '…' : '');
    if (content.includes(expected)) {
      return {
        passed: true,
        kind: 'file_contains',
        evidence: `${v.spec} contains "${preview}"`,
      };
    }
    return {
      passed: false,
      kind: 'file_contains',
      evidence: `${v.spec} does NOT contain expected "${preview}"`,
    };
  } catch (err) {
    return {
      passed: false,
      kind: 'file_contains',
      evidence: `failed to read ${v.spec}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------- shell_exit_zero ----------

interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runShell(cmd: string, options: { cwd?: string; timeoutMs: number }): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, {
      shell: true,
      cwd: options.cwd,
      env: process.env,
      timeout: options.timeoutMs,
    });
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf-8');
    });
    child.on('error', (err) => {
      resolve({ stdout, stderr: stderr || err.message, code: -1 });
    });
    child.on('exit', (code) => {
      resolve({ stdout, stderr, code });
    });
  });
}

async function verifyShellExitZero(
  v: Verification,
  ctx: VerifierContext,
): Promise<VerifierResult> {
  const timeoutMs = ctx.shellTimeoutMs ?? 30_000;
  const result = await runShell(v.spec, { cwd: ctx.cwd, timeoutMs });
  if (result.code === 0) {
    const tail = result.stdout.trim().slice(0, 200);
    return {
      passed: true,
      kind: 'shell_exit_zero',
      evidence: `\`${v.spec}\` exited 0${tail ? `\n${tail}` : ''}`,
    };
  }
  const stderr = (result.stderr || result.stdout).slice(0, 200);
  return {
    passed: false,
    kind: 'shell_exit_zero',
    evidence: `\`${v.spec}\` exited ${result.code ?? '?'}${stderr ? `\n${stderr}` : ''}`,
  };
}

// ---------- tool_returns ----------

function verifyToolReturns(v: Verification, ctx: VerifierContext): VerifierResult {
  const events = listEvents(ctx.sessionId, { types: ['tool_returned'] });
  const matches = events.filter((e) => {
    const tool = (e.data as { tool?: unknown }).tool;
    return typeof tool === 'string' && tool === v.spec;
  });
  if (matches.length === 0) {
    return {
      passed: false,
      kind: 'tool_returns',
      evidence: `tool \`${v.spec}\` was never called this session`,
    };
  }
  const last = matches[matches.length - 1];
  const result = (last.data as { result?: unknown }).result;
  const resultText = typeof result === 'string' ? result : JSON.stringify(result);
  if (v.expected && !resultText.includes(v.expected)) {
    return {
      passed: false,
      kind: 'tool_returns',
      evidence: `last \`${v.spec}\` call returned text not matching expected "${v.expected}". Got: ${resultText.slice(0, 200)}`,
    };
  }
  return {
    passed: true,
    kind: 'tool_returns',
    evidence: `${v.spec} returned: ${resultText.slice(0, 200)}`,
  };
}

// ---------- event_emitted ----------

function verifyEventEmitted(v: Verification, ctx: VerifierContext): VerifierResult {
  if (!EVENT_TYPE_SET.has(v.spec)) {
    return {
      passed: false,
      kind: 'event_emitted',
      evidence: `unknown event type "${v.spec}" — must be one of the closed enum`,
    };
  }
  const events = listEvents(ctx.sessionId, { types: [v.spec as EventType] });
  if (events.length === 0) {
    return {
      passed: false,
      kind: 'event_emitted',
      evidence: `no ${v.spec} event in this session`,
    };
  }
  return {
    passed: true,
    kind: 'event_emitted',
    evidence: `${events.length} ${v.spec} event(s) emitted (last seq=${events[events.length - 1].seq})`,
  };
}

// ---------- user_confirms ----------

function verifyUserConfirms(v: Verification, ctx: VerifierContext): VerifierResult {
  // Prefer explicit approval_resolved events; fall back to a matching
  // user_input_received text if `expected` is provided.
  const approvals = listEvents(ctx.sessionId, { types: ['approval_resolved'] });
  const approvedHit = approvals.find((e) => {
    const approved = (e.data as { approved?: unknown }).approved;
    if (approved !== true) return false;
    if (!v.expected) return true;
    // The approval was for a specific subject (spec). Match on data
    // fields that approval_resolved is expected to carry.
    const subject = (e.data as { subject?: unknown }).subject;
    return typeof subject === 'string' && subject.includes(v.expected);
  });
  if (approvedHit) {
    return {
      passed: true,
      kind: 'user_confirms',
      evidence: `approval_resolved (seq=${approvedHit.seq}) approved subject "${v.spec}"`,
    };
  }

  const inputs = listEvents(ctx.sessionId, { types: ['user_input_received'] });
  const expected = v.expected ?? v.spec;
  const inputHit = inputs.find((e) => {
    const text = (e.data as { text?: unknown }).text;
    return (
      typeof text === 'string' && text.toLowerCase().includes(expected.toLowerCase())
    );
  });
  if (inputHit) {
    return {
      passed: true,
      kind: 'user_confirms',
      evidence: `user_input_received (seq=${inputHit.seq}) matched "${expected}"`,
    };
  }

  return {
    passed: false,
    kind: 'user_confirms',
    evidence: v.expected
      ? `no approval and no user input matched "${v.expected}"`
      : `no approval_resolved event for subject "${v.spec}"`,
  };
}
