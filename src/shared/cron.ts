/**
 * Canonical 5-field cron SYNTAX validator — the single source of truth.
 *
 * Collapsed from six byte-identical copies that had drifted across the
 * codebase (orchestration-tools, console-routes, workflow-validator,
 * workflow-scheduler, daemon/runner, and workflow-schedule-tools'
 * `isValidCron`). A pure leaf module with NO imports, so any layer can use
 * it without cycle risk.
 *
 * Scope: SYNTAX only — five space-separated fields of the allowed shape.
 * Runtime "does this cron fire at time T?" semantics are a deliberately
 * separate concern (workflow-scheduler.ts:cronMatches). The webhook ingress
 * keeps its own deliberately-looser pre-check (allows month/day names) — not
 * a duplicate of this strict validator.
 */
export function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(part));
}
