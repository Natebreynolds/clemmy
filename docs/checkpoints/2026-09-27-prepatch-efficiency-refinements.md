# Prepatch refinements after the 03ff91db6 live runs

Owner scope: prepare improvements now; decide on hotpatch later. This wave does
not restart/install the app, change providers/accounts, run paid model tests,
change personal workflows, or claim release acceptance.

## Candidate and evidence

Base: `03ff91db6cd43de86c80f51d1274b65ce6bb40c2`, branch
`codex/release-integration-0927`, worktree `clem-worktrees/combined-retry`.
The installed app was independently observed at that base, fingerprint
`d4aba179f4ccff72265e43d87ab8656acc2fab5f323a3f4fcd9668faa5176ed5`.
The changes below belong to the commit containing this checkpoint. Main and
the two pre-existing experimental journey edits are excluded from this wave.

Evidence: `output/live-acceptance-03ff91db6/REPORT.md` in the main worktree;
full discovery envelope, saved plan and run receipts under the integration
worktree's `output/takeover-2026-09-27/`.

The controlled workflow spent 2.229 seconds executing and 147.070 seconds on
the complete request (264,704 input tokens). The first create attempted a
JavaScript transform string; refusal happened before creation. Actual model
history had the complete discovery page, but schema compaction had removed
the nested transform instructions. The event preview's 8K clipping was not
the model's context and is not the defect.

Plan revision took 177.897 seconds / 91,062 input tokens. The operator created
the destination directory between checks, so the changed filesystem state was
real. Do not attribute that whole interval to duplicated plan text or remove
freshness checks to make a benchmark faster.

## Implemented

1. **Nested tool instructions within the existing page budget.** Secondary
   previews and redundant secondary prose yield before the selected operation's
   nested description/examples. JSON structure, literal enum/const data,
   capability/account/carrier information and lossless schema handles remain.
   The 20K page ceiling is unchanged. Partially compacted schemas still explicitly
   require the full-schema read; this is not permission to guess missing fields.
   The exact live workflow discovery query now exposes the transform JSON format.
2. **Saved-plan corrections by exact reference.** `base_ref_json` can be paired
   with `step_patches`, and optional replacement text/criteria. Unchanged steps,
   bindings and dependencies are retained. Existing preparation refresh and the
   complete candidate review still run. Foreign/mismatched references do not
   fall back to a guessed new plan. This changes no Execute admission or effects.
3. **One copy of plan prose in final review.** When the reviewed reply exactly
   equals fullText, the evidence packet carries graph/readiness/prerequisites
   without repeating that text. All prepared contracts remain. If the two texts
   differ, the full candidate is retained. On the captured revision this removes
   1,783 serialized characters from a 10,599-character candidate packet; the
   1,745-character prose is still sent once. These are character measurements,
   not provider-token or latency claims.
4. **Recall provenance stays visible.** Fact evidence now carries its stored
   episode kind and observation time through recall. Ranking explanations call
   it a retained source link, not independent verification. Scores, stored facts,
   evidence retention and ranking are unchanged. This does not independently
   validate old assistant interpretations or repair historical source attribution.
5. **Jev receives late request constraints.** Turn-start selection no longer
   silently cuts requests at 3,000 characters or flattens their whitespace.
   Complete accepted text reaches the decision; the existing transport timeout
   and ordinary-discovery fallback remain. A long request costs more Jev input
   than a truncated one; the correctness benefit is preserving its real scope.
6. **New Chat is reachable again.** The merged Today route was always rendering
   Home, leaving the existing Chat reset handler unused. Explicit New Chat and
   seeded chat links now select the lazy conversation screen. Each new-chat
   navigation remounts it, clearing unsent draft state and focusing the composer.
   Ordinary Today navigation still shows Home. Narrow-screen history closes on
   navigation identity, including a new chat at the same URL. The separate
   mobile PWA already uses its own compose handler and was not changed.

## Verification before patch

Red pins were observed before fixes for nested argument instructions, saved-plan
correction, duplicated plan prose, recall origin and long-request Jev routing.
Then:

- Tool discovery/publishing/memory cohort: 112 passed, zero failed/skipped.
- Real host Plan review cohort: 8 passed, including correction, unavailable review,
  timeout, digest mismatch and delivery variants.
- Jev control-plane/proven-operation cohort: 40 passed.
- UI navigation/layout and entity-memory cohort: 19 passed (four ranking checks
  overlap the first cohort).
