import { createHash } from 'node:crypto';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

/** Local publication ownership, never an account or execution grant. Legacy
 * rows keep exact-content identity until an explicit connection issues a nonce. */
export function connectedCliRevision(value: unknown): string | null {
  if (!record(value)) return null;
  if (Object.hasOwn(value, 'connectionRevision')) {
    const revision = value.connectionRevision;
    return typeof revision === 'string' && revision.length > 0 && revision.length <= 128
      && !/[\u0000-\u0020\u007f]/.test(revision) ? revision : null;
  }
  return `legacy:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

export function cliHealthMatchesConnection(connected: unknown, health: unknown): boolean {
  if (!record(connected) || !record(health)
    || !Object.hasOwn(connected, 'id') || !Object.hasOwn(connected, 'command')
    || !Object.hasOwn(health, 'id') || !Object.hasOwn(health, 'command')
    || typeof connected.id !== 'string' || !connected.id || typeof connected.command !== 'string' || !connected.command
    || connected.id !== health.id || connected.command !== health.command) return false;
  const revision = connectedCliRevision(connected);
  if (!revision) return false;
  return (!Object.hasOwn(connected, 'connectionRevision') && !Object.hasOwn(health, 'connectionRevision'))
    || health.connectionRevision === revision;
}
