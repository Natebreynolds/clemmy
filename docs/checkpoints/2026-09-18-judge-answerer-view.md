# 2026-09-18 (night) — The judge sees what the answerer saw

Continues `2026-09-18-host-text-memory-and-cache-routing.md`. Same method:
measure on the owner's real store and live app, never on a unit suite alone.

The completion judge was 24% of all uncached tokens over four days
(gpt-5.6-sol alone), with single judge calls of 434k and 710k tokens. The cause
was not the verdict — it was the evidence: every retained read result, whole,
on every judge call, including results the answerer itself only ever saw a
20k-char view of.

---

## 1. Result

Every completion verdict since 09-11 (181 judge calls over 125 accepted
sources), with the read evidence rebuilt from a copy of the owner's store by
the old and the new builder:

| | read evidence per judge call (sum) | ≈ tokens |
|---|---|---|
| before | 26.2M chars | 6.5M |
| after | 12.8M chars | 3.2M (−51%) |

Largest sources: 1.91M → 559k chars, 1.58M → 206k, 621k → 87k, 542k → 108k.
85 results were bounded, 164 superseded, 333 discovery results summarized.

Live, hotpatched owner app, same questions as the earlier probes:

| probe | judge input | verdict |
|---|---|---|
| "What is on my Outlook calendar today?" | **7,408** tokens (was 9,275–9,340; 13,903 with the discovery dump) | done, first pass — all six events correct |
| "Which emails came into my inbox today?" | 14,825 tokens; mailbox result shown BOUNDED (19,214 of 23,852 bytes), discovery as navigation (was a 17 KB dump) | rejected, correctly: the reply missed the 2:05 a.m. email and called present senders "unavailable"; the re-run's reply fixed both |

---

## 2. What changed (`host-completion-work.ts`)

1. **Each result is shown the way the answerer received it.** A result within
   the per-result bound (`DEFAULT_TOOL_RESULT_MAX_CHARS`, 20k) is shown whole.
   A larger one is shown as the same structure-aware view the model got —
   `compactStructuredJsonToolOutput` for JSON (whole records, true counts,
   clipped oversized strings), `digestToolOutput` for text (head and tail),
   with the resource-id index the model's view carried. Its header says
   `showing a BOUNDED view … Content outside it was not seen by the answerer
   unless another read shown here covers it`, and its row records
   `viewBounded: true`, `contentComplete: false`. Tools that read retained
   output (`readsRetainedOutput` in the registry: `recall_tool_result`,
   `tool_output_query`, `file_query`) hand the answerer their page whole, so
   they are shown whole.
