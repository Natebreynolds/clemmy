import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { createHash } from 'node:crypto';
import * as approvalRegistry from './approval-registry.js';
import { isExpired } from './approval-registry.js';
import { appendEvent } from './eventlog.js';
import { pendingActionApprovalViewFromArgs } from './pending-action-view.js';
import { addNotification } from '../notifications.js';
import {
  decideToolApproval,
  isDestructiveExternalToolCall,
  needsApprovalFromTaxonomy,
} from '../../agents/tool-taxonomy.js';
import { needsApprovalForShellSmart, needsApprovalForWriteFile } from '../../tools/computer-tools.js';
import {
  decodedToolArgs,
  extractComposioSlug,
  parseToolAuthority,
  resolveToolInvocation,
  toolActionSegment,
} from '../../agents/tool-invocation.js';
import { redactSensitiveText } from '../security.js';

/** The execution trio must run the SAME per-call approval logic the Codex lane
 *  uses (smart shell deny-list, sensitive-path write checks, composio read/write
 *  slug classification) — they are in the SDK profile's ADVERTISE list, and
 *  blanket fast-allowing that list let `sf data create record` write real CRM
 *  records with zero approval on default scope (proof converse-first,
 *  2026-07-02). Each returns the Codex-lane needsApproval(runContext, input). */
const EXECUTION_APPROVAL_FNS: Record<string, (rc: unknown, input: unknown) => Promise<boolean>> = {
  run_shell_command: needsApprovalForShellSmart(),
  write_file: needsApprovalForWriteFile(),
  composio_execute_tool: needsApprovalFromTaxonomy('composio_execute_tool'),
};

/**
 * The async approval gate for the AGENTIC Claude Agent SDK lane.
 *
 * The Agent SDK calls `canUseTool` (host-side, in the parent process) BEFORE it
 * executes a tool — and it AWAITS the returned promise across a human decision,
 * keeping the single `query()` run alive (verified in sdk.d.ts CanUseTool +
 * proven by the clementine-dev reference app). So this is where "ask the user"
 * lives for the Agent SDK lane, mirroring how the @openai/agents Runner pauses
 * on `needsApproval`.
 *
 * Flow per tool call:
 *   1. read/local tools (the lane's allowlist) → fast-allow, no DB, no human.
 *   2. everything else → decideToolApproval() — the SAME taxonomy the Codex lane
 *      uses (admin/destructive/strict → approve; plan-scope/yolo/workspace →
 *      auto). Plan-scope auto-approve is handled INSIDE decideToolApproval, so a
 *      fanned-out batch only prompts once.
 *   3. needsApproval === false → allow (the MCP-side gates are still the
 *      second, automated safety layer).
 *   4. needsApproval === true → register (approval-registry) + surface (same
 *      notification + approval_requested event the @openai/agents lane emits) +
 *      AWAIT the human decision, then allow/deny.
 *
 * Fail closed: any registry/surfacing failure denies (never run an unapproved
 * mutation). The MCP-subprocess gate chain (gated-mutating-tools.ts) is the
 * automated floor that runs only AFTER an allow here.
 */

