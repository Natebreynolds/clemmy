import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { assertWindowsPrivateFilesystem, type PrivateFilesystemIdentity } from './windows-private-filesystem.js';
import { syncDirectoryMetadata } from './sync-directory.js';

const MAX_CREDENTIAL_BYTES = 8 * 1024 * 1024;
const MESSAGE = 'Credential storage privacy or integrity could not be verified. Check NTFS folder permissions and the Clementine installation, then retry; no other credential source was selected. A write may require verification before retrying.';

export class CredentialStoragePrivacyError extends Error {
  constructor(_cause?: unknown) {
    // JSON parse errors can quote credential bytes. Keep nested causes out of
    // log/UI error serialization as well as the public message.
    super(MESSAGE);
    this.name = 'CredentialStoragePrivacyError';
  }
}
export function isCredentialStoragePrivacyError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CredentialStoragePrivacyError';
}
type AclCheck = (target: string, identity: PrivateFilesystemIdentity, kind: 'file' | 'directory', harden?: boolean,
  options?: { allowInheritedPrivate?: boolean }) => unknown;

const regular = (stat: BigIntStats): boolean => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.ino !== 0n;
const same = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

/** How long an unchanged path may reuse its last verified permissions. */
export const CREDENTIAL_ACL_REUSE_MS = 30_000;

/** One canonical policy for the daemon and desktop. Dependency injection only
 * qualifies host filesystem guards offline; Windows acceptance uses native ACL.
 * No credential bytes are cached and no file is read on import.
 *
 * Every Windows ACL observation launches the native probe synchronously, and
 * the daemon reads the same few credential files many times a second (.env,
 * vault and sign-in lookups). Observing all of them on every read held the
 * event loop through the first boot: installed beta 3.18.34-windows.3 never
 * answered its readiness probe within 90 s and was stopped. A verified
 * observation is therefore reused while the path is provably the same object,
 * for at most CREDENTIAL_ACL_REUSE_MS. A file must keep its exact identity,
 * size, write and change times; NTFS records a permission change in the
 * change time, so a broadened file is observed again at once. A directory
 * must keep its identity; its times move with every sibling write, so a
 * broadened directory is observed again within the reuse window. Hardening,
 * a refused observation and a changed identity are never reused. */
