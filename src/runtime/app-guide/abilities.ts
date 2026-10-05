/**
 * What Clementine can do for the owner, whether each part is set up, and the
 * place in the app where it is set up.
 *
 * Clem reads this through app_guide so she can answer "how do I…" and "where
 * is…" from the live state instead of guessing, and offer the one thing that
 * would let her do what was asked. Each fact is read on its own: a probe that
 * fails reports `unknown` for its ability and never hides the others.
 */
import { APP_PLACES } from './app-places.js';

export type AbilityState = 'ready' | 'not_set_up' | 'needs_attention' | 'unknown';

export interface AppAbility {
  id: string;
  name: string;
  /** What the owner gets from it, in their words. */
  unlocks: string;
  state: AbilityState;
  /** The fact behind the state, in plain words. */
  detail: string;
  /** The app place where it is set up or seen. */
  place: string;
}

/** Live facts, each null when it could not be read. */
export interface AppAbilityFacts {
  brain: { model: string; provider: string } | null;
  checker: { otherFamilyConnected: boolean; reviewsOwnFamily: boolean } | null;
  jev: { configured: boolean; enabled: boolean } | null;
  recallKey: boolean | null;
  apps: { keyPresent: boolean; connected: string[] } | null;
  mcp: { servers: number; unhealthy: string[] } | null;
  phones: number | null;
  phonePush: { ready: boolean; reason?: string } | null;
  calendarWatch: { enabled: boolean; error?: string; lastFinding?: string } | null;
}

const PROVIDER_WORDS: Record<string, string> = {
  claude: 'your Claude account',
  codex: 'your ChatGPT account',
  byo: 'a model key',
  xai: 'your xAI account',
};

function providerWords(provider: string): string {
  return PROVIDER_WORDS[provider] ?? provider;
}