function pollMs(): number {
  const n = Number.parseInt(process.env.CLEMMY_APPROVAL_POLL_MS ?? '', 10);
  return Number.isFinite(n) && n >= 10 ? n : 1500;
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function bareToolName(toolName: string): string {
  return toolName.split('__').at(-1) ?? toolName;
}

interface ApprovalToolIdentity {
  /** Exact durable authority. Native external tools retain `<server>__<tool>`. */
  authority: string;
  /** Human-friendly/local-runtime tail. Never use this as external authority. */
  display: string;
  nativeExternal: boolean;
  /** `mcp__` carrier without a trustworthy `<server>__<tool>` split. */
  malformedNative: boolean;
}

function approvalToolIdentity(toolName: string): ApprovalToolIdentity {
  const trimmed = toolName.trim();
  const parsed = parseToolAuthority(trimmed);
  const display = parsed.tool || bareToolName(trimmed);
  if (!parsed.valid) {
    // Never collapse an unparseable native carrier onto a local fast-allow
    // tail. Retain the whole raw identity for its card/resume authority and
    // force a human gate below regardless of Autonomous policy.
    return {
      authority: parsed.authority || trimmed,
      display: display || trimmed,
      nativeExternal: true,
      malformedNative: true,
    };
  }
  return {
    authority: parsed.authority,
    display,
    nativeExternal: parsed.external,
    malformedNative: false,
  };
}

const SAFE_TARGET_KEYS = [
  'to',
  'to_email',
  'recipient',
  'recipients',
  'email',
  'address',
  'item_id',
  'message_id',
  'thread_id',
  'event_id',
  'file_id',
  'resource_id',
  'channel',
  'channel_id',
  'path',
] as const;

function brokerTargetDetail(args: unknown): string {
  let obj = decodedToolArgs(args);
  if (!obj) return '';
  const wrapped = obj.arguments ?? obj.args ?? obj.payload ?? obj.input;
  const nested = decodedToolArgs(wrapped);
  if (nested) obj = nested;
  const details: string[] = [];
  for (const key of SAFE_TARGET_KEYS) {
    const value = obj[key];
    if (value === undefined || value === null) continue;
    const rendered = Array.isArray(value)
      ? value.filter((entry) => typeof entry === 'string' || typeof entry === 'number').slice(0, 3).join(', ')
      : typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
    if (!rendered) continue;
    details.push(`${key}=${rendered.slice(0, 80)}`);
    if (details.length >= 2) break;
  }
  return redactSensitiveText(details.join(' · ')).slice(0, 140);
}

function approvalSubject(tool: string, args: Record<string, unknown>): string {
  const resolved = resolveToolInvocation(tool, args);
  if (resolved.externalBroker) {
    if (!resolved.valid) return `Run ${toolActionSegment(tool)} broker action?`;
    const slug = extractComposioSlug(resolved.args);
    const action = slug || resolved.toolName;
    const detail = brokerTargetDetail(resolved.args);
    return `Run ${action}${detail ? ` · ${detail}` : ''}?`.slice(0, 220);
  }
  if (tool === 'composio_execute_tool') {
    const slug = typeof args.tool_slug === 'string' && args.tool_slug.trim() ? args.tool_slug.trim() : 'a Composio action';
    return `Run ${slug}?`;
  }
  if (tool === 'run_shell_command') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    return `Run shell: ${redactSensitiveText(cmd).slice(0, 160)}`;
  }
  if (tool === 'run_batch') {
    // Same fix as the codex lane's extractApprovalSubject: never show a bare
    // "run_batch needs your approval" when the plan says what it really is.
    const plan = (args.plan ?? null) as { sideEffect?: string; items?: unknown[]; composioSlug?: string; tool?: string; objective?: string } | null;
    if (plan && typeof plan === 'object' && Array.isArray(plan.items)) {
      const target = plan.composioSlug || plan.tool || 'batch';
      return `Batch ${plan.sideEffect ?? 'write'} · ${plan.items.length} × ${target}${plan.objective ? ` — ${String(plan.objective).slice(0, 90)}` : ''}`;
    }
  }
  return `${tool} needs your approval`;
}

