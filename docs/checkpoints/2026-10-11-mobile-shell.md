# Mobile shell and conversation refinement — October 11, 2026

## Scope and source

Framework UI only. User approved the mobile refinement pass after reporting clutter, clipped tabs, screen fit and navigation problems. Retain the existing light/citrus brand, drawer navigation, all general-purpose capabilities, and saved Home preferences. Live artifact-creation previews remain deferred. No personal Space, integration, preference, model or external-action changes were made.

Candidate branch: `codex/mobile-shell` in `~/.codex/worktrees/work-navigator-artifacts/clementine-next`.
Base: `81b0e6316a6c133ebc4e8be8efa925b988a50fa1`, then contextual assistant commit `abc98b100a13f5d5d7f8427fb3c90115c5e19554` (cherry-pick of `0556a7e9bfe3bb213fd0fa3a0cdd718ca6260eb7`). The mobile commit follows this checkpoint's parent. Do not deploy only mobile assets: saved-file discussion requires the contextual backend routes and exact-revision attachment preparation.

## Behavior

- One navigation drawer is reachable from Chat, Project, Space, Agent, Activity-run and Flow details. Detail screens register ownership of their header so the outer header is hidden only while a replacement is mounted. Chats is a direct drawer destination. Closing the drawer returns focus to its actual invoking control.
- Chat has Back, title, Conversation options and navigation in one compact row. Agent, project, model and Plan mode live in a dismissible options sheet. Plan/execution status remains visible above the composer. Files and active browser shortcuts remain in the conversation; idle browser tools are available through options.
- Section switching preserves the selected conversation or unsent draft scope. Text, selected-file context, ordinary uploads, pending agent/project choices (including explicit Clem/no project), and Plan mode survive. One-shot handoffs are not replayed. Newly created sessions inherit draft state. Accepted requests settle only their exact submitted attachments/context; newer selections and later typing survive. Auth generation changes reject stale callbacks and clear window-local state.
- Pinned Spaces use a vertical list with three initial entries, Show all, and Add Space in the section header. Long names wrap. Home places From Clem decisions/updates inside the configured panes and keeps the owner's saved order/hidden panes. Space content and freshness lead; maintenance/configuration are under Details. Project decisions lead results and supporting details.
- Shared visual viewport measurements bound floating sheets without shrinking the root and double-lifting the composer. Sheet body scrolls while dismissal stays reachable. Landscape bottom margins are included in height budgets. Composer controls are 44 px and textarea height updates when its width changes. Inbox tabs and navigation labels wrap within their containers.

## Verification

- Mobile production build passed: TypeScript for app/service worker and Vite. Existing >500 kB chunk advisory remains.
- Final combined focused suite: **98 passed, 0 failed** across mobile shell, visible viewport, chat location, draft lifecycle, exact file context, browser visibility, Home/preferences, project and Space presentation. A separate chat/control/files pass was 56/56, then the final changed lifecycle pair was 18/18. The final composer width observer was checked through production build and browser resize; no new mirror test was added for it.
- Isolated runner functional checks passed. Its live-home sentinel explicitly reported NOT PERFORMED because the live installed daemon owns and changes secrets metadata. This is not installed acceptance or a sentinel isolation certification. No live reset was used.
- Browser inspection used the actual production mobile bundle against named synthetic Harbor/Studio/Space fixtures, never real accounts or model calls. Checked 320x568, 390x844, 844x390, 320x300, and a 20 px root font (125%) at 320 px. Header/attach/voice/send controls measured 44x44 in bounds; document width remained 320. Narrowing the screen expanded textarea from one line to its full two lines. Short options sheet measured y12..300 with a reachable 44px Done control and independently scrolling body. Landscape file sheet measured y12..372 within a 390px viewport.
- UI round trips verified: existing draft via Projects; unsent new chat with an upload, selected agent/project and Plan mode via Projects; HTML opening and selecting its exact version back into the existing draft; all six pinned Spaces and reachable Add; one header in Project/Space; Done focus restoration. PDF selection exposed the preview frame and Download, but embedded PDF pixels were not verified by this browser.
- Evidence: `output/ui-mobile-shell-acceptance/` contains final test/build logs, browser metrics, controlled fixture server and screenshots. `output/ui-mobile-shell-2026-10-11/` contains the focused chat/lifecycle logs. Temporary browser tab closed and viewport override reset. No provider tests ran.

## Installation and remaining acceptance

Read-only installed observation during work: version3.18.35, source `0633bbd1ecbb4b931c9c7cc8f9634ccc6a1ce50e`, dirty fingerprint `064e3612646e250137ed66dba5e2e38f019d3e689f6347f4c16facb061a5b05f`, schema93, daemon PID58749 started `2026-10-11T14:47:33.607Z`, installed entry under `~/Applications/Clementine.app`. This tag is an ancestor of the candidate base; a recent process launch is not newer source evidence. No registered worktree build stamp matched that dirty installed identity. The installed backend lacks the contextual file module.

Installation remains owned by the existing installer under `docs/CLEMENTINE-UI-HARNESS-REFINEMENT-HANDOFF-2026-10-02.md:36`: “The other agent owns installation/hotpatch coordination; this document does not authorize a competing install or restart.” Owner checkout `~/clem-worktrees/refusal-replan` was rechecked clean at81b0e6316. Do not overwrite the installed dirty runtime from an assumed base. Reconcile its exact changes, integrate the contextual dependency plus this mobile commit, build a frozen candidate, and coordinate one installed hotpatch.

Still required: named controlled fixtures in the installed app/live home, physical iPhone keyboard and safe-area/rotation checks, and native Dynamic Type. Browser reduced-height/font checks are approximations, not physical-device acceptance. Preserve other agents' edits/token-meter work; no competing restart or personal-data fixture reset is authorized by this checkpoint.
