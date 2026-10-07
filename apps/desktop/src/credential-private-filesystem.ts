import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The desktop build bundles the SINGLE root policy implementation. This file
// declares its local TS contract only; no ACL or storage logic is copied here.
interface CredentialPolicy {
  readCredentialFileSync(target: string): string | undefined;
  readCredentialSourceFileSync(target: string): string | undefined;
  writeCredentialFileSync(target: string, content: string): void;
  assertCredentialFileReadable(target: string): void;
  isCredentialStoragePrivacyError(error: unknown): boolean;
  CredentialStoragePrivacyError: new (cause?: unknown) => Error;
}
const policy = createRequire(import.meta.url)(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/credential-private-filesystem.cjs')) as CredentialPolicy;
export const readCredentialFileSync = policy.readCredentialFileSync;
export const readCredentialSourceFileSync = policy.readCredentialSourceFileSync;
export const writeCredentialFileSync = policy.writeCredentialFileSync;
export const assertCredentialFileReadable = policy.assertCredentialFileReadable;
export const isCredentialStoragePrivacyError = policy.isCredentialStoragePrivacyError;
export const CredentialStoragePrivacyError = policy.CredentialStoragePrivacyError;
