import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  certFingerprint,
  ensureMobileTlsIdentity,
  pemCertToDer,
  rotateMobileTlsIdentity,
} from './mobile-tls.js';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mobile-tls-'));
}

test('mints a persistent identity and returns the same one on subsequent calls', () => {
  const stateDir = freshDir();
  try {
    const first = ensureMobileTlsIdentity({ stateDir });
    assert.match(first.certPem, /BEGIN CERTIFICATE/);
    assert.match(first.keyPem, /BEGIN (EC )?PRIVATE KEY/);
    assert.ok(first.fingerprint.length >= 40, 'fingerprint is a base64url sha-256');

    const second = ensureMobileTlsIdentity({ stateDir });
    assert.equal(second.certPem, first.certPem);
    assert.equal(second.fingerprint, first.fingerprint);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fingerprint is base64url(sha256(cert DER)) — the exact value the iOS app pins', () => {
  const stateDir = freshDir();
  try {
    const identity = ensureMobileTlsIdentity({ stateDir });
    const expected = createHash('sha256').update(pemCertToDer(identity.certPem)).digest('base64url');
    assert.equal(identity.fingerprint, expected);
    assert.equal(certFingerprint(identity.certPem), expected);
    // base64url alphabet only — the value rides in a QR query param unescaped.
    assert.doesNotMatch(identity.fingerprint, /[+/=]/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('private key is written 0600', () => {
  const stateDir = freshDir();
  try {
    ensureMobileTlsIdentity({ stateDir });
    const mode = statSync(path.join(stateDir, 'mobile-tls', 'key.pem')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('rotation mints a new certificate with a new fingerprint', () => {
  const stateDir = freshDir();
  try {
    const before = ensureMobileTlsIdentity({ stateDir });
    const after = rotateMobileTlsIdentity({ stateDir });
    assert.notEqual(after.fingerprint, before.fingerprint);
    // And the rotated identity is what persists.
    const reread = ensureMobileTlsIdentity({ stateDir });
    assert.equal(reread.fingerprint, after.fingerprint);
    assert.equal(readFileSync(path.join(stateDir, 'mobile-tls', 'cert.pem'), 'utf8'), after.certPem);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('malformed PEM is rejected', () => {
  assert.throws(() => certFingerprint('not a pem'), /malformed/);
});
