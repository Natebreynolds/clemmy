/**
 * Workflow health check (2026-07-21, break-scenario B).
 *
 * A workflow authored months ago (or imported, or written against a since-
 * killed/renamed tool) can VALIDATE at save yet fail on first fire — the
 * "internal builder error" class, but for the STALE case: the tool it names
 * no longer exists in the registry. CALL-3 (workflow-validator.checkCallNode)
 * catches this at AUTHORING for structured call nodes; nothing re-checked an
 * ALREADY-SAVED workflow whose world moved underneath it (killed tools live
 * on in user-state files — a known class).
 *
 * This module answers "is this workflow still runnable?" against the LIVE
 * tool catalog, cheaply and deterministically (no model). It feeds:
 *   - the workflows list API (a health badge so the user sees a broken
 *     workflow BEFORE it silently no-ops on schedule),
 *   - a boot-time sweep that notifies once per broken enabled workflow.
 *
 * Fail-open by contract: an unreadable catalog yields "unknown", never a
 * false "broken" — a health check must not itself become the outage.
 */

import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { checkCallNode } from './workflow-validator.js';
import { LOCAL_MCP_TOOL_NAMES } from '../tools/catalog.js';

export type WorkflowHealthStatus = 'ok' | 'broken' | 'unknown';

export interface WorkflowHealthIssue {
  stepId: string;
  kind: 'unknown_call_tool';
  detail: string;
}

export interface WorkflowHealthReport {
  status: WorkflowHealthStatus;
  issues: WorkflowHealthIssue[];
}

function knownToolNames(): Set<string> | null {
  try {
    return new Set(LOCAL_MCP_TOOL_NAMES as readonly string[]);
  } catch {
    return null;
  }
}

/**
 * Deterministic health verdict for one workflow. Only HARD, unambiguous
 * breakage is reported: a structured `call.tool` whose slug is neither a
 * known local tool nor a plausibly-valid Composio/cx identifier shape
 * (checkCallNode's ERROR tier). Prompt-referenced tools and unverifiable
 * Composio slugs are deliberately NOT flagged — the catalog can't prove a
 * remote slug wrong, and a false "broken" badge is worse than none.
 */
export function checkWorkflowHealth(def: WorkflowDefinition): WorkflowHealthReport {
  const known = knownToolNames();
  if (!known) return { status: 'unknown', issues: [] };
  const issues: WorkflowHealthIssue[] = [];
  for (const step of def.steps ?? []) {
    if (!step.call || typeof step.call !== 'object' || typeof step.call.tool !== 'string') continue;
    const { errors } = checkCallNode({ id: step.id, call: step.call }, known);
    for (const error of errors) {
      // Only the "not a valid tool reference" (dead slug) class counts as
      // broken health — missing-required-arg errors depend on a cached
      // schema that may just be cold, which is a run-time concern, not a
      // structural "this can never run" one.
      if (/not a valid tool reference/.test(error)) {
        issues.push({ stepId: step.id ?? '?', kind: 'unknown_call_tool', detail: error });
      }
    }
  }
  return { status: issues.length > 0 ? 'broken' : 'ok', issues };
}
