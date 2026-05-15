import type { SecretDescriptor, SecretName } from './types.js';

/**
 * The canonical registry of credentials this project recognizes.
 *
 * STABILITY RULE: names and envVarNames in this table MUST NOT change
 * once shipped. They are also the source of truth for the keychain
 * account names (joined with the stable service name in keychain-store.ts).
 *
 * To add a new credential:
 *   1. Add a new entry here with a fresh stable name.
 *   2. Add the new name to the SecretName union in types.ts.
 *   3. Optionally add an envVarName so .env keeps working as the dev path.
 *   4. Update src/config.ts to read it via the SecretStore instead of
 *      reaching into process.env directly.
 *
 * Never repurpose an existing entry. To deprecate, keep the entry with
 * required: false and a deprecation note in the description.
 */
export const SECRET_DESCRIPTORS: readonly SecretDescriptor[] = [
  {
    name: 'openai_api_key',
    description: 'Optional OpenAI API key — enables embeddings, Realtime live voice, and direct OpenAI API features. Not required when the agent runtime uses Codex OAuth.',
    envVarName: 'OPENAI_API_KEY',
    required: false, // codex_oauth path can substitute for some workloads
    setupHint: 'Get one at https://platform.openai.com/api-keys. Starts with sk-.',
  },
  {
    name: 'discord_bot_token',
    description: 'Discord bot token — enables the Clementine bot to respond on Discord.',
    envVarName: 'DISCORD_BOT_TOKEN',
    required: false,
    setupHint: 'Create a bot at https://discord.com/developers/applications and copy its token.',
  },
  {
    name: 'composio_api_key',
    description: 'Composio API key — connects external apps (Gmail, Slack, Notion, GitHub, Linear, Calendar, Drive, CRMs).',
    envVarName: 'COMPOSIO_API_KEY',
    required: false,
    setupHint: 'Sign up at https://composio.dev and create an API key.',
  },
  {
    name: 'recall_api_key',
    description: 'Recall.ai API key — optional desktop meeting capture for Zoom, Meet, Teams, Slack Huddles, and in-person meetings.',
    envVarName: 'RECALL_API_KEY',
    required: false,
    setupHint: 'Sign up at https://www.recall.ai and create an API key for Desktop Recording SDK uploads.',
  },
  {
    name: 'codex_oauth_access_token',
    description: 'Codex OAuth access token — primary agent runtime auth for ChatGPT/Codex subscribers.',
    envVarName: '', // populated by clementine auth login-native, not from env
    required: false,
  },
  {
    name: 'codex_oauth_refresh_token',
    description: 'Codex OAuth refresh token — paired with the access token so the agent runtime can renew ChatGPT/Codex auth silently.',
    envVarName: '',
    required: false,
  },
  {
    name: 'webhook_secret',
    description: 'Dashboard / webhook auth secret. Used as ?token=... on dashboard URLs.',
    envVarName: 'WEBHOOK_SECRET',
    required: true,
    setupHint: 'Auto-generated on setup. Treat as a session token.',
  },
];

const BY_NAME = new Map<SecretName, SecretDescriptor>(
  SECRET_DESCRIPTORS.map((d) => [d.name, d]),
);

export function getSecretDescriptor(name: SecretName): SecretDescriptor {
  const found = BY_NAME.get(name);
  if (!found) {
    throw new Error(`Unknown secret: ${name}. Add it to SECRET_DESCRIPTORS in registry.ts.`);
  }
  return found;
}

export function listSecretDescriptors(): readonly SecretDescriptor[] {
  return SECRET_DESCRIPTORS;
}

/**
 * Keychain account name for this credential. Joined with the stable
 * service name to form a globally-unique entry. The "v1" suffix is the
 * version baseline — a future migration adds a v2 suffix WITHOUT
 * touching the v1 entries.
 */
export const KEYCHAIN_SERVICE = 'com.clemmy.desktop.v1';

export function keychainAccount(name: SecretName): string {
  return name;
}
