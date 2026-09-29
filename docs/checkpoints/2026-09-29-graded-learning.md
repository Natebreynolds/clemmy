# Graded learning — 2026-09-29

Branch `claude/graded-learning`, worktree `~/clem-worktrees/graded-learning`, on top of release candidate
`ba20f5756`. Framework only. Not installed.

## Owner direction

2026-09-29, asked what a harness that learns with its user should do next, and shown this proposal: "Sounds
perfect let's do it". Agreed order: grade and provenance first, then the owner's approval as confirmation, then a
live test of both; promotion on repetition and the Memory view after that.

## Why

Learning what finished work resolved was all or nothing. Live 2026-09-29, on two builds, the naming check chose
the right name at 0.72 against a bar of 0.80 and the whole resolution was discarded. The question it was asked
was written for an approval card ("an approval card shows this value"), which was not true of the case.

## Change

1. **A kept resolution carries a grade and what the grade rests on.**

   | Naming check | Owner approved the call, having been shown the value | Kept as |
   | --- | --- | --- |
   | sure (0.80 or more) | either | confirmed, by the naming check |
   | leans (0.50 to 0.80) | yes | confirmed, by the owner's approval |
   | leans (0.50 to 0.80) | no | a lead |
   | under 0.50, none, or no answer | either | nothing |

   A lead is worded as one ("not confirmed … Look it up again before using it"), trusted at 0.5 against 0.8, and
   never replaces a confirmed resolution for the same name and argument. A confirmed resolution replaces a lead
   and replaces an earlier confirmed value.
2. **The naming check is asked its own question**, about what the request's words called the value, beside the
   request. It returns the name with its confidence and applies no bar. The bar for confirmed is the bar a card's
   name is shown on, unchanged.
3. **An approval confirms a name only beside a check that already leans to it.** The owner approved a call, not
   a sentence about what its value is called. When the check does not lean, an approval is not looked for.
4. **What was considered and not kept is recorded with its reason**, never its value, and the record is written
   even when nothing was kept.

## How "the owner approved this call" is decided

No record says which approval released which call in the chat lane. The answer is put together from records that
each stand on their own, and every part must hold:

- the host's resume marker names this request as the work an approval released, validated by the function
  publication already uses;
- the approval was given by a person (`approvalDecidedByPerson`, the first place that classifies who resolved an
  approval; it fails closed on a surface it does not know);
- the approval's own frozen tool and arguments produce the call's contract digest, and no other call of the
  request shares it;
- the call settled after the decision;
- the card that was shown carried the value, whole and not withheld.

Checked read-only against five controlled approvals in the live record: each approval's contract matched exactly
one settled call of its request.

An approval changed before it was given confirms nothing: in this lane the changed call is a new call.

## Verification

- `tsc --noEmit` clean.
- `resolved-reference-learning.test.ts` 14 of 14, `approved-call-evidence.test.ts` 4 of 4 (one case that must
  confirm in three forms, fourteen that must not), router test for the new question.
- Surrounding files (delivery committer, approval registry): 80 tests, 0 fail.
- Not the full suite, not installed, not observed live.

## Limits

- Whether the new question makes the router sure where the card's question left it at 0.72 is not known. It can
  only be measured live.
- The grade lives in the memory's wording, its trust level and the learning event. The fact table has no field
  for it, so the Memory view cannot yet show a grade without reading the wording.
- Who resolved an approval is recognised by the name the surface wrote. A new surface confirms nothing until it
  is added to the one classifier.
- A value that reached the call through a pending-action record, a workflow or a staged transfer is not
  recognised as approved. Those lanes keep their own links and are not read here.
- Promotion of a lead by repetition is not built. A lead seen twice is still a lead.

## Owed

Full suite on a frozen tree, installation on the owner's word, and a live pair: a request that names something,
resolves it from a record and needs approval; then a second request that names the same thing and is given
nothing else.