export function appAbilitiesFromFacts(facts: AppAbilityFacts): AppAbility[] {
  const out: AppAbility[] = [];
  const unknown = (id: string, name: string, unlocks: string, place: string): AppAbility =>
    ({ id, name, unlocks, state: 'unknown', detail: 'Could not read this just now.', place });

  out.push(facts.brain
    ? { id: 'brain', name: "Clem's model", unlocks: 'Every answer and every job', state: 'ready',
        detail: `${facts.brain.model} on ${providerWords(facts.brain.provider)}.`, place: 'models' }
    : { id: 'brain', name: "Clem's model", unlocks: 'Every answer and every job', state: 'not_set_up',
        detail: 'No model account is signed in, so Clem cannot answer.', place: 'model-accounts' });

  const checkerUnlocks = 'Clem\'s work is checked by a model from a different company than the one that did it';
  if (!facts.checker) out.push(unknown('second-model', 'A second model provider', checkerUnlocks, 'model-accounts'));
  else if (facts.checker.otherFamilyConnected || !facts.checker.reviewsOwnFamily) {
    out.push({ id: 'second-model', name: 'A second model provider', unlocks: checkerUnlocks, state: 'ready',
      detail: 'Work is checked by a different model family.', place: 'models' });
  } else {
    out.push({ id: 'second-model', name: 'A second model provider', unlocks: checkerUnlocks, state: 'not_set_up',
      detail: 'Only one model provider is signed in, so the same family checks its own work.', place: 'model-accounts' });
  }

  const jevUnlocks = 'Fast first checks on routine decisions, so they do not wait on a large model';
  if (!facts.jev) out.push(unknown('jev', 'Jev', jevUnlocks, 'model-accounts'));
  else out.push({ id: 'jev', name: 'Jev', unlocks: jevUnlocks,
    state: facts.jev.configured && facts.jev.enabled ? 'ready' : facts.jev.configured ? 'needs_attention' : 'not_set_up',
    detail: facts.jev.configured && facts.jev.enabled ? 'Connected and on.'
      : facts.jev.configured ? 'Connected but turned off.' : 'Not connected.',
    place: 'model-accounts' });

  const meetingsUnlocks = 'Clem records your calls, writes the summary and can answer questions about them';
  if (facts.recallKey === null) out.push(unknown('meetings', 'Meeting recording', meetingsUnlocks, 'meetings'));
  else out.push({ id: 'meetings', name: 'Meeting recording', unlocks: meetingsUnlocks,
    state: facts.recallKey ? 'ready' : 'not_set_up',
    detail: facts.recallKey ? 'A Recall key is saved.' : 'No Recall key is saved, so calls are not recorded.',
    place: 'meetings' });

  const appsUnlocks = 'Clem reads and works in your email, calendar, chat and other apps';
  if (!facts.apps) out.push(unknown('apps', 'Connected apps', appsUnlocks, 'connect'));
  else if (!facts.apps.keyPresent) out.push({ id: 'apps', name: 'Connected apps', unlocks: appsUnlocks, state: 'not_set_up',
    detail: 'App connections are not set up yet.', place: 'connect' });
  else out.push({ id: 'apps', name: 'Connected apps', unlocks: appsUnlocks,
    state: facts.apps.connected.length > 0 ? 'ready' : 'not_set_up',
    detail: facts.apps.connected.length > 0 ? `Connected: ${facts.apps.connected.join(', ')}.` : 'No app is connected yet.',
    place: 'connect' });

  const mcpUnlocks = 'Add your own tools and data sources';
  if (!facts.mcp) out.push(unknown('mcp', 'MCP servers', mcpUnlocks, 'connect'));
  else out.push({ id: 'mcp', name: 'MCP servers', unlocks: mcpUnlocks,
    state: facts.mcp.unhealthy.length > 0 ? 'needs_attention' : facts.mcp.servers > 0 ? 'ready' : 'not_set_up',
    detail: facts.mcp.unhealthy.length > 0 ? `Not answering: ${facts.mcp.unhealthy.join(', ')}.`
      : facts.mcp.servers > 0 ? `${facts.mcp.servers} added.` : 'None added.',
    place: 'connect' });

  const phoneUnlocks = 'Talk to Clem and answer her from anywhere';
  if (facts.phones === null) out.push(unknown('phone', 'The phone app', phoneUnlocks, 'phone'));
  else out.push({ id: 'phone', name: 'The phone app', unlocks: phoneUnlocks,
    state: facts.phones > 0 ? 'ready' : 'not_set_up',
    detail: facts.phones > 0 ? `${facts.phones} phone${facts.phones === 1 ? '' : 's'} paired.` : 'No phone is paired.',
    place: 'phone' });

  const pushUnlocks = 'Clem can reach you on your phone when something needs you';
  if (!facts.phonePush) out.push(unknown('phone-alerts', 'Phone notifications', pushUnlocks, 'notifications'));
  else out.push({ id: 'phone-alerts', name: 'Phone notifications', unlocks: pushUnlocks,
    state: facts.phonePush.ready ? 'ready' : facts.phonePush.reason === 'apns_key_missing' ? 'needs_attention' : 'not_set_up',
    detail: facts.phonePush.ready ? 'On.'
      : facts.phonePush.reason === 'apns_key_missing' ? 'A phone is registered but this Mac cannot send it notifications yet.'
        : 'No phone is registered for notifications.',
    place: 'notifications' });

  const watchUnlocks = 'Clem watches your calendar for new invites and conflicts and asks before answering';
  if (!facts.calendarWatch) out.push(unknown('calendar-watch', 'Calendar watch', watchUnlocks, 'heartbeats'));
  else out.push({ id: 'calendar-watch', name: 'Calendar watch', unlocks: watchUnlocks,
    state: !facts.calendarWatch.enabled ? 'not_set_up' : facts.calendarWatch.error ? 'needs_attention' : 'ready',
    detail: !facts.calendarWatch.enabled ? 'Turned off.'
      : facts.calendarWatch.error ? `Its last look failed: ${facts.calendarWatch.error}`
        : facts.calendarWatch.lastFinding ? `On. Last look: ${facts.calendarWatch.lastFinding}` : 'On.',
    place: 'heartbeats' });

  return out;
}

