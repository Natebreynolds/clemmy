# Clementine Plugins — authoring guide

A plugin is a **cartridge**: one versioned bundle that seeds a Clementine with skills, workflows, MCP servers, and starter memory in a single insert. There is deliberately **no plugin runtime** — installed contents materialize onto the same shelves hand-built ones live on and run through the exact same certification and safety gates. Eject (disable) parks the capabilities without deleting anything; uninstall removes exactly what the cartridge brought.

The canonical example — and the template to copy — is [`examples/plugins/coach-starter-pack/`](../../examples/plugins/coach-starter-pack/).

## Directory layout

```
my-pack/
  plugin.json                      # the manifest (required)
  skills/<name>/SKILL.md           # Agent-Skills format: frontmatter + guidance
  workflows/<name>/SKILL.md        # workflow frontmatter + "## step: <id>" bodies
  workflows/<name>/scripts/        # optional; copied verbatim with the workflow
  mcp/servers.json                 # MCP server fragment merged into servers.json
  memory/*.md                      # starter knowledge, imported as facts
```

Every part is optional except `plugin.json`. Ship only the shelves your pack needs.

## plugin.json

```json
{
  "id": "acme.sales-pack",
  "name": "Acme Sales Pack",
  "version": "1.0.0",
  "description": "One line shown at consent time.",
  "publisher": { "name": "Acme", "url": "https://acme.example" },
  "requires": { "connections": ["salesforce"] },
  "permissions": {
    "tools": ["composio:SALESFORCE_*"],
    "externalWrites": "approval",
    "schedules": true,
    "config": ["plugin.acme.sales-pack.region"]
  }
}
```

- **id** — reverse-dot, lowercase (`publisher.pack-name`). Required.
- **version** — semver. Required.
- **permissions** is the **consent contract** shown before anything installs:
  - `externalWrites`: `"approval"` (default — normal approval gates) or `"never"` (send-class steps hard-disabled).
  - `schedules: true` if any bundled workflow has a cron trigger.
  - `config` keys must live under `plugin.<id>.*` — anything else is rejected.
- **entitlement** is reserved; omit it (only `"free"` installs today).

## Asset formats

**Skills** (`skills/<name>/SKILL.md`) — YAML frontmatter with `name` + `description`, then the guidance body. The description is how Clementine decides when the skill applies, so make it a real trigger sentence.

**Workflows** (`workflows/<name>/SKILL.md`) — frontmatter with `name`, `description`, `enabled`, `trigger`, `steps` (a list of `- id:` entries), then one `## step: <id>` section per step. Triggers:

```yaml
trigger:
  manual: true            # run on demand
# or
trigger:
  schedule: "0 9 * * 1"   # 5-field cron
  timezone: "America/New_York"   # optional IANA tz; omitted → daemon host time
```

A workflow that doesn't parse (no steps) blocks the whole install at preview — validate before you ship.

**MCP servers** (`mcp/servers.json`) — a map of server name → config, merged into the user's `servers.json` and stamped with your plugin id:

```json
{ "acme-data": { "type": "stdio", "command": "npx", "args": ["-y", "acme-mcp"], "enabled": true } }
```

Ship credential-requiring or heavyweight servers with `"enabled": false` and tell users to flip them on. Newly installed servers go live without a daemon restart when installed through the console; CLI installs may need `clementine daemon restart`.

**Memory** (`memory/*.md`) — imported as recallable facts through the memory-import pipeline (dedup + embedding + undo batch tagged `plugin:<id>`). Import at install time is **deterministic — no model call** — so structure your files for it:

- *Structured file* (frontmatter with `name`, `type`, `description`) → **one fact**: `[name] description`. Put the entire fact in the description; the body is kept for humans but not imported. `type` maps to the fact kind: `rule`/`guideline` → feedback, `preference` → user, `reference` (default), `project`, `constraint`.
- *Freeform file* (no frontmatter) → **each bullet or paragraph ≥ 24 chars becomes a fact** (up to 30 per file). Great for checklists and principle lists.

Caps: 400 files, 512 KB per file, directory depth 4. Lifecycle: memory facts stay live when the plugin is **disabled** (eject keeps the save) and are removed by **uninstall** (only the facts this install created — a fact the user already had is never touched). Corollary: if two packs ship an identical fact, it belongs to whichever installed first; likewise an uninstall → reinstall revives the original facts (deduped, not duplicated).

## Packing

```bash
tar -czf coach-starter-pack.clemplug -C examples/plugins/coach-starter-pack .
```

A `.clemplug` is just a gzipped tar (`.tgz`/`.tar.gz` also accepted) with `plugin.json` at the root or under a single top-level directory. Host it anywhere https-reachable and share the link.

## Installing

- **Console UI** — the Plugins panel on the Connect screen: drop the `.clemplug`, choose a file, or paste a URL. You see the consent contract (what installs, what it asks for), then the cartridge loads with each asset landing on its shelf.
- **CLI** — `clementine plugin install <dir | .clemplug | https://…>` prints the consent summary and stops; re-run with `--yes` to install. Also: `plugin list`, `plugin disable <id>` / `enable <id>` (eject/re-seat without deleting), `plugin uninstall <id>`.

Installs are **collision-safe**: a skill/workflow/server name that already exists blocks the install and rolls back everything — nothing of the user's is ever overwritten.

## Authoring with Claude Code

This repo ships an agent skill — [`.claude/skills/clementine-plugin-author/SKILL.md`](../../.claude/skills/clementine-plugin-author/SKILL.md) — that encodes every validation rule the installer enforces (id/version regexes, workflow step parsing, memory fact shapes, the validate→pack→smoke loop). Claude Code picks it up automatically whenever a task mentions building or packaging a Clementine plugin, so generated packs install first try.

The fastest path: copy the example pack and let Claude Code fill it in.

```
cp -r examples/plugins/coach-starter-pack my-pack
```

Then prompt: *"Turn my-pack into a Clementine plugin for <your domain>: rewrite plugin.json (id <you>.<pack>), the skills, workflows, and memory files following the formats in this guide. Keep memory files structured-frontmatter with the whole fact in the description."*

Validate without installing — the consent preview runs the full validation:

```bash
clementine plugin install ./my-pack        # preview only (no --yes): manifest, parse, collision checks
```

Then pack, install with `--yes` in a scratch `CLEMENTINE_HOME` to smoke it, and ship the `.clemplug`.
