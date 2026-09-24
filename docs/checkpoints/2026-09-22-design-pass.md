# Design and UI pass — 2026-09-22

Owner request: "start taking a full design and UI pass based on all the changes we have made."
Owner decisions (asked once, after the critique): P0s first then P1s with a hotpatch and live check
after each wave; "Not now" becomes a real snooze; Home is cleaned up, not rebuilt; the phone is
checked by pairing a temporary headless browser that is revoked afterwards.

## Critique (Impeccable, dual assessment)

Live installed app (sealed 3.18.19, daemon hotpatched), owner's home, 22 desktop screens at
1440×900 plus the phone from source. Score **18/40**. Snapshot:
`.impeccable/critique/2026-09-22T22-25-02Z__apps-console-web.md` (left open: two P1s remain, below).

| # | Finding | Status |
|---|---|---|
| P0 | `GET /api/console/sessions` held the daemon's event loop 12–26 s (a status ping waited 26 s); screens sat on skeletons 18–78 s | Fixed `ccc22503`, `7eb11623` |
| P0 | Home titled a Slack send "Approve: composio_execute_tool · work_call"; "Not now" declined for good; the phone never showed the draft | Fixed `76f3cafc`, `7eb11623`, `69d04d3e` |
| P1 | Clem's workflow reports: emoji statuses, operation ids, a 1970 retry time, a recovery path to a page that does not exist | Fixed `06cde9b5` |
| P1 | Needs-you counts disagree (desktop 9 / 21, phone 27 / 5) | **Partly**: the desktop Inbox no longer adds its own title regex; the lists are still assembled by three different projections |
| P1 | 40+ status strings, colour used for category | **Partly**: sentence-case certification pills, neutral origin Tag, amber for "needs review"; no single six-status presenter yet |

## What changed, by cause

- **Chat list speed.** 136 MB of `sessions.metadata_json` (132 MB of it `__conversation`) was
  JSON-parsed per call. `listSessions({ withoutConversationState: true })` strips the four state keys
  in SQL and pages on narrow columns first (`eventlog.ts`); only the list builder and the phone chat
  list use it — `updateSession` replaces metadata whole, so patch/delete keep full rows (pinned by a
  test). Live: 0.13–0.6 s, status pings unaffected. Phone chat list 2.2 s → 50 ms and 25 → 80 chats.
- **Dog mark** inlined into the bundle (small raster images inline; fonts stay files for the CSP).
- **Starter Spaces** route registered before `/spaces/:id` (was a 404).
- **One approval headline.** `approvalHeadline()` in `console-routes.ts` unwraps carriers for Home,
  the board and the Inbox runtime rows; Home uses the request's own subject like Needs you and the
  phone. `extractApprovalContentPreview` peels nested carriers and matches body fields by the words
  in their names (`markdown_text`), never id-shaped ones.
- **Snooze.** `src/runtime/home-snoozes.ts` + `POST /api/console/home/needs-you/snooze`: "Not now"
  keeps an approval or plan off Home for 4 h; it stays pending, in `counts.waiting` and in Needs you.
  Chat gains an explicit Decline. Plans on Home are reviewed, not approved inline.
- **Workflow report wording** (`workflow-runner.ts`): step lines in words, no retry time unless
  real, "Connect page", no raw operation ids; the engine's "No current capability is registered"
  diagnostic is recognised beside its template (`isCapabilityNotRegisteredMessage`) and kept off the
  person's report — the calendar watch shares the recogniser.
- **Surfaces**: plan steps instead of JSON; "Decline" everywhere on desktop; Space failure banner in
  words with Details; Space cards in words; the Spaces explainer only with no Spaces; usage chips in
  words with age ("83% of week · 2d old"), chosen by published windows not provider names, xl+ only;
  no false "Saved grok-4.6 is unavailable" when the same model answers; aligned model-role rows;
  Clean up confirms per-row clears; Inbox pane sized to content; away rows readable; leading emoji
  stripped from list titles on both surfaces; phone Flows "1 step" and warning-tone tags.

## Evidence

- Offline profiling against an APFS clone (`cp -c`) of the live `harness.db` in a scratch home.
- UI tests: 787 / 789 pass (the two failures reproduce at the pre-pass commit). Backend files touched
  pass except two failures that reproduce at the pre-pass commit
  (`space-routes` manual-refresh manifest test; ambiguous-account `label` test).
- Four hotpatches of `~/Applications/Clementine.app` (daemon + both web dists, backups retained);
  final running build `fcaa8754` (fingerprint `c33943ab…`). Updater `pending/` still held.
- Screenshots per wave under the session scratchpad (`ui-pass/shots-*`, phone `shots-m*`).

## Notes for the next pass

- Another session's commit `bf684668` (dead-occurrence sweep) swept in this pass's uncommitted
  board-hint change in `console-routes.ts`; the change is correct and was left in place. Its boot
  sweep went live with the wave-2 hotpatch.
- Remaining: one server projection for "needs you" feeding the sidebar, Inbox tab and phone; a
  `presentStatus()` six-status presenter; the Space view kit's source strip still prints raw
  refresh errors; phone device labels fall back to the browser user agent; Automate has no search or
  sort for 111 workflows; historical notifications and chat messages keep their old wording.

## Release gates for 3.18.20 after this pass (runtime `ad91ccf9`)

