/**
 * Workspace STARTER RECIPES — the first-ten-minutes activation layer.
 *
 * A recipe is DATA (title, pitch, build prompt, which connection classes make
 * it possible), never code: Clem builds the actual workspace from the prompt
 * through the normal space_save flow, personalized to whatever the user's
 * runtime-discovered connections actually are. No accounts, ids, or vendors
 * are pinned — a recipe only names toolkit-slug FAMILIES to decide relevance,
 * and recipes with no requirements are available to everyone from minute one.
 *
 * Two consumers:
 *  - GET /api/console/spaces/starters → the gallery's "start from a recipe" list.
 *  - maybeOfferStarterWorkspace() — a deterministic, once-ever nudge from the
 *    daemon tick: when the user has ZERO workspaces and ≥1 usable connection,
 *    Clem OFFERS to build the best-matching starter (the user decides; nothing
 *    is ever auto-built — the user owns what gets created).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { isSpacesEnabled, spaceStore } from './store.js';
import { addNotification } from '../runtime/notifications.js';

export interface WorkspaceStarterRecipe {
  id: string;
  title: string;
  /** One-line user-facing pitch ("what you'd get"). */
  pitch: string;
  /** Toolkit-slug substrings (lowercase) — ANY match makes the recipe relevant.
   *  Empty = relevant for everyone (needs no external connection). */
  connects: string[];
  /** The build request seeded into chat/dock when the user picks it. */
  buildPrompt: string;
}

export const WORKSPACE_STARTER_RECIPES: WorkspaceStarterRecipe[] = [
  {
    id: 'deal-board',
    title: 'Deal Board',
    pitch: 'A live board of your open deals — stage, age, next step — refreshed on a schedule, with stale ones flagged.',
    connects: ['salesforce', 'hubspot', 'pipedrive', 'attio'],
    buildPrompt: 'Build me a Deal Board workspace: pull my open deals/opportunities from my connected CRM into a live board grouped by stage, showing amount, age, and last activity. Flag anything stale (no activity in 14+ days). Refresh it every morning and re-engage me if a deal goes stale.',
  },
  {
    id: 'inbox-triage',
    title: 'Inbox Triage',
    pitch: 'Your unread mail sorted into needs-reply / FYI / noise, with one-click drafted replies (you approve every send).',
    connects: ['gmail', 'outlook', 'googlemail'],
    buildPrompt: 'Build me an Inbox Triage workspace: pull my recent unread email from my connected mailbox, sort it into "needs reply", "FYI", and "noise", and give each needs-reply row a Draft button that composes a reply for my approval. Never send anything without my approval.',
  },
  {
    id: 'daily-brief',
    title: 'Daily Brief',
    pitch: "Today's meetings, waiting-on-you items, and anything that changed overnight — one page, ready before you sit down.",
    connects: ['calendar', 'outlook', 'gmail', 'googlecalendar'],
    buildPrompt: "Build me a Daily Brief workspace: today's calendar, emails waiting on my reply, and my open tasks — one clean page, refreshed early each morning so it's ready when I sit down.",
  },
  {
    id: 'seo-rank-tracker',
    title: 'SEO Rank Tracker',
    pitch: 'Your target keywords with live positions and movement arrows — re-engages you when a ranking moves.',
    connects: ['dataforseo', 'semrush', 'ahrefs', 'serp'],
    buildPrompt: 'Build me an SEO Rank Tracker workspace: ask me for my domain and 5-10 target keywords, then track their positions with movement since last check, refreshed daily. Re-engage me when anything moves more than 3 spots.',
  },
  {
    id: 'client-health',
    title: 'Client Health Board',
    pitch: 'Every client with a freshness score — last touch, open items, sentiment — so nobody quietly goes cold.',
    connects: ['salesforce', 'hubspot', 'airtable', 'notion'],
    buildPrompt: 'Build me a Client Health workspace: list my clients/accounts from my connected system with last-touch date, open items, and a simple health color (green/yellow/red by recency). Refresh daily and re-engage me when anyone goes red.',
  },
  {
    id: 'task-cockpit',
    title: 'Task Cockpit',
    pitch: 'Your tasks and goals as a live kanban Clem keeps tidy — works with no connections at all.',
    connects: [],
    buildPrompt: 'Build me a Task Cockpit workspace: my open tasks and goals as a kanban (todo / doing / done) with an add-task box, pulled from your local task list. Keep it tidy with your task hygiene each evening.',
  },
];