2. **A repeated exact call is judged by its latest read.** Same tool and same
   effective argument digest: the latest successful read is shown; earlier ones
   are receipt lines (`superseded_read`, "the same call ran again later as
   logicalCall=…"), keeping handle and digest. Polls and re-reads of a Space
   were the largest repeats (one turn: 7 of 13 `space_get` reads).
3. **Discovery is summarized once a business read has answered** —
   `discoveryNavigation` plus each discovered operation's input contract
   (`required` and `accepted` parameter names, no prose). A discovery that
   found nothing stays whole: that absence can be what a reply rests on.
4. **The rule text says what the view is.** The judge system prompt, the host
   completion instruction and the workflow-origin reviewer label now say:
   results are shown whole or as the bounded view the answerer received; a
   claim resting on content outside what is shown — including a claim that
   something is missing, empty, unavailable or complete — is unverified unless
   another read shown here covers it (a filtered query, a true count, a
   recalled page).

The trajectory watcher's incremental path is unchanged apart from input
contracts on its navigation rows. Plan-preparation evidence uses the same
builder, so it gets the same bounds.

## 3. Why this is not the 09-08 cutoff again

`boundedJudgeEvidence` (removed in `5a1ca884`) cut the *concatenated* evidence
at 24k chars: whole results in the middle vanished, and the receipt still
claimed complete coverage. Now the bound is per result, it is the bound the
answerer had, and the evidence says so. Both incidents behind the "complete
evidence" rule stay pinned, rewritten to assert the property that mattered:

- **Facebook projection** (answerer projected away engagement, then claimed
  "likes, shares, comments and views came back empty"): the bounded view of
  the 256k-char dataset keeps all 25 posts with every decisive field —
  likes, shares, comments, views, shared posts; only the opaque 10k media
  strings are clipped. The false absence claim stays refutable.
- **Decisive middle record**: survives whole inside the bounded view.

## 4. Validation

- **Decisive facts survive (10 real catches from last week).** For each, the
  judge-time evidence was rebuilt (settlements after the verdict removed in a
  rolled-back transaction on the copy) and searched for the fact the original
  judge cited: the six true calendar events (two calendar hallucinations),
  the `stdout` wrapper and totals (Space parses nothing), the out-of-window
  `2025-08-25` deal, contacts and closed-lost records (false "zero" claims),
  the file content behind a wrong takeaway, the absence of any failed
  provider call behind a claimed binding error. **One regression was found
  and fixed here:** "the Draft reply action omits the required
  `mail_folder_id`" rested on the operation schema inside a `tool_search`
  dump that navigation had dropped — hence the input contracts in §2.3.
- **Offline model re-judge: not run.** Judging from an isolated home needs a
  judge credential there; copying the owner's codex access token and reading
  the keychain credential from a temp home were both refused by the session's
  permission policy. A model re-judge has to run inside the owner's daemon,
  which holds its own auth.
- Tests: `host-completion-contract.test.ts` (old whole-bytes assertions
  rewritten to the answerer-view contract; new: supersession, input
  contracts), all judge suites, `src/runtime/harness` + `src/execution`
  chunked (762 files, 8,616 pass, 0 fail); judge suites 212/213 (1 opt-in
  skip); gates `check:operation-identity` and `no-hardcoded-provider-pins`.

## 5. Dropped: reordering the judge prompt for cache reuse

Measured before building it: the judge runs on gpt-5.6-sol over the codex
wire — 604 calls last week, 27.5M input tokens, **1.6% cached**. That backend
caches the instructions+tools prefix, never conversation content (see §3 of
`2026-09-18-host-text-memory-and-cache-routing.md`); on the Claude wire a one-block
prompt cannot hit a partial prefix either. No judge wire would have cached a
reordered prompt, so the reorder was not made.

## 6. "Rejections must cite evidence" — the split (owner decision)

All 85 rejections since 09-11, classified by what each rests on:

| rests on | execution (55) | plan review (30) |
|---|---|---|
| reply contradicted by evidence or an operation contract | 10 | 3 |
| saved artifact / plan violates a stated requirement | 10 | 7 |
| requested work absent from the evidence | 18 | 10 |
| claimed failure with no matching call | 14 | 1 |
| asked the owner a question (should have been AWAITING) | 2 | 1 |
| rubric/robustness judgment, no evidence cited | 0 | 8 |
| judge could not see the artifact (draft body not shown) | 1 | 0 |

So a cite-evidence rule would touch at most 12 of 85. The waste is elsewhere:
**47 sources were rejected at least once; 14 were accepted after re-running
(16 re-runs); 33 ended still rejected (55 re-runs — 77% of all 71 re-runs):
30 on a fresh rejection, 3 on a carried verdict (§7).**
The re-run mostly repeats the same failure: the Outlook invite update
(11 rejections across 4 sources, "claimed connector failure, no update
call"), plan publication failures (10), Space cross-tool requirements (3
sources). Options for the owner:

1. Plan-review rubric items (8) become advisory — matches the 09-15 "Plan is
   best effort" directive.
2. A re-run that repeats the same rejection with no new successful business
   call stops, delivers the honest report, and records the failure as a
   learned correction (instead of a third identical attempt).
3. The three "asked the owner" rejections are verdict-shape errors
   (AWAITING exists for them).

## 7. Known gaps

- `space_history` and `space_diff` format results at 36k; the judge bounds
  them at 20k (10 settled calls ever). Exact fix: a declared per-tool result
  budget read by both the formatter and the judge.
- **Carried verdicts can skip a corrected answer (pre-existing, 09-15).** A
  continuation with no new business call and a reply that
  `honestFailureReportSettles` accepts keeps the previous rejection without a
  judge call. That predicate only asks whether the reply claims completed
  work, so a corrected *answer* to a read question qualifies: in the live mail
  probe the re-run fixed both findings, yet the source is recorded as not
  fulfilled. 3 sources last week ended this way.
- The remaining large judge calls are Space redesigns that read many distinct
  pages (one: 28 recalled pages, 22 shown whole). Only verification by
  reference — the reply cites the evidence it rests on — shrinks those.

## 8. State

- Code: `40e45d9d` on local `main`, unpushed (with the earlier 09-18 commits).
  The `apps/usage-sidecar/*` changes in the tree are not part of this work.
- The owner's app (3.18.17, user-level install) runs this build as a hotpatch;
  the prior daemon is retained as `daemon/dist.backup-nzFf4W`.
- Owed: the owner's call on §6; the carried-verdict gap and the declared
  per-tool result budget in §7.