async function settle<T>(read: () => T | Promise<T>, budgetMs = 2_000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); timer.unref?.(); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read every fact from the live host. */
export async function readAppAbilityFacts(): Promise<AppAbilityFacts> {
  const [brain, checker, jev, recallKey, apps, mcp, phones, heartbeats] = await Promise.all([
    settle(async () => {
      const { resolveRoleModel } = await import('../harness/model-roles.js');
      const { claudeAvailable, codexAvailable } = await import('../harness/judge-family.js');
      const role = resolveRoleModel('brain');
      if (!claudeAvailable() && !codexAvailable() && role.provider !== 'byo') return null;
      return { model: role.modelId, provider: role.provider };
    }),
    settle(async () => {
      const { checkerSettingsFacts } = await import('../harness/debate-model.js');
      const facts = checkerSettingsFacts();
      return { otherFamilyConnected: facts.otherFamilyConnected, reviewsOwnFamily: facts.reviewsOwnFamily };
    }),
    settle(async () => {
      const { getJevStatus } = await import('../jev/connect.js');
      const status = await getJevStatus();
      return { configured: status.configured, enabled: status.enabled };
    }),
    settle(async () => {
      const { getSecretStore } = await import('../secrets/index.js');
      const secret = await (await getSecretStore()).get('recall_api_key');
      return Boolean(secret.value);
    }),
    settle(async () => {
      const { getComposioCredentialStatus, listConnectedToolkits } = await import('../../integrations/composio/client.js');
      const status = getComposioCredentialStatus();
      if (!status.apiKeyPresent) return { keyPresent: false, connected: [] };
      const toolkits = await listConnectedToolkits();
      const names = [...new Set(toolkits.filter((toolkit) => toolkit.status === 'ACTIVE' || toolkit.status === 'active')
        .map((toolkit) => toolkit.slug).filter(Boolean))];
      return { keyPresent: true, connected: names };
    }),
    settle(async () => {
      const { discoverMcpServers } = await import('../mcp-config.js');
      const { listMcpServerHealth } = await import('../mcp-namespace-shim.js');
      const servers = discoverMcpServers().length;
      const unhealthy = listMcpServerHealth()
        .filter((row) => row.state === 'unavailable' || row.state === 'degraded')
        .map((row) => row.name);
      return { servers, unhealthy };
    }),
    settle(async () => {
      const { getMobileAccessStatusPayload } = await import('../../integrations/mobile-access.js');
      return (await getMobileAccessStatusPayload()).sessions.length;
    }),
    settle(async () => {
      const { listHeartbeats } = await import('../../agents/heartbeats.js');
      return listHeartbeats();
    }),
  ]);
  const calendar = heartbeats?.find((row) => row.id === 'calendar');
  const push = heartbeats?.[0]?.phonePush as { ready: boolean; reason?: string } | undefined;
  return {
    brain, checker, jev, recallKey, apps, mcp, phones,
    phonePush: push ? { ready: push.ready, ...(push.reason ? { reason: push.reason } : {}) } : null,
    calendarWatch: calendar ? {
      enabled: calendar.enabled,
      ...(calendar.lastError ? { error: calendar.lastError.reason } : {}),
      ...(calendar.lastFinding?.summary ? { lastFinding: calendar.lastFinding.summary } : {}),
    } : null,
  };
}

const STATE_HEADINGS: Array<[AbilityState, string]> = [
  ['needs_attention', 'Needs attention'],
  ['not_set_up', 'Not set up'],
  ['ready', 'Ready'],
  ['unknown', 'Could not check'],
];

/** The guide as Clem reads it: abilities by state, then every place. */
export function appGuideText(abilities: readonly AppAbility[], options: { places?: boolean } = {}): string {
  const lines: string[] = ['What is set up in Clementine right now, and where each part lives.'];
  for (const [state, heading] of STATE_HEADINGS) {
    const rows = abilities.filter((ability) => ability.state === state);
    if (rows.length === 0) continue;
    lines.push('', `${heading}:`);
    for (const ability of rows) {
      lines.push(`- ${ability.name}: ${ability.detail} Gives: ${ability.unlocks}. Place: ${ability.place}`);
    }
  }
  if (options.places !== false) {
    lines.push('', 'Places (id: name, what it is for):');
    for (const place of APP_PLACES) lines.push(`- ${place.id}: ${place.name}, ${place.purpose}${place.phone ? '' : ' (Mac only)'}`);
  }
  lines.push('', 'To send the owner to a place, link it in your reply as [Open <name>](app:<id>); they tap it to go there. Say what to do once they are there.');
  return lines.join('\n');
}
