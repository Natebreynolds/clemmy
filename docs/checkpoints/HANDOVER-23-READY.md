# C32 FROZEN — held-owner lifecycle, native outcome carriers, cold recall frontier

Implementation agent (HARNESS owner) -> original Codex reviewer.
Built, cut over, live-tested, FROZEN and SERVING. The live window is yours.

  checkout    /Users/nathan.reynolds/clementine-next-live-iteration-31
  fingerprint ef053030321f83f98a418119f1ba8e185d33c19136256458b7662d80aa32523d
  manifest    output/candidate32-live/frozen/MANIFEST.txt  (per-file sha256)
  schema 80   typecheck 0 errors · console-web exit 0 · mobile-web exit 0

Three of your four numbered items moved. Plan revision→Execute (§3) is NOT
started. Both corrections you recorded are accepted; the second one led
somewhere I would not have found without it.

## 1. THE DECISIVE FAILURE — a held turn no longer finishes its own owner

Your chronology was exact. `console-routes.ts` started its status at `completed`,
the callback returned only `{text, sessionId}` so runConversation's `hold` never
reached the caller, and the `finally` finished the attempt at 02:41:24.777 while
its own scheduled recovery ran on. Every later child lease named that finished
attempt, `isDispatchLeaseCurrent` correctly refused all fifteen, and the owner
was asked to retype a request whose board never changed.

The lease guard is untouched — it was right. What changed is the premature
finish it exposed:

- the bridge now reads `result.hold` and asks the session whether the DURABLE
  recovery sidecar names this exact activation (`recoveryOwnedByActivation`);
- if it does, the attempt is left LIVE and a
  `attempt_retained_for_recovery_owner` diagnostic is recorded;
- positive evidence only — no sidecar, unreadable metadata or a different owner
  all answer false, so nothing can claim "held with recovery armed" without an
  actual owner and checkpoint.

Something must then close it, and the only honest moment is the one you named:
`commitTurnOutcome` finishes the attempt when its exact source publishes a typed
terminal. Idempotent by construction — the UPDATE carries `finished_at IS NULL`,
so an attempt another owner already closed keeps the status that owner set.

**LIVE, your decisive journey** — ordinary same-session Space read → targeted
edit → readback, on a NEW test-owned board (yours is preserved untouched):

  session sess-desktop-3a9e4297cec9091a95740db9, source 141531
  space_get x1, space_get_view x2, space_edit_view x1 — ONE write
  child_lease_activation_failed: 0        (was 15)
  attempt closed normally, status completed
  terminal: done — not a request to retype
  readback: Northwind Ready | Southgate READY | Eastvale Ready
    Southgate was Blocked; the other two rows are untouched; one view revision kept

Fixture bounds missed and NOT patched: 6 searches (bound 5), 11 calls (bound 10),
114s. One `workspace_list` settled `policy_denial/refused_pre_dispatch` — the
model reached for the local workspace lister when it wanted Spaces, which is a
native-discovery observation for §2, not a lifecycle failure.

## 2. Native outcome carriers — your correction, and where it actually led

You were right that the duplicate fix never reached the producer. Fixing that
honestly took three live iterations, and the first two failed:

1. `orchestration-tools.ts:1171` now returns a typed non-write, not plain text.
   Live: STILL `unknown / execution_failed, mutating=1`.
2. Added a serializable `structuredContent` marker beside the nominal WeakMap.
   Live: STILL unchanged.
3. Root cause found at `local-runtime-tools.ts:114`: the local bridge FLATTENS
   every local result to text, and wraps `isError` into
   `HostLocalExecutionFailureResult`. Both markers were destroyed before the
   settlement ever saw the value — and my own `isError:true` was what turned it
   into an execution failure.

`HostLocalNonWriteResult` now carries the outcome across that boundary, as the
same nominal-carrier pattern as its failure sibling. The classifier honours a
typed non-write ahead of the generic MCP flag and ahead of prose inference,
because a tool stating its outcome in a field outranks anything inferred from
the bytes around it.

**LIVE on the frozen build**, the real producer path:

  workflow_create  invalid_arguments / local_execution
                   evidence=structured  detail=host_reported:duplicate

That is your probe's `typed_hypothetical` expectation, now reached by the actual
MCP shape. The behaviour changed with it — before: "I kept coming back to the
same saved checkpoint and it would not reopen… Nothing was sent or changed."
After: "'clemmy-frozen-c31-0907' already exists with a different description.
Should I update that existing workflow to 'Duplicate probe.'?" The existing
workflow was not modified.

Two honest notes on that run: `mutating` is still 1 on those rows (it records
the attempt's intent, not an effect — the effect columns are 0), and ONE
`child_lease_activation_failed` appeared later in its repair loop, so that class
is reduced, not eliminated.

## 3. Cold recall — frontier and fixtures corrected

Your two corrections were both real. The assistant fixture used
`awaiting_user_input` carrying loose text, which `pullRecentTurnsForSessions`
does not project — so it indexed the QUESTION and silently dropped the ANSWER,
usually the thing recall is looking for. Conversations are now built through
`beginRunAttempt` / `recordRunAttemptUserInput` / `commitTurnOutcome`, and the
assertion matches text that appears ONLY in the assistant turn.

The 128-public-event frontier is carried forward: a search that names terms
sweeps until it has covered the observed range or spent a bounded sweep budget.
A target past the first pass was not merely queued behind the backlog — it was
never queued at all, so relevance ordering alone could not have reached it. With
no terms this is exactly one pass, unchanged.

The test now uses 111 conversations, places the target past the frontier, and
DISCRIMINATES: neutralise prioritisation and sweeps and it fails 3/1; restore
them and it passes 4/4. Principal isolation and coverage honesty are asserted.

## 4. Not done — plainly

**§3 Plan revision → exact Execute: NOT STARTED.** No work at all. Sources
140735/141289 and artifacts 140854/141337 remain preserved and unexecuted.

**§1 remainder:** judge/no-progress counters are still lost on continue-checkpoint
adoption (`adoptRecoveredConversation` persists history and lastResponseId only),
so `continuationsUsed:0` will still be reported. One exact activation owner for
timer and immediate continuation is not implemented; the overlapping-entry hazard
you traced at 5190-5191 stands. The stale/finished-owner refusal is not surfaced
as a structured orchestration condition — the fix removes its main cause rather
than reporting it.

**§2 remainder:** five schema carriers unaudited, exact-slug authoritative lookup
untouched (L06 fuzzy promotion stands), supported native read route for compound
work still undesigned. Space create latency undiagnosed.

**§4 remainder:** producer→persistence→reopen→learning still unproven, receipt
tests remain hand-built, usage/request linkage and RecordedVerdict owner-selection
not done.

## 5. Checks

  local-typed-negative 13/13 · held-owner-lifecycle 4/4 (new)
  cold-session-recall 4/4 (discriminating) · recovering-steer 12/12
  superseded-recovery 14/14 · restart-recovery 17/17 · session 14/14
  delivery-committer 18/18 · attempt-settlement 2/2
  completion-review-policy 13/13 · same-provider-review 12/12
  orchestration-tools 93/93 · brackets 108/108 · loop.test.ts 279 ok / 0 not ok

Preserved, nothing replayed: every C12–C31 artifact, the R03 edit session, both
Cedar Plan artifacts, your qualification board, and every live session named
here.
