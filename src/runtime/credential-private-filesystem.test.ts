import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createCredentialFilePolicy, CREDENTIAL_ACL_REUSE_MS, CredentialStoragePrivacyError } from './credential-private-filesystem.js';

function fixture(run: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'clem-credential-policy-')));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('retained credential bytes and identity survive repeated reads that reuse one unchanged observation', () => fixture(root => {
  const target = path.join(root, "retained & ' café 日本語.json"); const bytes = '{"grant":"synthetic retained"}\n';
  writeFileSync(target, bytes); const before = lstatSync(target, { bigint: true }); let observations = 0;
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: (file, identity, kind, harden, options) => {
    assert.equal(harden, false); assert.equal(options?.allowInheritedPrivate, true);
    assert.equal(identity.ino, lstatSync(file, { bigint: true }).ino);
    if (kind === 'file') observations += 1;
  } });
  assert.equal(policy.readCredentialFileSync(target), bytes);
  assert.equal(policy.readCredentialFileSync(target), bytes);
  assert.equal(observations, 1, 'an unchanged file is observed once, not before and after every read');
  const after = lstatSync(target, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs); assert.equal(after.ctimeNs, before.ctimeNs);
}));

function countingPolicy(clock: { now: number }, refuse: (file: string) => boolean = () => false) {
  const observed: string[] = []; const hardened: string[] = [];
  const policy = createCredentialFilePolicy({ platform: 'win32', now: () => clock.now, checkAcl: (file, _identity, kind, harden) => {
    (harden ? hardened : observed).push(`${kind}:${path.basename(file)}`);
    if (refuse(file)) throw new Error('synthetic weak ACL');
  } });
  return { policy, observed, hardened };
}

test('an unchanged credential reuses its observation inside the window and is observed again after it', () => fixture(root => {
  const target = path.join(root, 'vault.json'); writeFileSync(target, '{"grant":"synthetic"}');
  const clock = { now: 1_000 }; const { policy, observed } = countingPolicy(clock);
  for (let read = 0; read < 50; read += 1) assert.equal(policy.readCredentialFileSync(target), '{"grant":"synthetic"}');
  assert.deepEqual(observed, [`directory:${path.basename(root)}`, 'file:vault.json'], 'fifty reads of an unchanged file launch two observations');
  clock.now += CREDENTIAL_ACL_REUSE_MS - 1; policy.readCredentialFileSync(target);
  assert.equal(observed.length, 2, 'still inside the window');
  clock.now += 1; policy.readCredentialFileSync(target);
  assert.deepEqual(observed.slice(2), [`directory:${path.basename(root)}`, 'file:vault.json'], 'the window bounds how long a broadened directory or file can go unobserved');
}));

test('a changed file and a replaced directory are observed again at once', () => fixture(root => {
  const state = path.join(root, 'state'); mkdirSync(state); const target = path.join(state, 'vault.json');
  writeFileSync(target, '{"grant":"one"}');
  const clock = { now: 1_000 }; const { policy, observed } = countingPolicy(clock);
  policy.readCredentialFileSync(target); observed.length = 0;
  writeFileSync(target, '{"grant":"two, longer"}');
  assert.equal(policy.readCredentialFileSync(target), '{"grant":"two, longer"}');
  assert.deepEqual(observed, ['file:vault.json'], 'new bytes are observed again; the unchanged directory is reused');
  observed.length = 0;
  renameSync(state, path.join(root, 'state-aside')); mkdirSync(state); writeFileSync(target, '{"grant":"replacement"}');
  assert.equal(policy.readCredentialFileSync(target), '{"grant":"replacement"}');
  assert.deepEqual(observed, ['directory:state', 'file:vault.json'], 'a different directory object is never covered by the old observation');
}));

