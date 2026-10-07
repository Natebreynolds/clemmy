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
 * The identity is minted once with Node's crypto and persisted under the
 * state dir. Rotation is explicit (rotateMobileTlsIdentity) — a rotated cert
 * invalidates the pin baked into every paired app, so each rotation requires
 * re-pairing by QR. That is the recovery story, not a failure mode: the pin
 * travels only ever inside a QR the user scans on purpose.
 */
import 'reflect-metadata';
import { createHash, createPrivateKey, randomBytes, webcrypto, X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509';
import { BASE_DIR } from '../config.js';
import { withFileLock } from './atomic-json.js';
import { syncDirectoryMetadata } from './sync-directory.js';
import { assertWindowsPrivateFilesystem } from './windows-private-filesystem.js';

export interface MobileTlsIdentity {
  keyPem: string;
  certPem: string;
  /** base64url(SHA-256(certificate DER)) — what the iOS app pins. */
  fingerprint: string;
}

export interface MobileTlsOptions {
  stateDir?: string;
}

const MAX_IDENTITY_FILE_BYTES = 64 * 1024;
const GENERATION_TIMEOUT_MS = 5_000;

function stateDir(opts?: MobileTlsOptions): string {
  return path.resolve(opts?.stateDir ?? path.join(BASE_DIR, 'state'));
}

function tlsDir(opts?: MobileTlsOptions): string { return path.join(stateDir(opts), 'mobile-tls'); }

function statOrMissing(target: string): BigIntStats | null {
  try { return lstatSync(target, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
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

function requirePrivateDirectory(dir: string, hardenNew = false): void {
  const previous = statOrMissing(dir);
  if (!previous) throw new Error('mobile-tls: identity directory is missing');
  const stat = lstatSync(dir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('mobile-tls: identity directory is unsafe');
  if (process.platform === 'win32') assertWindowsPrivateFilesystem(dir, stat, 'directory', hardenNew);
  else if ((stat.mode & 0o777n) !== 0o700n) throw new Error('mobile-tls: identity directory is not private');
}

function readIdentityFile(target: string, privateKey: boolean): string {
  const entry = lstatSync(target, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n
    || entry.size <= 0n || entry.size > BigInt(MAX_IDENTITY_FILE_BYTES)) throw new Error('mobile-tls: identity file is unsafe');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (before.dev !== entry.dev || before.ino !== entry.ino || before.nlink !== 1n) throw new Error('mobile-tls: identity file changed');
    if (privateKey) {
      if (process.platform === 'win32') assertWindowsPrivateFilesystem(target, before, 'file');
      else if ((before.mode & 0o777n) !== 0o600n) throw new Error('mobile-tls: private key is not private');
    }
    const bytes = readFileSync(fd, 'utf8');
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(target, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1n) throw new Error('mobile-tls: identity file changed');
    if (privateKey && process.platform === 'win32') assertWindowsPrivateFilesystem(target, after, 'file');
    return bytes;
  } finally { closeSync(fd); }
}

function readIdentity(dir: string): MobileTlsIdentity {
  const keyPem = readIdentityFile(path.join(dir, 'key.pem'), true);
  const certPem = readIdentityFile(path.join(dir, 'cert.pem'), false);
  const certificate = new X509Certificate(certPem);
  if (!certificate.checkPrivateKey(createPrivateKey(keyPem)) || !certificate.verify(certificate.publicKey)) {
    throw new Error('mobile-tls: certificate and private key do not match');
  }
  return { keyPem, certPem, fingerprint: certFingerprint(certPem) };
}

async function mintIdentity(): Promise<{ keyPem: string; certPem: string }> {
  const crypto = webcrypto as unknown as Crypto;
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const notBefore = new Date();
  const certificate = await X509CertificateGenerator.createSelfSigned({
    name: 'CN=Clementine Mobile', serialNumber: randomBytes(16).toString('hex'),
    notBefore, notAfter: new Date(notBefore.getTime() + 3650 * 24 * 60 * 60 * 1000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }, keys,
    extensions: [new SubjectAlternativeNameExtension([{ type: 'dns', value: 'clementine.local' }]),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature)],
  }, crypto);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  return { keyPem: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'pem', type: 'pkcs8' }).toString(),
    certPem: certificate.toString('pem') };
}

async function generate(dir: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // A timeout cannot publish a late crypto result: publication begins only
  // after this await succeeds. There is no executable or certificate-store dependency.
  const identity = await Promise.race([mintIdentity(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('mobile-tls: certificate generation timed out')), GENERATION_TIMEOUT_MS);
  })]).finally(() => { if (timer) clearTimeout(timer); });
  const temporary = mkdtempSync(`${dir}.new-`);
  try {
    requirePrivateDirectory(temporary, true);
    for (const [name, bytes] of [['key.pem', identity.keyPem], ['cert.pem', identity.certPem]]) {
      const target = path.join(temporary, name);
      const fd = openSync(target, 'wx', 0o600);
      try {
        if (process.platform === 'win32') assertWindowsPrivateFilesystem(target, fstatSync(fd, { bigint: true }), 'file', true);
        writeFileSync(fd, bytes, 'utf8');
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    syncDirectoryMetadata(temporary);
    const previous = statOrMissing(dir);
    if (previous) {
      requirePrivateDirectory(dir);
      // Recover an empty host directory only. No retained file is replaced.
      if (readdirSync(dir).length !== 0) throw new Error('mobile-tls: identity directory changed during generation');
      const current = lstatSync(dir, { bigint: true });
      if (current.dev !== previous.dev || current.ino !== previous.ino) throw new Error('mobile-tls: identity directory changed during generation');
      rmdirSync(dir);
    }
    // Publish the complete pair together. A crash before rename leaves no
    // partial paired identity; retained certificate/key bytes never enter here.
    renameSync(temporary, dir);
    syncDirectoryMetadata(path.dirname(dir));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/**
 * Returns the persisted identity, minting it on first use. Throws if identity
 * generation fails or the persisted files are unreadable — callers treat that as
 * "direct-app door stays closed", never as a daemon-fatal error.
 */
export async function ensureMobileTlsIdentity(opts?: MobileTlsOptions): Promise<MobileTlsIdentity> {
  mkdirSync(stateDir(opts), { recursive: true, mode: 0o700 });
  const dir = tlsDir(opts);
  return withFileLock(path.join(stateDir(opts), 'mobile-tls-identity'), async () => {
    if (statOrMissing(dir)) requirePrivateDirectory(dir);
    const key = statOrMissing(path.join(dir, 'key.pem'));
    const cert = statOrMissing(path.join(dir, 'cert.pem'));
    // A partial/corrupt retained identity requires deliberate rotation. Never
    // silently replace its key and invalidate a previously paired device.
    if (Boolean(key) !== Boolean(cert)) throw new Error('mobile-tls: identity is incomplete; rotate explicitly to re-pair');
    if (!key && !cert) await generate(dir);
    requirePrivateDirectory(dir);
    return readIdentity(dir);
  });
}

/** Discards the current identity and mints a fresh one. Every paired app must re-pair. */
export async function rotateMobileTlsIdentity(opts?: MobileTlsOptions): Promise<MobileTlsIdentity> {
  mkdirSync(stateDir(opts), { recursive: true, mode: 0o700 });
  return withFileLock(path.join(stateDir(opts), 'mobile-tls-identity'), async () => {
    rmSync(tlsDir(opts), { recursive: true, force: true });
    await generate(tlsDir(opts));
    requirePrivateDirectory(tlsDir(opts));
    return readIdentity(tlsDir(opts));
  });
}
