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

// Does a single cron field (wildcard, step "*/N", range "1-5", list "0,30", or a
// literal like "9") match a value?
function fieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

/**
 * Next fire time (ISO) for a 5-field cron expr, scanning forward at minute
 * resolution for up to 48h. Returns null for an invalid expr or no match in the
 * window. Extracted from orchestration-tools so any surface (e.g. the Slack
 * command center's "Upcoming" section) can compute next-run without importing the
 * MCP tool layer. `now` is injectable for tests.
 */
export function getNextRun(expr: string, now: Date = new Date()): string | null {
  if (!validateCronExpression(expr)) return null;
  const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/);
  for (let offset = 1; offset <= 2880; offset += 1) {
    const t = new Date(now.getTime() + offset * 60_000);
    if (
      fieldMatch(minF, t.getMinutes()) &&
      fieldMatch(hourF, t.getHours()) &&
      fieldMatch(domF, t.getDate()) &&
      fieldMatch(monF, t.getMonth() + 1) &&
      fieldMatch(dowF, t.getDay())
    ) {
      return t.toISOString();
    }
  }
  return null;
}
