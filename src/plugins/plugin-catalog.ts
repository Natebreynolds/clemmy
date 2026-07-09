/**
 * Plugin catalog - small discover/install layer above the cartridge slot.
 *
 * The install path still goes through previewPlugin/installPlugin. Catalog
 * entries only resolve to a normal .clemplug archive, so consent, validation,
 * collision checks, and rollback stay centralized in plugin-store.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, getRuntimeEnv } from '../config.js';
import { downloadPluginArchive } from './plugin-fetch.js';

export interface PluginCatalogContents {
  skills: number;
  workflows: number;
  mcpServers: number;
  memoryFiles: number;
}

export interface PluginCatalogItem {
  id: string;
  name: string;
  version: string;
  description: string;
  publisher?: { name?: string; url?: string };
  tags?: string[];
  source: 'builtin' | 'url' | 'local';
  sourceUrl?: string;
  contents?: PluginCatalogContents;
  featured?: boolean;
}

export interface PluginCatalogResponse {
  items: PluginCatalogItem[];
  sources: string[];
  warnings: string[];
}

interface BuiltinPlugin extends PluginCatalogItem {
  files: Record<string, string>;
}

const COACH_STARTER_PACK: BuiltinPlugin = {
  id: 'clementine.coach-starter-pack',
  name: 'Coach Starter Pack',
  version: '1.0.0',
  description: 'Session notes, prep briefs, weekly check-in drafts, and coaching operating principles pre-loaded into memory.',
  publisher: { name: 'Clementine Examples' },
  tags: ['coaching', 'client work', 'starter'],
  source: 'builtin',
  featured: true,
  contents: { skills: 2, workflows: 2, mcpServers: 1, memoryFiles: 3 },
  files: {
    'plugin.json': JSON.stringify({
      id: 'clementine.coach-starter-pack',
      name: 'Coach Starter Pack',
      version: '1.0.0',
      description: 'Everything a coaching practice needs on day one: session prep and notes, a weekly client check-in rhythm, and the coaching operating principles pre-loaded into memory.',
      publisher: { name: 'Clementine Examples' },
      permissions: { externalWrites: 'approval', schedules: true },
    }, null, 2),
    'skills/session-notes/SKILL.md': `---
name: session-notes
description: Turn a raw coaching-session debrief (voice-note transcript, bullet dump, or free writing) into structured session notes with commitments and follow-ups.
---

When the user shares anything that reads like a coaching session debrief, structure it into session notes. Do not invent content - if a section has nothing, omit it.

Produce:

1. **Session summary** - 2-3 sentences on what the session covered and the client's state.
2. **Key themes** - the underlying threads (energy, avoidance, momentum), not just topics.
3. **Breakthroughs & insights** - anything the client saw for the first time, in their own words where possible.
4. **Commitments** - what the client committed to, each with an owner and a by-when. A commitment without a date gets flagged, not guessed.
5. **Coach follow-ups** - what the coach owes the client before next session.
6. **Next session seed** - one line: where to open next time.

Keep the client's language. Coaches review these notes months later - favor specifics ("said no to the Tuesday board ask") over abstractions ("worked on boundaries").
`,
    'skills/goal-review/SKILL.md': `---
name: goal-review
description: Run a structured quarterly-style goal review conversation - progress, obstacles, recommitment - for a coaching client's stated goals.
---

When the user asks to review goals (their own or a client's), run this structure conversationally - one section at a time, don't dump the whole framework at once.

1. **Restate the goal** as last recorded, and ask if it's still the goal. A changed goal is progress, not failure - capture the new version.
2. **Evidence check**: what has actually happened since the last review? Ask for specifics, gently distinguish activity from progress.
3. **Obstacle sort**: for each obstacle, classify together - *circumstance* (outside control), *system* (fixable process), or *story* (a belief worth challenging).
4. **One lever**: identify the single highest-leverage action for the next period. Resist lists.
5. **Recommit or release**: explicit choice - recommit (with the lever and a date) or consciously release the goal. Both are wins; drifting is the only loss.

Close by summarizing the review in five lines or fewer, suitable for pasting into session notes.
`,
    'workflows/session-prep/SKILL.md': `---
name: session-prep
description: Before a coaching session, assemble a one-page prep brief for a named client - history, open commitments, and a suggested opening.
enabled: true
trigger:
  manual: true
inputs:
  client:
    type: string
    required: true
    description: The client's name, exactly as it appears in session notes.
steps:
  - id: prep
---

## step: prep

Assemble a one-page prep brief for the client named in the inputs. Pull from memory and prior session notes:

- **Last session**: summary + how it ended.
- **Open commitments**: each with its by-when and current status if known.
- **Running themes**: patterns across the last few sessions.
- **Suggested opening**: one question to open with, grounded in their open commitment (see the coaching principles in memory - accountability before agenda).

If the client has no history yet, produce a first-session brief instead: what to establish (goals, cadence, how they want to be held accountable). Never fabricate history.
`,
    'workflows/weekly-checkin/SKILL.md': `---
name: weekly-checkin
description: Every Monday morning, draft the week's client check-in notes from recent session notes and open commitments - drafts only, nothing sends without approval.
enabled: true
trigger:
  schedule: "0 9 * * 1"
steps:
  - id: gather
  - id: draft
---

## step: gather

Review memory and recent notes for every active coaching client: last session's summary, open commitments and their due dates, and anything the coach owes them. Produce a short per-client digest. If there are no active clients yet, say so and stop - do not invent clients.

## step: draft

For each client digest from the previous step, draft a short, warm check-in message (3-5 sentences): acknowledge last session's focus, name the open commitment and its date without nagging, and offer one specific support. Present all drafts for review - these are drafts for the coach to send; never send anything directly.
`,
    'mcp/servers.json': JSON.stringify({
      'coach-thinking': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        description: 'Structured step-by-step reasoning for working through complex client situations. Ships disabled - enable it from the MCP panel when you want it.',
        enabled: false,
      },
    }, null, 2),
    'memory/client-onboarding-checklist.md': `New coaching client onboarding - the first-session foundations:

- A new coaching client's first session establishes their primary goal in their own words, written down verbatim.
- Every new client chooses how they want to be held accountable (direct challenge vs. gentle reminder) - ask, never assume.
- Agree the session cadence and the rescheduling rule in the first session, before any coaching begins.
- Capture what "this engagement succeeded" looks like in one sentence the client writes themselves.
- The first check-in message goes out within 48 hours of the first session while momentum is high.
`,
    'memory/coaching-philosophy.md': `---
name: coaching-philosophy
type: rule
description: Coaching operating principle - open every client session with accountability on the last commitment before any new agenda; commitments are the spine of the engagement.
---

The check-in on the previous commitment always comes first. New topics, however urgent they feel, come after the client has looked at what they said they'd do.
`,
    'memory/session-cadence.md': `---
name: session-cadence
type: reference
description: Default coaching cadence - weekly or biweekly 50-minute sessions, Monday check-in drafts, session notes written same day, goal review every 12 sessions.
---

Notes written the same day are twice as useful; the goal review at session 12 is where clients decide to recommit or release.
`,
  },
};

const BUILTINS: BuiltinPlugin[] = [COACH_STARTER_PACK];

function publicItem(item: PluginCatalogItem): PluginCatalogItem {
  const { id, name, version, description, publisher, tags, source, sourceUrl, contents, featured } = item;
  return { id, name, version, description, publisher, tags, source, sourceUrl, contents, featured };
}

function normalizeCatalogItem(raw: unknown): PluginCatalogItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id.trim() : '';
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const version = typeof obj.version === 'string' ? obj.version.trim() : '1.0.0';
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  const sourceUrl = typeof obj.sourceUrl === 'string'
    ? obj.sourceUrl.trim()
    : typeof obj.url === 'string'
      ? obj.url.trim()
      : '';
  if (!id || !name || !description || !sourceUrl) return null;
  const publisher = rawPublisher(obj.publisher);
  const tags = Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : undefined;
  const contents = rawContents(obj.contents);
  return {
    id,
    name,
    version,
    description,
    publisher,
    tags,
    source: sourceUrl.startsWith('file:') ? 'local' : 'url',
    sourceUrl,
    contents,
    featured: obj.featured === true,
  };
}

function rawPublisher(raw: unknown): PluginCatalogItem['publisher'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  const url = typeof obj.url === 'string' ? obj.url : undefined;
  return name || url ? { name, url } : undefined;
}

function rawContents(raw: unknown): PluginCatalogContents | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const n = (key: string) => {
    const value = obj[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  };
  return { skills: n('skills'), workflows: n('workflows'), mcpServers: n('mcpServers'), memoryFiles: n('memoryFiles') };
}

function readLocalCatalog(): { items: PluginCatalogItem[]; source?: string; warning?: string } {
  const file = path.join(BASE_DIR, 'plugins', 'catalog.json');
  if (!existsSync(file)) return { items: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    const rawItems = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { plugins?: unknown[] }).plugins)
        ? (parsed as { plugins: unknown[] }).plugins
        : [];
    return { items: rawItems.map(normalizeCatalogItem).filter((i): i is PluginCatalogItem => Boolean(i)), source: file };
  } catch (err) {
    return { items: [], source: file, warning: `Could not read plugin catalog ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function readRemoteCatalog(): Promise<{ items: PluginCatalogItem[]; source?: string; warning?: string }> {
  const url = getRuntimeEnv('CLEMMY_PLUGIN_CATALOG_URL', '').trim();
  if (!url) return { items: [] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = await res.json() as unknown;
      const rawItems = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { plugins?: unknown[] }).plugins)
          ? (parsed as { plugins: unknown[] }).plugins
          : [];
      return { items: rawItems.map(normalizeCatalogItem).filter((i): i is PluginCatalogItem => Boolean(i)), source: url };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { items: [], source: url, warning: `Could not read plugin catalog ${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function listPluginCatalog(): Promise<PluginCatalogResponse> {
  const local = readLocalCatalog();
  const remote = await readRemoteCatalog();
  const byId = new Map<string, PluginCatalogItem>();
  for (const item of [...BUILTINS.map(publicItem), ...local.items, ...remote.items]) byId.set(item.id, item);
  const sources = ['built-in examples', local.source, remote.source].filter((s): s is string => Boolean(s));
  const warnings = [local.warning, remote.warning].filter((w): w is string => Boolean(w));
  const items = [...byId.values()].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || a.name.localeCompare(b.name));
  return { items, sources, warnings };
}

export async function createCatalogPluginArchive(catalogId: string, tmpDir: string): Promise<string> {
  const builtin = BUILTINS.find((p) => p.id === catalogId);
  if (builtin) return writeBuiltinArchive(builtin, tmpDir);

  const catalog = await listPluginCatalog();
  const item = catalog.items.find((p) => p.id === catalogId);
  if (!item?.sourceUrl) throw new Error(`Plugin catalog item not found: ${catalogId}`);
  if (item.sourceUrl.startsWith('file:')) {
    const file = new URL(item.sourceUrl);
    const sourcePath = file.pathname;
    if (!existsSync(sourcePath)) throw new Error(`Plugin catalog source not found: ${sourcePath}`);
    const archivePath = path.join(tmpDir, path.basename(sourcePath));
    cpSync(sourcePath, archivePath);
    return archivePath;
  }
  const dl = await downloadPluginArchive(item.sourceUrl);
  try {
    const archivePath = path.join(tmpDir, path.basename(dl.file));
    cpSync(dl.file, archivePath);
    return archivePath;
  } finally {
    dl.cleanup();
  }
}

function writeBuiltinArchive(plugin: BuiltinPlugin, tmpDir: string): string {
  const sourceDir = path.join(tmpDir, plugin.id.replace(/[^a-z0-9.-]/gi, '_'));
  mkdirSync(sourceDir, { recursive: true });
  for (const [rel, text] of Object.entries(plugin.files)) {
    const target = path.join(sourceDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf-8');
  }
  const archivePath = path.join(tmpDir, `${plugin.id}.clemplug`);
  execFileSync('tar', ['-czf', archivePath, '-C', sourceDir, '.'], { stdio: 'pipe' });
  rmSync(sourceDir, { recursive: true, force: true });
  return archivePath;
}
