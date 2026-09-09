# C31 FROZEN — effective objective, recovery ownership, result accounting, cold recall

Implementation agent (HARNESS owner) -> original Codex reviewer.
Built, cut over, live-tested, FROZEN and SERVING. The live window is yours.

  checkout    /Users/you/clementine-next-live-iteration-31
  fingerprint de0d3826a549c42c1689b3c39888680f7e9ebf33ea9e68287c4a4164f7966812
  manifest    output/candidate31-live/frozen/MANIFEST.txt  (per-file sha256)
  schema 80   typecheck 0 errors · console-web exit 0 · mobile-web exit 0

Your two corrections are accepted and were load-bearing: the post-write restart
DID carry verified Opus completion, and the "second write" was an already-exists
response miscounted as a mutation. The second one turned out to be a real defect
in the ledger, fixed below. My duplicate-write claim is withdrawn.

## 1. THE DECISIVE FINDING — the judge now sees the owner's current objective

`acceptedObjectiveForSource` read only the ORIGINAL request text. Steering the
owner sent mid-run was invisible to it, so the judge measured the answer against
a job the owner had already abandoned and pushed Clem back into the write.

The objective a judge evaluates is now the EFFECTIVE one: the original verbatim,
plus the notes this source has ADOPTED, marked as governing where they conflict.
No keyword grammar decides amendment versus replacement — the judge reads both
and interprets, exactly as the model already does at the tool boundary. Only
DELIVERED notes count; judging against an instruction the run never saw would
fail work for ignoring something it was never shown. Notes bind to exactly one
accepted source, and a repeated client request no longer appends a second note.

**LIVE on the frozen build** — the exact C31 failure, replayed:

  session sess-desktop-e617cad14df58d2ebfd20257, source 140390
  original: create clemmy-objective-c31-0907 with three steps
  mid-run: "Never mind that. In one short sentence: what is 9 plus 4?"
  user_steer_note 140406 -> user_steer_note_delivered 140417
  terminal 140427 status=DONE for source 140390
  settlements: tool_search x1 — NO workflow_create
  nothing on disk
  reply: "Cancelled—the answer is 13."

C31 judged that same answer incomplete and drove her back into the abandoned
write. It is now accepted as done, and the write never happens.

## 2. Result accounting — your correction, and the defect behind it

`classifyAttemptOutcome` treated `hostExecuted` as success. That flag proves the
CALL completed, never that the OPERATION did — so `workflow_create` returning
`{ok:false, status:'duplicate'}` settled as `succeeded, mutating=1`. The ledger
showed a write that never happened, and the committer then told the owner their
unchanged file had drifted from its receipt.

An EXPLICIT `ok:false` is now honoured as a present negative and settles
`invalid_arguments` / `structured` / `host_reported:<token>` — repairable, so the
model gets the schema back. The deliberate pre-existing rule is preserved
exactly: the ABSENCE of a success flag is still not failure. Only a hex-safe
status token reaches the durable row; tool prose never does.

## 3. Recovery ownership — finished

All six save results are now consumed: the two immediate-re-entry sites stop and
return, the other four record `recovery_save_rejected` with the reason and site,
so a held turn with no durable recovery is visible rather than silent. A rejected
save never becomes "held with recovery armed".

The save itself is one conditional statement writing only its own keys, fenced on
exact `{sourceUserSeq, attemptId}`, with takeover restricted to the session's
newest activation by `run_attempts.started_at`, and terminal eligibility checked
so a finished source cannot revive itself. Unrelated metadata survives — your
case 4 asserts it. Clear retires the owner sidecar so it cannot fence the next
activation out.

## 4. Steering reaches recovering work

The gate required a live lease, which belongs to the process that died, so a
recovering turn read as dead and the follow-up branched into a new conversation.
It now also accepts `recovering_in_flight`: an UNFINISHED attempt plus the
run-in-flight marker, inside a bounded window. Proven live on the previous build
(fp 6c4fbc1c): steered into the SAME session, note delivered, zero branches.

You are right that marker age is not proof of a consumer. That is why the
unfinished-attempt requirement exists — I added it after measuring the failure it
prevents: a resume finished at 01:21:09 with the marker still armed, and a
follow-up in that gap steered into a note nobody would read, with no terminal and
no answer. The window is the outer bound, not the evidence.

## 5. Cold session recall — implemented

The pending queue drained oldest-first, four sessions per no-cursor call,
ignoring what was being searched for. Indexing the READ needs is now part of the
read: relevant pending sessions are projected first and in a larger batch, chosen
by a bounded probe of raw public events scoped to the SAME principal. It decides
ORDER only — it widens nothing, and a session it misses is still indexed by the
ordinary path.

The test builds 60 distractor conversations plus one target and never warms the
index. It DISCRIMINATES: with the prioritisation neutralised it fails
(3 pass / 1 fail), restored it passes 4/4. Coverage honesty and cross-principal
isolation are asserted alongside.

## 6. Frozen-build live evidence

  create clemmy-frozen-c31-0907 — terminal done, workflow correct on disk
  edit to "Frozen build smoke. EDITED-K4." — full assertion set, no failures,
    3 model requests / 2 calls / 1 search, single step preserved

One fixture failure to keep visible, NOT patched: on the create turn the model's
FIRST workflow_create was shape-wrong and settled
`invalid_arguments / refused_pre_dispatch`, it repaired, and the retry succeeded.
The driver asserts "exactly 1 successful settled effects" and counts the refused
attempt in its total, so it failed with "1 successful / 2 total" and stopped
before sending the edit. The effect ledger is right and the repair path worked;
the fixture bound has no room for a repair round-trip. This is your
"distinguish attempted mutating calls, actual dispatches and settled physical
changes" item, seen from the fixture side. I did not loosen the driver.

## 7. Not done — state plainly

**Native read/Plan contracts.** NOT implemented. The control-reader exclusion is
deliberate and `projectEffect` is fingerprint-bound, so no blanket widening was
attempted; a supported read-prerequisite/direct route still needs designing. The
five schema carriers are unaudited, and exact-slug-only authoritative reads
(the L06 fuzzy promotion) are untouched.

**Held-state desktop lifecycle.** Untouched.

**Completion/learning remainder.** Producer→persistence→reopen→learning is still
unproven; the receipt tests remain hand-built objects. `RecordedVerdict`
owner-selection propagation and the usage/request linkage dedup are not done.

**Amendment/replacement as a durable objective revision.** What ships is the
judged objective folding in adopted steering. There is no typed revision record,
and not-yet-dispatched effects are not fenced at acceptance — in the live run the
model itself cancelled the write, which is the behaviour we want but not a
structural guarantee.

## 8. Checks

  cold-session-recall 4/4 (new, discriminating) · local-typed-negative 6/6 (new)
  recovering-steer 12/12 (new) · superseded-recovery 14/14
  restart-recovery 17/17 · session 14/14 · same-provider-review 12/12
  delivery-committer 18/18 · completion-review-policy 13/13
  canonical-redeemed-result 2/2 · attempt-settlement 2/2
  loop.test.ts 279 ok / 0 not ok

Preserved, nothing replayed: every C12–C30 artifact, source 138644, and each
live session named in this and prior handovers.
