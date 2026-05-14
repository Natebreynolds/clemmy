import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SecretBackend, SecretName } from './types.js';
import { getSecretDescriptor } from './registry.js';

/**
 * Env backend — read-only. Reads from process.env first, then from the
 * project's .env files in the same order src/config.ts uses. Never
 * writes (writing env vars at runtime doesn't persist anywhere
 * meaningful).
 *
 * This backend exists as a transparent fallback: a user with a dev
 * .env keeps working without us forcing them through Keychain. The
 * dashboard surfaces env-only credentials with an `env_only` status
 * so they can migrate when they're ready.
 */

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      let value = trimmed.slice(eq + 1);
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function packageDir(): string {
  // src/runtime/secrets/env-store.ts → up three levels to package root.
  // import.meta.url isn't always set in the way we want; use the same
  // resolution config.ts uses by walking up from this file.
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', '..');
}

function activeEnvFiles(): string[] {
  const home = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  return [
    path.join(packageDir(), '.env'),
    path.join(process.cwd(), '.env'),
    path.join(home, '.env'),
  ].filter((p, i, all) => all.indexOf(p) === i);
}

export class EnvSecretBackend implements SecretBackend {
  readonly name = 'env' as const;
  readonly isAvailable = true;

  async get(name: SecretName): Promise<string | undefined> {
    const descriptor = getSecretDescriptor(name);
    if (!descriptor.envVarName) return undefined;

    const fromProcess = process.env[descriptor.envVarName];
    if (fromProcess !== undefined && fromProcess !== '') return fromProcess;

    for (const filePath of activeEnvFiles()) {
      const parsed = readEnvFile(filePath);
      const value = parsed[descriptor.envVarName];
      if (value !== undefined && value !== '') return value;
    }

    return undefined;
  }

  async set(_name: SecretName, _value: string): Promise<void> {
    // Env backend is read-only by design. Writing to process.env at
    // runtime wouldn't persist across daemon restarts; writing to a
    // .env file from a Keychain-bound desktop app would be a leak.
    throw new Error('EnvSecretBackend is read-only — use the file or keychain backend to write.');
  }

  async delete(_name: SecretName): Promise<void> {
    // Same reasoning — we never edit user .env files automatically.
    // The user removes them by hand if they want to migrate fully.
    return;
  }
}
