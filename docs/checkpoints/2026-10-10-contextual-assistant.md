# Contextual assistant UI — October 10, 2026

Framework work in `codex/contextual-assistant`, based on `6ee6dd13b`. The earlier artifact/project-resume pass is integrated in the active framework as `f7bc0f659`. This pass connects finished files to the next message and reduces competing task UI. Live artifact-creation previews remain deferred.

## Behavior

- Desktop and phone finished-file viewers expose **Ask Clem about this**. A visible, removable selection travels with the next message; choosing it neither sends a message nor changes the original file. Existing draft text and uploads survive.
- Project/Made files return to a proven source conversation. A worker's producer ID alone is not treated as a conversation: when ancestry is unavailable, the action explicitly offers a new chat. Desktop keeps the result beside the conversation at wide sizes; narrow windows return to the composer.
- The file selected is the version actually read. Session-file responses expose a SHA-256 revision, and preview/download requests can require it. Preparation refuses changed, missing, unauthorized or oversized files and keeps the draft recoverable.
- Preparation snapshots exact bytes into the existing attachment store and returns a normal inbox attachment ID. The regular desktop/mobile chat admission carries that attachment; no new chat verb or domain-specific email/PDF protocol exists. Server-derived producer, file identity, original path, snapshot path and revision accompany the attachment as reference provenance. Content grants no independent authority to execute or publish.
- Local extraction does not launch paid image description or audio transcription. Unsupported/extraction-failed formats still provide the exact saved snapshot with an honest limitation. Ask is available for stable recorded files up to the existing 25 MiB content limit; larger files retain existing opening/downloading behavior.
- Desktop delegated work groups current decisions first, then attention, with background/finished/stopped work folded by default. Counts, labels and controls derive from canonical task state. A new question reopens its group; ordinary polling does not. Folding retains unsent answers. Unrelated global attention cards no longer duplicate the conversation's current decision area; Inbox and Home remain available.
- Draft clearing follows host acceptance, not the click on Send. New typing/uploads/selections survive a delayed receipt. Unknown transport outcomes retain exact retry identity; proven attachment/busy rejection cannot silently steer a message without its files. Both desktop and mobile guard delayed file/agent/project preparation against chat changes. Home hands off its draft when its first message is accepted.
- Selected context, drafts and group expansion are window-local UI state, not a relaunch-persistence promise. This pass does not add a generated catch-up summary, redesign every completion type, or attach Space/project-page content through the file endpoint.

## Verification and evidence

Evidence lives in `output/ui-contextual-assistant-acceptance/`, `output/contextual-assistant-acceptance/`, and the scoped agent log directories. Final test/build receipts are recorded in the accompanying acceptance JSON after the source is frozen. Focused suites passed 215 tests: 142 desktop/shared-engine cases, 34 mobile cases, and 39 backend/route/attachment cases. Root typecheck passed. The isolated runners reported functional success; their live-home sentinels explicitly did not certify isolation while the active installed daemon was changing its own metadata. No fixture reset targeted the live home.

Controlled browser review uses only the named synthetic Harbor launch fixture and production frontend assets. No model or external action runs. Desktop checks cover rendered HTML/PDF, selected context, draft preservation, accepted-send clearing, changed-file recovery, project-to-source handoff, and decision-answer preservation while folding. Phone checks cover the same selected-file flow and narrow widths. Screenshots show the explicit synthetic-fixture banner. This is functional and visual fixture evidence, not installed/live-home acceptance or physical iPhone validation.

The review found and corrected desktop focus being taken by a newly mounted viewer after a project handoff, plus mobile retry settlement clearing a newer selected file. The mobile fixture initially omitted the real route's `accepted: true`; that fixture defect is not a product failure or a successful acceptance receipt. Only the corrected-contract run counts.

## Integration and installed acceptance

The installation owner remains the active framework agent. The primary checkout's `docs/CLEMENTINE-UI-HARNESS-REFINEMENT-HANDOFF-2026-10-02.md:36` assigns installation/hotpatch coordination to that agent and disallows a competing install/restart. This pass does not transfer that ownership.

Fresh read-only observation during final preparation found:

- Active framework: `claude/answered-refusal-replan` in `/Users/nathan.reynolds/clem-worktrees/refusal-replan`, committed `278776b40895308a7d9169d0abb2f916355a3819` with unrelated workflow edits still in progress.
- Installed source: `278776b40895308a7d9169d0abb2f916355a3819`, clean; fingerprint `f6c0b713f1ad1a0ab78684c3ce94d34c3bcc5bdf99440e6f1f5e4048fc0b9598`.
- Installed daemon: `~/Applications/Clementine.app/Contents/Resources/daemon/dist/index.js`, PID 39285, schema 93, retained shell version 3.18.33. This source does not include the current contextual-assistant pass.

Recheck those identities before integration. Integrate this commit into the owner's current lane, build frozen source, hotpatch through the existing owner, then record served source/fingerprint. Required installed/live-home acceptance uses a named controlled session/project: open its finished HTML/PDF/other file, select Ask, send with the selected snapshot, verify its ordinary attachment receipt, preserve a draft across navigation, reject a changed file without losing the draft, and answer a real controlled delegated question through its existing continuation. Include desktop and mobile browser flows. Never reset the live home or alter personal Spaces/integrations to make these checks pass. No paid model/provider qualification is claimed by synthetic UI acceptance.
