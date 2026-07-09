---
name: clementine-plugin-author
description: Author, validate, and pack a Clementine plugin cartridge (.clemplug) — a bundle of skills, workflows, MCP servers, and memory. Use whenever the task is to create, edit, review, or package a Clementine plugin, a .clemplug, a starter pack, or plugin.json. Encodes the exact formats the installer validates so generated plugins install first try.
---

# Authoring Clementine plugin cartridges

A plugin is a directory (packed as a gzipped tar named `.clemplug`) that materializes onto Clementine's existing shelves. The installer **validates hard** — follow these formats exactly or the install blocks. Full prose guide: `PLUGINS.md` (repo root). Working template: `examples/plugins/coach-starter-pack/` — when in doubt, copy it and edit.

## Layout (all parts optional except plugin.json)

```
<pack>/
  plugin.json
  skills/<name>/SKILL.md
  workflows/<name>/SKILL.md      (+ scripts/, references/ copied verbatim)
  mcp/servers.json
  memory/*.md
```

## plugin.json — validation rules (errors BLOCK install)

```json
{
  "id": "publisher.pack-name",
  "name": "Human Name",
  "version": "1.0.0",
  "description": "One line shown at consent.",
  "publisher": { "name": "Publisher" },
  "requires": { "connections": ["salesforce"] },
  "permissions": {
    "externalWrites": "approval",
    "schedules": true,
    "config": ["plugin.publisher.pack-name.key"]
  }
}
```

- `id` MUST match `^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$` — lowercase reverse-dot with at least one dot (`acme.sales-pack`). No underscores, no uppercase.
- `version` MUST be semver (`1.0.0`).
- NEVER set `entitlement` (or set exactly `"free"`) — anything else is rejected.
- Every `permissions.config` key MUST start with `plugin.<id>.` — anything else is rejected.
- Set `permissions.schedules: true` if ANY workflow has a cron trigger.
- `externalWrites`: `"approval"` (default) or `"never"` (hard-disables send-class steps).
- List `requires.connections` for any service the content assumes (informational, shown at consent).

## Skills — `skills/<name>/SKILL.md`

YAML frontmatter with `name` (match the directory name; lowercase/hyphens only — unsafe names block install) and `description` (the trigger sentence — write when the skill applies, not what it is). Body = the guidance.

## Workflows — `workflows/<name>/SKILL.md`

MUST parse to ≥1 step or the whole install blocks at preview. Exact shape:

```markdown
---
name: my-workflow
description: What it does and when it runs.
enabled: true
trigger:
  manual: true          # OR: schedule: "0 9 * * 1"  (+ optional timezone: "America/New_York")
steps:
  - id: first
  - id: second
---

## step: first

Instructions for this step.

## step: second

Instructions for this step.
```

Every `steps: - id:` entry needs a matching `## step: <id>` body section. Optional `inputs:` map (`type`, `required`, `description` per input). Workflows never send externally on their own — drafts for review, gated by `externalWrites`.

## MCP servers — `mcp/servers.json`

```json
{ "server-name": { "type": "stdio", "command": "npx", "args": ["-y", "some-mcp"], "description": "…", "enabled": true } }
```

Ship credential-requiring or heavyweight servers with `"enabled": false` and say so in the description. Types: `stdio` (command/args/env) or `http`/`sse` (url/headers).

## Memory — `memory/*.md` (import is deterministic, NO model call)

Two file shapes — choose deliberately:

1. **Structured** (frontmatter `name`, `type`, `description`) → imports **exactly ONE fact**: `[name] description`. Put the ENTIRE fact in the description — the body is for humans and is NOT imported. `type` maps: `rule`/`guideline` → feedback · `preference`/`user` → user · `constraint`/`policy` → constraint · `project`/`goal` → project · anything else → reference.
2. **Freeform** (no frontmatter) → **each bullet/numbered line ≥ 24 chars becomes a fact** (max 30/file). Use for checklists and principle lists.

Caps: 400 files, 512 KB/file, depth 4. Facts must be generic to the pack's domain — never user-specific names, IDs, or accounts.

## Collision rule

A skill/workflow/MCP-server name that already exists on the target machine **blocks the whole install** (with rollback). Namespace names with the pack's flavor (`acme-outbound`, not `outbound`).

## Validate → pack → smoke (always do all three)

```bash
# 1. Preview = full validation (manifest, workflow parse, safe names) with NO install:
npx tsx src/index.ts plugin install ./my-pack            # in this repo; installed CLI: clementine plugin install ./my-pack

# 2. Pack (plugin.json at archive root):
tar -czf my-pack.clemplug -C my-pack .

# 3. Smoke in a SCRATCH home — NEVER the real ~/.clementine-next:
CLEMENTINE_HOME=$(mktemp -d) npx tsx src/index.ts plugin install ./my-pack.clemplug --yes
```

The preview must show every intended shelf (skills/workflows/MCP/memory counts). After the smoke install, uninstall (`plugin uninstall <id>`) should report the same artifact count. If preview errors: fix the named artifact — the error strings are specific (bad id, workflow failed to parse, unsafe skill name, config outside sandbox).

## Checklist before delivering a pack

- [ ] `id` reverse-dot lowercase, semver version, no `entitlement`
- [ ] Every workflow has `steps:` ids AND matching `## step:` bodies
- [ ] `schedules: true` iff a cron trigger exists; cron is 5-field
- [ ] Credential-needing MCP servers ship `enabled: false`
- [ ] Structured memory files carry the whole fact in `description`
- [ ] Names namespaced against collisions
- [ ] Preview (no `--yes`) clean · packed · smoked in temp `CLEMENTINE_HOME` · uninstall clean
