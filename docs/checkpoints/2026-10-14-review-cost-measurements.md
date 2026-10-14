# Completion review cost, measured on the live home (2026-10-12 → 10-14)

Scope: 59 chat turns with a completion review in the last 48 hours, read from
`goal_alignment_judged` (kind `completion`) in the live harness database.
Fixture turns included; owner turns dominate.

## Findings

- Reviews per turn: 1 in 35 turns, 2 in 19, 3 in 4, 4 in 1. Forty percent of
  turns pay for two or more reviews.
- First verdict `fulfills: false` in 36 of 59 turns. When false, `repairScope`
  was `claims` 27 times, unscoped 17, `reply_format` 2.
- Review wait (time from the last model or tool event to the verdict):
  read turns median 17.8 s, p90 25 s (first review) and 36 s (second);
  write turns median 24 s, p90 36 s.
- Review depth: `fast` 52, `full` 25, none 12. The fast lane on read turns is
  a second-model review (effort medium), not the local check.
- The local check (`jevAttempt`) accepted 8 of 43 attempts; 35 came back
  `accepted: false, coverageComplete: false`.

## Three timelines

| turn | work done at | review 1 | revise | review 2 | wall |
|---|---|---|---|---|---|
| one-line browser question (read) | 12 s | 20.5 s, false, claims | 2.6 s | 12.9 s, true | 48 s |
| arithmetic + status question (read) | 52 s | 18 s, false, claims | 1.7 s | 20.6 s | 92 s |
| owner follow-up, three shell reads | 55 s | 43.7 s, false, claims | 7.6 s | 51.7 s, true | 158 s |

The first review's `claims` objections were wording precision ("live
credentials" where the evidence said "credentials available"; a trailing
question that broke a one-line format). Each cost a full second review.

## What this points at (not built; the review path has an owner)

- A read turn whose only finding is `claims` pays two second-model reviews.
  The revised draft could ship with the chip saying it was revised per review,
  or the existing claim-removal path could apply on the first round for reads.
- The local check almost never vouches (`coverageComplete: false`); until it
  does, "reads get the local check only" is in practice "reads get the fast
  second-model review", twice when claims are found.
