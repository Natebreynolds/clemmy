import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { resolveSafeCliProbe } from '../../runtime/cli-discovery.js';

/**
 * Curated catalog of installable CLIs that Clementine knows how to:
 *   1. install in one click (via the existing approved-install runner)
 *   2. point the user at the right auth flow afterward
 *   3. surface to the agent as a "connected" CLI (vs random $PATH noise)
 *
 * The UI is search-first — entries here aren't displayed in a grid. The
 * user types "salesforce", "railway", etc., and we filter against name +
 * command + vendor + tags. This file is the only place the catalog lives;
 * adding a new entry here is the entire change.
 *
 * Adding rules of thumb:
 *   - Install commands MUST match the allowlist in
 *     integrations/browser-harness.validateInstallCommand. Today that
 *     means npm/brew/uv/pipx/git-clone forms.
 *   - Provide an `installFallback` only if the primary form isn't
 *     universally available (e.g. brew-only formulae get a curl fallback
 *     in the doc text, not as a run-it command).
 *   - Auth flow is best linked, not scripted — `authDocsUrl` is required.
 *     `authCommand` is optional and only useful when there's a clean
 *     one-liner like `gh auth login`.
 */

export type CliInstallSource = 'npm' | 'brew' | 'uv' | 'pipx';

/**
 * Read-only auth-state probe for a catalog CLI. By contract the probe
 * command must be a pure status read (whoami/status/list shapes) — the
 * catalog test pins that no probe carries a mutating verb. Output is
 * ANSI-stripped before classification (netlify colors its status output).
 *
 * Classification order (auth-health.ts): signedOutPattern match →
 * signed_out; exit 0 with output → ok; otherwise → error. The pattern is
 * checked FIRST because some CLIs report signed-out states with exit 0
 * (verified live: `gcloud auth list --filter=status:ACTIVE` prints `[]`
 * and exits 0 with no active account).
 */
export interface CliAuthProbe {
  /** argv appended to the entry's command, e.g. ['whoami']. */
  args: string[];
  /** Regex source (case-insensitive) marking a signed-out result. */
  signedOutPattern?: string;
  /** Regex source whose first capture group extracts the account name. */
  usernameCapture?: string;
  /** Probe timeout; default 5s in auth-health. */
  timeoutMs?: number;
}

export interface CliCatalogEntry {
  /** Stable id used by the UI + connected-clis record. kebab-case. */
  id: string;
  /** Display name. */
  name: string;
  /** Bare command the user would run. Used for $PATH lookup. */
  command: string;
  /** Vendor / company so the user can recognize it. */
  vendor: string;
  /** Short pitch — one sentence. */
  description: string;
  /** Search aliases. Include nicknames, abbreviations, common typos. */
  tags: string[];
  /** Install command, must match the install allowlist. */
  installCommand: string;
  installSource: CliInstallSource;
  /** Docs URL the "Configure" button opens. Required. */
  authDocsUrl: string;
  /** Optional auth-bootstrap command shown post-install. */
  authCommand?: string;
  /** Optional project / product homepage shown on the card. */
  homepage?: string;
  /** Optional read-only auth-state probe. Absent → auth status 'unknown'. */
  authProbe?: CliAuthProbe;
  /**
   * True ONLY when authCommand completes without TTY input (opens a
   * browser / device-code flow and waits on a localhost callback). Gates
   * the one-click Sign in job — a wrong `true` means a hung job, so this
   * is set per-entry only after the flow is verified by hand. Entries
   * whose login prompts in the terminal (aws configure, gcloud init,
   * vercel's method picker, stripe's press-Enter pairing) stay absent.
   */
  authHeadless?: boolean;
}

/**
 * Curated entries. Order doesn't matter — search ranks by relevance.
 * Keep this list deliberately small and well-tested rather than chasing
 * coverage; better to ship 15 reliable links than 50 broken ones.
 */
