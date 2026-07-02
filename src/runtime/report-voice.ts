/**
 * Human voice for report-back bodies.
 *
 * Background-task workers are PROMPTED to end their final text with an audit
 * ledger — `## Completed` / `## Evidence / Verification` / `## Remaining Risks`
 * / `## Next Step` (see `buildWorkerPrompt` in execution/background-tasks.ts).
 * That ledger is exactly right for the MODEL (it flows to the origin session and
 * to `background_task_status`), but a HUMAN opening the completion notification
 * just wants the answer — not a verification worksheet.
 *
 * `humanizeReportBody` strips the machine scaffolding from the HUMAN-FACING
 * notification body ONLY. It never changes what the model receives anywhere.
 * Pure and fail-open: any error (or empty result) returns the original text.
 */

// A standalone audit heading (`## Evidence / Verification` or `## Remaining
// Risks`, tolerant of `###` and spacing). Everything from the FIRST such heading
// onward is the audit ledger the human doesn't need.
const AUDIT_SECTION_RE = /^#{2,3}[ \t]*(?:Evidence[ \t]*\/[ \t]*Verification|Remaining Risks)[ \t]*\r?$/im;

// A leading machine framing token like `[background task bg-x completed] `.
const LEADING_MACHINE_FRAMING_RE = /^\[(?:background task|workflow run) [^\]]+\]\s*/;

export function humanizeReportBody(text: string): string {
  try {
    if (!text) return text;
    let out = text;
    // (a) Drop the audit ledger: keep everything BEFORE the first Evidence /
    //     Remaining-Risks heading (the actual answer/summary + any `## Completed`).
    const match = AUDIT_SECTION_RE.exec(out);
    if (match) out = out.slice(0, match.index);
    // (b) Strip a leading machine framing token, if present.
    out = out.replace(LEADING_MACHINE_FRAMING_RE, '');
    // (c) Collapse 3+ consecutive newlines to a single blank line.
    out = out.replace(/\n{3,}/g, '\n\n');
    out = out.trim();
    // Never hand back an empty body — fall back to the original text.
    return out.length ? out : text;
  } catch {
    return text;
  }
}
