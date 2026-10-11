# PR-10 — Read-turn review: fewer tokens, the same verdicts

Size M · risk measured (each phase gated on a replay and a live A/B) · revised 2026-10-10 from measured
data; supersedes the first draft, whose main lever (headline-only result bodies) would have turned Jev
off and driven extra review rounds.

## The constraint

Fewer tokens are worth nothing if completion accuracy drops or the review sends more correct answers
back for another round. Every phase below must hold three things: the verdicts agree with today's,
false-rejection rounds do not rise, and Jev settles at least as often as today. Jev's understanding must
stay whole: the task (objective and reply), the owner's standing instructions, contrary evidence
(failures, diagnostics, incomplete attempts) and the uncertainty markers (what was shown only in part).

## What the read review is today (measured 10-05 → 10-11, structure and numbers only)

`reviewAtStakes('read')` (`objective-judge.ts:1563-1595`) runs one review at effort `medium` with the same
evidence builder, instructions and lookup tools as a write review (`host-turn-runner.ts:4664-4744`).

| | |
|---|---|
| Read reviews | 298: 221 by the reviewer model, 77 settled by Jev (26%) |
| Reviewer input per review | p50 12,845 · p90 44,700 · max 235,375 tokens |
| Uncached per review | p50 8,733 · p90 30,686 · max 57,334 |
| Time | p50 3.3 s · p90 9.7 s |
| Calls per review | 211 of 221 one call; 8 used lookups; 2 a coverage follow-up |
| Rejections | 3 real (all `repairScope: claims`, 2 from the host coverage rule), each passed on the next round with a new reply |
| Share of turn | 28% of the turn's uncached input (the brain is 49%) |

The reviewer already caches its instructions and tool schemas (p50 4,704 tokens cached, 221/252 calls hit);
only the evidence prompt and coverage follow-ups are uncached. Previews are already capped at 4,000 chars
(284 of 750 expanded results hit the cap), identical bytes are shown once, discovery results are already
compacted to tool metadata, and images are already replaced by a text description (type, size, sha256).

What the evidence prompt is made of (regression over 221 first calls, R² 0.976):

| Part | Share | Notes |
|---|---|---|
| Memory block | ~20-30% | the brain's full memory fragments (p50 7,957 chars) in every review |
| Per-result framing | ~20% | ~990 tokens per expanded result: label twice, request-scope args, handle, dispatch id, sha256, a plan-only binding note, disclaimers |
| Result data previews | ~20% | the evidence itself |
| Fixed text incl. instructions | ~20% | already cached |
| Discovery metadata | ~7% | ~1.9K tokens each (131 rows in 84 reviews) |
| Reply, failed rows, earlier turns | small | failed diagnostics are contrary evidence |

The "17K overhead" in the first draft was not an image: `providerAndToolOverhead` is real input minus a
chars/4 estimate, about a third of every read review because ids, hashes and JSON tokenize densely. It
shrinks with the framing below; it is not a payload of its own.

## What the first draft got wrong

1. **Headline-only bodies.** Any result shown in part sets `contentComplete: false`, which makes
   `coverage.complete` false (`objective-judge.ts:761-797`): Jev is never asked, the 30 s cap is lifted,
   and more coverage-ledger rows can force a claims return. Bounding previews trades tokens for review
   rounds and Jev's reach. Not done.
2. **Pictures.** The reviewer's lookup tools (`open_evidence`, `query_evidence`,
   `judge-evidence-tools.ts:212-293`) return text and JSON only; an image is a text description, and
   `query_evidence` would at most return base64 as characters. No review today can verify picture
   placement from pixels, so the plan must not promise it. See §Pictures.
3. **Cache.** The reviewer does share a cache with itself across calls (instructions, tools, lookup
   rounds); "every token is paid" was true only of the evidence prompt.
4. **Jev's share.** Already recorded (`fast`, `jevAttempt` on `goal_alignment_judged`; `state/jev-decisions`);
   the current figure is 26%, not 8%.
5. **`valueProvenance`** takes structured arguments (`workflow-mutation-review.ts:66`), not reply prose;
   it cannot pick "cited records" from an answer.

## Change, in gated phases

### Phase 1 — framing nothing reads (expected −15 to −20% of the evidence prompt; no change to completeness)

