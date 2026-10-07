import assert from 'node:assert/strict';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCredentialFilePolicy, CredentialStoragePrivacyError } from './credential-private-filesystem.js';

function fixture(run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-credential-policy-')));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('retained credential bytes and identity survive repeated current-permission reads', () => fixture(root => {
  const target = path.join(root, "retained & ' café 日本語.json"); const bytes = '{"grant":"synthetic retained"}\n';
  writeFileSync(target, bytes); const before = lstatSync(target, { bigint: true }); let observations = 0;
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: (file, identity, kind, harden, options) => {
    assert.equal(harden, false); assert.equal(options?.allowInheritedPrivate, true);
    assert.equal(identity.ino, lstatSync(file, { bigint: true }).ino);
    if (kind === 'file') observations += 1;
  } });
  assert.equal(policy.readCredentialFileSync(target), bytes);
  assert.equal(policy.readCredentialFileSync(target), bytes);
  assert.equal(observations, 4, 'each retained read observes current file permissions before and after bytes');
  const after = lstatSync(target, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
}));

test('new dedicated directories and empty exclusive temp are hardened before credential bytes', () => fixture(root => {
  const target = path.join(root, 'new owned root', 'state', 'vault.json'); const hardened: string[] = [];
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: (file, _identity, kind, harden, options) => {
    if (harden) {
      hardened.push(file); assert.notEqual(options?.allowInheritedPrivate, true);
      if (kind === 'file') assert.equal(readFileSync(file).length, 0, 'no secret bytes precede exact-handle hardening');
    }
  } });
  const raw = '{"grant":"synthetic new"}'; policy.writeCredentialFileSync(target, raw);
  assert.equal(policy.readCredentialFileSync(target), raw);
  assert.ok(hardened.includes(path.dirname(target))); assert.ok(hardened.some(file => file.endsWith('.tmp')));
  assert.equal(hardened.includes(root), false, 'existing profile-like parent is verify-only');
}));

test('unsafe present ACL refuses both retained read and overwrite without mutating credential bytes', () => fixture(root => {
  const target = path.join(root, 'vault.json'); const raw = '{"grant":"synthetic retained"}'; writeFileSync(target, raw);
  const before = lstatSync(target, { bigint: true });
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: file => { if (file === target) throw new Error('synthetic weak ACL'); } });
  assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError);
  assert.throws(() => policy.writeCredentialFileSync(target, '{"grant":"replacement"}'), CredentialStoragePrivacyError);
  assert.equal(readFileSync(target, 'utf8'), raw); assert.equal(lstatSync(target, { bigint: true }).ino, before.ino);
}));

test('missing credentials distinguish safe absence from unsafe directory, alias and dangling parent', () => fixture(root => {
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => {} });
  assert.equal(policy.readCredentialFileSync(path.join(root, 'missing', 'vault.json')), undefined);
  const weak = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => { throw new Error('synthetic unsafe parent'); } });
  assert.throws(() => weak.readCredentialFileSync(path.join(root, 'vault.json')), CredentialStoragePrivacyError);
  const dangling = path.join(root, 'dangling'); symlinkSync(path.join(root, 'absent'), dangling, 'junction');
  assert.throws(() => policy.readCredentialFileSync(path.join(dangling, 'vault.json')), CredentialStoragePrivacyError);
  const directory = path.join(root, 'directory'); mkdirSync(directory);
  const alias = path.join(root, 'alias'); symlinkSync(directory, alias, 'junction');
  assert.throws(() => policy.readCredentialFileSync(path.join(alias, 'vault.json')), CredentialStoragePrivacyError);
}));

test('symlink, hardlink and directory credential entries cannot enter read or publication', () => fixture(root => {
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => {} });
  const target = path.join(root, 'real.json'); writeFileSync(target, '{"grant":"synthetic"}');
  const alias = path.join(root, 'alias.json'); linkSync(target, alias);
  assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError);
  assert.throws(() => policy.writeCredentialFileSync(alias, '{}'), CredentialStoragePrivacyError);
  if (process.platform !== 'win32') {
    const symlink = path.join(root, 'symlink.json'); symlinkSync(target, symlink);
    assert.throws(() => policy.readCredentialFileSync(symlink), CredentialStoragePrivacyError);
  }
  assert.throws(() => policy.readCredentialFileSync(root), CredentialStoragePrivacyError);
}));

test('path replacement during current ACL observation refuses stale handle bytes', () => fixture(root => {
  const target = path.join(root, 'vault.json'); writeFileSync(target, '{"grant":"old"}'); let replaced = false;
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: (file, _identity, kind) => {
    if (kind === 'file' && !replaced) {
      replaced = true; const other = path.join(root, 'replacement.json'); writeFileSync(other, '{"grant":"new"}');
      // Windows refuses to rename over a name whose file the policy holds open,
      // but lets the open file itself move aside: the same path swap the policy
      // must notice, on every platform (run 37656675446 saw EPERM on the one-step rename).
      renameSync(file, path.join(root, 'moved-aside.json')); renameSync(other, file);
    }
  } });
  assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError);
  assert.equal(readFileSync(target, 'utf8'), '{"grant":"new"}', 'refusal does not delete a replacement entry');
}));

test('invalid-present bytes are preserved and parse/utility causes cannot leak through errors', () => fixture(root => {
  const target = path.join(root, 'vault.json'); const raw = '{"synthetic-secret-marker": malformed}'; writeFileSync(target, raw);
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => {} });
  assert.throws(() => policy.writeCredentialFileSync(target, '{}'), (error: unknown) => {
    assert.ok(error instanceof CredentialStoragePrivacyError); assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes('synthetic-secret-marker'), false); return true;
  });
  assert.equal(readFileSync(target, 'utf8'), raw);
  assert.equal(new CredentialStoragePrivacyError(new Error('synthetic-secret-marker')).cause, undefined);
}));

test('POSIX policy retains ordinary missing/read/write behavior', () => fixture(root => {
  const policy = createCredentialFilePolicy({ platform: 'darwin', checkAcl: () => { throw new Error('must not run'); } });
  const target = path.join(root, 'state', 'vault.json'); assert.equal(policy.readCredentialFileSync(target), undefined);
  policy.writeCredentialFileSync(target, '{}'); assert.equal(policy.readCredentialFileSync(target), '{}');
}));

test('optional absent public sources do not require private parent ACL while present and dangling sources do', () => fixture(root => {
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => { throw new Error('synthetic public parent'); } });
  const target = path.join(root, '.env');
  assert.equal(policy.readCredentialSourceFileSync(target), undefined, 'an absent optional source in public package/cwd is safe absence');
  assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError, 'owned stores retain stricter missing-parent admission');
  writeFileSync(target, 'OPENAI_API_KEY=synthetic');
  assert.throws(() => policy.readCredentialSourceFileSync(target), CredentialStoragePrivacyError);
  const alias = path.join(root, 'dangling'); symlinkSync(path.join(root, 'absent'), alias, 'junction');
  assert.throws(() => policy.readCredentialSourceFileSync(path.join(alias, '.env')), CredentialStoragePrivacyError);
}));
