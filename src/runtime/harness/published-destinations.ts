/**
 * Established-destination memory — the durable project→destination binding that
 * unifies the destination gate's PROVENANCE with the agent's TOOL RECALL.
 *
 * The 2026-06-21 recurrence taught the real lesson: the destination gate hard-
 * blocked a redeploy because provenance was SAME-SESSION only — it treated a
 * site the user had deliberately published to for days as an "unrelated live
 * site". But "have I published this project here before?" is a MEMORY question,
 * and the harness already had the answer (prior deploys, the pinned focus, a
 * tool-choice memo). The fix is to LEARN it: when a publish to an explicit
 * target SUCCEEDS, record (project → destination) durably; thereafter the gate
 * confers provenance on that target for that project (no re-clobber risk — it's
 * keyed by project, so a site established for the coffee-shop project can never
 * provenance a law-firm deploy), and the agent can recall where this project
 * deploys.
 *
 * Targets are stored as IDENTITY FORMS (see destinationIdentityForms) so a site
 * created as `foo` matches a later deploy to `foo.netlify.app` — general across
 * netlify/vercel/pages/etc with no vendor list. Machine-scoped JSON, best-effort
 * (a read/write failure never breaks a tool call — it only makes the gate
 * stricter, never looser).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { getMachineId } from '../machine-id.js';
import { destinationIdentityForms } from './destination-gate.js';

const STORE_DIR = path.join(BASE_DIR, 'state', 'published-destinations');
const MAX_FORMS_PER_PROJECT = 50;

interface ProjectDestinations {
  /** Identity forms (host + first label) of every target this project has
   *  successfully published to. */
  forms: string[];
  lastAt: string;
  count: number;
}
type Store = Record<string, ProjectDestinations>;

function storeFile(): string {
  return path.join(STORE_DIR, `${getMachineId()}.json`);
}

/** Project identity = the deploy's working directory (or focus resource), so the
 *  binding is per-project. Lowercased, trailing-slash-stripped for stability. */
export function normalizeProjectKey(key: string | undefined): string {
  return (key ?? '').trim().toLowerCase().replace(/\/+$/, '');
}

function load(): Store {
  try {
    if (!existsSync(storeFile())) return {};
    const parsed = JSON.parse(readFileSync(storeFile(), 'utf8')) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(storeFile(), JSON.stringify(store, null, 2), 'utf8');
  } catch {
    /* best-effort — telemetry/memory must never break a tool call */
  }
}

/**
 * Record that `projectKey` successfully published to `targets` (call ONLY after a
 * verified-successful publish). Stores every target's identity forms so future
 * provenance matching is alias-aware. Idempotent + bounded.
 */
export function recordPublishedDestination(projectKey: string | undefined, targets: string[], at = new Date().toISOString()): void {
  const pk = normalizeProjectKey(projectKey);
  if (!pk || !Array.isArray(targets) || targets.length === 0) return;
  const incoming = new Set<string>();
  for (const t of targets) for (const f of destinationIdentityForms(t)) incoming.add(f);
  if (incoming.size === 0) return;
  const store = load();
  const prior = store[pk]?.forms ?? [];
  const merged = [...new Set([...prior, ...incoming])].slice(-MAX_FORMS_PER_PROJECT);
  store[pk] = { forms: merged, lastAt: at, count: (store[pk]?.count ?? 0) + 1 };
  save(store);
}

/** The identity forms of every destination `projectKey` has established. Empty
 *  when the project has never had a recorded successful publish. */
export function establishedTargetsFor(projectKey: string | undefined): Set<string> {
  const pk = normalizeProjectKey(projectKey);
  if (!pk) return new Set();
  return new Set(load()[pk]?.forms ?? []);
}

/** Does `target` belong to a destination `projectKey` has established before?
 *  Identity-aware (slug vs subdomain vs url). */
export function isEstablishedDestination(projectKey: string | undefined, target: string): boolean {
  const established = establishedTargetsFor(projectKey);
  if (established.size === 0) return false;
  return destinationIdentityForms(target).some((f) => established.has(f));
}

/**
 * A one-line context hint naming where THIS project deploys, so the agent
 * RECALLS the established destination and updates it explicitly (`--site
 * <target>`) instead of re-discovering, minting a new site, or tripping the
 * provenance gate. This is the AGENT side of the gate↔recall unification
 * (2026-06-21): the same durable record that confers provenance also tells the
 * agent how it deploys this project. Empty when the project has none. Pure read.
 */
export function renderEstablishedDestinationsForContext(projectKey: string | undefined): string {
  const forms = establishedTargetsFor(projectKey);
  if (forms.size === 0) return '';
  // Prefer the actionable full-host forms (foo.netlify.app) over bare labels.
  const hosts = [...forms].filter((f) => f.includes('.'));
  const display = (hosts.length > 0 ? hosts : [...forms]).slice(0, 3);
  return `You have deployed THIS project before to: ${display.join(', ')}. To update it, redeploy to the SAME target explicitly (e.g. \`--site <that target or its id>\`) — do not create a new site or re-discover the destination.`;
}

/** Test seam: the on-disk store path (so tests can assert/clean it). */
export function _publishedDestinationsFileForTests(): string {
  return storeFile();
}