test('a changed change time is observed immediately even with unchanged bytes and identity', (t) => fixture(root => {
  const target = path.join(root, 'vault.json'); const raw = '{"grant":"synthetic"}';
  writeFileSync(target, raw);
  const actual = lstatSync(target, { bigint: true });
  const originalLstat = fs.lstatSync; const originalFstat = fs.fstatSync;
  let changeTime = actual.ctimeNs; let refuse = false;
  // Linux tmpfs can report an unchanged ctime after a real chmod. Pin the
  // metadata contract directly; actual Windows ACL edits have a native gate.
  const controlled = <T extends ReturnType<typeof originalLstat>>(stat: T): T => {
    if (!stat || stat.dev !== actual.dev || stat.ino !== actual.ino) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ctimeNs: changeTime });
  };
  t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => controlled(originalLstat(...args)));
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => controlled(originalFstat(...args)));
  syncBuiltinESMExports();
  try {
    const clock = { now: 1_000 }; const { policy, observed } = countingPolicy(clock, file => refuse && file === target);
    assert.equal(policy.readCredentialFileSync(target), raw);
    observed.length = 0;
    assert.equal(policy.readCredentialFileSync(target), raw);
    assert.deepEqual(observed, [], 'an equal signature still reuses the observation');
    changeTime += 1n;
    assert.equal(policy.readCredentialFileSync(target), raw);
    assert.deepEqual(observed, ['file:vault.json'], 'ctime alone invalidates the observation');
    observed.length = 0; changeTime += 1n; refuse = true;
    assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError);
    assert.deepEqual(observed, ['file:vault.json'], 'the changed object receives a fresh ACL decision');
    assert.equal(readFileSync(target, 'utf8'), raw, 'a refused observation preserves the file');
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
}));

test('a refused observation is never reused, and hardening is never skipped', () => fixture(root => {
  const target = path.join(root, 'vault.json'); writeFileSync(target, '{"grant":"synthetic"}');
  let weak = true; const clock = { now: 1_000 };
  const { policy, observed, hardened } = countingPolicy(clock, file => weak && file === target);
  assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError);
  assert.throws(() => policy.readCredentialFileSync(target), CredentialStoragePrivacyError, 'a refusal is observed again, never remembered as safe');
  assert.equal(observed.filter(entry => entry === 'file:vault.json').length, 2);
  weak = false;
  assert.equal(policy.readCredentialFileSync(target), '{"grant":"synthetic"}');
  const owned = path.join(root, 'owned', 'meta.json');
  policy.writeCredentialFileSync(owned, '{"one":1}'); const firstHardening = hardened.length;
  policy.writeCredentialFileSync(owned, '{"two":2}');
  assert.ok(firstHardening > 0 && hardened.length > firstHardening, 'every write hardens its own temporary file');
}));

test('a missing credential reuses the observation of its unchanged parent', () => fixture(root => {
  const clock = { now: 1_000 }; const { policy, observed } = countingPolicy(clock);
  for (let read = 0; read < 20; read += 1) assert.equal(policy.readCredentialFileSync(path.join(root, 'auth.json')), undefined);
  assert.deepEqual(observed, [`directory:${path.basename(root)}`]);
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

test('explicit private text writes create and repeatedly rotate .env bytes through the Windows policy', () => fixture(root => {
  const hardened: string[] = [];
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: (file, _identity, kind, harden) => {
    if (harden && kind === 'file') {
      assert.equal(readFileSync(file).length, 0, 'private hardening precedes any credential bytes');
      hardened.push(file);
    }
  } });
  for (const existing of [false, true]) {
    const target = path.join(root, existing ? 'existing.env' : 'new', '.env');
    if (existing) { mkdirSync(path.dirname(target)); writeFileSync(target, 'CONTROLLED_KEY=old\n'); }
    for (const value of ['CONTROLLED_KEY="synthetic first"\n', 'CONTROLLED_KEY=" second with spaces "\n']) {
      policy.writeCredentialTextFileSync(target, value);
      assert.equal(policy.readCredentialSourceFileSync(target), value);
      if (process.platform !== 'win32') assert.equal(lstatSync(target).mode & 0o777, 0o600);
    }
  }
  assert.equal(hardened.length, 4, 'every text publication hardens an exclusive empty temporary file');
}));

test('the JSON writer still rejects malformed and non-object existing text without publication', () => fixture(root => {
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => {} });
  const target = path.join(root, 'vault.json');
  for (const before of ['CONTROLLED_KEY=synthetic-private-marker\n', '{"synthetic-private-marker": malformed}', '[]', 'null', '42', '"synthetic-private-marker"']) {
    writeFileSync(target, before);
    const identity = lstatSync(target, { bigint: true });
    assert.throws(() => policy.writeCredentialFileSync(target, '{"replacement":true}'), (error: unknown) => {
      assert.ok(error instanceof CredentialStoragePrivacyError);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error.stack), /synthetic-private-marker/);
      return true;
    });
    assert.equal(readFileSync(target, 'utf8'), before);
    assert.equal(lstatSync(target, { bigint: true }).ino, identity.ino);
    assert.deepEqual(readdirSync(root), ['vault.json'], 'a refusal leaves no temporary file');
  }
}));

