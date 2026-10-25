# Configurable iPhone widget dashboard — 2026-10-25

Owner requested a larger widget with information and workflow actions, then explicitly chose “Run it directly from the widget.” Work is on `codex/memory-completion-refinement`, starting at `5bbd6ae45f2407007e059ac02bf867ed0e5433f2`. Claude's separate `claude/daemon-loop-holds` worktree was last observed at `bec0fe03a`; its source and runtime were not changed here.

## Implemented

- New medium/large **Clem dashboard**, configurable as Overview, Information, or Workflows. Existing widgets remain available.
- Information uses the existing explicitly saved Space snapshot and age. No background polling or claim of live information.
- Up to three explicit workflow pins, with bounded presentation data and canonical saved slugs. The fourth pin is refused rather than silently replacing another. Remove and logout/unpair clearing are included.
- Run buttons use an authenticated foreground AppIntent. A ready workflow with no declared inputs starts through the existing mobile `runWorkflow` path without a second Run tap. Clem opens to show the result; workflows needing inputs or preparation stay in their normal review UI. Existing approvals and admission checks remain authoritative.
- A separate, app-private Keychain record binds one tap to its exact navigation UUID, workflow and pairing for five minutes. Consumption must persist before permission is returned. Plain URLs never grant execution; lost receipts are not automatically retried. This is not a new backend idempotency guarantee.
- Warm links preserve the document, retire the previous workflow depth registration without popping the new route, and acknowledge only the exact displayed destination or a proven 404. Refreshes during claim settlement release the UI without repeating the action.

## Validation retained

Evidence directory: `/Users/nathan.reynolds/clementine-next/output/widget-dashboard-2026-10-25/`.

- Initial regular iPhone simulator run: 23 focused native tests passed. This preceded the Keychain persistence correction.
- Final Duo simulator run: 24 focused native tests passed, including a unique-fixture real Keychain round trip, consumption replay refusal, exact target/pairing, expiry, storage failures, warm/cold navigation, and native rendering.
- Final linked-text alignment correction: the dashboard ImageRenderer test passed again. Native preview is `large-widget-preview.png`; long/empty content, all three modes, medium/large, default/xxxLarge and light/dark rendering attachments are retained.
- 39 focused mobile tests passed, covering widget receipts, route validation, readiness, failed/late claims, no retry after timeout, and normal detail-to-widget back history.
- Mobile production build and TypeScript checks passed. The existing large-chunk advisory remains.
- Independent source review found and closed the asynchronous consumed-marker persistence risk and warm back-stack regression.

## Limits and next acceptance

No desktop install/restart, personal workflow execution, physical iPhone install, TestFlight upload, push, tag or publication occurred. These are simulator/unit/rendering results, not proof of WidgetKit Home Screen hosting or physical iPhone/Apple Watch behavior. Merge the current peer changes before any combined installation. Then validate an explicitly named controlled no-input workflow from the installed widget, required-input/approval fallback, duplicate/reopen behavior, offline recovery, and real widget configuration on regular iPhone and Duo. Do not use personal/business workflows as fixtures.

The owner subsequently identified the Apple Watch icon surface as Smart Stack/recording Live Activity. Its native layout correction is a separate follow-up; the widget results above do not qualify that Watch path.

## Watch Smart Stack follow-up

- Added an explicit small supplemental recording activity with the existing Clem mark, authoritative recording phase/staleness, and the relevant existing Finish, End voice, Cancel, Review, or Open action. Controls say **On iPhone**; the Watch does not acquire microphone ownership. No transcript, reply, or free-form message is exposed in this compact view.
- iOS 18 and later register exactly one supplemental configuration for small/medium activities. iOS 17 retains the legacy configuration. Apple's public availability builder wrapper is used because the bundle builder rejects an `#unavailable` replacement branch. The initial compiler failure is retained in `watch-followup.log`; the corrected build passed.
- The medium phone banner, its padding, and Dynamic Island content remain unchanged. The source review checked single registration, exact recording IDs, phase handling, and availability.
- `watch-final.xcresult` contains **3 passing native tests**: seven compact Watch states at two representative viewports and default/xxxLarge text, existing phone recording renders, and authoritative phase/staleness assertions. The four Watch rendering cohorts were visually inspected. These are synthetic native ImageRenderer fixtures on the Duo iPhone simulator, not exact Watch host dimensions or Smart Stack screenshots. The existing phone large-text Review label still truncates in its narrow rendering fixture; this follow-up did not modify that pre-existing layout.
- This addresses the app's compact Live Activity content. A system icon badge/cache issue remains unproven until the owner checks the real Watch. Physical Watch hosting, action delivery and installed iPhone workflow taps remain pending. No physical install, upload, runtime restart or publication occurred.
- Claude's worktree was rechecked at `bec0fe03a` with `src/runtime/harness/loop.ts` modified. Those edits were preserved. Combine current peer work before the next installed acceptance build.
