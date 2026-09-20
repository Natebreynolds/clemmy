# Daytime testing handoff — September 20, 2026

The user requested a stopping point to test Clem throughout the day. Pause
framework edits, hotpatches, and agent-generated acceptance runs until the user
asks to resume. The broader improvement goal remains unfinished; this is a
stable testing handoff, not release qualification.

Installed app: ~/Applications/Clementine.app, live home ~/.clementine-next.
Version 3.18.17; running fingerprint:
2a9ef67f56122426c279ca47e104b14009f34fc059e4eb5d40dc3b11e42d8dd5.
Rechecked the live build/settings endpoints and responsive desktop window at
handoff. Zero active run leases. Roles: Claude Opus 5 foreground, Luna default
worker, Sol completion reviewer. Explicit Haiku 4.5 acceptance also passed.
Both desktop and mobile web assets were included in the latest hotpatch;
physical mobile acceptance remains open. Rollback copies are retained.

Latest completed change: exact memory reads return recorded source IDs and
bounded source previews, with inference/status labels. Direct Opus and delegated
Haiku live acceptance both passed the first completion review. Earlier bounded
native/MCP/CLI/Composio coverage is documented in current-framework-state.md.
Those runs do not establish that every tool or workflow will succeed.

Suggested natural testing:
- Create a Space and a small workflow; try both Plan and Act, then run the workflow.
- Give a project-specific preference, correct it, and ask about it in a new chat.
- Try ordinary read tasks through native tools, a local MCP, CLI, and Composio.
- Continue a longer conversation and try the mobile app.

For a problem, retain the chat/run and note expected behavior versus observed
behavior. The live logs and token sidecar can support diagnosis later. Preserve
all existing usage-sidecar work and shared uncommitted edits on main/e5a75f5a.

Next unimplemented optimization: workflow_create, workflow_update and space_save
account for roughly two-thirds of the retained tool catalog bytes. Audit only;
no schema-compaction source change was made or installed. Resume with careful
contract-preserving prose reduction and live authoring/execution checks, keeping
native tools first-class and MCP/CLI/Composio available. Other remaining work:
long-running recovery, broader scoped memory/proactivity, physical mobile, and
matched efficiency trials. No general superiority claim over Claude Code.
