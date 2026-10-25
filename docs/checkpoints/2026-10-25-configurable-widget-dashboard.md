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
