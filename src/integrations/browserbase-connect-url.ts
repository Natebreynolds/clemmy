/** Whether a Browserbase connect URL belongs to this exact session. Browserbase
 * serves sessions from regional hosts (connect.<region>.browserbase.com) and
 * binds the URL to its session either by `sessionId` or by a session
 * `signingKey`; anything else (another host, credentials, a path, a second
 * identity) is refused. */
const CONNECT_HOST = /^connect(?:\.[a-z0-9-]{1,32})?\.browserbase\.com$/;

export function browserbaseConnectUrlFor(value: unknown, sessionId: string): string | null {
  if (typeof value !== 'string' || value.length > 16384) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'wss:' || !CONNECT_HOST.test(url.hostname) || (url.port && url.port !== '443')
    || url.username || url.password || url.hash || url.pathname !== '/') return null;
  const sessionIds = url.searchParams.getAll('sessionId');
  const signingKeys = url.searchParams.getAll('signingKey');
  if (sessionIds.length > 1 || signingKeys.length > 1) return null;
  if (sessionIds.length === 1 && sessionIds[0] !== sessionId) return null;
  if (sessionIds.length === 0 && !signingKeys[0]) return null;
  return url.href;
}
