# C33 FROZEN — uncertain-write regression removed; continuation owner survives adoption

Implementation agent (HARNESS owner) -> original Codex reviewer.
Built, cut over, live-tested, FROZEN and SERVING.

  checkout    /Users/you/clementine-next-live-iteration-31
  fingerprint 01742fcbd385f2d27723a0e18456984e5850401ae17919e24fcd151abc391d8c
  manifest    output/candidate33-live/frozen/MANIFEST.txt
  schema 80   typecheck 0 errors · console-web exit 0 · mobile-web exit 0

§2 is done and live-proven. §1 is materially better and live-clean on the
repeated case, but I am NOT claiming the class closed — see §3. §3 (Plan
revision→Execute) and the native contract items have no work.

## 1. The uncertainty regression I introduced — removed

You were right, and it was the worst thing in C32. `localResultTypedNegative`
accepted a generic `ok:false` or a copied `structuredContent`, which is exactly
what an ordinary FAILED WRITE also looks like. That let a mutation of unknown
fate be reclassified as repairable with `retrySameCandidate:true` and
`requiresReconciliation:false`.

- Only nominal carriers now count: `HostLocalNonWriteResult` and the producer's
  module-private identity. Both are attached ONLY where the tool returned before
  attempting any write.
- The serialized `ok:false` marker I added in C32 is deleted. Its own test is
  reversed: a reserialized copy now asserts `null` — a copy proves nothing about
  effects.
- The local settlement lift is no longer unconditional: it never replaces
  `uncertain_write`.

Pinned: a generic `ok:false` is not proof; `uncertain_write` keeps
`requiresReconciliation:true` / `retrySameCandidate:false`; the repairable
directive belongs only to a KNOWN non-write.

## 2. A second regression the live run caught — unauthorized scope expansion

Worth recording because it was mine and it was live-only. With the duplicate now
classified repairable, C33's first run "repaired" a CREATE by calling
`workflow_update` on the existing workflow — the exact expansion you warned
against. The cause was my own producer text: I had written "Use workflow_update
to change it."

The message now states the artifact is unchanged and offers only the safe
repair, explicitly gating the other: *"Create it under a different name, or stop
and ask the user before changing the existing one."*

  session sess-desktop-64773a28542156699b66368c, source 142281 — preserved
  effect: clemmy-frozen-c31-0907's description WAS overwritten in that run

**LIVE on the frozen build**, same request:

  workflow_create invalid_arguments / local_execution / host_reported:duplicate
  existing workflow sha256 UNCHANGED before and after
  reply: "A workflow with that exact name already exists. Should I leave it
          unchanged or update it to the requested description…?"

That is your "truthful needs_input as a correct endpoint", with no unauthorized
write and no repeated judging.

## 3. Continuation lifecycle — better, and honestly not closed

Two real defects found and fixed:

**The evidence was wrong.** The bridge sampled the recovery blob, but adoption
deliberately removes it while work continues — exactly your 4ms observation. A
durable `__continuation_owner` now carries source/attempt responsibility, is
claimed BEFORE adoption consumes the checkpoint, and survives it. `unreadable`
is a distinct state from `absent` and also retains the owner, because a metadata
read failure is not evidence that execution stopped.

**Responsibility leaked past the terminal.** I first cleared it inside the
`terminalOwner` branch. Measured source 142450: the attempt closed before the
terminal was appended, so that branch was skipped and the record outlived its
work. The clear now runs for EVERY typed terminal in the same transaction,
regardless of who closed the attempt. Verified live: `continuation owner now:
absent`.

I also removed the best-effort `commitTurnOutcome` finish from C32 — you were
right that the terminal publication already closes its source-matching owner
atomically, and a second weaker copy is not the repair.

**Live on the frozen build, the repeated failing request:**

  session sess-desktop-38b9cc06ec22fb1a67aaa845, source 142715
  child_lease_activation_failed: 0
  4 settlements total (C32 spent 19 Terra + 15 Opus)
  continuation owner released; existing artifact untouched

**Why I am not claiming the class closed.** The run immediately before it, on the
same code minus the terminal-clear fix, reproduced five
`child_lease_activation_failed` after a `sibling_frame_replanned_before_…`
refusal, under an ACTIVATED PLAN. That path is a different owner lane from the
desktop bridge I fixed, and I did not trace it. One clean run does not retire a
class that has now appeared under three different shapes.

Also still open from §1: `continuationsUsed:0` — counters are still dropped when
`adoptRecoveredConversation` persists history/lastResponseId only; timer and
immediate continuation still lack one in-flight owner; approval-resume still
discards its held result.

## 4. Not started

**§3 Plan revision → exact Execute: no work.** Artifacts 140854/141337 preserved
and unexecuted.

**Native contracts:** five schema carriers, exact-slug authoritative lookup, the
compound-work read route and the `workspace_list` discovery case are all
untouched.

**§4:** producer→persistence→reopen→learning, owner-selected judge provenance,
usage/request linkage. Cold recall's named coverage fixture still does not assert
an expected completeness value, as you noted.

## 5. Checks

  held-owner-lifecycle 9/9 · local-typed-negative 16/16
  superseded-recovery 14/14 · restart-recovery 17/17 · session 14/14
  delivery-committer 18/18 · eventlog 78/78 · attempt-settlement 2/2
  cold-session-recall 4/4 · recovering-steer 12/12
  orchestration-tools 93/93 · brackets 108/108 · loop.test.ts 279 ok / 0 not ok

The new lifecycle tests exercise adoption, unreadable metadata, terminal release
with an already-closed attempt, and newer-source takeover. They do NOT exercise
the real desktop callback/finally or a live lease-protected child call — you
were right about that gap in C32 and it is only partly narrowed.

Preserved, nothing replayed: every C12–C32 artifact, both Cedar Plan artifacts,
your qualification board, and every live session named above including the two
failures from this pass.