test('private text mode retains weak ACL, symlink, hardlink and directory refusals', () => fixture(root => {
  const target = path.join(root, 'retained.env'); const retained = 'CONTROLLED_KEY=synthetic-private-marker\n';
  writeFileSync(target, retained);
  const weak = createCredentialFilePolicy({ platform: 'win32', checkAcl: file => {
    if (file === target) throw new Error('synthetic-private-marker');
  } });
  assert.throws(() => weak.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=replacement\n'), (error: unknown) => {
    assert.ok(error instanceof CredentialStoragePrivacyError);
    assert.equal(error.cause, undefined); assert.doesNotMatch(String(error.stack), /synthetic-private-marker/);
    return true;
  });
  assert.equal(readFileSync(target, 'utf8'), retained);
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => {} });
  const alias = path.join(root, 'hardlink.env'); linkSync(target, alias);
  for (const entry of [target, alias, root]) {
    assert.throws(() => policy.writeCredentialTextFileSync(entry, 'CONTROLLED_KEY=replacement\n'), CredentialStoragePrivacyError);
  }
  if (process.platform !== 'win32') {
    const symlink = path.join(root, 'symlink.env'); symlinkSync(target, symlink);
    assert.throws(() => policy.writeCredentialTextFileSync(symlink, 'CONTROLLED_KEY=replacement\n'), CredentialStoragePrivacyError);
    assert.equal(lstatSync(symlink).isSymbolicLink(), true);
  }
  assert.equal(readFileSync(target, 'utf8'), retained);
  assert.equal(readFileSync(alias, 'utf8'), retained);
}));

for (const race of ['replaced', 'changed-in-place'] as const) {
  test(`private text publication refuses a target ${race} during temporary-file hardening`, () => fixture(root => {
    const target = path.join(root, '.env'); const prior = 'CONTROLLED_KEY=retained\n'; writeFileSync(target, prior);
    const raced = 'CONTROLLED_KEY=synthetic-external-replacement\n'; let crossed = false;
    const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: (file, _identity, kind, harden) => {
      if (kind === 'file' && harden && !crossed) {
        crossed = true;
        assert.equal(readFileSync(file).length, 0);
        if (race === 'replaced') {
          const replacement = path.join(root, 'replacement.env'); writeFileSync(replacement, raced);
          renameSync(target, path.join(root, 'retained-aside.env')); renameSync(replacement, target);
        } else writeFileSync(target, raced);
      }
    } });
    assert.throws(() => policy.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=must-not-publish\n', { expectedPrior: prior }), CredentialStoragePrivacyError);
    assert.equal(crossed, true);
    assert.equal(readFileSync(target, 'utf8'), raced, 'never overwrite or delete the other writer’s current bytes');
    assert.equal(readdirSync(root).some(name => name.endsWith('.tmp')), false, 'only this write’s owned temporary file is removed');
  }));
}

