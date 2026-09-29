# Evidence sufficiency for reviewed claims — 2026-09-28

Branch `claude/evidence-sufficiency`, worktree `~/clem-worktrees/evidence-sufficiency`, based on installed
`8d4a039569bb6047cb2476a5234256e4c5eadc57` (`codex/meeting-analysis-save`). Framework only. Main, the installed
checkout and other worktrees were not edited. Private evidence is under `output/evidence-sufficiency-0928/`
(ignored, not committed).

## What the owner's nine-event run actually shows

Session `sess-desktop-0136a0a289ab560e140028c2`, source 325147, run on predecessor build `54f31fe7a`.

- The calendar read returned 94 records, 351,835 bytes. The answerer saw a 3,236-character view of 64 records; 28
  showed a title and 36 showed only the all-day flag. The view never stated that the source held 94 records.
- The reply said the month was checked and none of the events existed. The completion review accepted it, citing
  "the prior October 2026 calendar read (94 records)".
- The statement is true: none of the eight distinct titles occurs in the 94 retained records (checked read-only
  against the retained result). It was not established by what the answerer was shown.
- The review was shown 3,687 of 351,835 bytes. The usage ledger shows it made one evidence lookup (prompt grew from
  39,355 to 42,229 tokens). What it looked up was never recorded, so the verdict cannot be audited afterwards.
- The "three completion reviews" were one review: a first pass (38.6 s), a second turn after that lookup (12.7 s),
  and a re-ask for the verdict line because the second output did not parse (56.7 s, 2,254 prompt and 4,123 output
  tokens to restate one line). The unparsed output was not kept, so its cause is unknown.

The defect is therefore unauditable and unenforced evidence, not a wrong outcome in this run.

## Change

1. **Reviewer lookups are recorded.** Each `open_evidence` and `query_evidence` call is recorded by the host with
   what it returned: character range, record path, total, matched and returned counts, offset, filter and fields,
   or why it was refused. A query page is cut between records and reports only the records it returned.
2. **Evidence rows carry coverage facts.** Read rows on the verdict record the retained result's record count,
   whether the source reported nothing further for that request, and whether a write by the same request settled
   after the read.
3. **A verdict names what it needs the whole of.** After a DONE line the reviewer adds `NEEDS ALL OF: <refs>`, naming
   each result where something must be absent from it or true of every record in it, or `NEEDS ALL OF: none` when
   the verdict rests only on what it was shown, including a result's stated record count. The review prompt lists, from the host record, the results the
   reviewer holds only in part.
4. **The host compares the two.** A result shown in part supports such a verdict only when the rest was opened, every
   record was paged, or a criterion was queried against every record, and the source reported nothing further. A
   record count, a successful outcome or a matching schema is not an inspection.
5. **One follow-up, then correction.** When an acceptance needs the whole of an uninspected result, or does not say
   what it needs while results are held in part, the reviewer is asked once, with the exact results and what was read
   of them. If it still accepts on a result nobody read in full, the acceptance does not stand: the work returns to
   the assistant as a claims correction, to read every record or to say what was checked. A verdict that never says
   what it needs stands as `unattested`; nothing shows it needs the unopened result, so the work is not sent back.
6. **The verdict record carries all of it** (`evidenceCoverage` on `goal_alignment_judged`; a non-sufficient status
   on the published verdict reference).
7. **The answerer's bounded list view states its denominator**: records in the source list, records shown, and the
   fields every shown record carries.
8. **A verdict line asked for separately is restated at low depth**, and the start of the first output is kept on
   the verdict record.
9. **An approval batch asks an identical label question once.** Nine members of the owner's run asked the same
   question nine times and received the same answer. Display only; authority unchanged.

No regex reads the reply or the objective. Which results a verdict needs the whole of is the reviewer's typed answer; what
was inspected is the host's record.

## Unchanged

Approval authority, grouping, frozen arguments, consent, execution, notifications and the approval precheck. Plan
reviews and reviews without evidence tools keep their single pass. Jev's fast acceptance already required complete
receipts and is unchanged. No new execution layer, no provider or model name in a permission branch.

## Verification before installation

- `tsc --noEmit` clean.
- New pins: 17 coverage checks, 11 reviewer-flow checks driving the real judge runner with a scripted model that
  makes real lookups, 2 host evidence checks over real settlements, 4 lookup-recording checks, 1 restatement check,
  2 bounded-view checks, 2 label checks.
- Baseline falsification: the 11 reviewer-flow pins run against `8d4a03956` fail 9 of 11; the two that pass pin
  unchanged behaviour. The baseline accepts "94 records were returned and none pre-existed" with no lookup.
  Log: `output/evidence-sufficiency-0928/baseline-red.log`.
- Focused regression around the changed seams: 22 files, 739 tests, 738 pass, 1 skip that predates this change,
  0 fail. Logs `focused-1.log` to `focused-3.log`.
- Fixture homes are isolated. The isolation sentinel was not performed because the live daemon was writing.
- This is not the full release suite and not installed-app acceptance.

## Limits

- The reviewer can still name a result it did not use, or omit one it did. The host checks what is named against
  what was inspected; it does not read the reviewer's reasoning.
- A filtered query counts as exhaustive for its criterion. Whether the criterion matches the claim is the
  reviewer's judgement.
- An unattested acceptance is recorded and delivered. It is not yet shown on the desktop or mobile card.
- The bounded view still chooses which fields to show by spread and cost. On a calendar-shaped list under a
  4,000-character budget it showed only the end time. The view now says so; it does not yet choose better.
- Whether the owner's configured reviewer writes the `NEEDS ALL OF` line is a live question. When it does not, each
  such review costs one follow-up call.

## Measured in the recorded runs, not yet changed

From a read-only trace of both acceptance runs (`output/evidence-sufficiency-0928/prep-trace.md`):

| Candidate | Measured cost | Why it is not in this change |
| --- | --- | --- |
| Model round after a plain rejection | 7.0 s, 36,766 uncached prompt tokens; the host replaces the reply with a fixed sentence | Whether a later turn depends on that round's history is not established |
| Refusal on attendee format | One brain round: 7.4 s, 54,330 prompt tokens | The provider schema contradicts itself; rewriting the model's arguments would change the approved bytes |
| Narrowed tool surface after a denied optional read | About 7.2 s and two cache misses | The narrowing exists to stop loops after real failures |
| One precheck request per approval batch | 8 of 9 reviewer calls, about 10,000 prompt tokens, 4 to 7 s | A real check; needs per-member attribution and a planted-conflict test first |

Assumption provenance before an approval (inferred year, default duration) is the next correctness change and is
not part of this one.

## Owed

Installed-app acceptance on the live home with named controlled fixtures: served identity, a read whose result is
larger than its view with a statement about what is absent, a prepared group declined with zero effects, and the
recorded coverage on each verdict. Then the full suite and journeys on a frozen tree, integration with main, and
release qualification. No tag exists for this wave.
