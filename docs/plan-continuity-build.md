# Plan Continuity Build Spec (Phase 2)

**Status:** built in the local working tree. 2026-05-30. Builds on the
live-proven Phase 1 (clarify-first; see conversational-autonomy-build.md).
Plan continuity defaults on, with `CLEMMY_PLAN_CONTINUITY=off` as the escape
hatch.

## The owner's model (their words, synthesized)
"When Clementine presents a plan, the subsequent message must be validated against
the plan. If it's not an answer to the plan, she's smart enough to say 'these don't
seem like answers to this — did you want to work on something else?' The plan is the
unit of continuity, carried in MEMORY — so session lifetime stops mattering: sessions
compact and roll over, and if the user comes back later ('can we get back on this?'),
Clementine pulls the open plan from memory even in a brand-new session."

## Root cause (verified in code)
plan-first.ts:350 — when a drafted plan has `needsUserInput`, it emits an
`awaiting_user_input` event and RETURNS **without** calling `surfacePlan`. So the
plan that ASKS a question is the one plan never persisted. The user's answer arrives
as a fresh orchestrator turn (agent_context_packet.inputPreview = just the answer
text) with no memory of the plan → re-derives → re-asks. The no-questions branch
(plan-first.ts:365) DOES surfacePlan + persist → works.

## What already exists (do NOT rebuild)
- `PlanProposal` persisted at `~/.clementine-next/state/plan-proposals/<id>.json`,
  survives sessions. `status: 'pending' | 'approved' | 'rejected' | 'superseded'`.
- `surfacePlan(input)`, `getPlanProposal(id)`, `listPlanProposals({status,sessionId})`,
  `approvePlanProposal`, `rejectPlanProposal`, `supersedePlanProposal` (plan-proposals.ts).
- `PlanProposal` carries `originatingRequest`, `plan` (incl. `needsUserInput`),
  `sessionId`, `channel`.
- `runPlanFirstPreflight` already does draft → surfacePlan → approve → execute when
  needsUserInput is empty (plan-first.ts:365-385).
- `listPlanProposals` filters by sessionId but ALSO supports listing all pending —
  we can query by channel via the proposal's `channel` field.

## Build (flag `CLEMMY_PLAN_CONTINUITY`, default on)

### 1. Persist the asking plan (plan-first.ts:350 branch)
When `plan.needsUserInput.length > 0` AND continuity is enabled: persist an
asking-plan via `surfaceAskingPlan({...})` so a durable pending PlanProposal
exists, carrying the questions (they're in `plan.needsUserInput`). Keep
emitting `awaiting_user_input` for the chat surface, but include the new
`planProposalId` in its data. Flag off → unchanged legacy behavior.

### 2. Detect an open plan on the next message (discord-harness.ts, before plan-first)
In `runDiscordHarnessConversation`, before the normal plan-first/orchestrator routing:
when flag on, query `listPlanProposals({ status: 'pending', channel: 'discord:<id>' })`
(add a `channel` filter to ListPlanProposalsFilter — currently only sessionId). Take
the most recent pending proposal whose `plan.needsUserInput` is non-empty = "open
question plan." If none, proceed as today.

### 3. Classify the message against the open plan (NEW: plan-continuity.ts)
Model-judged (owner picked "smart"). A small classifier call: given the open plan
(objective + the questions asked) + the new message, return one of:
- `answers` — the message answers the open questions (provide the extracted answers).
- `new_topic` — unrelated; the user moved on.
- `resume` — explicitly returning to the plan ("can we get back on this", "let's
  continue the deals thing").
- `abandon` — user says drop it / never mind.
Schema: `{ kind: 'answers'|'new_topic'|'resume'|'abandon', answers?: string,
confidence: number, reason: string }`. Keep the call tiny (cheap model, low tokens);
it only fires when a pending question-plan exists.

### 4. Route on the classification
- **answers / resume(+answers)**: re-enter plan-first with the ORIGINAL request +
  folded-in answers (extend `runPlanFirstPreflight` to accept `priorAnswers?: string`
  → append to the planner prompt: "The user answered the open questions: <answers>.
  Produce a now-COMPLETE plan with needsUserInput EMPTY."). Mark the old proposal
  `superseded`. Re-draft → surfacePlan (no questions now) → one approval → execute.
  This is the loop the owner wants. Apply safe-default rule
  (feedback_defaults_and_workflow_leadin: new sheet unless told otherwise) so the
  re-draft fills any still-open slot rather than re-asking.
- **new_topic**: Clem says "those don't seem like answers to <the closed-deals plan> —
  want me to set that aside and work on this instead? (the plan stays saved, just
  reply 'resume deals' anytime)". Leave the proposal pending. Then handle the new
  message normally.
- **abandon**: `rejectPlanProposal` / `supersedePlanProposal`; acknowledge; proceed.
- **resume** (no fresh answers, just "let's get back on it"): re-surface the open
  plan's questions ("picking back up on <objective> — I still need: <questions>").

### 5. Cross-session resume (session lifetime stops mattering)
Because the proposal is on disk keyed by channel, Step 2's `listPlanProposals` query
works even after the session went stale and a NEW session was created. So a "can we
get back on this?" in a brand-new session still finds the pending plan. No special
session-resurrection needed — the plan IS the continuity. (Optionally surface it
proactively: when a new session starts and a pending question-plan exists for the
channel, Clem can note "you have an open plan: <objective> — want to continue it?")

## Verification
- Unit: classifier prompt builder + the routing decision (pure where possible).
  Plan-continuity classification of: the exact "Last week, Google sheet, closed won
  only" against the deals plan → `answers`; "actually can you check my email" →
  `new_topic`; "let's get back to the deals thing" → `resume`; "never mind" → `abandon`.
- Flag-off byte-identical (no proposal persisted in the has-questions branch; no
  classification; today's behavior).
- Live test (flag on, hot-patch): (a) vague deals ask → plan + questions [proven];
  (b) answer all three → she proceeds with a COMPLETE plan + ONE approval, NO re-ask
  (defaults new sheet); (c) instead of answering, send "check my email" → she notices
  + offers to switch, plan stays saved; (d) later/new session "get back on the deals
  plan" → she resumes from the saved plan.
- Full suite green. Owner blesses before flag-on default.

## Rollback
Flag `CLEMMY_PLAN_CONTINUITY=off` → has-questions branch doesn't persist a proposal,
no classification, bare orchestrator handles the next message (today's behavior).

## Risk watch
- Classifier false-positive (calls a real answer `new_topic`): bias toward `answers`
  when the message plausibly maps to the questions; only `new_topic` on a clear pivot.
- Stale pending plans piling up: supersede on resolve; consider a TTL/reaper later
  (out of scope for this build — note it).
- Don't double-fire with Phase 1's ambiguity branch: if a pending question-plan
  exists, Step 2 routing takes precedence over a fresh shouldUsePlanFirst evaluation.