export const CLI_CATALOG: readonly CliCatalogEntry[] = [
  {
    id: 'salesforce',
    name: 'Salesforce CLI',
    command: 'sf',
    vendor: 'Salesforce',
    description: 'Manage Salesforce orgs, deploy metadata, run SOQL, and automate Apex.',
    tags: ['salesforce', 'sf', 'sfdx', 'crm', 'apex', 'soql'],
    installCommand: 'npm install -g @salesforce/cli',
    installSource: 'npm',
    authDocsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_auth_intro.htm',
    authCommand: 'sf org login web -a default',
    homepage: 'https://developer.salesforce.com/tools/salesforcecli',
  },
  {
    id: 'higgsfield',
    name: 'Higgsfield CLI',
    command: 'higgsfield',
    vendor: 'Higgsfield',
    description: 'Run Higgsfield image, video, and Marketing Studio generative workflows from the terminal.',
    tags: ['higgsfield', 'higgs', 'hf', 'video', 'image', 'generative', 'ai', 'marketing studio', 'soul-id', 'product-photoshoot'],
    installCommand: 'npm install -g @higgsfield/cli',
    installSource: 'npm',
    authDocsUrl: 'https://higgsfield.ai/cli',
    // Note: subcommand `auth login`, not bare `login` (verified against
    // higgsfield 0.1.33). Surfaces as the post-install bootstrap step
    // so the user knows the exact handshake command.
    authCommand: 'higgsfield auth login',
    homepage: 'https://higgsfield.ai',
  },
  {
    id: 'railway',
    name: 'Railway CLI',
    command: 'railway',
    vendor: 'Railway',
    description: 'Deploy services, manage environments, and tail logs on Railway.',
    tags: ['railway', 'deploy', 'paas'],
    installCommand: 'npm install -g @railway/cli',
    installSource: 'npm',
    authDocsUrl: 'https://docs.railway.com/guides/cli',
    authCommand: 'railway login',
    // Verified live: exit 0 + "Logged in as user@host 👋"; signed out
    // reports "Unauthorized. Please login with `railway login`".
    authProbe: { args: ['whoami'], signedOutPattern: 'unauthorized|not logged in', usernameCapture: 'Logged in as (\\S+)' },
    // `railway login` opens the browser and waits on a callback — no TTY
    // input. Job runner enforces a hard timeout as the safety net.
    authHeadless: true,
    homepage: 'https://railway.com',
  },
  {
    id: 'vercel',
    name: 'Vercel CLI',
    command: 'vercel',
    vendor: 'Vercel',
    description: 'Deploy front-end and edge functions to Vercel, manage projects + domains.',
    tags: ['vercel', 'deploy', 'next.js', 'nextjs', 'edge'],
    installCommand: 'npm install -g vercel',
    installSource: 'npm',
    authDocsUrl: 'https://vercel.com/docs/cli',
    authCommand: 'vercel login',
    homepage: 'https://vercel.com',
  },
  {
    id: 'supabase',
    name: 'Supabase CLI',
    command: 'supabase',
    vendor: 'Supabase',
    description: 'Local dev + migrations + Edge Functions for Supabase projects.',
    tags: ['supabase', 'postgres', 'database', 'edge functions'],
    installCommand: 'brew install supabase/tap/supabase',
    installSource: 'brew',
    authDocsUrl: 'https://supabase.com/docs/guides/local-development/cli/getting-started',
    authCommand: 'supabase login',
    homepage: 'https://supabase.com',
  },
  {
    id: 'github',
    name: 'GitHub CLI',
    command: 'gh',
    vendor: 'GitHub',
    description: 'Work with PRs, issues, releases, and Actions from the terminal.',
    tags: ['github', 'gh', 'git', 'pr', 'pull request'],
    installCommand: 'brew install gh',
    installSource: 'brew',
    authDocsUrl: 'https://docs.github.com/en/github-cli/github-cli/quickstart',
    authCommand: 'gh auth login',
    homepage: 'https://cli.github.com',
  },
  {
    id: 'aws',
    name: 'AWS CLI',
    command: 'aws',
    vendor: 'Amazon Web Services',
    description: 'Manage every AWS service from S3 to IAM to Lambda.',
    tags: ['aws', 'amazon', 's3', 'iam', 'lambda', 'ec2'],
    installCommand: 'brew install awscli',
    installSource: 'brew',
    authDocsUrl: 'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html',
    authCommand: 'aws configure',
    homepage: 'https://aws.amazon.com/cli/',
  },
  {
    id: 'gcloud',
    name: 'Google Cloud CLI',
    command: 'gcloud',
    vendor: 'Google Cloud',
    description: 'Manage GCP projects, services, and resources.',
    tags: ['gcloud', 'gcp', 'google cloud', 'firebase'],
    installCommand: 'brew install --cask google-cloud-sdk',
    installSource: 'brew',
    authDocsUrl: 'https://cloud.google.com/sdk/docs/initializing',
    authCommand: 'gcloud init',
    // Verified live: active account as a JSON array; with NO active
    // account it prints `[]` and still exits 0 — the pattern carries the
    // signed-out truth, not the exit code.
    authProbe: { args: ['auth', 'list', '--format=json', '--filter=status:ACTIVE'], signedOutPattern: '^\\s*\\[\\s*\\]\\s*$', usernameCapture: '"account":\\s*"([^"]+)"', timeoutMs: 10_000 },
    homepage: 'https://cloud.google.com/sdk',
  },
  {
    id: 'heroku',
    name: 'Heroku CLI (manual)',
    // Note: Heroku is intentionally omitted from auto-install because
    // the canonical brew form is `brew tap heroku/brew && brew install
    // heroku`, which is a two-step command our installer allowlist
    // rejects. Listed here so search finds it, but installCommand
    // points the user at the docs rather than running a broken cmd.
    command: 'heroku',
    vendor: 'Heroku',
    description: 'Manage Heroku apps, dynos, addons, and releases. Install via the linked docs.',
    tags: ['heroku', 'paas', 'deploy'],
    installCommand: 'brew install heroku',
    installSource: 'brew',
    authDocsUrl: 'https://devcenter.heroku.com/articles/heroku-cli',
    authCommand: 'heroku login',
    homepage: 'https://devcenter.heroku.com/articles/heroku-cli',
  },
  {
    id: 'stripe',
    name: 'Stripe CLI',
    command: 'stripe',
    vendor: 'Stripe',
    description: 'Trigger events, tail webhook logs, manage products and prices.',
    tags: ['stripe', 'payments', 'webhooks'],
    installCommand: 'brew install stripe/stripe-cli/stripe',
    installSource: 'brew',
    authDocsUrl: 'https://docs.stripe.com/stripe-cli',
    authCommand: 'stripe login',
    homepage: 'https://stripe.com/docs/stripe-cli',
  },
  {
    id: 'wrangler',
    name: 'Cloudflare Wrangler',
    command: 'wrangler',
    vendor: 'Cloudflare',
    description: 'Build, deploy, and tail Workers; manage Pages, KV, R2, D1.',
    tags: ['cloudflare', 'wrangler', 'workers', 'pages', 'kv', 'r2', 'd1'],
    installCommand: 'npm install -g wrangler',
    installSource: 'npm',
    authDocsUrl: 'https://developers.cloudflare.com/workers/wrangler/get-started/',
    authCommand: 'wrangler login',
    homepage: 'https://developers.cloudflare.com/workers/',
  },
  {
    id: 'flyio',
    name: 'Fly.io CLI',
    command: 'flyctl',
    vendor: 'Fly.io',
    description: 'Deploy apps globally on Fly.io machines.',
    tags: ['fly', 'flyio', 'fly.io', 'flyctl', 'deploy'],
    installCommand: 'brew install flyctl',
    installSource: 'brew',
    authDocsUrl: 'https://fly.io/docs/flyctl/auth-login/',
    authCommand: 'flyctl auth login',
    homepage: 'https://fly.io',
  },
  {
    id: 'netlify',
    name: 'Netlify CLI',
    command: 'netlify',
    vendor: 'Netlify',
    description: 'Deploy sites, run local dev, manage Netlify Functions.',
    tags: ['netlify', 'jamstack', 'deploy'],
    installCommand: 'npm install -g netlify-cli',
    installSource: 'npm',
    authDocsUrl: 'https://docs.netlify.com/cli/get-started/',
    authCommand: 'netlify login',
    // Verified live: exit 0 with a "Current Netlify User" block (ANSI
    // colored — auth-health strips escapes) even outside a linked
    // project; signed out prints "Not logged in".
    authProbe: { args: ['status'], signedOutPattern: 'not logged in', usernameCapture: 'Email:\\s*(\\S+)', timeoutMs: 10_000 },
    authHeadless: true,
    homepage: 'https://www.netlify.com',
  },
  {
    id: 'doppler',
    name: 'Doppler CLI',
    command: 'doppler',
    vendor: 'Doppler',
    description: 'Sync secrets across environments without checking them into source.',
    tags: ['doppler', 'secrets', 'env'],
    installCommand: 'brew install dopplerhq/cli/doppler',
    installSource: 'brew',
    authDocsUrl: 'https://docs.doppler.com/docs/install-cli',
    authCommand: 'doppler login',
    homepage: 'https://www.doppler.com',
  },
  {
    id: 'ngrok',
    name: 'ngrok',
    command: 'ngrok',
    vendor: 'ngrok',
    description: 'Expose local servers to the public internet via secure tunnels.',
    tags: ['ngrok', 'tunnel', 'webhook'],
    installCommand: 'brew install ngrok/ngrok/ngrok',
    installSource: 'brew',
    authDocsUrl: 'https://ngrok.com/docs/getting-started/',
    authCommand: 'ngrok config add-authtoken <your-token>',
    homepage: 'https://ngrok.com',
  },
  {
    id: 'doctl',
    name: 'DigitalOcean CLI',
    command: 'doctl',
    vendor: 'DigitalOcean',
    description: 'Manage Droplets, Apps, Kubernetes, and Spaces on DigitalOcean.',
    tags: ['digitalocean', 'doctl', 'do'],
    installCommand: 'brew install doctl',
    installSource: 'brew',
    authDocsUrl: 'https://docs.digitalocean.com/reference/doctl/how-to/install/',
    authCommand: 'doctl auth init',
    homepage: 'https://www.digitalocean.com/products/tools',
  },
  // Guest agent harnesses — these two are what project_run drives inside the
  // user's local projects. They cannot ship bundled with the app (Claude Code
  // is proprietary; both self-update and carry per-user subscription auth),
  // so install-on-demand through this catalog IS the distribution story.
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    vendor: 'Anthropic',
    description: 'Anthropic’s coding agent — runs your projects’ slash commands and skills on your Claude subscription.',
    tags: ['claude', 'claude code', 'anthropic', 'agent', 'harness', 'coding'],
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    installSource: 'npm',
    authDocsUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    authCommand: 'claude auth login',
    // Verified live (claude 2.1.220): `claude auth status` exits 0 with JSON
    // {"loggedIn":true,...,"email":"..."}. Signed-out shape not exercised
    // (would require logging the user out) — pattern targets the documented
    // loggedIn:false field, and pattern-first classification covers an
    // exit-0 signed-out report, same trap class as gcloud.
    authProbe: { args: ['auth', 'status'], signedOutPattern: '"loggedIn"\\s*:\\s*false', usernameCapture: '"email"\\s*:\\s*"([^"]+)"' },
    homepage: 'https://www.anthropic.com/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    vendor: 'OpenAI',
    description: 'OpenAI’s coding agent — works in your projects on your ChatGPT subscription.',
    tags: ['codex', 'openai', 'chatgpt', 'agent', 'harness', 'coding'],
    installCommand: 'npm install -g @openai/codex',
    installSource: 'npm',
    authDocsUrl: 'https://developers.openai.com/codex/cli',
    authCommand: 'codex login',
    // Verified live (codex-cli 0.144.3): `codex login status` exits 0 with
    // "Logged in using ChatGPT". Signed-out shape not exercised — the CLI
    // reports "Not logged in" per its own docs/help.
    authProbe: { args: ['login', 'status'], signedOutPattern: 'not logged in', usernameCapture: 'Logged in using (\\S+)' },
    homepage: 'https://developers.openai.com/codex',
  },
];