function surfaceApproval(
  sessionId: string,
  approvalId: string,
  tool: string,
  args: Record<string, unknown>,
  subject: string,
): void {
  try {
    addNotification({
      id: `approval-${approvalId}`,
      kind: 'approval',
      title: 'Approval pending',
      body: subject,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { approvalId, tool, sessionId },
    });
  } catch (err) {
    // Notification failure must not break the pause — the approval still lives
    // in the registry and the dashboard surfaces it.
    console.error('[claude-agent-approval] addNotification failed', {
      approvalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'Clem',
      type: 'approval_requested',
      data: { tool, subject, args, pendingAction: pendingActionApprovalViewFromArgs(args), approvalId },
    });
  } catch {
    /* best-effort: the registry row is the source of truth */
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // NOTE: do NOT unref() — we are genuinely waiting on the approval, and the
  // poll loop is bounded by the abort signal + the approval TTL (isExpired),
  // so it always terminates. unref()'ing here lets the event loop drain
  // mid-wait (breaks the await; surfaced as a hang under node:test).
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

type Resolution = 'approved' | 'rejected' | 'expired' | 'aborted' | 'park_timeout';

/** Hold ceiling for the chat/worker WAIT gate (fail-closed park, 2026-07-20).
 *  The card TTL is 24h, and `wait` mode used to hold the live SDK child + the
 *  open turn for that whole window when nobody answered — an autonomous run
 *  blocked on an unseen card was indistinguishable from a hang. After this
 *  long still-pending, the wait converts into an honest PARK: the tool is
 *  denied with a "waiting on your approval" message (the model wraps up and
 *  reports), the card stays durable + RESUMABLE, and chat-approval-resume
 *  re-drives the session when the card is approved. 0/off restores the
 *  legacy TTL-bounded hold. */
export function approvalWaitParkMs(): number {
  const raw = (process.env.CLEMMY_APPROVAL_WAIT_PARK_MS ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'off') return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60_000;
}

export type ClaudeAgentApprovalBoundaryState = 'pending' | 'rejected' | 'expired' | 'cancelled';

export interface ClaudeAgentApprovalBoundary {
  approvalId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  state: ClaudeAgentApprovalBoundaryState;
}

export interface GatedToolPermissionOptions {
  /** Default `wait` preserves chat/worker behavior. `park` is workflow-only: the
   * SDK query is interrupted after the durable exact-payload card is stored. */
  approvalMode?: 'wait' | 'park';
  onApprovalBoundary?: (boundary: ClaudeAgentApprovalBoundary) => void;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

/** Opaque and deterministic across daemon restarts; the hash keeps exact send
 * contents out of the index while binding the grant to every payload field. */
export function workflowApprovalResumeKey(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  // Preserve the delimiter-bearing provider identity exactly. Normalizing
  // `alpha__bc` and `alph__abc` into alphanumerics would collapse two distinct
  // external authorities before the cryptographic hash. Bare/local names keep
  // their historical normalization so outstanding local approvals still resume.
  const authorityKey = tool.includes('__') ? tool.trim() : normalizeToolName(tool);
  const digest = createHash('sha256')
    .update(canonicalJson({ sessionId, tool: authorityKey, args }))
    .digest('hex');
  return `claude-workflow-tool-v1:${digest}`;
}

async function awaitApproval(approvalId: string, signal?: AbortSignal, parkAfterMs = 0): Promise<Resolution> {
  const interval = pollMs();
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) return 'aborted';
    const row = approvalRegistry.get(approvalId);
    if (!row) return 'expired';
    if (row.status === 'resolved') return row.resolution === 'approved' ? 'approved' : 'rejected';
    if (row.status === 'expired' || row.status === 'cancelled') return 'expired';
    if (isExpired(row)) return 'expired';
    if (parkAfterMs > 0 && Date.now() - startedAt >= parkAfterMs) return 'park_timeout';
    await sleep(interval, signal);
  }
}

/**
 * Build the async `canUseTool` for the agentic Agent SDK lane. `fastAllowTools`
 * are the read/local tool names that never need a human (the lane's read-only /
 * local-authoring allowlist); everything else runs the approval decision.
 */
export function buildGatedToolPermission(
  sessionId: string,
  fastAllowTools: string[],
  gateOptions: GatedToolPermissionOptions = {},
): CanUseTool {
  const fastAllow = new Set(fastAllowTools.map(normalizeToolName).filter(Boolean));
  return (async (toolName, input, options) => {
    const identity = approvalToolIdentity(toolName);
    const bare = identity.display;
    const authorityTool = identity.authority;
    // Permission is a decision boundary, not the canonical execution record.
    // The shared SDK stream emits exactly one top-level tool_called row from the
    // actual tool_use id for agentic, workflow, and allow-only lanes alike.
    // The CLI's control-protocol schema requires `updatedInput` on EVERY allow
    // (a bare {behavior:'allow'} fails its Zod parse with "updatedInput expected
    // record, received undefined" and the tool call dies — 2026-07-02 end-of-day
    // task_hygiene incident). Echo the original input back unchanged.
    const args = (input ?? {}) as Record<string, unknown>;
    // Execution trio FIRST — these are always in the profile's advertise list,
    // so the fastAllow shortcut below must never cover them. Same per-call
    // logic as the Codex lane: "Bash is bash" (reads auto-allow), destructive
    // shapes + CRM/SaaS writes + sensitive paths → human approval (plan-scope
    // and YOLO still auto-approve inside the shared decision path).
    // External providers cannot inherit the semantics of a same-tail local
    // execution tool. `mcp__foreign__run_shell_command` is provider code, not
    // Clementine's smart shell gate.
    const executionApproval = identity.nativeExternal ? undefined : EXECUTION_APPROVAL_FNS[bare];
    if (executionApproval) {
      let needs = true;
      try {
        needs = await executionApproval({ context: { sessionId } }, args);
      } catch { /* fail closed → ask the human */ }
      if (!needs) return { behavior: 'allow', updatedInput: args } as PermissionResult;
      // fall through to the register/surface/await flow below
    } else {
      // Preserve the original MCP namespace through destructive classification.
      // `mcp__m365__sharepoint_delete_item` is a provable external delete, but
      // its display-friendly tail `sharepoint_delete_item` is not: the shared
      // classifier deliberately requires the MCP carrier before treating a bare
      // name as external. Never let a read/local profile entry erase that proof.
      const destructiveExternalCall = isDestructiveExternalToolCall(toolName, args);
      if (
        !destructiveExternalCall
        && !identity.nativeExternal
        && (fastAllow.has(normalizeToolName(toolName)) || fastAllow.has(normalizeToolName(bare)))
      ) {
        return { behavior: 'allow', updatedInput: args } as PermissionResult;
      }
      const needsApproval = identity.malformedNative
        ? true
        : decideToolApproval({
            sessionId,
            toolName: authorityTool,
            args,
            isDestructiveHint: destructiveExternalCall,
          }).needsApproval;
      if (!needsApproval) return { behavior: 'allow', updatedInput: args } as PermissionResult;
    }

    let approvalId: string;
    let resumeKey: string;
    try {
      const subject = approvalSubject(authorityTool, args);
      if (gateOptions.approvalMode === 'park') {
        resumeKey = workflowApprovalResumeKey(sessionId, authorityTool, args);
        const prior = approvalRegistry.claimResumableApproval(resumeKey);
        if (prior.state === 'approved') {
          // Atomic one-shot claim: this exact payload may proceed once. A later
          // identical call cannot reuse the same human decision.
          return { behavior: 'allow', updatedInput: args } as PermissionResult;
        }
        if (prior.state === 'pending') {
          gateOptions.onApprovalBoundary?.({
            approvalId: prior.row.approvalId,
            sessionId,
            tool: authorityTool,
            args,
            state: 'pending',
          });
          return {
            behavior: 'deny',
            message: `Approval ${prior.row.approvalId} is pending; the workflow run has been parked.`,
            interrupt: true,
          } as PermissionResult;
        }
        if (prior.state === 'rejected' || prior.state === 'expired' || prior.state === 'cancelled') {
          gateOptions.onApprovalBoundary?.({
            approvalId: prior.row.approvalId,
            sessionId,
            tool: authorityTool,
            args,
            state: prior.state,
          });
          const action = prior.state === 'rejected' ? 'rejected' : prior.state === 'cancelled' ? 'cancelled' : 'expired';
          return {
            behavior: 'deny',
            message: `Approval ${prior.row.approvalId} was ${action}; the exact tool payload was not run.`,
            interrupt: true,
          } as PermissionResult;
        }

        if (prior.state === 'consumed') {
          // The exact payload was already approved AND executed earlier in this
          // run (the one-shot grant is spent). A workflow step replays from
          // scratch on resume, so re-surfacing a fresh card here would ask the
          // human to re-approve an already-sent action — a duplicate irreversible
          // send (or a livelock if they decline). It is terminal-done: refuse the
          // re-run so the from-scratch replay skips it, and do NOT park — the run
          // continues to its next still-ungranted action.
          return {
            behavior: 'deny',
            message: `This exact action was already approved and executed earlier in this run (approval ${prior.row.approvalId}); skipped to avoid a duplicate send.`,
            interrupt: false,
          } as PermissionResult;
        }

        // No prior decision (state 'none'): create a fresh exact-payload card.
        // registerResumable is race-safe and tells us whether this process owns
        // surfacing the card.
        const registered = approvalRegistry.registerResumable({
          sessionId,
          subject,
          tool: authorityTool,
          args,
          resumeKey,
        });
        approvalId = registered.row.approvalId;
        if (registered.created) surfaceApproval(sessionId, approvalId, authorityTool, args, subject);
        gateOptions.onApprovalBoundary?.({
          approvalId,
          sessionId,
          tool: authorityTool,
          args,
          state: 'pending',
        });
        return {
          behavior: 'deny',
          message: `Approval ${approvalId} is pending; the workflow run has been parked.`,
          interrupt: true,
        } as PermissionResult;
      }

      // WAIT gate (chat/worker): the card is durable + RESUMABLE (2026-07-20).
      // A prior resumable decision binds this exact payload FIRST — the
      // approve-after-park resume path re-runs the tool with identical args
      // and must proceed on the human's existing one-shot grant instead of
      // re-asking. 'pending' reuses the already-surfaced card (a parked wait
      // from an earlier turn — fresh hold window, no duplicate card). Every
      // other prior state (none/rejected/expired/cancelled/consumed) registers
      // a fresh card, preserving the legacy re-ask semantics for a genuinely
      // new attempt: only registerResumable's pending-dedupe and the approved
      // one-shot claim change behavior, never the human's right to be asked.
      resumeKey = workflowApprovalResumeKey(sessionId, authorityTool, args);
      const prior = approvalRegistry.claimResumableApproval(resumeKey);
      if (prior.state === 'approved') {
        return { behavior: 'allow', updatedInput: args } as PermissionResult;
      }
      if (prior.state === 'pending') {
        approvalId = prior.row.approvalId;
      } else {
        const registered = approvalRegistry.registerResumable({ sessionId, subject, tool: authorityTool, args, resumeKey });
        approvalId = registered.row.approvalId;
        if (registered.created) surfaceApproval(sessionId, approvalId, authorityTool, args, subject);
      }
    } catch (err) {
      return {
        behavior: 'deny',
        message: `Could not request approval for ${bare}: ${err instanceof Error ? err.message : String(err)}`,
        interrupt: false,
      } as PermissionResult;
    }

    const decision = await awaitApproval(approvalId, options?.signal, approvalWaitParkMs());
    if (decision === 'approved') {
      try {
        // `resolve(..., approved)` records the human decision; it does not spend
        // its execution authority. Claim the exact row atomically before this
        // live call proceeds, just as the park/resume path does on re-entry.
        const claimed = approvalRegistry.claimResumableApproval(resumeKey, approvalId);
        if (claimed.state === 'approved') {
          return { behavior: 'allow', updatedInput: args } as PermissionResult;
        }
        return {
          behavior: 'deny',
          message: claimed.state === 'consumed'
            ? 'This approval was already used by an identical action, so this duplicate was not run.'
            : 'The approval could not be claimed for this exact action, so it was not run.',
          interrupt: false,
        } as PermissionResult;
      } catch (err) {
        return {
          behavior: 'deny',
          message: `Could not claim approval for ${bare}: ${err instanceof Error ? err.message : String(err)}`,
          interrupt: false,
        } as PermissionResult;
      }
    }
    if (decision === 'park_timeout') {
      // Fail-closed park: durable marker so chat-approval-resume can re-drive
      // this session when the card is approved later; the card itself stays
      // pending (the 24h reaper still owns final expiry + its notification).
      try {
        appendEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'approval_parked',
          data: { approvalId, tool: authorityTool, subject: approvalSubject(authorityTool, args) },
        });
      } catch { /* the marker is best-effort; the deny below is still honest */ }
      return {
        behavior: 'deny',
        message:
          'PARKED — this action still needs the user\'s approval and they have not answered yet. '
          + 'Do NOT retry it now and do NOT treat it as done. Finish anything that does not depend on it, '
          + 'then tell the user exactly what is waiting on their approval; the moment they approve the card, '
          + 'the task resumes and this exact payload will go through without re-asking.',
        interrupt: false,
      } as PermissionResult;
    }
    const message =
      decision === 'rejected' ? 'You rejected this action, so it was not run.'
      : decision === 'expired' ? 'The approval request expired before it was answered.'
      : 'The run was aborted before approval.';
    return { behavior: 'deny', message, interrupt: false } as PermissionResult;
  }) as CanUseTool;
}
