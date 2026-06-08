/**
 * Workspace creation-time smoke — the Space mirror of the workflow read-only
 * creation test (the v0.5.70 "scorpion" fix). On save, RUN each data source once
 * (read-only, no LLM) to confirm it returns real data, and VERIFY each action's
 * Composio toolkit is actually authed (without firing the action). A Space only
 * stays 'active' if every source ran; a source that ERRORED parks it 'paused'
 * (draft) so a broken pipeline never ships looking done. A source that returned
 * ZERO rows stays active but becomes a clarifying question (an empty result can
 * be legitimate — "no leads today" — so ask rather than block).
 *
 * This is the layer that catches what structure-validation can't: a wrong query,
 * a guessed Composio slug, a runner whose shape doesn't match the view.
 */
import { spaceStore } from './store.js';
import { refreshSpaceData } from './runner.js';
import { readData } from './data-store.js';
import { listConnectedToolkits } from '../integrations/composio/client.js';

/** Heuristic "did this source return anything usable?" — empty array, empty
 *  object, or null/undefined all count as empty; any non-empty array or scalar
 *  value (at top level or one level down, e.g. {contacts:[...]}) counts as data. */
export function looksEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).filter((k) => k !== '_meta');
    if (keys.length === 0) return true;
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (Array.isArray(v)) { if (v.length > 0) return false; continue; }
      if (v && typeof v === 'object') { if (!looksEmpty(v)) return false; continue; }
      if (v != null && v !== '' && v !== 0 && v !== false) return false; // a real scalar
    }
    return true;
  }
  return value === '' || value === 0 || value === false;
}

/** Composio tool slug → toolkit slug (the first segment, lowercased).
 *  e.g. OUTLOOK_OUTLOOK_SEND_EMAIL → "outlook", SALESFORCE_QUERY → "salesforce". */
export function toolkitSlugForTool(toolSlug: string): string {
  return (toolSlug.split('_')[0] ?? '').toLowerCase();
}

export interface SpaceSmokeResult {
  ran: boolean;
  failed: { id: string; error: string }[];
  empty: string[];
  actionWarnings: string[];
}

/**
 * Run the creation smoke for a saved Workspace. Executes every data source once
 * (persisting the first pull as a bonus), classifies the output, and checks each
 * action's toolkit connection. Pure data sources only — actions are NEVER fired.
 */
export async function runSpaceCreationSmoke(slug: string): Promise<SpaceSmokeResult> {
  const rec = spaceStore.get(slug);
  if (!rec) return { ran: false, failed: [], empty: [], actionWarnings: [] };

  const failed: { id: string; error: string }[] = [];
  const empty: string[] = [];
  const actionWarnings: string[] = [];

  for (const source of rec.dataSources) {
    let results;
    try {
      results = await refreshSpaceData(slug, source.id);
    } catch (err) {
      failed.push({ id: source.id, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const r = results[0];
    if (!r || !r.ok) { failed.push({ id: source.id, error: r?.error ?? 'unknown error' }); continue; }
    const data = readData(slug);
    const val = data && typeof data === 'object' ? (data as Record<string, unknown>)[source.id] : undefined;
    if (looksEmpty(val)) empty.push(source.id);
  }

  // Verify each action's Composio toolkit is connected (read-only; never fire).
  const composioActions = rec.actions.filter((a) => a.composioSlug && a.composioSlug.trim());
  if (composioActions.length > 0) {
    let connected: Awaited<ReturnType<typeof listConnectedToolkits>> = [];
    try { connected = await listConnectedToolkits(); } catch { connected = []; }
    if (connected.length === 0) {
      // Couldn't reach Composio — a transient failure must NOT block; advise.
      for (const a of composioActions) {
        actionWarnings.push(`Couldn't verify action "${a.id}" (Composio not reachable) — confirm "${a.composioSlug}" is the real slug and its app is connected before relying on the send.`);
      }
    } else {
      const activeToolkits = new Set(
        connected.filter((c) => /active/i.test(c.status)).map((c) => c.slug.toLowerCase()),
      );
      for (const a of composioActions) {
        const tk = toolkitSlugForTool(a.composioSlug!);
        if (!activeToolkits.has(tk)) {
          actionWarnings.push(`Action "${a.id}" calls "${a.composioSlug}" but the "${tk}" app isn't connected/active in Composio — authorize it in Connect, or the action will fail when fired.`);
        }
      }
    }
  }

  return { ran: true, failed, empty, actionWarnings };
}