export function createCredentialFilePolicy(dependencies: { platform?: NodeJS.Platform; checkAcl?: AclCheck; now?: () => number } = {}) {
  const windows = (dependencies.platform ?? process.platform) === 'win32';
  const observeAcl = dependencies.checkAcl ?? assertWindowsPrivateFilesystem;
  const now = dependencies.now ?? (() => performance.now());
  const verified = new Map<string, { at: number; stat: BigIntStats }>();
  const checkAcl = (target: string, stat: BigIntStats, kind: 'file' | 'directory', harden = false,
    options?: { allowInheritedPrivate?: boolean }): void => {
    const key = `${kind}\0${options?.allowInheritedPrivate === true}\0${target}`;
    const prior = verified.get(key);
    verified.delete(key);
    if (!harden && prior && now() - prior.at < CREDENTIAL_ACL_REUSE_MS && prior.stat.dev === stat.dev
      && prior.stat.ino === stat.ino && (kind === 'directory' || same(prior.stat, stat))) {
      verified.set(key, prior);
      return;
    }
    observeAcl(target, stat, kind, harden, options);
    if (!harden) verified.set(key, { at: now(), stat });
  };
  const assertMissingPathParents = (directory: string, verifyNearestPrivate = true): void => {
    let current = directory;
    let nearestObserved = false;
    while (true) {
      try {
        const stat = lstatSync(current, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) throw new CredentialStoragePrivacyError();
        if (!nearestObserved) { if (verifyNearestPrivate) privateDirectory(current); nearestObserved = true; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) return;
      current = parent;
    }
  };
  const privateDirectory = (directory: string, harden = false): void => {
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || before.ino === 0n) throw new CredentialStoragePrivacyError();
    checkAcl(directory, before, 'directory', harden, { allowInheritedPrivate: !harden });
    const after = lstatSync(directory, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink() || !after.isDirectory()) throw new CredentialStoragePrivacyError();
  };
  const ensureDirectory = (directory: string): void => {
    try { lstatSync(directory); privateDirectory(directory); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new CredentialStoragePrivacyError();
    ensureDirectory(parent);
    // Harden only directories created by this writer. Existing parents are
    // admitted read-only; neither user profiles nor legacy roots are repaired.
    mkdirSync(directory, { mode: 0o700 });
    privateDirectory(directory, true);
  };
  const read = (target: string, optionalExternalSource = false): string | undefined => {
    if (!windows) return existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    let fd: number | undefined;
    try {
      const directory = path.dirname(target);
      if (!path.isAbsolute(target) || target.includes('\0')) throw new CredentialStoragePrivacyError();
      let entry: BigIntStats;
      try { entry = lstatSync(target, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { assertMissingPathParents(directory, !optionalExternalSource); return undefined; }
        throw error;
      }
      if (!regular(entry) || entry.size > BigInt(MAX_CREDENTIAL_BYTES)) throw new CredentialStoragePrivacyError();
      privateDirectory(directory);
      fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = fstatSync(fd, { bigint: true });
      if (!regular(before) || !same(entry, before)) throw new CredentialStoragePrivacyError();
      checkAcl(target, before, 'file', false, { allowInheritedPrivate: true });
      const raw = readFileSync(fd, 'utf8');
      const after = fstatSync(fd, { bigint: true });
      if (!regular(after) || !same(before, after) || !same(after, lstatSync(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      checkAcl(target, after, 'file', false, { allowInheritedPrivate: true });
      privateDirectory(directory);
      if (!same(after, fstatSync(fd, { bigint: true })) || !same(after, lstatSync(target, { bigint: true }))) throw new CredentialStoragePrivacyError();
      return raw;
    } catch (cause) { throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause); }
    finally { if (fd !== undefined) closeSync(fd); }
  };
  const write = (target: string, content: string): void => {
    if (!windows) {
      mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, target);
        try { chmodSync(target, 0o600); } catch { /* preserve existing POSIX best-effort semantics */ }
      } finally { try { unlinkSync(temporary); } catch { /* already published */ } }
      return;
    }
    let fd: number | undefined;
    let temporary: string | undefined;
    let temporaryIdentity: BigIntStats | undefined;
    try {
      if (Buffer.byteLength(content) > MAX_CREDENTIAL_BYTES) throw new CredentialStoragePrivacyError();
      const prior = read(target);
      // An invalid-present file must not become an empty writable store. The
      // caller additionally checks its own wallet/vault schema before writing.
      if (prior !== undefined) {
        const parsed: unknown = JSON.parse(prior);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CredentialStoragePrivacyError();
      }
      const priorIdentity = prior === undefined ? null : lstatSync(target, { bigint: true });
      const directory = path.dirname(target);
      ensureDirectory(directory);
      temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      const empty = fstatSync(fd, { bigint: true });
      temporaryIdentity = empty;
      if (!regular(empty) || empty.size !== 0n) throw new CredentialStoragePrivacyError();
      checkAcl(temporary, empty, 'file', true);
      writeFileSync(fd, content, 'utf8');
      fsyncSync(fd);
      const written = fstatSync(fd, { bigint: true });
      if (!regular(written) || written.dev !== empty.dev || written.ino !== empty.ino || !same(written, lstatSync(temporary, { bigint: true }))) throw new CredentialStoragePrivacyError();
      checkAcl(temporary, written, 'file');
      privateDirectory(directory);
      if (read(target) !== prior || (priorIdentity && !same(priorIdentity, lstatSync(target, { bigint: true })))) throw new CredentialStoragePrivacyError();
      closeSync(fd); fd = undefined;
      renameSync(temporary, target); temporary = undefined;
      syncDirectoryMetadata(directory);
      if (read(target) !== content) throw new CredentialStoragePrivacyError();
    } catch (cause) { throw isCredentialStoragePrivacyError(cause) ? cause : new CredentialStoragePrivacyError(cause); }
    finally {
      if (fd !== undefined) closeSync(fd);
      if (temporary && temporaryIdentity) {
        try {
          const current = lstatSync(temporary, { bigint: true });
          if (regular(current) && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) unlinkSync(temporary);
        } catch { /* never remove a replacement or retained credential */ }
      }
    }
  };
  return {
    readCredentialFileSync: (target: string): string | undefined => read(target),
    // Optional external .env/CLI files are never hardened. Safe absent files
    // need no private ACL on public package/cwd parents. Present files use the
    // same current parent/file ACL, no-follow and exact identity checks.
    readCredentialSourceFileSync: (target: string): string | undefined => read(target, true),
    writeCredentialFileSync: write,
    assertCredentialFileReadable: (target: string): void => { read(target); },
  };
}

const policy = createCredentialFilePolicy();
export const readCredentialFileSync = policy.readCredentialFileSync;
export const readCredentialSourceFileSync = policy.readCredentialSourceFileSync;
export const writeCredentialFileSync = policy.writeCredentialFileSync;
export const assertCredentialFileReadable = policy.assertCredentialFileReadable;
