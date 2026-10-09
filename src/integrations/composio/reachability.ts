/**
 * Whether this computer could reach Composio, in plain words.
 *
 * A failed Composio read must never look like "no apps connected": the owner
 * sees why the list or the connect link did not load. The words come from the
 * network error's own codes (undici's `cause.code`, the SDK's connection error
 * names), never from provider text, so no secret a provider echoes can reach
 * the screen or the log.
 */

/** How long a Connect screen read waits on Composio before it answers with
 * what it has and why the rest is missing. */
export const COMPOSIO_DASHBOARD_READ_DEADLINE_MS = 20_000;

const CERTIFICATE_CODE = /CERT|SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL/;
const LOOKUP_CODE = /^(ENOTFOUND|EAI_AGAIN|EAI_NONAME)$/;
const TIMEOUT_CODE = /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$|TimeoutError$/;
const DROPPED_CODE = /^(ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|UND_ERR_SOCKET|UND_ERR_CLOSED)$/;
const CONNECTION_NAME = /^(APIConnectionError|FetchError)$/;

/** The error's own codes and class names, through its cause chain. */
export function composioErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && record.code.trim()) codes.push(record.code.trim());
    if (typeof record.name === 'string' && record.name.trim() && record.name !== 'Error') codes.push(record.name.trim());
    current = record.cause;
  }
  return [...new Set(codes)];
}

/** A failure's message with its codes, for a provider-facing reason string. */
export function composioErrorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const codes = composioErrorCodes(err).filter((code) => !message.includes(code));
  return codes.length ? `${message} (${codes.join(', ')})` : message;
}

/** Plain words for why Composio could not be reached, or null when the
 * failure is not about reaching it. A recorded reason string is read by the
 * same codes it carries. */
export function composioReachabilityProblem(err: unknown): string | null {
  const codes = typeof err === 'string' ? err.match(/[A-Z][A-Z0-9_]{3,}|[A-Za-z]+Error\b/g) ?? [] : composioErrorCodes(err);
  const message = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
  if (codes.some((code) => CERTIFICATE_CODE.test(code))) {
    return 'this network’s security certificate isn’t trusted (a proxy or antivirus that inspects web traffic often causes this)';
  }
  if (codes.some((code) => LOOKUP_CODE.test(code))) return 'Composio’s address couldn’t be found on this network';
  if (codes.some((code) => TIMEOUT_CODE.test(code)) || /deadline exceeded|did not answer/i.test(message)) {
    return 'Composio didn’t answer in time';
  }
  if (codes.some((code) => DROPPED_CODE.test(code))) return 'the connection to Composio was refused or dropped';
  if (codes.some((code) => CONNECTION_NAME.test(code)) || /\bfetch failed\b/i.test(message)) {
    return 'the network request to Composio failed';
  }
  return null;
}

/** Plain words for a failed Composio read: why it could not be reached, a
 * rejected key, or that the read did not load. */
export function composioReadProblem(reason: unknown): string {
  const reachability = composioReachabilityProblem(reason);
  if (reachability) return reachability;
  const text = typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
  if (/\bHTTP (401|403)\b/.test(text)) return 'Composio rejected the saved API key';
  return 'Composio didn’t return the list';
}

/** Settle within `ms`: the work's own result, or a deadline error. The work
 * keeps running and fills its caches when it finishes. */
export function withComposioDeadline<T>(work: Promise<T>, ms = COMPOSIO_DASHBOARD_READ_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Composio did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  work.catch(() => { /* a late failure after the deadline is the caller's cache's concern */ });
  return Promise.race([work, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}
