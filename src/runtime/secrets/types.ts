/**
 * SecretStore — credential abstraction with three layered backends.
 *
 * Why this exists:
 *   - .env + state/auth.json works fine for a CLI but is the wrong
 *     long-term path for a packaged desktop app.
 *   - Keychain is useful, but it is fragile as a default desktop store
 *     because app updates can trigger macOS access prompts.
 *   - This abstraction keeps the local file vault as the stable default
 *     while preserving Keychain as an explicit repair/reset/migration
 *     target.
 *
 * Design rules (from the project goal):
 *   1. One stable keychain service name forever: com.clemmy.desktop.v1.
 *      Versioned via the "v1" suffix so a future v2 can coexist for
 *      controlled migration without breaking historical entries.
 *   2. Audit metadata (which source, last set, last validated, status)
 *      lives in a plain JSON file. Raw secret values NEVER touch this
 *      file — only the fact that they exist + where + when.
 *   3. Migration between sources is always confirm-then-move. We never
 *      delete a secret from one source until readback from the new
 *      source verifies the same value.
 *   4. The "Repair Keychain" and "Reset Credentials" flows are first-
 *      class operations — not afterthoughts — so a user whose keychain
 *      got into a weird state can recover without arcane shell commands.
 */

/** Where a secret came from when we read it. */
export type SecretSource = 'keychain' | 'file' | 'env' | 'missing';

/** Status the dashboard renders for each known credential. */
export type SecretStatus =
  | 'connected'      // value exists and was last set/validated successfully
  | 'missing'        // no value in any backend
  | 'unreadable'     // backend has an entry but couldn't read it (likely corruption)
  | 'needs_repair'   // value exists but failed validation (e.g., 401 on a ping)
  | 'env_only';      // present only in .env (fine for CLI, flag for desktop migration)

/** Stable identifier for a known credential. NEVER change once shipped. */
export type SecretName =
  | 'openai_api_key'
  | 'discord_bot_token'
  | 'composio_api_key'
  | 'recall_api_key'
  | 'browser_use_api_key'
  | 'codex_oauth_access_token'
  | 'codex_oauth_refresh_token'
  | 'webhook_secret';

/** Per-credential audit metadata. Stored in secrets-meta.json. */
export interface SecretMetadata {
  name: SecretName;
  source: SecretSource;
  status: SecretStatus;
  /** ISO timestamp of the last successful set() through this store. */
  lastSetAt?: string;
  /** ISO timestamp of the last successful validation (e.g., live API ping). */
  lastValidatedAt?: string;
  /** Version of the credential name (com.clemmy.desktop.<version>). */
  version: 'v1';
  /** Last error reason when status is unreadable / needs_repair. */
  lastError?: string;
}

/** Result of a get() call — includes provenance and metadata snapshot. */
export interface SecretGetResult {
  name: SecretName;
  value?: string;
  source: SecretSource;
  status: SecretStatus;
  metadata?: SecretMetadata;
}

/** Result of a set() call. */
export interface SecretSetResult {
  name: SecretName;
  source: SecretSource;
  status: SecretStatus;
  metadata: SecretMetadata;
}

/** Snapshot returned by health() — one row per known credential. */
export interface SecretHealthRow {
  name: SecretName;
  description: string;
  source: SecretSource;
  status: SecretStatus;
  hasValue: boolean;
  lastSetAt?: string;
  lastValidatedAt?: string;
  envFallbackAvailable: boolean;
  envVarName: string;
}

/**
 * A single secret-storage backend. Both env and file backends are
 * always available; keychain is gated on keytar being installable
 * (which it isn't in the daemon-only / CLI path, only in Electron).
 */
export interface SecretBackend {
  readonly name: SecretSource;
  readonly isAvailable: boolean;
  /** Read the raw secret. Returns undefined when absent. Throws on a
   *  hard backend error (e.g., keychain locked) so the composite can
   *  fall through to the next backend with the failure recorded. */
  get(name: SecretName): Promise<string | undefined>;
  /** Write the secret. Backend chooses whether to throw or no-op when
   *  unavailable (e.g., env backend cannot write — it's read-only). */
  set(name: SecretName, value: string): Promise<void>;
  /** Remove the secret. Idempotent. */
  delete(name: SecretName): Promise<void>;
}

/** Known credential descriptor — used by the registry to drive
 *  health() output and the dashboard's "Credentials" panel. */
export interface SecretDescriptor {
  name: SecretName;
  description: string;
  envVarName: string;
  /** When true, this credential is required for core function (chat,
   *  daemon). When false, it gates an optional integration (Composio,
   *  Discord) and missing status is a warning, not an error. */
  required: boolean;
  /** Brief help text the dashboard shows in the "how to set this" hint. */
  setupHint?: string;
}
