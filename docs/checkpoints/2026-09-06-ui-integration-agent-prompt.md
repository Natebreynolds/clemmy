UI OWNER NEXT PASS — RUN IDENTITY, COMPLETE HISTORY, HONEST LIVE STATE, AND SHARED REVIEW CONTROLS

**Final ownership transfer — September 7:** The owner has ended the reviewer role. The implementation agent owns qualification, checkpoint updates, UI integration and release preparation from here. No future reviewer response or live-window handoff is required. The recurring monitor is paused. Read the [final handoff](/Users/nathan.reynolds/clementine-next/docs/checkpoints/2026-09-07-final-harness-handoff.md); it supersedes older coordination instructions below. Historical evidence remains scoped to its recorded build.

LATEST ORIGINAL-UI REVIEW — September7,01:42UTC
Original HEAD remains c7e9454f; the new Home/Inbox/shared-presenter work is dirty source, separate from serving C31. Preserve it.19 new/supporting paths were reviewed;110 of125 prior hashes are unchanged and15 changed. The403-file inventory is identity only, not whole-source review. No rendered/device/build qualification was performed.

Complete the prior history/Stop/mobile A→B/offline/resume/Home-destination/push corrections below; their controlling bytes remain unchanged. The new Inbox End this run button is useful exact-run cancellation, but does not fix stale Run detail identity or the desktop Stop-card matcher.

New source corrections for this UI pass:
- Bind bulk-clear confirmation to the actual notification IDs shown at the first tap, or invalidate it when that set changes. A Boolean confirmation plus the latest polled IDs can clear a different same-sized set.
- The daemon bulk-read protection must resolve pending proposal referents if it promises to preserve every decision notification. classifyNotification without approval/plan/trust callbacks misses proposal-only shapes. Marking read grants no approval; keep those semantics distinct and test actual producer shapes.
- Render typed held reasons accurately. not_found means missing/pruned, not an unanswered decision that stayed in Needs you.
- Do not label an eight-hour-silent run Stopped without authoritative stopped state. Show no recent activity/stalled separately from host lifecycle and live action authority.

Exact evidence, snapshots and integration boundaries:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c31-final-review-0142/ui/ui-delta-review.md

Retain the candidate's taskMode/planArtifactRef/exact Execute and review-policy plumbing when merging original conversation components; the originals still lack those fields. Coordinate the accepted steering-objective/held-lifecycle contract with the harness owner. No reviewer live hold is active. Freeze combined bytes only after both owners' corrections, then qualify the real desktop/mobile interacting journeys before packaging/tagging.


The owner has two implementation workstreams: your UI improvements and the harness refinements. The future tag must contain both. The implementation lead now coordinates both and maintains the shared checkpoint. Reread it before each pass and integration:
/Users/nathan.reynolds/clementine-next/docs/checkpoints/2026-09-05-harness-refinement-handoff.md

Keep the new run pages, reservation/settlement distinction, deliverables/timeline, mobile deep links, cache timestamps and attention/status work. The20:02–20:11UTC review confirms the five existing defect branches remain unchanged and adds two real-producer navigation gaps in HEADa88d1b76. These are moving-original-tree findings, not rendered desktop/phone qualification. Codex reviewed C30 HANDOVER-21 and22 new live turns, followed by C31's recovery/selection updates and implementer live evidence. Original UI/source bytes remain unchanged at c7e9454f, so the prior findings below remain open. The reviewer live window is released at closure. Coordinate cutover after checking the claim and current activity.

1. Desktop history can falsely declare complete coverage.
The events API limits raw rows before public filtering. useRunEvents stops on projected batch.length<500 and does not follow a completed session. An early short/empty projected page can hide the later write/final reply while runLedgerIsComplete returns true, leading to “changed nothing.” Use an authoritative continuation cursor/coverage signal, not projected row count. Prove a completed run with filtered first pages and its write/final reply later. An incomplete history must never support a no-effects claim.

2. Desktop workflow Stop cannot resolve real control shapes.
A workflow card has sessionId:null; the exact attempt card has sourceKind:run and is excluded. The source-derived real-shape pair yields no Stop target, while background Stop works. Resolve the actual owning workflow/run identifiers and an allowed cancellation control. Do not match by title or broadly select a sibling attempt. Preserve background and parked/awaiting-input cancellation behavior.

