import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import * as approvalRegistry from './approval-registry.js';
import { isExpired } from './approval-registry.js';
import { appendEvent } from './eventlog.js';
import { pendingActionApprovalViewFromArgs } from './pending-action-view.js';
import { addNotification } from '../notifications.js';
import { decideToolApproval, needsApprovalFromTaxonomy } from '../../agents/tool-taxonomy.js';
import { needsApprovalForShellSmart, needsApprovalForWriteFile } from '../../tools/computer-tools.js';

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

function approvalSubject(tool: string, args: Record<string, unknown>): string {
  if (tool === 'composio_execute_tool') {
    const slug = typeof args.tool_slug === 'string' && args.tool_slug.trim() ? args.tool_slug.trim() : 'a Composio action';
    return `Run ${slug}?`;
  }
  if (tool === 'run_shell_command') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    return `Run shell: ${cmd.slice(0, 160)}`;
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

type Resolution = 'approved' | 'rejected' | 'expired' | 'aborted';

async function awaitApproval(approvalId: string, signal?: AbortSignal): Promise<Resolution> {
  const interval = pollMs();
  for (;;) {
    if (signal?.aborted) return 'aborted';
    const row = approvalRegistry.get(approvalId);
    if (!row) return 'expired';
    if (row.status === 'resolved') return row.resolution === 'approved' ? 'approved' : 'rejected';
    if (row.status === 'expired' || row.status === 'cancelled') return 'expired';
    if (isExpired(row)) return 'expired';
    await sleep(interval, signal);
  }
}

/**
 * Build the async `canUseTool` for the agentic Agent SDK lane. `fastAllowTools`
 * are the read/local tool names that never need a human (the lane's read-only /
 * local-authoring allowlist); everything else runs the approval decision.
 */
export function buildGatedToolPermission(sessionId: string, fastAllowTools: string[]): CanUseTool {
  const fastAllow = new Set(fastAllowTools.map(normalizeToolName).filter(Boolean));
  return (async (toolName, input, options) => {
    const bare = bareToolName(toolName);
    // Clean live progress (parity with the Codex lane): emit a tool_called event
    // so the dock shows "Using read_file…" — instead of streaming the model's raw
    // text, which dumped its tool-call XML into the bubble. Fires for EVERY tool
    // (fast-allow reads included). Best-effort: progress never blocks a tool.
    try { appendEvent({ sessionId, turn: 0, role: 'Clem', type: 'tool_called', data: { tool: bare } }); } catch { /* progress only */ }
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
    const executionApproval = EXECUTION_APPROVAL_FNS[bare];
    if (executionApproval) {
      let needs = true;
      try {
        needs = await executionApproval({ context: { sessionId } }, args);
      } catch { /* fail closed → ask the human */ }
      if (!needs) return { behavior: 'allow', updatedInput: args } as PermissionResult;
      // fall through to the register/surface/await flow below
    } else {
      if (fastAllow.has(normalizeToolName(toolName)) || fastAllow.has(normalizeToolName(bare))) {
        return { behavior: 'allow', updatedInput: args } as PermissionResult;
      }
      const { needsApproval } = decideToolApproval({ sessionId, toolName: bare, args });
      if (!needsApproval) return { behavior: 'allow', updatedInput: args } as PermissionResult;
    }

    let approvalId: string;
    try {
      const subject = approvalSubject(bare, args);
      const row = approvalRegistry.register({ sessionId, subject, tool: bare, args });
      approvalId = row.approvalId;
      surfaceApproval(sessionId, approvalId, bare, args, subject);
    } catch (err) {
      return {
        behavior: 'deny',
        message: `Could not request approval for ${bare}: ${err instanceof Error ? err.message : String(err)}`,
        interrupt: false,
      } as PermissionResult;
    }

    const decision = await awaitApproval(approvalId, options?.signal);
    if (decision === 'approved') return { behavior: 'allow', updatedInput: args } as PermissionResult;
    const message =
      decision === 'rejected' ? 'You rejected this action, so it was not run.'
      : decision === 'expired' ? 'The approval request expired before it was answered.'
      : 'The run was aborted before approval.';
    return { behavior: 'deny', message, interrupt: false } as PermissionResult;
  }) as CanUseTool;
}
