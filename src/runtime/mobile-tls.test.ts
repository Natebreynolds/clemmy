import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, createServer, type TLSSocket } from 'node:tls';
import { assertWindowsPrivateFilesystem } from './windows-private-filesystem.js';
import {
  certFingerprint,
  ensureMobileTlsIdentity,
  pemCertToDer,
  rotateMobileTlsIdentity,
} from './mobile-tls.js';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mobile-tls-'));
}

test('mints a persistent identity and returns the same one on subsequent calls', async () => {
  const stateDir = freshDir();
  try {
    const first = await ensureMobileTlsIdentity({ stateDir });
    assert.match(first.certPem, /BEGIN CERTIFICATE/);
    assert.match(first.keyPem, /BEGIN (EC )?PRIVATE KEY/);
    assert.ok(first.fingerprint.length >= 40, 'fingerprint is a base64url sha-256');

    const second = await ensureMobileTlsIdentity({ stateDir });
    assert.equal(second.certPem, first.certPem);
    assert.equal(second.fingerprint, first.fingerprint);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('fingerprint is base64url(sha256(cert DER)) — the exact value the iOS app pins', async () => {
  const stateDir = freshDir();
  try {
    const identity = await ensureMobileTlsIdentity({ stateDir });
    const expected = createHash('sha256').update(pemCertToDer(identity.certPem)).digest('base64url');
    assert.equal(identity.fingerprint, expected);
    assert.equal(certFingerprint(identity.certPem), expected);
    // base64url alphabet only — the value rides in a QR query param unescaped.
    assert.doesNotMatch(identity.fingerprint, /[+/=]/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('private key has real host privacy protection', async () => {
  const stateDir = freshDir();
  try {
    await ensureMobileTlsIdentity({ stateDir });
    const target = path.join(stateDir, 'mobile-tls', 'key.pem');
    if (process.platform === 'win32') {
      assertWindowsPrivateFilesystem(target, lstatSync(target, { bigint: true }), 'file');
      const dir = path.dirname(target);
      assertWindowsPrivateFilesystem(dir, lstatSync(dir, { bigint: true }), 'directory');
    } else assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('rotation mints a new certificate with a new fingerprint', async () => {
  const stateDir = freshDir();
  try {
    const before = await ensureMobileTlsIdentity({ stateDir });
    const after = await rotateMobileTlsIdentity({ stateDir });
    assert.notEqual(after.fingerprint, before.fingerprint);
    // And the rotated identity is what persists.
    const reread = await ensureMobileTlsIdentity({ stateDir });
    assert.equal(reread.fingerprint, after.fingerprint);
    assert.equal(readFileSync(path.join(stateDir, 'mobile-tls', 'cert.pem'), 'utf8'), after.certPem);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('malformed PEM is rejected', () => {
  assert.throws(() => certFingerprint('not a pem'), /malformed/);
});

test('first generation requires no PATH executable and retains P-256, name, SAN and lifetime', async () => {
  const stateDir = freshDir();
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = '';
    const identity = await ensureMobileTlsIdentity({ stateDir });
    const key = createPrivateKey(identity.keyPem);
    const cert = new X509Certificate(identity.certPem);
    assert.equal(key.asymmetricKeyType, 'ec');
    assert.equal(key.asymmetricKeyDetails?.namedCurve, 'prime256v1');
    assert.equal(cert.subject, 'CN=Clementine Mobile');
    assert.equal(cert.issuer, cert.subject);
    assert.equal(cert.subjectAltName, 'DNS:clementine.local');
    assert.ok(cert.checkPrivateKey(key));
    assert.ok(cert.verify(cert.publicKey));
    assert.equal(Date.parse(cert.validTo) - Date.parse(cert.validFrom), 3650 * 24 * 60 * 60 * 1000);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('valid existing OpenSSL-style EC key and certificate bytes are retained exactly', async () => {
  const stateDir = freshDir();
  try {
    const identity = await ensureMobileTlsIdentity({ stateDir });
    const keyPem = createPrivateKey(identity.keyPem).export({ type: 'sec1', format: 'pem' }).toString().replace(/\n/g, '\r\n');
    const certPem = identity.certPem.replace(/\n/g, '\r\n');
    writeFileSync(path.join(stateDir, 'mobile-tls', 'key.pem'), keyPem);
    writeFileSync(path.join(stateDir, 'mobile-tls', 'cert.pem'), certPem);
    const retained = await ensureMobileTlsIdentity({ stateDir });
    assert.equal(retained.keyPem, keyPem);
    assert.equal(retained.certPem, certPem);
    assert.equal(retained.fingerprint, identity.fingerprint);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('a partial retained identity refuses without replacing the surviving paired key', async () => {
  const stateDir = freshDir();
  try {
    const identity = await ensureMobileTlsIdentity({ stateDir });
    rmSync(path.join(stateDir, 'mobile-tls', 'cert.pem'));
    await assert.rejects(ensureMobileTlsIdentity({ stateDir }), /incomplete.*rotate explicitly/);
    assert.equal(readFileSync(path.join(stateDir, 'mobile-tls', 'key.pem'), 'utf8'), identity.keyPem);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('a mismatched retained key refuses without repairing or rotating either file', async () => {
  const stateDir = freshDir();
  const otherDir = freshDir();
  try {
    const identity = await ensureMobileTlsIdentity({ stateDir });
    const other = await ensureMobileTlsIdentity({ stateDir: otherDir });
    const keyPath = path.join(stateDir, 'mobile-tls', 'key.pem');
    writeFileSync(keyPath, other.keyPem);
    await assert.rejects(ensureMobileTlsIdentity({ stateDir }), /do not match/);
    assert.equal(readFileSync(keyPath, 'utf8'), other.keyPem);
    assert.equal(readFileSync(path.join(stateDir, 'mobile-tls', 'cert.pem'), 'utf8'), identity.certPem);
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(otherDir, { recursive: true, force: true }); }
});

test('a hard-linked retained key is refused', async () => {
  const stateDir = freshDir();
  try {
    await ensureMobileTlsIdentity({ stateDir });
    linkSync(path.join(stateDir, 'mobile-tls', 'key.pem'), path.join(stateDir, 'unexpected-key-alias'));
    await assert.rejects(ensureMobileTlsIdentity({ stateDir }), /identity file is unsafe/);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('concurrent first use and a fresh process retain one paired identity', async () => {
  const stateDir = freshDir();
  try {
    const identities = await Promise.all([ensureMobileTlsIdentity({ stateDir }), ensureMobileTlsIdentity({ stateDir })]);
    assert.equal(identities[0].fingerprint, identities[1].fingerprint);
    assert.equal(identities[0].keyPem, identities[1].keyPem);
    const source = new URL('./mobile-tls.ts', import.meta.url);
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import {ensureMobileTlsIdentity} from ${JSON.stringify(source.href)}; const i=await ensureMobileTlsIdentity({stateDir:${JSON.stringify(stateDir)}}); console.log(i.fingerprint);`], {
      env: { ...process.env, CLEMENTINE_HOME: stateDir }, encoding: 'utf8', timeout: 60_000, maxBuffer: 4096,
    });
    assert.equal(child.status, 0, 'fresh isolated reader must finish');
    assert.equal(child.stdout.trim(), identities[0].fingerprint);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('generated certificate completes real loopback TLS; a wrong pin is rejected', async () => {
  const stateDir = freshDir();
  const sockets = new Set<TLSSocket>();
  const identity = await ensureMobileTlsIdentity({ stateDir });
  const server = createServer({ key: identity.keyPem, cert: identity.certPem }, (socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.end('controlled TLS bytes');
  });
  server.on('tlsClientError', () => { /* intentional wrong-pin control */ });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const read = (expectedPin: string) => new Promise<string>((resolve, reject) => {
      const client = connect({ host: '127.0.0.1', port: address.port, servername: 'clementine.local', ca: identity.certPem,
        rejectUnauthorized: true, checkServerIdentity: (_hostname, peer) => {
          const actual = createHash('sha256').update(peer.raw).digest('base64url');
          return actual === expectedPin ? undefined : new Error('controlled pin mismatch');
        } });
      sockets.add(client); client.once('close', () => sockets.delete(client));
      client.setTimeout(5_000, () => client.destroy(new Error('controlled TLS deadline')));
      let bytes = ''; client.on('data', (data) => { bytes += data.toString(); });
      client.once('error', reject); client.once('end', () => resolve(bytes));
    });
    assert.equal(await read(identity.fingerprint), 'controlled TLS bytes');
    await assert.rejects(read('not-the-paired-certificate'), /pin mismatch/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('Windows retained key with a broadened ACL refuses without silent repair', { skip: process.platform !== 'win32' }, async () => {
  const stateDir = freshDir();
  try {
    const identity = await ensureMobileTlsIdentity({ stateDir });
    const target = path.join(stateDir, 'mobile-tls', 'key.pem');
    const script = String.raw`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false,$true); $p=[Console]::In.ReadToEnd(); $a=Get-Acl -LiteralPath $p; $r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow); $a.AddAccessRule($r); Set-Acl -LiteralPath $p -AclObject $a`;
    const command = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const weakened = spawnSync(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      input: target, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 4096,
    });
    assert.equal(weakened.status, 0, 'synthetic key ACL control must complete');
    await assert.rejects(ensureMobileTlsIdentity({ stateDir }), /ACL could not be verified/);
    assert.throws(() => assertWindowsPrivateFilesystem(target, lstatSync(target, { bigint: true }), 'file'), /ACL could not be verified/);
    assert.equal(readFileSync(target, 'utf8'), identity.keyPem);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
