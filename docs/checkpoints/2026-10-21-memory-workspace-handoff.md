# Memory workspace refinement — 2026-10-21

## Scope and ownership

The owner requested a premium desktop Memory experience: dependable scrolling, less visual overload, visible learning, clear evidence and correction controls, and questions to Clem inside Memory. They explicitly assigned integration before the next tag to another agent. This branch does not install, restart, hotpatch, release, or modify personal memory.

- Branch: `codex/memory-workspace-2026-10-21`
- Worktree: `/Users/nathan.reynolds/.codex/worktrees/memory-workspace/clementine-next`
- Main base: `14fa578bc` (v3.18.37)
- Inherited baseline: `7035f3d95`

The shared main checkout already contained five uncommitted Memory refinements. Baseline `7035f3d95` preserves their exact contents; it is **not newly authored work in this pass**. Files: `Memory.tsx`, `HealthStrip.tsx`, `ReviewPane.tsx`, `MemoryWorkPanel.tsx`, and three disclosure rules in `styles.css`. Their original SHA256s are in `output/memory-workspace/inherited-files.json`. All five were rechecked unchanged in the shared checkout after implementation.

Integration must preserve that baseline and any later changes by other agents. If the receiving branch already contains those refinements, apply the commits after `7035f3d95` rather than replaying the baseline as new work. If it is still at clean `14fa578bc`, the full branch contains the baseline plus this pass. Do not reset, stash away, or overwrite the shared dirty checkout to make a merge easy. Stage only intended paths after reconciling shared changes.

## Findings and resulting behavior

The installed Memory screen put multiple screens of background activity before the actual stores. A live-state-driven disclosure could also expand or collapse as five-second polls changed state. Switching stores retained the enclosing page's old scroll offset; shorter content clamped that offset and appeared to skip content. Review rows and search/detail layout changes added more movement above the reading position.

Memory now owns its viewport. Search and section navigation stay in place, the selected store scrolls independently, and the inspector/Ask pane has its own scroll position. Store/query/scope navigation explicitly starts the content at the beginning; polling does not reset it. Background learning disclosures open only by user action.

The warm paper design and existing typography remain. Overview leads with actual learning status/model and a bounded selection of saved memories, ordered newest first within that selection. Facts, people, procedures/tools, timeline and sources are direct sections. Full learning activity and review/health have dedicated sections. Working context and the knowledge map remain available through disclosures. Fact rows lead with content and scope; provenance, history, importance and secondary actions remain available without dominating every row.

Selecting a memory opens a light, theme-aware inspector with evidence and correction controls. Corrections adopt the returned canonical fact ID before subsequent Pin/Forget actions. Known historical facts offer Restore and Ask rather than active-fact controls. Unknown confidence/pin state and failed reads remain unknown; they do not become fabricated confidence or empty-memory claims.

Ask Clem uses the existing chat execution, approval, retry, Stop, plan and task controls. Opening the pane or selecting an example sends nothing. An explicitly selected memory contributes a visible exact reference, not a silently copied memory body. The pane stays mounted while hidden or while reading another Memory section. Its draft/retry ownership is separate from the primary chat. Opening the real conversation safely transfers drafts and late uploads; conflicting destination drafts and unconfirmed requests remain protected.

## Boundaries

This is a frontend/framework change. It does not change memory ranking, learning models, provider selection, databases, personal facts, integrations, or tool authorization. Asking Clem uses the normal assistant capabilities and approvals; the pane is not a separately enforced read-only agent.

The auxiliary pane preserves a conversation while it is mounted within Memory. Full-page reload recovery of an unaccepted auxiliary draft is not newly implemented. After server acceptance, Open chat leads to the ordinary saved conversation. Ordinary main-chat storage behavior is unchanged when the new optional pending scope is omitted.

Desktop is the primary target. Container-aware navigation and an explicit side panel avoid forcing three columns into small windows. The separate mobile app/widget implementation is outside this pass.

## Verification

- Production console build and TypeScript: passed (`npm --prefix apps/console-web run build`). Existing large-bundle advisory remains.
- 65 focused tests passed: memory assistant draft/retry/handoff, composer drafts, scope semantics, memory work view model and Memory unknown/error-state guards.
- Nine controlled React render checks passed for inspector current/historical/unknown states, bounded memory selection and read failures. These replaced network fetch with a throwing guard.
- Impeccable detector: no findings on the changed Memory surfaces (`output/memory-workspace/design-detect.json`).
- `git diff --check`: passed.

Build dependencies were installed from the existing console lockfile into this worktree only after the shared dependency directory proved incomplete. No package or lockfile change is part of the branch.

The isolated test runner reported its live-home comparison **NOT PERFORMED** because the concurrently running daemon changed WAL/SHM/tool-contract files. The focused tests themselves passed. This must not be described as proof of installed-app/live-home acceptance; the daemon was not stopped for the test.

### Controlled browser acceptance

First rendered batch passed at 1440×900, 1024×900 and 720×645. Facts stayed at scrollTop 1706 and navigation Y 133 after a delayed 900 ms refresh/revision; deliberate store navigation reset content to zero. Correction, Pin and Forget used the replacement ID. An Ask draft survived hide/reopen and a synthetic submission completed in the same pane. Learning activity remained readable at desktop and smaller-window widths. No document/content horizontal overflow was found; the small-window section rail intentionally scrolls horizontally. The final bounded recheck covers shorter composer copy and direct correction focus. The fixture serves the actual built console at `http://127.0.0.1:58921/console/memory`, with named synthetic records only. It has no live daemon proxy and blocks unrelated writes. Its correction fixture returns `10001 → 20001`; only `20001` accepts follow-up Pin/Forget/Restore. Its chat endpoint returns a synthetic local stream and makes no provider calls. Source, request log, mutation log and screenshots live under `output/memory-workspace/`. These local evidence files are ignored by Git; preserve needed evidence before archiving the worktree.

### Acceptance after integration

The integrating agent should rebuild from the final integrated tree, hotpatch/install according to the active release procedure, and verify the served build fingerprint in the installed app/live home. Recheck the current running configuration rather than relying on this task's starting installed stamp. Use named controlled facts/conversations only; do not reset fixtures against the live home or clean up personal/business memory.

Verify desktop scroll stability through a background poll, section/search navigation, narrow-window access, inspector correction followed by actions on the replacement ID, and a real Ask Clem request using the actual configured provider. Synthetic SSE/fixture success proves UI plumbing only, not the requested provider's execution or the next release's acceptance. Then coordinate the next tag under the owner's existing release instructions.