- Root TypeScript check passed. Console build passed; mechanical UI detector
  returned no findings. Final clean candidate build is recorded separately.
- Actual browser clicks against the development console: Today → New Chat opens
  the composer; typing an unsent draft then New Chat empties it and focuses the
  composer; Today returns to its dashboard. No message was submitted. This is a
  development-browser check, not installed desktop or physical iPhone acceptance.

Test logs are copied to `output/prepatch-refinements-2026-09-27/`. The isolated
runner's live-home sentinel could not prove an unchanged live home while the
running daemon wrote there. Test fixtures use their disposable homes; none of
these results substitute for installed-app/live-home acceptance.

## Further Jev work, grounded in the running harness

Read-only observation at 2026-09-28T05:19:29Z, from that UTC day's decision log:

| Lane | Actual calls | Successful responses | Reported input tokens | Sum call ms |
| --- | ---: | ---: | ---: | ---: |
| Turn start | 9 | 8 | 20,114 | 4,808 |
| Discovery rank | 10 | 9 | 13,516 | 5,906 |
| Trajectory | 12 | 10 | 7,339 | 8,022 |
| Completion | 3 | 2 | 7,611 | 5,243 |
| Operation effect | 11 | 11 | 10,565 | 1,948 |
| Operation delivery | 1 | 1 | 2,540 | 745 |

These include concurrent owner activity and are not a matched benchmark.
Skip rows are excluded. Failed-call token usage is unavailable, not proven zero;
output tokens are absent from this decision-log projection (the usage ledger is
the authority). Summed call duration is not task wall time. Turn-start outcomes
were six `none`, two `strategy`, one without an outcome. Rank and trajectory
rows lacked terminal outcome labels here. A successful HTTP response does not
prove a correct decision or agreement with a flagship reviewer.

Prioritize:

1. **Measure candidate coverage and actual benefit.** Join each turn-start/rank
   decision to exact served tool/account, fresh schema disclosure, eventual
   settlement and avoided discovery frames. Inspect the six no-fit starts before
   broadening candidate pools. A no-fit can be correct; neither lexical matches
   nor past success confer present authority.
2. **Use Jev to select the smallest useful evidence packet.** Nominate memory
   and retained-result handles, keep corrections/approved-plan/pending approval
   and completed-write receipts unconditional, and let the brain retrieve more.
   The shared candidate/memory question helper exists, but current production
   callers found in this checkout use it via candidate ranking, not a combined
   memory+candidate preparation request. Wire shared questions only where the
   actual inputs are ready together; do not serialize unrelated preparation.
3. **Learn from resolved work rather than copied answers.** Tie learned recipes
   to successful exact operation/schema/account evidence and owner corrections.
   Keep source provenance distinct from assistant interpretation; never make
   repeated agreement with an old answer look like independent corroboration.
4. **Reuse decisions only under their real dependencies.** A repeat decision
   needs identical accepted request/correction, candidate contracts, account
   selection, evidence revision and policy. Invalidate on any change. Do not add
   a global query-string cache or reuse write authorization.
5. **Expand watcher/completion substitution only with labeled outcomes.** Jev
   can triage coverage, novelty and obvious drift; exact receipts and selected
   review policy remain authoritative. Present logs do not establish that every
   larger-model review was redundant. Optimize evidence duplication and repair
   loops before weakening review coverage or introducing speculative hedges.

For every proposed improvement compare total task wall time, brain/worker/Jev/
reviewer tokens including failed attempts, cache hits, discovery frames and
correctness on matched work. A cheaper brain turn with more routing and recovery
is not a win. No new Jev lane is enabled speculatively in this wave.

## Still owed after the owner chooses to patch

Build exact committed source in the clean qualification checkout; coordinate
the existing Terminal hotpatch recipe; confirm served build-info/fingerprint.
Repeat the same real read tasks, controlled workflow author/enable/execute,
BLUE→GREEN plan correction/Execute and restart/no-replay check. Compare full
task tokens/calls/wall time at matched role settings and load, not just brain
latency. Check New Chat from Today, an existing conversation and the narrow
desktop layout in the installed app. Physical mobile acceptance remains owed.

Long-conversation forced compaction, sustained fan-out, fault between external
effect and receipt, and outstanding full-suite/journey qualification remain
release obligations from the preceding checkpoint. Do not call this tag-ready.
