# Qualification takeover — September 7, evening

**Handoff received; implementation and live qualification are active.** Read the [current takeover checkpoint](/Users/you/clementine-next-live-iteration-31/docs/checkpoints/2026-09-07-takeover-qualification.md) for serving/source ownership, implemented changes, preserved live failures and subsequent proof. This document preserves the earlier read-only baseline; its old PIDs and pending-handoff state are historical. Codex now owns the work through release qualification. The older staged fixes remain a checklist to reconcile, not a declaration that later source lacks them.

## Source and live state

- Root/UI checkout `/Users/you/clementine-next`: HEAD `ced9a5e6`, extensive uncommitted harness changes.
- Serving checkout `/Users/you/clementine-next-live-iteration-31`: HEAD `9cdf31fc`, extensive uncommitted runtime and UI changes. The tracked diff spans 170 files; untracked additions require separate inventory.
- Observed daemon PID 23755, started September 7 at 18:25 Pacific, entry `src/index.ts` in the serving checkout. No restart performed by this reviewer.
- Therefore “everything is on HEAD” is not established. Qualification must identify dirty source bytes and integration must preserve both checkouts' work.

## Newly observed evidence

1. **Platform 49 C39 returned a plan.** Source 149138, terminal 149516, recorded in `output/candidate39-live/p49.out.json` in the serving checkout. 504.900 seconds, 45 top-level calls, 17 model requests; its configured assertions pass. The reply explicitly acknowledges unread middle/older Sheet data. This improves on blocked C37/C38 but does not prove complete evidence access, verified business findings or Plan revision → exact Execute. It also makes causal claims about blank rows that need source evidence, rather than treating an observed gap as proof of a particular failed write.
2. **Recent Facebook completion is premature.** Source 151611, terminal 151725, Grok 4.6 through `host_harness`/`host_v1`, reports success/done after roughly 11 minutes, with reply: “The check-in landed; next I’ll actually run the posts scraper against Scorpion’s Facebook page.” Completion review is `enabled_unavailable`. This is a terminal completion contract problem: a promise of the requested future work is not the delivered report. It needs trace-level investigation, not a blanket regex on reply prose.
3. **The currently active Facebook replay still hit the schema boundary.** Source 151767, event 151808, refuses `input.startUrls` on the actor call before provider dispatch. Subsequent events show malformed host carriers and recovery attempts. Do not classify this unfinished run's final outcome yet. The earlier open-schema validator diagnosis remains directly relevant.
4. **Useful fresh recall is visible.** Source 150758 read the existing Tim Demik Sheet and asked whether to create another or work with it. No new write was reported. This is evidence of retained context; it does not prove every account/history claim in that sheet.
5. **A scheduled native workflow failed repeatedly.** `end-of-day` sources 151102, 151117 and 151133 failed within seconds with generic error replies. Root cause is not yet established; include this scheduled/native lane in the takeover, not just foreground chat.

The shared reader helper has since gained `authenticRetainedAlternatives`, so the morning source snapshot is no longer current. Its primary route selection still checks presentation storage and defaults missing recall budget to available; reconcile all later caller changes and real reader behavior before reporting this closed.

## Next work after the implementation handoff

Identify owned edits and serving bytes; reconcile every claimed fix with its discriminating test and latest live evidence. Group remaining defects around usable retained reads, valid schema transport, truthful completion and lifecycle ownership. Then qualify connected Normal/Plan/Execute, provider/native workflows, review modes, restart/Stop, memory and combined UI behavior using the [staged master prompt](/Users/you/clementine-next/docs/checkpoints/2026-09-07-final-master-prompt.md). Preserve failures and measure business outcomes, not merely terminal `done` or broad timing bounds.

The database recommendation is separate: [storage direction and durability checks](/Users/you/clementine-next/docs/checkpoints/2026-09-07-database-direction.md). No database migration has been authorized or performed as a shortcut to fixing the harness.
