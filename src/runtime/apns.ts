/**
 * Direct APNs delivery — the daemon talks to Apple itself, token-based auth,
 * no push gateway or third-party relay in between. The native iOS app
 * registers its device token over the paired mobile session, and every loud
 * notification fans out here alongside the other destinations.
 *
 * Configuration (either source; env wins per key):
 *   env:  APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_PATH (or APNS_KEY_P8 = pem body),
 *         APNS_TOPIC, APNS_ENV ('sandbox' | 'production')
 *   file: state/apns.json { keyId, teamId, keyPath?, key?, topic?, environment? }
 *
 * Until a key is configured the module reports unconfigured and the delivery
 * leg fails soft — registrations are still accepted, so pushes start flowing
 * the moment the key lands, with no re-pairing.
 */
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

/** Xcode debug/dev builds get sandbox tokens; TestFlight/App Store get production. */
export type ApnsEnvironment = 'sandbox' | 'production';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** PKCS#8 PEM contents of the .p8 signing key. */
  key: string;
  /** The app's bundle id. */
  topic: string;
  environment: ApnsEnvironment;
}

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  /** Apple's reason string on failure, e.g. 'BadDeviceToken', 'Unregistered'. */
  reason?: string;
}

/** Matches apps/ios bundle id; override via topic config if the app id changes. */
const DEFAULT_TOPIC = 'ai.breakthroughcoaching.clem';

export interface ApnsConfigOptions {
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

function configFile(opts?: ApnsConfigOptions): string {
  return path.join(opts?.stateDir ?? path.join(BASE_DIR, 'state'), 'apns.json');
}

export function loadApnsConfig(opts?: ApnsConfigOptions): ApnsConfig | null {
  const env = opts?.env ?? process.env;
  let file: Record<string, unknown> = {};
  const filePath = configFile(opts);
  if (existsSync(filePath)) {
    try { file = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>; } catch { /* unreadable = unset */ }
  }
  const str = (envKey: string, fileKey: string): string => {
    const fromEnv = env[envKey]?.trim();
    if (fromEnv) return fromEnv;
    const fromFile = file[fileKey];
    return typeof fromFile === 'string' ? fromFile.trim() : '';
  };

  const keyId = str('APNS_KEY_ID', 'keyId');
  const teamId = str('APNS_TEAM_ID', 'teamId');
  let key = str('APNS_KEY_P8', 'key');
  if (!key) {
    const keyPath = str('APNS_KEY_PATH', 'keyPath');
    if (keyPath && existsSync(keyPath)) {
      try { key = readFileSync(keyPath, 'utf8'); } catch { /* unreadable = unset */ }
    }
  }
  if (!keyId || !teamId || !key) return null;

  const environment = str('APNS_ENV', 'environment').toLowerCase() === 'production' ? 'production' : 'sandbox';
  return {
    keyId,
    teamId,
    key,
    topic: str('APNS_TOPIC', 'topic') || DEFAULT_TOPIC,
    environment,
  };
}

export function isApnsConfigured(opts?: ApnsConfigOptions): boolean {
  return loadApnsConfig(opts) !== null;
}

function base64url(input: Buffer | string): string {
  return (typeof input === 'string' ? Buffer.from(input) : input).toString('base64url');
}

/**
 * Provider JWT. Apple accepts tokens 20–60 minutes old; we cache and re-mint
 * at 45. ES256 must be raw r||s (ieee-p1363), NOT DER — the same encoding
 * mismatch that once broke device-session verification, in the other
 * direction.
 */
let cachedToken: { token: string; mintedAt: number; keyId: string } | null = null;
const TOKEN_MAX_AGE_MS = 45 * 60 * 1000;

export function mintApnsJwt(config: Pick<ApnsConfig, 'keyId' | 'teamId' | 'key'>, nowMs = Date.now()): string {
  if (cachedToken && cachedToken.keyId === config.keyId && nowMs - cachedToken.mintedAt < TOKEN_MAX_AGE_MS) {
    return cachedToken.token;
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }));
  const signingInput = `${header}.${claims}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: config.key, dsaEncoding: 'ieee-p1363' });
  const token = `${signingInput}.${base64url(signature)}`;
  cachedToken = { token, mintedAt: nowMs, keyId: config.keyId };
  return token;
}

/** Test seam. */
export function _resetApnsTokenCacheForTests(): void {
  cachedToken = null;
}

export function apnsHost(environment: ApnsEnvironment): string {
  return environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';
}

export interface ApnsAlert {
  deviceToken: string;
  title: string;
  body: string;
  /** Deep link the app opens on tap; carried outside `aps`. */
  url?: string;
}

export function buildApnsPayload(alert: Pick<ApnsAlert, 'title' | 'body' | 'url'>): Record<string, unknown> {
  return {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: 'default',
    },
    ...(alert.url ? { url: alert.url } : {}),
  };
}

/**
 * One alert to one device. Opens a fresh HTTP/2 session per send — loud
 * notifications are rare enough that connection pooling would be complexity
 * without a measurable win; revisit if delivery volume ever says otherwise.
 */
export function sendApnsAlert(alert: ApnsAlert, opts?: ApnsConfigOptions): Promise<ApnsSendResult> {
  const config = loadApnsConfig(opts);
  if (!config) {
    return Promise.resolve({ ok: false, status: 0, reason: 'NotConfigured' });
  }
  const token = mintApnsJwt(config);
  const payload = JSON.stringify(buildApnsPayload(alert));

  return new Promise((resolve) => {
    const session = http2.connect(apnsHost(config.environment));
    const finish = (result: ApnsSendResult): void => {
      session.close();
      resolve(result);
    };
    session.on('error', (err) => finish({ ok: false, status: 0, reason: err.message }));

    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${alert.deviceToken}`,
      'authorization': `bearer ${token}`,
      'apns-topic': config.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 300),
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.on('response', (headers) => { status = Number(headers[':status'] ?? 0); });
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('error', (err) => finish({ ok: false, status: 0, reason: err.message }));
    req.on('end', () => {
      if (status === 200) { finish({ ok: true, status }); return; }
      let reason: string | undefined;
      try { reason = (JSON.parse(body) as { reason?: string }).reason; } catch { /* body optional */ }
      finish({ ok: false, status, reason });
    });
    req.end(payload);
  });
}

/** Reasons that mean the token is dead and the destination should be reaped. */
export function isApnsTokenGone(result: ApnsSendResult): boolean {
  return result.status === 410
    || result.reason === 'Unregistered'
    || result.reason === 'BadDeviceToken'
    || result.reason === 'DeviceTokenNotForTopic';
}
