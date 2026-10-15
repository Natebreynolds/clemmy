# Composio SDK 0.24, and five unit failures from the project-tools round (2026-10-15)

For the agent working on `codex/agentic-forward-motion`.

## Composio SDK 0.14 → 0.24 (branch `claude/composio-sdk-0.24`)

The upgrade commit sits on your installed `32874bbde`. It changes
`package.json`, the lockfile and one test file, and no runtime source.

What was checked:

- **Same response shapes.** Clem's live reads return identical results on
  both versions: 1,608 catalog toolkits, 17 connected accounts, 26 auth-config
  toolkits, Gmail toolkit detail, and exact tool schemas.
- **Dispatch contract unchanged.** Prepared one-shot dispatch keeps its
  contract on the new owned client (2.0.0-rc.14), checked at the fetch wire:
  - A short owner deadline ends the request.
  - A longer owner window outlives the SDK default.
  - With no deadline, the SDK default applies.
  - An owner stop aborts the request once, with no retry.
- **Tests.** `client.host-deadline.test.ts` used to hook the old client's
  internal `fetchWithTimeout`, which no longer exists. It now checks the same
  contract at the fetch boundary.
- **Node.** The SDK declares Node >=22.22.3. The packaged daemon runs on
  Electron 43's Node 24.17.

A hotpatch from this line stays safe. Clem's source uses nothing new, so a
dist built against 0.24 runs on the installed 0.14 `node_modules`. The new SDK
reaches users only through a release build.

## Five unit failures arrive with f5dbfa30c

These were bisected on the same test files. `bdaa37ef8` and `6effe7aa1` pass
33/33. `f5dbfa30c`, `0172c4526` and `1ee29ec19` each fail the same five:

- `tool-registry.test.ts`, the F1 workflow-step and F2 worker checks. The
  registry derives `project_tools_connect` and `project_tools_inspect` as
  blocked, but the hand-maintained lists do not include them. Please confirm
  which list the runtime enforces. If it is the hand-maintained list, workflow
  steps and workers can currently call the new setup tools.
- `capability-lifecycle-ordinary-channel.acceptance`, matrix row 6.
- `provider-neutral-foreground-read.acceptance`, matrix rows 1 and 3, a cold
  two-page read.
- `provider-neutral-live-read-planning.acceptance`, disjoint CLI and native
  MCP discovery.

`ordinary-conversation-competitive-acceptance` ("62 greetings…") fails on
main as well. Three `liveness-beacon.test.ts` stall tests also fail on this
machine with or without these changes; they look load-sensitive.
