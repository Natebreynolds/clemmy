/**
 * Workspace re-engage — the one canonical path that wakes Clem about activity in
 * a Workspace. Used by BOTH the HTTP route (the dock's "ask", a view-tracked
 * note/threshold) AND the scheduler (E2: a scheduled runner that emits a
 * `_reengage` signal → a proactive ping). Extracting it here means the surface
 * can reach out to you from a background refresh with NO bespoke per-runner HTTP
 * call (a sandboxed runner can't authenticate to the /reengage route anyway).
 *
 * Records the interaction durably (a note + audit) regardless of whether it
 * wakes, then — only if the trigger is configured (or it's an explicit 'ask') —
 * stages a turn into the Workspace's dedicated chat thread via the unified
 * outcome contract (idempotent by source id, never throws into the caller).
 */
import { spaceStore } from './store.js';
import { appendNote, appendAudit } from './data-store.js';
import { deliverOutcome } from '../runtime/outcome.js';

/** The dedicated chat thread for a Workspace's floating "Ask Clem" dock +
 *  re-engage wakes. Stable + deterministic so the dock and the callback share
 *  one continuous per-workspace conversation. */
export function spaceSessionId(slug: string): string {
  return `space-${slug}`;
}

export type ReengageTrigger = 'note' | 'ask' | 'threshold';

export interface ReengageInput {
  trigger: ReengageTrigger;
  message?: string;
  actionId?: string;
  meta?: Record<string, unknown>;
}

/** {status, body} so the HTTP route can return the exact same shape it always
 *  has, and the scheduler can ignore it. */
export interface ReengageOutcome {
  status: number;
  body: Record<string, unknown>;
}

export async function reengageSpace(slug: string, input: ReengageInput): Promise<ReengageOutcome> {
  const rec = spaceStore.get(slug);
  if (!rec) return { status: 404, body: { error: 'not found' } };
  if (rec.status === 'archived') return { status: 423, body: { error: 'workspace is archived' } };

  const trigger = input.trigger;
  const message = (input.message ?? '').trim();
  const actionId = (input.actionId && input.actionId.trim())
    ? input.actionId.trim()
    : `${trigger}-${message.slice(0, 24)}`;

  // Always record the interaction durably (notes are the audit of what happened
  // in the surface, even if we don't wake Clem for it).
  if (message) appendNote(slug, { text: message, kind: trigger, meta: input.meta });
  appendAudit(slug, { method: 'POST', path: `/reengage/${trigger}`, outcome: 'ok' });

  // A configured-but-unlisted, non-'ask' trigger is recorded only (no wake) —
  // 'ask' is an explicit user request and always wakes.
  const configured = rec.reengage?.triggers ?? [];
  const shouldWake = trigger === 'ask' || configured.includes(trigger);
  if (!shouldWake) {
    return { status: 202, body: { ok: true, reengaged: false, reason: 'trigger not configured' } };
  }

  try {
    const guidance = rec.reengage?.guidance;
    deliverOutcome(
      {
        status: 'needs_input',
        summary: message
          ? `In your "${rec.title}" workspace: ${message}`
          : `Activity in your "${rec.title}" workspace (${trigger}) needs a look.`,
        detail: [
          message ? `User: ${message}` : `Trigger: ${trigger}`,
          guidance ? `What you set up to do here: ${guidance}` : '',
          `Inspect the current state with space_get('${slug}') (manifest + data + notes); to read the view HTML before editing it, use space_get_view('${slug}').`,
          `If the user wants to change the DATA (better/different rows, a tighter filter, fewer/more fields, one row per entity), edit the data runner with write_file, call space_try_runner('${slug}', '<runner>') to SEE the JSON (nothing persisted), then space_refresh('${slug}') to persist — report the new row count, and do NOT say it's done while the surface still shows the old data. For layout/copy tweaks read with space_get_view then space_edit_view. Never read the view or test a runner from the shell.`,
        ].filter(Boolean).join('\n\n'),
      },
      {
        originSessionId: spaceSessionId(slug),
        sourceLabel: 'workspace',
        sourceId: `${slug}:${actionId}`,
        title: rec.title,
        statusHint: `space_get('${slug}')`,
      },
    );
    return { status: 202, body: { ok: true, reengaged: true, sessionId: spaceSessionId(slug) } };
  } catch (err) {
    return { status: 202, body: { ok: true, reengaged: false, error: err instanceof Error ? err.message : String(err) } };
  }
}