Re-run on shared `main` after the design commits and the other session's
readiness-hold and dead-occurrence fixes, since the last gated commit
`a7099a68`:

- `npm run build` clean (stamp `ad91ccf9`, dirty only from the owner's
  uncommitted `docs/JEV-FRAMEWORK-HANDOFF-2026-09-21.md` and an untracked
  critique file); `npm run typecheck`, console-web and mobile-web `tsc`
  clean; both web builds clean.
- `test:release-assets` 56/56, `test:release-closure` 137/137,
  `test:public-hygiene` 4/4.
- Every test file covering code changed since `a7099a68` (137 files: the
  touched backend files, route gating, the board, and every console-web,
  mobile-web and chat-engine test): 1,514 tests, 1,508 pass, 6 fail. All
  six fail by name at `a7099a68` in a clean worktree: `useChat` empty
  completion, the Home mock route, space-routes manual refresh manifest,
  the ambiguous-account `label` pin, and two `orchestration-tools`
  workflow_create tests. **No regression.**
- Version is already 3.18.20; tag this commit or its successor (docs-only
  after `ad91ccf9`). Not tagged, nothing pushed by this session.

## Round 2 and 3 (evening 2026-09-22) — committed on `main`, handed to the harness agent

The owner stopped the UI work here ("I'll let them take over for a bit"). Nothing below
is installed: the installed app runs `bf09b1d2`. These commits are on `main` and still
need installing and checking live.

| Commit | What |
|---|---|
| `29b63454` … `8f25ea2a` | One needs-you count (`src/dashboard/needs-you.ts`), live at 10 on every surface (installed) |
| `b03e3a84` | `keyUrl` on credential descriptors and model presets; Jev key link; Second opinion control retired (installed) |
| `bf09b1d2` | Each page named once (installed) |
| `0a3b8f04` | Model picker drawn against the window (`lib/popover-placement.ts`). Reproduced first: in a Space's Ask Clem dock only 376 of 420px showed. There is no separate quick-chat window; `main.ts` creates splash, main, setup and notch only, and the notch has no composer |
| `ab0d7fab` | Build Home as a tracked journey (`lib/home-builds.ts`). Progress comes from the turn's `conversation_completed` by `sourceUserSeq`; "done" only once a Space whose `originSessionId` is that session exists; it is then placed through the layout contract, which retries once on a 409 conflict. Working now retired from Home on desktop and phone |
| `42db5a57` | Home in the two styles the owner chose from three proposals (artifact https://claude.ai/artifact/6aH9ATh1wkS6zXnAqTZyEQ). **Briefing** and **Dashboard**, plus a live "Clem is working" band, a Today pane read from the calendar watch's saved snapshot, Space summary tiles from the phone's projection, and Tune → Style / live band / Spaces on Home |

**Harness-owned files touched (please review):**
- `src/runtime/home-preferences.ts`: adds `style`, `liveStatus`, `spaceViews` and the `today` pane id. Unknown values fall back to defaults; older records keep every choice. The server default order still lists `running`; the client retires it on read.
- `src/agents/calendar-watch.ts`: `isUnansweredInvite` is now exported so Today uses the watch's own rule.
- `src/runtime/secrets/{registry,types}.ts`: `keyUrl`.

New read-only routes:
- `GET /api/console/home/today`
- `GET /api/console/home/space-summaries?ids=`
- `GET /api/console/needs-you/summary`

None of them makes a provider or model call.

**Combined candidate:** `main` at `42db5a57` merges cleanly with `harness/3.19` at `2f47c55a` (checked with `git merge-tree`). The harness worktree had uncommitted edits at the time, so no combined build was made.

**Tests at `42db5a57`:** backend, console-web and mobile-web typechecks are clean. UI, phone and affected backend files: 847 of 850 pass. The 3 failures fail by name at baseline: `useChat` empty completion, the Home mock route, and the space-routes manual-refresh manifest test.

**Owed on the installed app, against the live home, after the combined install:**
1. build-info gitSha matches the candidate.
2. Switch styles in Tune, relaunch, and check the choice held (`state/home-preferences.json` has `style`).
3. Switch one Space between Summary and Full, and check it held.
4. With a run active (drive it with Grok or GLM), the band names it and its step. When idle it says "caught up" with the next calendar check.
5. Today matches the calendar watch.
6. One Build Home journey with a named fixture prompt on a Grok brain: card, then ready, then pinned. Relaunch mid-build and check it resumes. Check a duplicate submit is refused.
7. Space dock picker at 1100×720 is fully visible. Switch the brain grok-4.6 → GLM, send, check `turn_model_routed`, then switch back.
8. Phone: pair a temporary browser. Home has no work pane, the header chip shows, and the count matches. Revoke that device by id.

Local previews used the working-tree dist with the daemon's `__CLEM_BOOTSTRAP__` grafted in. Real feeds came from an APFS clone of the home's state, served read-only.

**Known gaps:**
- The phone does not use the style or the live band yet.
- Summary tiles are only as good as a Space's authored `_mobile` summary. A Space whose numbers live in its view code (Platform 4.9) defaults to its full page.
- Build Home pointers are kept per window in localStorage. The state they point to is durable.
- After a failed Tune save, the panel resends its whole draft, which can carry a stale `spaceViews`.
- Pre-existing: `MadePane` and `DeliveredShelf` share the query key `['delivered']` with different limits.
