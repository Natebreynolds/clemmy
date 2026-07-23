/**
 * Capacity advisor (v2.3.0 L3): when a provider limit stops work, the card the
 * user sees must speak THEIR language — not "switch the Brain in Settings →
 * Models" (live 2026-07-22: a $20-plan Codex user's 30 prepared drafts stranded
 * behind a weekly usage limit with developer-speak remediation).
 *
 * Two shapes, two messages:
 *  - SHORT reset (retry-after known / plain 429): "retrying at ~HH:MM".
 *  - PLAN-LIMIT shape (usage_limit / quota, unknown or weekly reset): honest
 *    "may not reset for days" + the guided durable fix — a per-token worker
 *    key with `worker` routing so the subscription does judgment while volume
 *    runs on per-token pricing that effectively never rate-limits.
 * Pure + total: classification never throws; unknown inputs read as SHORT.
 */

const PLAN_LIMIT_RE = /usage[_ ]?limit|plan[_ ]?limit|usage_limit_reached|quota (?:exceeded|reached)|exceeded your current quota|weekly limit/i;

export interface CapacityAdvice {
  shape: 'short_reset' | 'plan_limit';
  /** One plain-words paragraph for the user-facing card/summary. */
  copy: string;
}

export function capacityAdvice(opts: {
  /** The provider failure text (raw). */
  reason: string;
  /** What is safely prepared/parked, in plain words (e.g. "all 30 drafts are prepared and saved"). */
  preparedNote?: string;
  /** Known retry time, if the provider said. */
  retryAtIso?: string;
}): CapacityAdvice {
  const reason = (opts.reason ?? '').slice(0, 500);
  const prepared = opts.preparedNote?.trim()
    ? `${opts.preparedNote.trim()} Nothing was lost and nothing was sent. `
    : '';
  if (PLAN_LIMIT_RE.test(reason)) {
    return {
      shape: 'plan_limit',
      copy:
        `${prepared}Your AI plan's usage limit is reached, and on this plan it may not reset for days. `
        + 'Two ways forward: (1) add a pay-per-use worker model (about a 2-minute setup: Settings → Models → add a BYO key, routing mode "worker") — your main model keeps doing the thinking while the heavy lifting runs on the new key, and this stops happening; '
        + 'or (2) wait — the work resumes automatically when your limit resets.',
    };
  }
  const when = opts.retryAtIso
    ? (() => { try { return new Date(opts.retryAtIso!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch { return null; } })()
    : null;
  return {
    shape: 'short_reset',
    copy:
      `${prepared}The AI provider hit a temporary rate limit. `
      + (when ? `I'll retry automatically at about ${when}.` : "I'll retry automatically in a few minutes."),
  };
}