3. Mobile run A can survive a switch to B.
Activity mounts an unkeyed Run and useScreenData is not resource-keyed. Changing sessionId does not reset/refetch or invalidate A's pending request. If B fails, A remains and Stop still targets A. Key/reset by exact identity and reject old request generations. Prove loaded A→B, pending A→B, and failed B. B's destination must never show A's actionable state.

4. Failed refresh can still claim a run is live.
The current predicate uses only status plus service-worker stamp. Retained in-memory data after a failed refresh can be offline:true but live:true. Derive live status and elapsed time from successful current reads and display stale data honestly. Preserve a usable, exactly targeted Stop with fresh or clearly best-effort authority; never silently act on the previous run or introduce unnecessary approval.

5. A delivered turn presentation does not always end its run.
The new endsTheRun(eventType) treats every conversation_completed event as final. That event can carry typed needs_input/resumable/awaitingUser. useRunEvents now exits after a paused read; the old/current extracted comparison previously continued to the later same-step completion. Use typed outcome plus authoritative run/session lifecycle and retain following across input/resume. Prove needs_input from both stream and post-stream read, followed by same-step continuation, alongside true completed/failed and approval-paused controls. The four extracted assertions establish a source-contract defect, not a rendered incident.

Evidence and exact source locations:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c21-review/ui-desktop-review.md
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c21-review/ui-mobile-review.md
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c22-review/ui-progress-review.md
Existing focused checks passed39/39 desktop and74/74 mobile in the prior review; the latest desktop suite again passes39/39 despite the watcher counterexample. Ten watched files were stable during the latest bounded check, while the overall original source is still moving. Add meaningful integrated regressions for all five cases; do not treat source-pattern tests as rendered behavior proof.

6. Home Open run must use an owned run address.
HEADa88d1b76 adds session-first routing. Background activity publishes its own runSessionId and works. Actual workflow activity publishes runId only, so it still falls back to Tasks; the new test invents a sessionId that this publisher does not provide. Fan-out sessionId is originSessionId, so the new branch opens the origin chat and drops the reducerTaskId fallback. Use a typed canonical run destination distinct from origin conversation; retain the exact plan/task fallback when no run address exists. Do not infer a step session from a presumed step name. Cover producer→route using real workflow/fan-out shapes and preserve the background positive. Home tests13/13 pass despite these gaps; five exact-source assertions reproduce them. Evidence:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c24-review/original-ui-review.md
The separate dirty Home layout was read narrowly. AppShell/RunTimeline/BackgroundTasks changed concurrently outside that bounded audit; those bytes need final combined review/rendering.

7. Match native microphone consent to actual voice behavior.
The new paired-origin/main-frame/microphone-only branch is appropriately narrow. Its Info.plist copy promises hold-to-talk and transcription on the Mac with no third party, while AskCapsule currently uses browser SpeechRecognition and a tap toggle. That code does not establish the promised processing path. Align copy with implementation, or implement and qualify the promised Mac-local path before stating it. Keep explicit capture state and permission recovery truthful. Prove actual iOS dictation/stop/denial on the integrated build; this source review establishes no audio routing.

8. Surface APNs registration failure separately from permission denial.
Foreground permission refresh and a denied-permission settings action are useful. The new failure callback still only logs and rebroadcasts unchanged authorizationStatus; an authorized device that cannot register sees no notice. Retain the failure state and its actual recovery action without calling it denied. Release/Debug entitlement selection is separate from the daemon's APNs environment, as the README now admits. Build14 metadata is not successful push delivery. Native findings and hashes:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/2033-review/original-ui-review.md
All118 previously reviewed UI/API/Home paths are unchanged; these native commits do not close the earlier findings.

9. Preserve pending decisions and explicit delivery tests through the new notification gate.
Original commit c7e9454f adds isWorthNotifying before WebPush/APNs, but calls it without the pending-referent lookups used by the classifier. Actual pending approval, plan and standing-permission producer shapes then classify neither and lose external notification. Resolve the canonical pending referent or carry trustworthy typed intent through the delivery boundary; do not infer it from prose. The queue currently treats the gate's nonthrowing suppression as delivered, so distinguish intentional suppression from successful transport. Add producer→gate→transport coverage using real shapes. The separate testNotificationDestination creates a plain system notification with no qualifying status, so the gate also silently skips it while the test endpoint reports ok:true. Give the explicitly requested test a truthful delivery path/result without weakening ordinary attention filtering. Exact old/current functions with stub transports reproduce both regressions; no live push delivery was attempted.
The previous blocked-capability account/whole-run no-send wording remains reachable and unchanged. PIN reservation lifetime and pruned-device revoke-all behavior are unchanged. Keep their scoped corrections visible, without treating this new commit as proof of their repair. Evidence:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c26-review/original-incremental-review.md

