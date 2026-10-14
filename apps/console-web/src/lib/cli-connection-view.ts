import type { CliHealth } from './connect';

// Match the existing background health sweep. Expiration changes presentation
// only; it never starts a probe or declares an account signed out.
export const CLI_HEALTH_FRESH_FOR_MS = 30 * 60_000;

export interface CliConnectionInput {
  health?: CliHealth;
  installed?: boolean;
  authRequired?: boolean;
  unavailable?: boolean;
}

export interface CliConnectionPresentation {
  state: 'not_checked' | 'not_installed' | 'installed' | 'available' | 'connected'
    | 'signed_out' | 'needs_configuration' | 'credential_blocked' | 'check_needed' | 'unavailable';
  label: string;
  tone: 'success' | 'warning' | 'neutral';
  help: string;
  account?: string;
}

/** Only the exact CLI or one unambiguous command alias supplies its health. */
export function cliConnectionHealth(
  health: Readonly<Record<string, CliHealth>> | undefined,
  id: string,
  command: string,
): CliHealth | undefined {
  const exact = health?.[id];
  if (exact?.id === id && exact.command === command) return exact;
  const matches = Object.entries(health ?? {}).filter(([key, row]) => row.id === key && row.command === command);
  return matches.length === 1 ? matches[0]![1] : undefined;
}

/** Saved membership, executable availability and current account access are
 * different facts. Neither missing evidence nor a failed refresh invents one. */
export function cliConnectionPresentation(input: CliConnectionInput, now = Date.now()): CliConnectionPresentation {
  const h = input.health;
  if (input.unavailable) return { state: 'unavailable', label: 'Status unavailable', tone: 'warning',
    help: 'Connection status could not refresh. Try refreshing the list.' };
  if (h?.issue === 'credential_store_unavailable') return { state: 'credential_blocked', label: 'Credential access blocked', tone: 'warning',
    help: 'Finish the credential prompt on your computer. A new sign-in may not be needed.' };
  if (h?.issue === 'configuration_required') return { state: 'needs_configuration', label: 'Needs setup', tone: 'warning',
    help: 'Clem can help select the account, project, or other setting this tool needs.' };
  const checked = h ? Date.parse(h.checkedAt) : Number.NaN;
  if (h && (h.authStatus === 'error' || h.staleSince || h.lastProbeError || !Number.isFinite(checked) || checked > now
    || now - checked > CLI_HEALTH_FRESH_FOR_MS)) {
    return { state: 'check_needed', label: 'Check needed', tone: 'warning',
      help: 'The last access check is out of date or did not finish. Ask Clem to check before using it.' };
  }
  const installed = h?.installed ?? input.installed;
  if (installed === false) return { state: 'not_installed', label: 'Not installed', tone: 'neutral',
    help: 'Ask Clem to install this tool if your task needs it.' };
  if (installed !== true) return { state: 'not_checked', label: 'Not checked', tone: 'neutral',
    help: 'Its availability and access have not been verified yet.' };
  if (h?.authStatus === 'signed_out') return { state: 'signed_out', label: 'Sign-in needed', tone: 'warning',
    help: 'Clem can start setup; finish any browser or private sign-in prompt when asked.' };
  if (h?.authStatus === 'ok') return { state: 'connected', label: 'Connected', tone: 'success',
    help: 'Sign-in was verified. Access to each task still depends on its account and permissions.',
    ...(h.username ? { account: h.username } : {}) };
  if (input.authRequired === false) return { state: 'available', label: 'Available', tone: 'success',
    help: 'This tool is installed and explicitly needs no account sign-in.' };
  return { state: 'installed', label: 'Installed', tone: 'neutral',
    help: 'The command is available; account access has not been verified.' };
}
