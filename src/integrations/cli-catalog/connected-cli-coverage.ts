import { findCatalogEntry, readConnectedClis } from './catalog.js';
import { readPersistedHealth } from './auth-health.js';

export interface UsableConnectedCli {
  id: string;
  command: string;
  name: string;
  vendor: string;
  description: string;
  tags: readonly string[];
  signedInAs?: string;
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * CLIs the owner connected in the dashboard whose last persisted probe did not
 * find them signed out. No probe runs here: discovery reads the cached verdict.
 */
export function usableConnectedClis(): UsableConnectedCli[] {
  let connected: ReturnType<typeof readConnectedClis>;
  let health: ReturnType<typeof readPersistedHealth>;
  try {
    connected = readConnectedClis();
    health = readPersistedHealth();
  } catch {
    return [];
  }
  return Object.values(connected).flatMap((record) => {
    const row = health[record.id];
    if (row?.authStatus === 'signed_out' || row?.installed === false) return [];
    const catalog = findCatalogEntry(record.id);
    return [{
      id: record.id,
      command: record.command,
      name: record.name,
      vendor: record.vendor,
      description: catalog?.description ?? '',
      tags: catalog?.tags ?? [],
      ...(row?.authStatus === 'ok' && row.username ? { signedInAs: row.username } : {}),
    }];
  });
}

/**
 * The connected CLI that reaches this app, if any: its catalog id, vendor or
 * command is the app. A covered app is reachable now, so it is not a missing
 * connection.
 */
export function connectedCliCoveringApp(app: string): UsableConnectedCli | null {
  const needle = compact(app);
  if (!needle) return null;
  return usableConnectedClis().find((cli) => (
    [cli.id, cli.vendor, cli.command].some((name) => compact(name) === needle)
  )) ?? null;
}

/**
 * What the local command runner can reach right now. It joins that tool's
 * discovery text, so a search naming the vendor finds the runner and the row
 * says which command to use.
 */
export function connectedCliRunnerText(): string {
  const clis = usableConnectedClis();
  if (clis.length === 0) return '';
  const listed = clis.map((cli) => (
    `\`${cli.command}\` (${cli.name}, ${cli.vendor}${cli.signedInAs ? `, signed in as ${cli.signedInAs}` : ''})`
  ));
  const retrieval = clis.map((cli) => [cli.description, ...cli.tags].filter(Boolean).join(' ')).filter(Boolean);
  return [
    `Connected command-line tools the owner set up, ready to run here: ${listed.join('; ')}.`,
    ...retrieval,
  ].join('\n');
}
