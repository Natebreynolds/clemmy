import { PermissionFlagsBits } from 'discord.js';
import { DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID } from '../config.js';

const DEFAULT_PERMISSIONS = (
  PermissionFlagsBits.ViewChannel
  | PermissionFlagsBits.SendMessages
  | PermissionFlagsBits.ReadMessageHistory
  | PermissionFlagsBits.EmbedLinks
  | PermissionFlagsBits.AttachFiles
  | PermissionFlagsBits.AddReactions
).toString();

export interface DiscordInstallInfo {
  clientId: string;
  appName?: string;
  installUrl: string;
  permissions: string;
}

interface DiscordApplicationResponse {
  id?: string;
  name?: string;
}

export function buildDiscordInstallUrl(clientId: string, permissions = DEFAULT_PERMISSIONS): string {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'bot applications.commands');
  url.searchParams.set('permissions', permissions);
  return url.toString();
}

export async function fetchDiscordInstallInfo(token = DISCORD_BOT_TOKEN): Promise<DiscordInstallInfo | null> {
  if (!token) return null;

  const response = await fetch('https://discord.com/api/v10/oauth2/applications/@me', {
    headers: {
      Authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord application lookup failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json() as DiscordApplicationResponse;
  if (!data.id) {
    throw new Error('Discord application lookup did not return an application id.');
  }

  return {
    clientId: data.id,
    appName: data.name,
    permissions: DEFAULT_PERMISSIONS,
    installUrl: buildDiscordInstallUrl(data.id, DEFAULT_PERMISSIONS),
  };
}

export function getConfiguredDiscordInstallInfo(): DiscordInstallInfo | null {
  if (!DISCORD_CLIENT_ID) return null;
  return {
    clientId: DISCORD_CLIENT_ID,
    permissions: DEFAULT_PERMISSIONS,
    installUrl: buildDiscordInstallUrl(DISCORD_CLIENT_ID, DEFAULT_PERMISSIONS),
  };
}