SHARED COMPLETION-REVIEW CONTRACT:
The harness owner is implementing persisted settings/API/types, policy captured with the accepted task, and truthful terminal disposition. You own desktop/mobile controls and their presentation against that shared contract. Agree the small typed read/update/result shape before editing overlapping settings/chat/routes.

Desktop GET/PATCH /api/console/settings/completion-review and mobile GET/PATCH /m/api/settings/completion-review now have the intended shape: PATCH {enabled:boolean}, response {completionReview:{enabled:boolean,judge:string,judgeSource:string}}. C25 fixes the router mount; C26 reviewer proof now exercises the actual mounted app with private key-bound pairing. Signed phone GET/PATCH, console GET/PATCH, common persisted state, config reset, missing-proof rejection, invalid input without mutation and unrelated-origin rejection pass in one integrated test/eleven observations. Do not re-fix the path or repeat this as an unproven source-only contract. Shared types/helper, restricted PIN scope, real TLS/relay/iOS and rendered controls remain. C30 separately proves two private console-policy flips and settled policy/terminal rows surviving an actual process restart; it does not qualify phone controls or interrupted judge options. No admin secrets on the phone or weakened ingress. Build both controls against the shared response; show pending/failed saves honestly and display persisted state. Evidence:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c26-review/mobile-settings-review.md

- Completion review must turn on/off on both surfaces and support a selected judge from the same provider; cross-provider access is optional.
- Keep the existing Judge/checker and Second opinion meanings distinct. The latter does not disable completion review.
- Show intentional disabled, reviewed, unavailable/incomplete and deliberately not-required states accurately. A later settings change must not relabel an older task.
- Preserve exact Plan→reviewed revision→Execute and Stop/rejoin. Completion review grants no execution authority.
You own the settings components; the harness owner owns persisted policy/API/types and terminal facts. Add API clients to combined mobile API bytes without replacing candidate Plan/Execute transport. C27 preserves exact revision coverage and superseded history and fixes unknown/unreadable current inventory at publication. C28 restores failed authority retention, but its new undeclared state still has inconsistent publication handling. C30 now honors available owner selection and has real one-provider positive review and review-off persistence. Captured setting flips/settled reopen are proven privately. Learning reader/production propagation and interrupted-policy semantics remain unfinished. Partial required coverage can still yield false file-integrity reassurance; deliveredTextIsJudgedText is not yet a trustworthy unconditional byte comparison. Negative verdicts still collapse to unavailable in some paths. Consume typed facts and known effects; do not relabel old work from current settings.

C31 adds conditional recovery retirement and owner-selection propagation. Recovery saving still overwrites newer same-source state in an actual isolated control; held attempt lifecycle remains open. A successful pre-write restart is not the post-write recovery qualification. Keep the UI aligned with authoritative current source/run state and actual effects.

The broader campaign exposed a backend lifecycle case that the combined UI must not hide: accepted Plan revision138644 has a completed attempt row but no logical terminal/reply. A prior late response left stale recovery ownership. Coordinate the harness fix; presentation must distinguish an actual delivered terminal from attempt bookkeeping and retain exact Stop/rejoin identity. Post-write restart also says nothing changed despite retained local work; align the UI with the corrected common effect projection. Do not fix these solely by hiding messages or marking the client complete. Source evidence:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c30-review/live/L12-revise/review.md
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c30-review/L08-restart-review.md

The reviewer completed the C30 first breadth pass; rendered desktop/mobile qualification remains outstanding. Prepare the UI cases and combined-source preimages in parallel with the next harness correction. Qualify the interacting cases again on the actual combined build. Coordinate through:
/Users/nathan.reynolds/clementine-next/docs/checkpoints/2026-09-06-expanded-live-qualification.md