/** Recipes relevant to THIS user right now, given runtime-discovered toolkit
 *  slugs (lowercased). Connection-free recipes always qualify. */
export function availableStarterRecipes(connectedSlugs: string[]): Array<WorkspaceStarterRecipe & { connected: boolean }> {
  const slugs = connectedSlugs.map((s) => s.toLowerCase());
  return WORKSPACE_STARTER_RECIPES
    .map((recipe) => ({
      ...recipe,
      connected: recipe.connects.length === 0
        || recipe.connects.some((family) => slugs.some((slug) => slug.includes(family))),
    }))
    .filter((r) => r.connected || r.connects.length > 0); // keep all; `connected` drives ordering/labels
}

const OFFER_MARKER = path.join(BASE_DIR, 'state', 'starter-workspace-offer.json');

export interface StarterOfferDeps {
  listConnectedSlugs: () => Promise<string[]>;
  notify?: typeof addNotification;
  now?: () => Date;
}

/**
 * Once-ever activation nudge: zero workspaces + at least one usable connection
 * (or a connection-free recipe day-one) → a single SUGGEST notification. Never
 * builds anything — the user replies in chat and Clem builds through the normal
 * flow. Deterministic, no LLM, marker-guarded, fail-quiet.
 */
/** Throttle: a fresh install with no connections shouldn't probe Composio on
 *  every daemon tick — once per 30 min is plenty for an activation nudge. */
let lastProbeMs = 0;
const PROBE_INTERVAL_MS = 30 * 60 * 1000;

export async function maybeOfferStarterWorkspace(deps: StarterOfferDeps): Promise<boolean> {
  try {
    if (!isSpacesEnabled()) return false;
    if (existsSync(OFFER_MARKER)) return false;
    if (spaceStore.list(true).length > 0) {
      // The user already has workspaces — never nudge; mark so we never rescan.
      writeMarker({ offeredAt: null, reason: 'already-has-workspaces' }, deps);
      return false;
    }
    // Only the NETWORK probe is throttled — the local checks above stay cheap
    // enough to run on every tick.
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (nowMs - lastProbeMs < PROBE_INTERVAL_MS) return false;
    lastProbeMs = nowMs;
    let slugs: string[] = [];
    try { slugs = await deps.listConnectedSlugs(); } catch { slugs = []; }
    const available = availableStarterRecipes(slugs).filter((r) => r.connected);
    // Require at least one CONNECTED recipe beyond the always-available ones —
    // the nudge lands best when it names the user's own systems.
    const connectedBacked = available.filter((r) => r.connects.length > 0);
    if (connectedBacked.length === 0) return false; // wait for a connection; marker NOT written
    const top = [...connectedBacked, ...available.filter((r) => r.connects.length === 0)].slice(0, 3);
    const lines = top.map((r) => `• ${r.title} — ${r.pitch}`).join('\n');
    (deps.notify ?? addNotification)({
      id: 'starter-workspace-offer',
      kind: 'system',
      title: 'Want a live workspace? I can build one now.',
      body: `You're connected — I can build you a live, self-refreshing workspace in a few minutes. Good fits:\n${lines}\n\nJust tell me which one (or describe your own) and I'll build it.`,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      read: false,
      metadata: { recipes: top.map((r) => r.id) },
    });
    writeMarker({ offeredAt: (deps.now?.() ?? new Date()).toISOString(), recipes: top.map((r) => r.id) }, deps);
    return true;
  } catch {
    return false; // the nudge must never break the daemon tick
  }
}

function writeMarker(content: Record<string, unknown>, deps: StarterOfferDeps): void {
  try {
    mkdirSync(path.dirname(OFFER_MARKER), { recursive: true });
    writeFileSync(OFFER_MARKER, JSON.stringify({ ...content, at: (deps.now?.() ?? new Date()).toISOString() }, null, 2), 'utf-8');
  } catch { /* marker is best-effort; dedup by notification id is the backstop */ }
}

/** Test hook: read the marker (or null). */
export function readStarterOfferMarker(): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(OFFER_MARKER, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}
