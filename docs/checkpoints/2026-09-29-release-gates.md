# Release gates: no compiled-in operations — 2026-09-29

Branch `claude/release-gates-0928`, worktree `~/clem-worktrees/release-gates-0928`, on top of
`claude/first-frame-readiness` (`d479ab503`). Framework only.

## Owner direction

2026-09-28, in reply to the provider-pin ratchet failure: "there should never be any hard coded operations in the
code like that. So needs a clean up and framework direction."

## What failed and why

Both failures were introduced by the 16-commit wave that was hotpatched before this work began. They fail on
`8d4a03956` and pass on main `5df6c757e`.

| Check | Cause |
| --- | --- |
| `project-plan-ir.test.ts`, manifest growth | `meeting_search`, `meeting_read` and `view_image` were declared project-eligible to reach the chat planning surface |
| `no-hardcoded-provider-pins.test.ts`, new file | `integrations/composio/approval-destination-label.ts` named four Slack operations |
| `no-hardcoded-provider-pins.test.ts`, growth (hidden behind the one above) | `integrations/composio/operation-semantics.ts` gained a Slack operation: 13 literals against a ceiling of 11 |

## Change

1. **The three readers keep their place on the planning surface through `localPlanningRead`.** That declaration
   exists for exactly this. Eligibility for durable projects needs its own replay and realm review, which has
   not happened, so they are not in that manifest.
2. **An approval names a returned value by what it was made from.** Some values a card shows were returned by an
   operation, and the record that carries them names nothing. `producedFromIdentifier` goes one step back through
   the call that returned the value: same account, provider envelope clean, the value returned and not passed
   in, and every such call given the same single identifier. Naming that identifier is the existing question
   over the existing records. No operation, provider or field name is read. The Slack-specific join is deleted.
3. **No table of operation names lowers consent.** The compiled-in declaration for opening a conversation is
   removed, with its schema guard. What an operation does is learned from its definition and the exact call, by
   two models that must agree (`learned-operation-delivery.ts`, unchanged).

## Behaviour that changes, and the cost

- Opening a conversation by a person's id is carded again until the learner is sure of it. On 2026-09-28 the
  learner was not sure for that call (delivery probability 0.15 against a bar of 0.10), which is why the table
  entry had been added. The card is the conservative outcome; the meaningless-card complaint it answered is open
  again.
- A card for a send to an opened conversation is named through the general path, which asks the router once. The
  deleted join asked no model and added the words "DM with". The name and the account remain.

## Proposed framework direction for the open complaint — not built

Learn what an operation does from what it did. After the owner has approved a call and it has settled, the
provider's own result is evidence the definition alone does not give: whether anything was delivered to anyone.
The two models that already judge a definition would be given that settled result for the same exact definition
and arguments, and a verdict would be written only when both agree, bound to the definition and schema digest, as
today. It would lower a card only for that exact definition, only from the next accepted request, and never for
an operation with a destructive, administrative or outbound floor.

This changes when the owner is asked for consent. It needs the owner's decision before it is built.

## Verification

- `tsc --noEmit` clean.
- `no-hardcoded-provider-pins.test.ts` and `project-plan-ir.test.ts` pass.
- New pins: the produced-from relation with invented operations for two unrelated kinds of thing, ten inexact
  relations that must name nothing, and a consent pin that an unlearned preparation call is carded.
- Focused regression over consent, approval and label tests: 42 files, 1,180 tests, 1,179 pass, 1 skip, 0 fail.
- Full suite and installed-app acceptance are recorded in `output/release-gates-0928/`.

## Still compiled in

The ratchet's baseline lists 85 files that named provider operations before 2026-09-02. They are unchanged here.
The ratchet only lets those counts fall. Bringing them to zero is a separate, larger piece of work.
