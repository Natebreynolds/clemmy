/**
 * Small deterministic repairs for common model-facing tool aliases.
 *
 * These aliases do not widen authority: call_tool still checks that the
 * resolved real tool is present on the active turn's first-class/deferred
 * surface before dispatch. They only prevent a guessed, familiar name from
 * bouncing when Clementine already exposes the equivalent capability.
 */

const SIMPLE_HTTP_GET_ALIASES = new Set([
  'http_fetch',
  'web_fetch',
  'web_fetch_simple',
  'fetch_url',
]);

export function isCallToolAliasName(rawName: string): boolean {
  return SIMPLE_HTTP_GET_ALIASES.has(rawName.trim().toLowerCase());
}

export interface ResolvedCallToolAlias {
  ok: true;
  targetName: string;
  targetArgs: Record<string, unknown>;
}

export interface RefusedCallToolAlias {
  ok: false;
  detail: string;
}

export type CallToolAliasResolution = ResolvedCallToolAlias | RefusedCallToolAlias;

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

const HTTP_META_MARKER = '__CLEMENTINE_HTTP_META_V1__';

function boundedHttpGetCommand(url: string): string {
  // Curl performs the one bounded network read. Its write-out JSON is appended
  // after a private marker; Python reads the same byte stream once, separates
  // metadata from the untouched body, computes the exact body digest, and emits
  // one machine-readable envelope. No temp file and no second request.
  const curl = [
    'curl',
    '--fail-with-body',
    '--silent',
    '--show-error',
    '--location',
    '--max-redirs 5',
    '--connect-timeout 10',
    '--max-time 20',
    '--max-filesize 1048576',
    "--proto '=http,https'",
    "--proto-redir '=http,https'",
    '--write-out',
    shellSingleQuote(`\\n${HTTP_META_MARKER}%{json}`),
    '--url',
    shellSingleQuote(url),
  ].join(' ');
  const python = [
    'import hashlib,json,sys',
    'raw=sys.stdin.buffer.read()',
    `marker=b"\\n${HTTP_META_MARKER}"`,
    'body,meta_raw=raw.rsplit(marker,1)',
    'meta=json.loads(meta_raw.decode("utf-8","replace"))',
    'status=int(meta.get("http_code") or 0)',
    'curl_exit=int(meta.get("exitcode") or 0)',
    'ok=curl_exit==0 and 200<=status<400',
    'result={"ok":ok,"status":status,"url":meta.get("url_effective"),"contentType":meta.get("content_type") or None,"bytes":len(body),"sha256":hashlib.sha256(body).hexdigest(),"curlExitCode":curl_exit,"error":meta.get("errormsg") or None,"body":body.decode("utf-8","replace")}',
    'print(json.dumps(result,ensure_ascii=False,separators=(",",":")))',
    'raise SystemExit(0 if ok else (curl_exit or 22))',
  ].join(';');
  return `${curl} | python3 -c ${shellSingleQuote(python)}`;
}

/**
 * Resolve only a bounded, read-only HTTP GET alias. The resulting command uses
 * curl's protocol, redirect, time, and response-size limits. Arbitrary methods,
 * headers, bodies, and credentials are refused so an alias can never smuggle a
 * mutation through a name that looks read-only.
 */
export function resolveCallToolAlias(
  rawName: string,
  args: unknown,
): CallToolAliasResolution | null {
  if (!isCallToolAliasName(rawName)) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, detail: `${rawName} requires a JSON object with one "url" field.` };
  }
  const input = args as Record<string, unknown>;
  const extraKeys = Object.keys(input).filter((key) => key !== 'url' && key !== 'method');
  if (extraKeys.length > 0) {
    return {
      ok: false,
      detail: `${rawName} is a bounded GET alias and does not accept: ${extraKeys.join(', ')}.`,
    };
  }
  const method = typeof input.method === 'string' ? input.method.trim().toUpperCase() : 'GET';
  if (method !== 'GET') {
    return { ok: false, detail: `${rawName} permits GET only; use the real write/send tool for ${method}.` };
  }
  if (typeof input.url !== 'string' || !input.url.trim()) {
    return { ok: false, detail: `${rawName} requires a non-empty "url" string.` };
  }
  if (input.url.length > 4_096) {
    return { ok: false, detail: `${rawName} refused a URL longer than 4096 characters.` };
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { ok: false, detail: `${rawName} requires a valid absolute http(s) URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, detail: `${rawName} permits only http:// or https:// URLs.` };
  }
  if (url.username || url.password) {
    return { ok: false, detail: `${rawName} refuses credentials embedded in a URL.` };
  }

  const normalizedUrl = url.toString();
  return {
    ok: true,
    targetName: 'run_shell_command',
    targetArgs: {
      command: boundedHttpGetCommand(normalizedUrl),
      cwd: null,
      timeout_ms: 30_000,
    },
  };
}
