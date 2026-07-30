/**
 * TLS identity for the direct-app mobile door.
 *
 * The iOS app connects straight to the daemon over the local network — no
 * tunnel in the middle. Browsers cannot trust a self-signed certificate, but a
 * native app can pin one: the QR code that pairs the phone carries this
 * certificate's SHA-256 fingerprint, and the app accepts exactly that
 * certificate and nothing else. That is strictly stronger than the tunnel
 * path, where TLS terminated at a third party that could read every byte.
 *
 * The identity is minted once with the system openssl and persisted under the
 * state dir. Rotation is explicit (rotateMobileTlsIdentity) — a rotated cert
 * invalidates the pin baked into every paired app, so each rotation requires
 * re-pairing by QR. That is the recovery story, not a failure mode: the pin
 * travels only ever inside a QR the user scans on purpose.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export interface MobileTlsIdentity {
  keyPem: string;
  certPem: string;
  /** base64url(SHA-256(certificate DER)) — what the iOS app pins. */
  fingerprint: string;
}

export interface MobileTlsOptions {
  stateDir?: string;
}

function tlsDir(opts?: MobileTlsOptions): string {
  return path.join(opts?.stateDir ?? path.join(BASE_DIR, 'state'), 'mobile-tls');
}

/**
 * Extracts the DER bytes from a single-certificate PEM. Exported for the
 * fingerprint test to assert against an independently computed hash.
 */
export function pemCertToDer(certPem: string): Buffer {
  const match = certPem.match(/-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/);
  if (!match) throw new Error('mobile-tls: certificate PEM is malformed');
  return Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
}

export function certFingerprint(certPem: string): string {
  return createHash('sha256').update(pemCertToDer(certPem)).digest('base64url');
}

function generate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  // P-256 to match the device-session curve; 10 years because expiry is not a
  // control here — the app pins the exact certificate, and rotation is a
  // deliberate re-pair, not a calendar event.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-keyout', keyPath, '-out', certPath,
    '-days', '3650', '-nodes',
    '-subj', '/CN=Clementine Mobile',
    '-addext', 'subjectAltName=DNS:clementine.local',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Key material never needs group/world access.
  writeFileSync(keyPath, readFileSync(keyPath), { mode: 0o600 });
}

/**
 * Returns the persisted identity, minting it on first use. Throws if openssl
 * is unavailable or the persisted files are unreadable — callers treat that as
 * "direct-app door stays closed", never as a daemon-fatal error.
 */
export function ensureMobileTlsIdentity(opts?: MobileTlsOptions): MobileTlsIdentity {
  const dir = tlsDir(opts);
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    generate(dir);
  }
  const keyPem = readFileSync(keyPath, 'utf8');
  const certPem = readFileSync(certPath, 'utf8');
  return { keyPem, certPem, fingerprint: certFingerprint(certPem) };
}

/** Discards the current identity and mints a fresh one. Every paired app must re-pair. */
export function rotateMobileTlsIdentity(opts?: MobileTlsOptions): MobileTlsIdentity {
  rmSync(tlsDir(opts), { recursive: true, force: true });
  return ensureMobileTlsIdentity(opts);
}
