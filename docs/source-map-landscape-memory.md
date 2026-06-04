# Source-Map / Landscape Memory — design

## Context

Clementine's brain should not be *flooded with content*. The superpower we want is
**knowing where to find things and when to use them** — a navigational index of the
user's (or company's) world: *"prospect records live in Airtable base X; board decks in
the Drive `Q3 Planning` folder; outreach goes through Outlook."*

This is the **pointer-first** principle ([[project_brain_architecture]]): memorize the
card catalog, not the library. The map is tiny (cheap tokens), never goes stale (it points
at the always-current source), and is fetched on demand. It is distinct from:

- **Semantic facts** (`consolidated_facts`) — *what* Clem knows.
- **The vault** (`vault_chunks`) — documents she has indexed.
- **Procedural memory** (tool-choices) — *how* to do X / which tool.

The source map is the missing **navigational** layer: *where* the data lives + *when* to go there.

It composes with the connectors work (Thread 1): the map says where to go and that it's a
real source; when Clem reads content there, Thread 1 captures the high-trust facts. And it
is the backbone of the company single-brain — a shared landscape every teammate can navigate.

## Data model — `resource_pointers` (migration v10)

```
resource_pointers:
  id            INTEGER PK
  app           TEXT      -- "Google Drive" / "Salesforce" / "Airtable" (from classifySource)
  kind          TEXT      -- folder|file|doc|sheet|base|table|object|channel|label|site
  ref           TEXT      -- stable locator (id/URI when known; else app:kind:slug(name))
  name          TEXT      -- "Q3 Planning"
  whats_here    TEXT      -- short: "board decks, OKRs, renewal model"
  when_to_use   TEXT      -- optional: "board prep, renewal targets, quarterly metrics"
  parent_ref    TEXT      -- folder tree / base→table hierarchy (nullable)
  trust         REAL      -- source trust prior (0.9 for systems of record)
  source        TEXT      -- 'reactive' | 'ingest'
  first_seen_at TEXT
  last_seen_at  TEXT
  mention_count INTEGER DEFAULT 1
  UNIQUE(app, ref)        -- dedupe → bounded; touches bump mention_count + last_seen
```

Pointer-first ⇒ **bounded**: one row per distinct resource, not per read. No content stored.

## Phase R — reactive mapping (BUILD NOW). Flag `CLEMMY_SOURCE_MAP` (default off).

Map the landscape organically from real work, with zero extra LLM calls:

1. The reflection extractor already runs on every connector tool return. When the flag is on,
   add a `resources` output (`{kind, name, ref?, whats_here?, when_to_use?}`) to its
   schema **and** prompt — both built dynamically so flag-off is byte-identical.
2. In `reflectOnToolReturn`, commit resources via `upsertResourcePointer` **before the
   importance gate** — decoupled from the 75-importance fact gate, because pointers are cheap
   and bounded and we want broad landscape coverage even in low-signal sessions. `app` + `trust`
   come from `classifySource(input.tool)`; only mint for `system_of_record` sources (the apps
   you actually navigate), never web/scrape.
3. Inject a compact **"Data Landscape"** block into context (`harness-context.ts` +
   `instructions.ts` for chat parity), objective-scoped (promote resources whose
   name/whats_here match the active objective) and hard token-budgeted, like the fact block.

Net effect: as Clem works, she builds a map of where your data lives, and reads it each turn
to navigate straight to the right source — in chat and in long-running workflows.

## Cold-start ingest — chosen path: ON-DEMAND, SUPERVISED (Phase I, partial)

How do we map terrain Clem hasn't worked in yet, without flooding her or risking an
unattended agent? An adversarial design review (2026-06-04) **rejected** the first idea — a
scheduled nightly *free-roaming agent* that discovers + executes connector actions — on three
verified grounds:

1. **Auto-approve of writes.** Background tasks run under `allowedTools:['*']` and auto-approve
   any non-admin tool; an unattended agent picking from 1000+ actions could land on a
   `DELETE`/`SEND` slug and have it silently approved at 4am. (P0)
2. **No deterministic arg-filler.** A fetched schema gives arg *shapes*, not *values* — the
   codebase delegates arg-building to the model. So "reuse the agent loop" *is* a nightly LLM:
   the worker-thrash anti-pattern, and untestable under reproduce-locally-first. (P0)
3. **Read-only regression.** A runtime-chosen slug throws away the structural read-only
   guarantee a fixed read slug has. (P0)

**Chosen instead — on-demand, supervised enumeration:**
- New `source_map_upsert` tool: the agent records pointers *while the user is present*, during a
  *"map my Drive" / "what bases do I have"* request or first deep encounter. It reuses the
  existing, already-bounded/thrash-guarded agent loop (discover → read → record) under normal
  approval gating — no new unattended surface.
- **Reactive minting stays the primary writer** — it already generalizes and already produces
  richer pointers (`whats_here`/`when_to_use`) than any structural crawler.

## Deferred — deterministic recipe-replay (Phase I, the rest)

If on-demand + reactive prove to leave a real cold-start gap (e.g. company onboarding,
long-running workflows needing full terrain up front), the recurring engine is built as
**discover-once → remember a recipe → replay deterministically**, NOT a nightly agent:

1. **Discover once** (supervised, on-demand): run the discover→fetch-schema→fill→execute loop
   *one time* to resolve `{actionSlug, concrete args, result-extraction path}` for a toolkit.
2. **Persist a `SourceIngestRecipe`** in a *purpose-built* store (NOT tool-choice-store, whose
   template is model-rendered + composio entries are advise-only/connection-stripped by design):
   `{toolkitSlug, actionSlug, args, resultPath, idField, nameField, parentField, cursorField,
   kind, successCount, failureCount}`.
3. **Read-only floor:** any executed/replayed slug must pass `classifyComposioSlug==='read'` —
   a write becomes *structurally impossible*, not prompt-discouraged.
4. **Nightly replay = deterministic code** (no LLM), fixture-testable; a recipe that errors /
   returns 0 rows N nights auto-invalidates (reuse `computeChoiceScore` /
   `AUTO_INVALIDATE_FAILURE_STREAK`) and re-enters discover-once on demand.

The pure helpers retained in `src/memory/source-ingest.ts` (capability resolution + the
defensive structural parsers) are the staging ground for this deferred engine. The
`CLEMMY_SOURCE_INGEST` flag is reserved for it. Per-toolkit knowledge lives in the recipe
**schema** (one struct for all toolkits), never in per-tool code and never in a nightly agent.

## Tools / UI (later)

- `source_map_search(query)` — semantic/lexical search over the map ("where do I find renewal data?").
- Dashboard "Landscape" panel — browsable tree per app with `whats_here`/`when_to_use`, editable.

## Verification

- Unit: `upsertResourcePointer` dedupes by (app, ref) + bumps mention/last_seen; render is
  budgeted + objective-scoped; flag-off ⇒ no resources committed AND the extractor
  schema/prompt are byte-identical to today.
- Live: after a few real connector reads with the flag on, `resource_pointers` holds one row
  per distinct folder/base/object with sensible `whats_here`.
- Full `npm test` + `tsc`.
