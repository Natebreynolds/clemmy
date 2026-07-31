/** Display helpers shared by server and client admin components. */

/**
 * Always rendered in UTC. Some of these values are printed by a server
 * component and some by a client component; a locale-local format would make
 * the same timestamp read differently depending on which side drew it.
 */
const WHEN = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${WHEN.format(d)} UTC`;
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/** `<input type="date">` wants YYYY-MM-DD; the API wants a timestamptz. */
export function dateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** End-of-day UTC, so "expires Aug 1" means the whole of Aug 1 is still valid. */
export function dateInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function keyLabel(prefix: string, last4: string): string {
  return `${prefix}…${last4}`;
}

export function isExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t < now;
}