test('private text mode retains the bounded-size refusal and static error', () => fixture(root => {
  const target = path.join(root, '.env'); const retained = 'CONTROLLED_KEY=retained\n'; writeFileSync(target, retained);
  const policy = createCredentialFilePolicy({ platform: 'win32', checkAcl: () => {} });
  assert.throws(() => policy.writeCredentialTextFileSync(target, 'x'.repeat(8 * 1024 * 1024 + 1)), CredentialStoragePrivacyError);
  assert.equal(readFileSync(target, 'utf8'), retained);
  assert.deepEqual(readdirSync(root), ['.env']);
}));

for (const platform of ['win32', 'darwin'] as const) {
  test(`${platform} text composition refuses a source changed before the writer's first read`, () => fixture(root => {
    const target = path.join(root, '.env');
    const composedPrior = 'UNRELATED=synthetic-composed-prior\nCONTROLLED_KEY=old\n';
    writeFileSync(target, composedPrior);
    const replacement = 'UNRELATED=synthetic-other-writer\nCONTROLLED_KEY=other\n';
    writeFileSync(target, replacement);
    const before = lstatSync(target, { bigint: true });
    let hardened = false;
    const policy = createCredentialFilePolicy({ platform, checkAcl: (_file, _identity, _kind, harden) => { hardened ||= Boolean(harden); } });
    assert.throws(() => policy.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=must-not-publish\n', {
      expectedPrior: composedPrior,
    }), (error: unknown) => {
      assert.ok(error instanceof CredentialStoragePrivacyError);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error.stack), /synthetic-(?:composed-prior|other-writer)/);
      return true;
    });
    assert.equal(hardened, false, 'a stale composition is rejected before staging');
    assert.equal(readFileSync(target, 'utf8'), replacement);
    assert.equal(lstatSync(target, { bigint: true }).ino, before.ino);
    assert.deepEqual(readdirSync(root), ['.env']);
  }));

  test(`${platform} text composition distinguishes expected absence from an omitted or inherited precondition`, () => fixture(root => {
    const target = path.join(root, '.env');
    const policy = createCredentialFilePolicy({ platform, checkAcl: () => {} });
    policy.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=created\n', { expectedPrior: undefined });
    assert.throws(() => policy.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=must-not-publish\n', {
      expectedPrior: undefined,
    }), CredentialStoragePrivacyError);
    assert.equal(readFileSync(target, 'utf8'), 'CONTROLLED_KEY=created\n');
    policy.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=no-pin\n');
    assert.equal(readFileSync(target, 'utf8'), 'CONTROLLED_KEY=no-pin\n');
    policy.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=inherited-is-not-a-pin\n',
      Object.create({ expectedPrior: 'not-the-current-value' }));
    assert.equal(readFileSync(target, 'utf8'), 'CONTROLLED_KEY=inherited-is-not-a-pin\n');
  }));
}

test('POSIX text composition checks again after staging and preserves another writer’s bytes', (t) => fixture(root => {
  const target = path.join(root, '.env'); const prior = 'CONTROLLED_KEY=retained\n';
  const replacement = 'CONTROLLED_KEY=other-writer\n'; writeFileSync(target, prior);
  const policy = createCredentialFilePolicy({ platform: 'darwin' });
  const realWrite = fs.writeFileSync; let raced = false;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    const result = Reflect.apply(realWrite, fs, args);
    if (!raced && typeof args[0] === 'string' && args[0].endsWith('.tmp')) {
      raced = true; realWrite(target, replacement);
    }
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => policy.writeCredentialTextFileSync(target, 'CONTROLLED_KEY=must-not-publish\n', {
      expectedPrior: prior,
    }), CredentialStoragePrivacyError);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
  assert.equal(raced, true);
  assert.equal(readFileSync(target, 'utf8'), replacement);
  assert.deepEqual(readdirSync(root), ['.env'], 'owned temporary bytes are cleaned after stale composition refusal');
}));