PRESERVE INTEGRATION:
Original now includes sixteen commits throughc7e9454f plus intended remaining dirty/untracked work. The latest notification gate needs the two corrections above. Preserve the latest native permission/notification/entitlement changes and Build14 metadata alongside the prior Home/layout changes. The19:12 review confirms all55 UI paths in the five newest commits match previously reviewed/inventoried bytes; none closes the five findings above. Current inventory and relay/notification review:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/2026-09-06T1912-integration-review.md
 C31 contains later harness and Plan/Execute changes absent from the original frontend. Inventory:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c21-review/root-integration-review.md
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c21-review/ui-current-integration-review.md
Recheck their preimages; source is still changing. Preserve shared write-ledger/design-token packages, aliases/styles, collapsed-session API steps, notification runSessionId, offline/session-fingerprint rules, relay/test-target changes and candidate Plan/Execute fields. Do not copy either tree wholesale or overwrite later candidate runtime with older original dirty source. The prior mobile boundary findings are separately documented; coordinate narrow ownership for their fixes.

The bounded relay review passed14/14 isolated connection tests and found no new session-authority blocker. One inherited cleanup edge remains: when a sending phone closes while its shared tunnel is backpressured, its drain/close subscriptions survive until tunnel recovery. Coordinate a narrow phone-close cleanup and reverse-direction regression with the relay owner; retain stream/session authority. Shared-proxy saturation can intentionally evict an active tunnel, so the final combined acceptance must exercise real daemon reconnect, phone SSE resume and exact Stop/rejoin under that condition. These follow-ups do not replace the five UI corrections or delay the separate harness batch. Evidence:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/1912-review/relay-review.md

Finish with a source manifest/handover: exact changed bytes, builds/tests, known gaps and real rendered/phone evidence. After both workstreams are ready, combine in an isolated target/dependencies, regenerate backend and both web assets, and qualify that exact build before the future tag. No tag readiness is currently claimed. The implementation lead owns further review and updates to the shared document; reread it as you improve.

C31 continuity follow-up: an ordinary “Never mind that” request during recovery was automatically moved to a branch, and the original workflow later wrote. Coordinate the host amendment/replacement contract with desktop/mobile conversation identity, Stop and rejoin. Assert that visible conversation, accepted source and effect owner agree; retain explicit separate-task behavior. This is not evidence that a typed cancel endpoint was invoked. Exact trace:
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/c31-review/live/branch-review.md

CURRENT REVIEW ADDENDUM — SEPTEMBER 7 FROZEN C31
Original UI bytes are unchanged this pass; do not reclassify earlier findings as fixed. Live source140867 now confirms the harness desktop held-as-completed problem: the attempt closes after read and subsequent child execution cannot use it. Coordinate its typed held/current-owner/terminal contract with the harness owner; UI must follow resumable work without inventing liveness. Plan revision141289 also produced a new plan ID/revision1 and changed unrelated layout; no Execute followed. Preserve exact revision/ref transport and inspect the combined rendered Plan/Execute behavior after the harness repair. This addendum is live harness evidence, not new rendered desktop/mobile qualification.
/Users/nathan.reynolds/clementine-next/output/reviewer-monitor/2026-09-07-c31-frozen-qualification.md

C32 REVIEW UPDATE — SEPTEMBER 7, 03:40 UTC
The original UI source is unchanged in this review. C32's live window returns to harness implementation for continuation ownership and uncertain-write classification; no combined tag is qualified. Preserve the existing UI assignment and evidence. Exact Plan revision→Execute remains unimplemented on the harness side, so a rendered button or API response alone cannot close that contract. Integrate and qualify the eventual combined identity as already assigned. Latest ruling: /Users/nathan.reynolds/clementine-next/output/reviewer-monitor/2026-09-07-c32-review.md

C34 REVIEW UPDATE — SEPTEMBER 7, 04:38 UTC
Original UI source remains unchanged. Current harness work must bind graphless mutations to the accepted job and finish continuation ownership; exact Plan revision/Execute still has no C33/C34 implementation. Preserve the UI assignment and verify the final integrated controls against those real contracts. A reviewed badge certifies its recorded evidence; it must not imply permission for an otherwise unauthorized mutation. Current ruling: /Users/nathan.reynolds/clementine-next/output/reviewer-monitor/2026-09-07-c34-review.md
