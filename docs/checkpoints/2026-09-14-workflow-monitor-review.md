# Workflow follow-up for patch 3.18.7

The installed-app findings below are separate from the approved research execution failure. Preserve the failed runs; do not enable or recreate a monitor to conceal a failed creation test.

## Comment monitor

In session `sess-desktop-fe74a1c10cefde3af99b09eb`, source 205387 asked for an hourly document-comment monitor. Two negative completion reviews (205411 and 205413) correctly found that no workflow had yet been created. The subsequent repair created it at 205442, but terminal 205449 reused the earlier negative verdict. Its reply and artifact coverage did not match the new result.

The host now performs final verification at the existing repair limit without granting another repair. This separates the number of repair continuations from whether the final candidate is reviewed. Owner opt-out and pending approval behavior remain unchanged. Tests cover a fresh positive verdict after the last repair, retained continuation counts across restart, and a final negative verdict without another model repair.

Creation test `1789411846638-862d08` then failed before its read-only step ran: `workflow_definition_authority_missing_or_changed`. The runner treated any prepared external catalog as requiring an authored external-write grant. The saved step was a read with a comment-list operation. The failure condition now requires an external-write capability in that prepared catalog. Read calls still use their ordinary exact binding; the existing write-authority refusal remains enforced for external writes.

Seven focused regression cases passed. Two run the production workflow creation-test owner with only provider catalog preparation and model I/O substituted: a read catalog reaches the model, while an unbound external-write catalog does not. This is controlled behavior evidence, not a live rerun of the user's monitor. The failed monitor remains disabled.

Raw local evidence: `output/release-3.18.7/monitor-hiccup/events.json`.

## Platform 49

The 08:00 PT run (`trigger-a1003e91f641aecad5bff4fbadddbb0e`) used an older runtime, reported as `b2a91bb3` in its blocked-terminal event. It read the sheet and Slack, received a repairable provider rejection for sheet ID 0, then ended with `catalog_snapshot_identity_mismatch` while discovering the necessary sheet metadata. The controller-owned discovery fix in `61c1a58b` already addresses that failure class and is included in installed 3.18.6 (`32269b1e`). Do not describe that morning trace as a fresh regression in the installed newer build.

The noon run (`trigger-6083161562802c09a0b7a1daaeafff5c`, source 205457) initially could not refresh its Google Sheets connection proof. `selected_connection_refresh_unavailable` means the check threw; it does not establish a disconnected account. Its automatic retry resumed at 19:01:42 UTC and successfully read Google Sheets and Slack. It ultimately blocked at event 205683 with `authority_acquisition:no_new_evidence`, on installed build `32269b1e`, with no settled external write.

At 205655 an exact `GOOGLESHEETS_INSERT_DIMENSION` search returned local tools with `brokerCoverage:builtins_only`. The later call lacked the provider's required `insert_dimension` field. A sheet-name lookup then used the wrong carrier wrapper, received a repair instruction to discover the exact schema, and encountered the same local-only search at 205672. This is a discovery wiring defect, not evidence of unavailable Sheets access.

The scheduled run uses the constrained workflow-step builder (`WORKFLOW_STEP_AGENT=on`). Both it and the alternative orchestrator builder omitted connected candidate sources from their workflow `tool_search`. The fix supplies the accepted source identity to both builders and connects their existing search tool to the same provider discovery and account/schema publication code used by foreground work. Results name `call_tool`, the workflow's actual execution carrier. Discovery performs no business operation and grants no write permission. Exact/local-only/compiled tool locks remain constrained.

Five discovery cases passed in `src/tools/tool-search-selected-account-evidence.test.ts`: existing foreground account disclosure, connected discovery through both workflow builders, and local-only restriction through both builders. The tests invoke the bracketed tools with the same durable workflow-owner stamp and discovery initialization as the production runner; they assert the exact schema, current catalog ref, selected account, carrier wrapper, and zero business I/O during discovery. Each connected case then invokes the actual `call_tool` path using the returned account label and verifies one read against that account. Provider metadata and the final one-request transport are substituted. This is not a live rerun of Platform 49.

An independent efficiency concern remains in the authored workflow: it asks each run to page history back to the oldest date already in its log. That can repeatedly reread old channel history. No owner workflow definition was changed in this patch, and it is not the cause of the schema-discovery refusal above.

Raw local evidence: `output/release-3.18.7/platform49/`. No reviewer writes to the owner's sheet or workflow were performed.

## Wider qualification

The initial broad local suite had 15,844 passes, 19 failures, 6 cancellations and 3 skips under heavy concurrent load. A serial rerun of the failed files plus the two CI failure files completed with 485 passes and one timing-fixture failure described below. After correcting that fixture, all 600 affected tests passed with no skips or cancellations, including both workflow builders, discovery, account routing, creation-test handoff, objective review, host runner, parallel read ordering and logical-call contract refinement. No test deadline or assertion was relaxed. A final clean-commit full suite, journeys, build/package/upgrade checks and live qualification still precede the tag; the earlier broad result is not a green release gate.

The parallel-read check also failed on the hosted runner and reproduced locally. Its four separate zero-delay timers could occupy different timer buckets, invalidating the fixture's assertion that all four bodies were due in the same phase. The fixture now releases them from one timer; the required observation remains four returned bodies and zero settlements. Windows CI separately failed while unlinking an open fixture telemetry database after all test assertions passed; teardown now closes that database before removing its temporary home. The iOS CI failure is an Xcode 15.4 runner unable to open project format 77; this Mac patch does not change the iOS project or claim iOS qualification.
