# PR-10 — Read-turn review: bounded evidence, measured before it is the default

Size M · risk measured (flag, default unchanged until proven) · depends on PR-06 (receipts to measure with)

## Why

The owner's rule (2026-10-08): a read-and-answer turn gets a light check; a full
other-model review is for work that wrote or created something. v3.18.34 made the
read review `fast`, which `reviewAtStakes`
(`src/runtime/harness/objective-judge.ts:1563-1590`) implements as effort
`medium` and a 30 s timeout on **the same evidence string** the full review gets
(`host-turn-runner.ts:4672-4745`, plus lookup tools). The 10-09/10-10 data
(`docs/checkpoints/2026-10-09-read-review-cost-data.md`):

| | |
|---|---|
| Phone read turn (slide 7) | reviewer 57,334 input tokens, none cached, 3.3 s; prompt components: instructions 2,849 · history 36,687 · toolSchemas 617 · providerAndToolOverhead 17,179 (an image block, probably) |
| Nine desktop runs of one read question | reviewer 16,090–54,108 uncached tokens each, 2.9–11.9 s |
| Share of the turn | the review was 39% of that turn's uncached input |

The reviewer is a different family by design, so it never shares the brain's
cache; every token it reads is paid. The earlier per-write review got a compact
index (26k → 12k chars, 10-01 §3) and a cache-friendly prompt order; the read
review did not.

## Change

Behind `CLEMMY_READ_REVIEW_EVIDENCE = full | bounded`, **default `full`** until
§Measure says otherwise, then flipped in a second commit on this same PR.

1. **A bounded evidence packet for `stakes === 'read'`.** Beside the evidence
   builder at `host-turn-runner.ts:4672-4745`, `buildReadReviewEvidence()`:
   - the accepted request and the delivered reply, verbatim;
   - the judged read results as a numbered index (tool, account label, when, a
     one-line headline per record: the same compact-index shape the per-write
     review uses), **not** their bodies;
   - the records the reply cites, in full, up to a budget (default 6,000 tokens of
     bodies; configurable), chosen by exact value match of what the reply says
     against retained results (`valueProvenance` from 10-01 already does this
     string search for the write review; reuse it);
   - images never inline: a thumbnail or `view_image` result appears as a
     reference the reviewer can open with its lookup tools, so a question that
     is about the picture still gets the picture, on request;
   - the lookup tools stay exactly as today, so the reviewer can fetch anything
     the index names.
2. **Jev's share, measured not changed.** Record on every read review whether Jev
   settled it (`objective-judge.ts:1866-1904`) and whether receipts were complete,
   so the 09-21 finding (8% settled, 72% complete) gets a current number. No
   change to the size gate in this PR.
3. **The verdict path is untouched.** `reviewAtStakes`, the fail-open contract,
   the continuation cap and the projection (`goal_alignment_judged`) do not change.
   Only the evidence string differs when the flag is `bounded`.

## Measure (the gate for flipping the default)

1. Replay the nine 10-10 desktop runs and the 10-09 phone run: build both
   evidence forms from the retained records (`scripts/probe-judge-live.ts` is the
   closest tool; extend it to take a source id and a form) and ask the same judge
   model. Record verdict agreement, uncached input and time per run. The default
   flips only if every verdict agrees (or disagrees in favour of a more cautious
   verdict) and uncached input falls by at least half.
2. `npm run measure:judge-calibration` (Cohen's κ on the seed set) equal or better.
3. Live, on the installed app: the three-message slide/drafts/PDF conversation
   and the read-only drafts question from v3.18.35's validation, `measure:turns`
   before and after, reviewer rows by role.
4. Report certified uncached input for the reviewer role, before and after, in the
   PR and in a dated checkpoint. Component timing is not proof (10-07 rule).

## Files

- `src/runtime/harness/host-turn-runner.ts` (evidence builder branch), new
  `read-review-evidence.ts` + test
- `src/runtime/harness/objective-judge.ts` (Jev settlement recording only)
- `scripts/probe-judge-live.ts` (replay by source and form)
- `docs/checkpoints/2026-10-xx-read-review-evidence.md` (the measurement)

## Tests

- Builder: the cited records are included in full, uncited ones as headlines; the
  body budget truncates with a count; an image becomes a reference; the request
  and reply are verbatim; a `write` turn never gets the bounded form.
- Flag `full` ⇒ the evidence string is byte-identical to main (characterization).
- Jev settlement is recorded on both forms.
- The nine-run replay script runs on fixtures with a stub judge.

## Done when

The flag exists with `full` as default and byte-identical behaviour; the replay
and calibration numbers are in a checkpoint; and, if the gate passed, the second
commit flips the default with the live `measure:turns` receipts attached.

## Do not

- Do not change review depth, the fail-open contract, or the continuation cap here.
- Do not drop the lookup tools from the read review; bounding means "on request",
  not "unavailable".
- Do not flip the default on component timing or a single run.
