import { z } from 'zod';

const instant = z.string().datetime({ offset: true });

/** An absolute occurrence, with no implicit host timezone or annual repeat. */
export function parseWorkflowOnceAt(value: unknown): { ok: true; at: string; atMs: number } | { ok: false; error: string } {
  const parsed = instant.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'run_at must be an ISO 8601 date and time with Z or an explicit UTC offset.' };
  const atMs = Date.parse(parsed.data);
  if (!Number.isSafeInteger(atMs) || atMs < 0) return { ok: false, error: 'run_at must be a valid absolute date and time.' };
  return { ok: true, at: new Date(atMs).toISOString(), atMs };
}
