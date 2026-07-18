/**
 * Non-extractable device keypair.
 *
 * This is what makes a stolen session cookie worthless. The private key is
 * generated with `extractable: false`, so `crypto.subtle.exportKey` on it
 * throws and there is NO code path — not ours, not injected script, not the
 * devtools console — that can read the private bits back out. It can only be
 * *used* to sign.
 *
 * A `CryptoKey` handle survives structured clone, so IndexedDB stores the live
 * key object rather than any serialization of it. The key never leaves the
 * browser's crypto implementation.
 *
 * Loss of this key is recoverable (re-pair from the desktop, or PIN), so
 * durability is not worth trading for extractability.
 */

const DB_NAME = 'clem-device';
const STORE = 'keys';
const KEY_ID = 'device-signing-key';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let cached: CryptoKeyPair | null = null;
let inflight: Promise<CryptoKeyPair> | null = null;

/**
 * Returns this device's keypair, generating and persisting it on first call.
 * Concurrent callers share one generation, so a burst of parallel requests at
 * startup cannot mint competing keys.
 */
export function ensureDeviceKey(): Promise<CryptoKeyPair> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    const db = await openDb();
    const existing = await idbGet<CryptoKeyPair>(db, KEY_ID);
    if (existing?.privateKey && existing?.publicKey) {
      cached = existing;
      return existing;
    }
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      // false = non-extractable. This is the entire security property.
      false,
      ['sign', 'verify'],
    );
    await idbPut(db, KEY_ID, pair);
    cached = pair;
    return pair;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** The public half, in the JWK shape the daemon stores. */
export async function exportPublicJwk(): Promise<JsonWebKey> {
  const pair = await ensureDeviceKey();
  return crypto.subtle.exportKey('jwk', pair.publicKey) as Promise<JsonWebKey>;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Signs a proof binding this request to (method, path, session, time, nonce).
 *
 * The signature covers the exact path so a proof captured on one route cannot
 * be replayed on another, and the session fingerprint so it cannot be moved to
 * a different session belonging to the same key.
 */
export async function signProof(
  method: string,
  path: string,
  sessionFingerprint: string,
): Promise<string> {
  const pair = await ensureDeviceKey();
  const header = b64urlJson({ alg: 'ES256', typ: 'clem-dpop+jws' });
  const payload = b64urlJson({
    htm: method.toUpperCase(),
    htu: path.split('?')[0],
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    sfp: sessionFingerprint,
  });
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  // WebCrypto emits raw r||s; the daemon verifies with dsaEncoding
  // 'ieee-p1363' to match. Do not "helpfully" DER-encode this.
  return `${header}.${payload}.${b64url(signature)}`;
}

/** True when this browser can do device binding at all. */
export function deviceKeySupported(): boolean {
  return typeof indexedDB !== 'undefined'
    && typeof crypto !== 'undefined'
    && typeof crypto.subtle !== 'undefined';
}