// ─── Search ─────────────────────────────────────────────────────────

export interface CatalogSearchResult extends CliCatalogEntry {
  /** Match score 0..1 — higher = better. UI sorts by this descending. */
  score: number;
}

/**
 * Substring + token search across name, command, vendor, tags, and
 * description. The dashboard's user types a partial name and we surface
 * matches sorted by relevance. No fuzzy matching — keeping it predictable
 * so "salesforce" returns Salesforce CLI deterministically.
 */
export function searchCatalog(query: string): CatalogSearchResult[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const results: CatalogSearchResult[] = [];
  for (const entry of CLI_CATALOG) {
    let score = 0;
    const name = entry.name.toLowerCase();
    const cmd = entry.command.toLowerCase();
    const vendor = entry.vendor.toLowerCase();
    const desc = entry.description.toLowerCase();
    // Strongest signals first: exact command match > exact name > prefix
    // matches > tag membership > description hit.
    if (cmd === q) score = Math.max(score, 1.0);
    if (name === q) score = Math.max(score, 0.95);
    if (cmd.startsWith(q)) score = Math.max(score, 0.85);
    if (name.startsWith(q)) score = Math.max(score, 0.8);
    for (const t of entry.tags) {
      const tag = t.toLowerCase();
      if (tag === q) score = Math.max(score, 0.78);
      else if (tag.startsWith(q)) score = Math.max(score, 0.7);
      else if (tag.includes(q)) score = Math.max(score, 0.55);
    }
    if (vendor.includes(q)) score = Math.max(score, 0.5);
    if (name.includes(q)) score = Math.max(score, 0.45);
    if (desc.includes(q)) score = Math.max(score, 0.3);
    if (score > 0) results.push({ ...entry, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

export function findCatalogEntry(id: string): CliCatalogEntry | undefined {
  return CLI_CATALOG.find((e) => e.id === id);
}

// ─── Install status (is the CLI on $PATH right now) ────────────────

function whichOnPath(command: string): string | undefined {
  const PATH = process.env.PATH ?? '';
  for (const dir of PATH.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      const st = statSync(candidate);
      if (st.isFile() && (st.mode & 0o111)) return candidate;
    } catch { /* skip */ }
  }
  return undefined;
}

export interface CatalogEntryStatus extends CliCatalogEntry {
  installed: boolean;
  installedAt?: string;
  /** Path the command resolves to on $PATH, when installed. */
  resolvedPath?: string;
}

export function statusForEntry(entry: CliCatalogEntry): CatalogEntryStatus {
  const resolved = whichOnPath(entry.command);
  const safe = resolved ? resolveSafeCliProbe(entry.command, resolved) : null;
  const connected = readConnectedClis()[entry.id];
  return {
    ...entry,
    installed: Boolean(safe && !safe.skipped),
    installedAt: connected?.installedAt,
    resolvedPath: safe?.path ?? resolved,
  };
}

export function statusForSearchResults(query: string): Array<CatalogEntryStatus & { score: number }> {
  return searchCatalog(query).map((entry) => ({ ...statusForEntry(entry), score: entry.score }));
}

// ─── Connected-CLI record (links to the agent) ──────────────────────

const CONNECTED_FILE = path.join(BASE_DIR, 'state', 'connected-clis.json');

export interface ConnectedCliRecord {
  id: string;
  command: string;
  vendor: string;
  name: string;
  installedAt: string;
  authDocsUrl: string;
  authCommand?: string;
  /** Denormalized from the catalog at record time (same as authCommand). */
  authProbe?: CliAuthProbe;
  authHeadless?: boolean;
}

interface ConnectedClisFile {
  version: 'v1';
  entries: Record<string, ConnectedCliRecord>;
  /**
   * Catalog ids the user EXPLICITLY chose to disconnect. We track this
   * so autoPromoteInstalledClis() doesn't immediately re-promote a CLI
   * the user just told us to forget. Empty/absent on fresh installs.
   * Cleared per-id when the user clicks Reconnect.
   */
  forgotten?: string[];
}

export function readConnectedClis(): Record<string, ConnectedCliRecord> {
  if (!existsSync(CONNECTED_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONNECTED_FILE, 'utf-8')) as ConnectedClisFile;
    if (parsed && parsed.entries) return parsed.entries;
  } catch { /* fall through */ }
  return {};
}

/** Same file as readConnectedClis but returns the forgotten ids list.
 *  Kept as a separate function so callers don't have to know about the
 *  full file shape. Returns [] when file is missing or malformed. */
export function readForgottenCliIds(): string[] {
  if (!existsSync(CONNECTED_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(CONNECTED_FILE, 'utf-8')) as ConnectedClisFile;
    return Array.isArray(parsed.forgotten) ? parsed.forgotten : [];
  } catch { return []; }
}

function writeConnectedClis(entries: Record<string, ConnectedCliRecord>, forgotten?: string[]): void {
  mkdirSync(path.dirname(CONNECTED_FILE), { recursive: true });
  const tmp = `${CONNECTED_FILE}.${process.pid}.tmp`;
  // Preserve forgotten[] from disk if not explicitly passed in. That way
  // callers that only need to update entries (recordConnectedCli) don't
  // have to know about the forgotten list.
  const finalForgotten = forgotten ?? readForgottenCliIds();
  const payload: ConnectedClisFile = { version: 'v1', entries };
  if (finalForgotten.length > 0) payload.forgotten = finalForgotten;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  renameSync(tmp, CONNECTED_FILE);
}

/**
 * Mark a catalog entry as connected (typically called right after the
 * install runner reports success). Idempotent — a second call updates
 * installedAt to "now".
 */
export function recordConnectedCli(entry: CliCatalogEntry): ConnectedCliRecord {
  const current = readConnectedClis();
  const record: ConnectedCliRecord = {
    id: entry.id,
    command: entry.command,
    vendor: entry.vendor,
    name: entry.name,
    installedAt: new Date().toISOString(),
    authDocsUrl: entry.authDocsUrl,
    authCommand: entry.authCommand,
    ...(entry.authProbe ? { authProbe: entry.authProbe } : {}),
    ...(entry.authHeadless !== undefined ? { authHeadless: entry.authHeadless } : {}),
  };
  current[entry.id] = record;
  writeConnectedClis(current);
  return record;
}

/**
 * Drop a connected-CLI record AND remember that the user explicitly
 * forgot it, so the auto-promote loop doesn't immediately re-add it on
 * the next refresh. The binary on PATH is untouched — this just clears
 * Clementine's note that the user wants this surfaced as connected.
 */
export function forgetConnectedCli(id: string): void {
  const current = readConnectedClis();
  const forgotten = readForgottenCliIds();
  const hadEntry = id in current;
  if (hadEntry) delete current[id];
  // Idempotent: add to forgotten if not already there.
  const nextForgotten = forgotten.includes(id) ? forgotten : [...forgotten, id];
  if (!hadEntry && nextForgotten.length === forgotten.length) return; // nothing to write
  writeConnectedClis(current, nextForgotten);
}

/**
 * Reconnect a previously-forgotten catalog CLI. Drops it from the
 * forgotten list and records the connection. Used by the dashboard's
 * "Reconnect" button when the user wants a CLI back after explicitly
 * disconnecting it earlier.
 */
export function reconnectCli(id: string): ConnectedCliRecord | null {
  const entry = findCatalogEntry(id);
  if (!entry) return null;
  const forgotten = readForgottenCliIds().filter((x) => x !== id);
  const current = readConnectedClis();
  const record: ConnectedCliRecord = {
    id: entry.id,
    command: entry.command,
    vendor: entry.vendor,
    name: entry.name,
    installedAt: new Date().toISOString(),
    authDocsUrl: entry.authDocsUrl,
    authCommand: entry.authCommand,
    ...(entry.authProbe ? { authProbe: entry.authProbe } : {}),
    ...(entry.authHeadless !== undefined ? { authHeadless: entry.authHeadless } : {}),
  };
  current[entry.id] = record;
  writeConnectedClis(current, forgotten);
  return record;
}

/**
 * Auto-promotion sweep — for every catalog entry whose binary resolves
 * on PATH but isn't yet in the connected list AND wasn't explicitly
 * forgotten, write a connected record. Idempotent + fast (one PATH
 * resolution + one file write per missing entry).
 *
 * Why this exists: previously a user who installed Salesforce CLI via
 * `npm install -g @salesforce/cli` BEFORE installing Clementine got
 * `sf` on PATH but not in connected-clis.json. The agent could still
 * find it via the global CLI scan, but the dashboard wouldn't surface
 * it as a first-class integration and the agent missed the auth-
 * command hint. This closes the gap: any installed catalog CLI
 * becomes connected automatically, without making the user click
 * through the install flow.
 *
 * Disconnect semantics preserved: an id in `forgotten[]` is skipped
 * by this sweep. The user has to call reconnectCli(id) explicitly.
 *
 * Returns the list of promoted ids for logging + UI feedback.
 */
export function autoPromoteInstalledClis(): { promoted: string[]; skipped: string[] } {
  const connected = readConnectedClis();
  const forgotten = new Set(readForgottenCliIds());
  const promoted: string[] = [];
  const skipped: string[] = [];
  for (const entry of CLI_CATALOG) {
    if (connected[entry.id]) continue; // already connected
    if (forgotten.has(entry.id)) { skipped.push(entry.id); continue; }
    const resolved = whichOnPath(entry.command);
    if (!resolved) continue;
    const safe = resolveSafeCliProbe(entry.command, resolved);
    if (!safe || safe.skipped) continue;
    // Installed AND eligible — promote.
    recordConnectedCli(entry);
    promoted.push(entry.id);
  }
  return { promoted, skipped };
}
