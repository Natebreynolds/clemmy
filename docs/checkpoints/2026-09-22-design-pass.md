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
