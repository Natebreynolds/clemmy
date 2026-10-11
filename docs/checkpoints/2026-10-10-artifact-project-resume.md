# Artifact opening and project resume — October 10, 2026

Implemented in `codex/artifact-project-resume`, based on framework commit `d413f969a6daa7dc42fbd6c51cabf7dea4ede4a5`. This continues the installed first navigation/file-panel pass. Framework UI work only; live creation previews remain deferred.

## Behavior

- Chat, Made, and project results use one artifact workspace and the same authenticated file reader. HTML, PDFs, images, Markdown, and text preview inside it; other formats retain Download/Open in app as supported.
- Made adds title/filename search, recent work, and direct Open. A filename search opens its matching file rather than a different representative file from the folder. Missing/unassociated files retain honest fallbacks.
- Project overviews on desktop and mobile prioritize the latest current conversation, recent results, explicit linked Spaces, Needs you, and current work. Existing purpose, agents, resources, conversation history, learned facts, and archive controls remain under Project details.
- Project results query the recorded project conversation IDs and their system-recorded worker descendants. Sibling branches in other projects are excluded. This is a bounded view of results from the overview's associated conversations, not an exhaustive project archive or a reconstruction of a file's project at write time.
- Files carry a server-issued reference to the exact recorded producer. Conversation links are separate and require a known user conversation or proven worker ancestry. No client-supplied path becomes a file capability.
- Desktop remembers the selected panel per view, PDF page/zoom/text mode, and text/image scroll while the window remains open. File identity is shared across surfaces, including chat receipts which initially lack a file ID. This is window-local UI state, not relaunch persistence. Sandboxed HTML/project-page iframe scroll is not accessible and is not promised.
- Phone project files reuse the existing file sheet. Closing preserves the project and returns focus to the selected result. No native code changed.

## Verification

Production desktop and mobile builds and typechecks passed. Focused tests: 28 backend/route, 15 desktop archive/viewer, 5 project projection, 3 reading-state, and 44 mobile regressions (95 total). The isolated runners reported functional success but did not certify live-home isolation because the active daemon was writing its own metadata. No test reset targeted the live home.

Controlled browser acceptance used only the named synthetic Harbor launch/Studio planning fixture, served from `output/ui-project-resume-acceptance/server.mjs` with the actual built frontends. Checked desktop 1440 px and 820 px, mobile 390 px and 320 px:

- Project and Made open rendered HTML in the shared panel.
- PDF page 2 at 125% survives project-to-chat navigation.
- Filename search chooses the exact matching file.
- A long Markdown document reopens at scrollTop 766.
- Narrow layout has no document overflow; Escape closes the panel and restores the Open button focus.
- Mobile Project → HTML sheet → Done preserves the project and restores focus; no overflow at either width.

Screenshots/build logs and the verification receipt live under `output/ui-project-resume-acceptance/`. The first daemon build correctly rejected a moving source tree while the parallel UI edits finished; the final build must use the frozen committed source. This earlier rejection is not a successful build receipt.

## Installed acceptance still required

Read-only observation during this pass found the installed app serving base `d413f969a6daa7dc42fbd6c51cabf7dea4ede4a5`, fingerprint `135dac0ae5d0d3e17453db32b8276d86f27aed0c1f9c9b5b1be18e82a61a68f4`, schema 93. The unlocked installed app was accessible. This pass has not hotpatched/restarted it or changed personal projects, Spaces, integrations, settings, or model selections.

The primary checkout's `docs/CLEMENTINE-UI-HARNESS-REFINEMENT-HANDOFF-2026-10-02.md:36` assigns installation/hotpatch coordination to the other agent and forbids a competing install. Recheck the current framework branch and installation owner before integrating. After the coordinated update, record the actual served source/fingerprint and use a named controlled project/session in the installed app/live home to verify Made and project Open, source links, PDF continuity, and mobile return behavior. Synthetic UI checks are not installed-app/live-home acceptance; no physical iPhone validation was performed in this pass.
