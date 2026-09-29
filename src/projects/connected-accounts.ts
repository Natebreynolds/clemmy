/**
 * What accounts are connected right now, for binding one to a project.
 *
 * A project names the account its work uses. The name is only worth keeping
 * if the account was connected when it was bound, so a binding is checked
 * against the live connection list and records what it was checked against.
 * Nothing is read from memory: a remembered account that is no longer
 * connected is not an account.
 */
import { listConnectedToolkits } from '../integrations/composio/client.js';
import { accountChoiceLabels } from '../tools/source-account-routing.js';

export interface ConnectedAccount {
  toolkit: string;
  /** The exact connected account, as a call would name it. */
  accountId: string;
  /** How the owner would recognise it. */
  label: string;
  /** Other things the owner might call it: its address, its handle. */
  names: string[];
}

export type ConnectedAccountDirectory = (toolkit: string) => Promise<ConnectedAccount[]>;

let directoryForTests: ConnectedAccountDirectory | null = null;

/** Test seam. Null restores the live directory. */
export function _setConnectedAccountDirectoryForTests(directory: ConnectedAccountDirectory | null): void {
  directoryForTests = directory;
}

export async function connectedAccountsFor(toolkit: string): Promise<ConnectedAccount[]> {
  const wanted = toolkit.trim().toLowerCase();
  if (!wanted) return [];
  if (directoryForTests) return directoryForTests(wanted);
  const connections = (await listConnectedToolkits({ requireFresh: true }))
    .filter((row) => row.slug.trim().toLowerCase() === wanted && /^active$/i.test(row.status.trim()));
  const labels = accountChoiceLabels(connections);
  return connections.map((row) => {
    const email = String(row.accountEmail ?? '').trim().toLowerCase().replace(/^smtp:/, '');
    return {
      toolkit: wanted,
      accountId: row.connectionId,
      label: labels[email || row.connectionId] ?? row.connectionId,
      names: [email, row.alias, row.accountLabel, row.accountName, row.wordId]
        .map((value) => String(value ?? '').trim()).filter(Boolean),
    };
  });
}

export type AccountChoice =
  | { kind: 'bound'; account: ConnectedAccount }
  | { kind: 'not_connected'; toolkit: string }
  | { kind: 'choose'; toolkit: string; choices: ConnectedAccount[]; named: string | null };

/**
 * The account meant, from what was named. One connected account and nothing
 * named is that account. Anything else that does not identify exactly one is
 * a question for the owner, asked with the choices.
 */
export async function chooseConnectedAccount(toolkit: string, named: string | null | undefined): Promise<AccountChoice> {
  const accounts = await connectedAccountsFor(toolkit);
  const wanted = toolkit.trim().toLowerCase();
  if (accounts.length === 0) return { kind: 'not_connected', toolkit: wanted };
  const name = String(named ?? '').trim().toLowerCase();
  if (!name) return accounts.length === 1 ? { kind: 'bound', account: accounts[0]! } : { kind: 'choose', toolkit: wanted, choices: accounts, named: null };
  const matches = accounts.filter((account) => account.accountId.toLowerCase() === name
    || account.label.trim().toLowerCase() === name
    || account.names.some((value) => value.toLowerCase() === name));
  return matches.length === 1
    ? { kind: 'bound', account: matches[0]! }
    : { kind: 'choose', toolkit: wanted, choices: accounts, named: String(named).trim().slice(0, 120) };
}