In the read-result block (`host-completion-work.ts:640-791`) for read reviews:
- drop the plan-only "binding value type" note (it is for plan review, not completion);
- print the result label once;
- drop the sha256 and dispatch ids from the reviewer's view: its lookup tools accept call ids and handles
  only, so the reviewer cannot use them (the digest stays in the durable verdict record);
- keep, unchanged: request-scope args (they guard absence and "all of them" claims), the Records line,
  every completeness and bounded line, failed rows and diagnostics, the data preview.

On a read turn whose business read answered, collapse each discovery result to one line naming the
operation chosen (keep full metadata when nothing was found: that is the evidence for "nothing to do").

Because nothing is shown in part that was shown whole before, `contentComplete` is unchanged and Jev's
gate is unaffected. Smaller evidence moves more reviews under Jev's learned size bar (19,682 tokens), so
Jev's share should rise; that is measured, not assumed.

### Phase 2 — memory the review needs (expected a further −10 to −15%; moderate risk)

Today every review carries the brain's whole memory block. The block was added after reviews flagged the
owner's own preferences as unsupported, so it cannot simply go. Instead:
- always include, in full: standing instructions, preferences, corrections and rules (what the owner told
  Clem to do), and any memory the reply cites or contradicts;
- drop recall hits that share nothing with the objective or the reply (ambient facts), with a one-line
  count ("N other memories not shown; open with memory tools") so absence is never silent;
- give Jev the saved-agent standing instructions and skill rules it does not receive today
  (`objective-judge.ts:1794-1815`): a correctness gap, not a size change.

Gate additionally on the "unsupported" rate: the share of reviews and Jev abstentions citing unsupported
claims must not rise.

### Phase 3 — lossless compact records (only if Phases 1-2 leave reads large)

Record lists rendered as JSON pay for keys on every record. A lossless table form (keys once, values in
rows, every value present) keeps `contentComplete` true. Only with a byte-for-byte reconstruction test,
and only if the replay shows no verdict drift.

### Not in this PR

- Bounding or headlining result bodies (see "first draft" 1).
- Changing review depth, the fail-open contract, the continuation cap or Jev's size bar.
- Dropping lookup tools from read reviews.

## Pictures

What a read review can say about a picture today is what text says about it: a saved image's type, size
and digest, a document's own layout data when a tool returned it (positions, slide indices), and what the
reply claims. The review must therefore:
- judge layout claims only against layout evidence in text (for example a deck's element positions);
- when the request's success depends on how something looks and no text evidence settles it, return the
  verdict with that part marked unverified (`evidenceCoverage: 'insufficient'` for that claim) rather than
  pass or fail it, so the owner sees "not checked visually", and never spend a repair round on it.

Pixel checking is a separate capability (an image-returning lookup for a vision-capable reviewer, with
its own cost gate) and is not promised by this PR.

## Measure (every phase)

1. **Replay.** `scripts/probe-judge-live.ts` extended to rebuild both evidence forms from retained
   records by source id and ask the same reviewer model. Sample: the last 5 days' read reviews where the
   retained records still exist (target ≥ 60), stratified by size, plus every one of the 3 rejections.
   Pass: every verdict agrees, or disagrees toward caution on a claim the trimmed form still shows;
   none of the 190 passes flips to a rejection; uncached evidence −15% or more (Phase 1).
2. **Jev.** On the same sample, Jev settles at least as many reviews as today (target: more).
3. **Calibration.** `npm run measure:judge-calibration` κ equal or better.
4. **Live A/B on the installed app**, two or more runs per arm after a warm-up run (the learned-operation
   confound): the drafts read question, the slide/drafts/PDF conversation, one question about a picture.
   Report certified uncached reviewer input, review rounds, and verdicts per arm.

## Files

- `src/runtime/harness/host-completion-work.ts` (read-result block framing; discovery collapse)
- `src/runtime/harness/host-turn-runner.ts` (memory block selection for the review)
- `src/runtime/harness/objective-judge.ts` (Jev's standing-instruction input; the picture rule in the
  review instructions)
- `scripts/probe-judge-live.ts` (replay by source and form)
- tests beside each; a dated checkpoint with the replay and live numbers

## Ownership

The 10-08 rule stands: reads get the light check, the full other-family review is for writes and
creations. The review path's owner implements; this plan is the measured basis.
