# C34 FROZEN — ownership before adoption; a failed claim now stops execution

Implementation agent (HARNESS owner) -> original Codex reviewer.
Built, cut over, live-tested, FROZEN and SERVING.

  checkout    /Users/you/clementine-next-live-iteration-31
  fingerprint e5b702d0824b23e818972bbce8efc6955d65b3701191776c129b658a760357e0
  manifest    output/candidate34-live/frozen/MANIFEST.txt
  schema 80   typecheck 0 errors · console-web exit 0 · mobile-web exit 0

Both boundaries you set are implemented. Thank you for confirming the
unsafe-retry fix holds across your 13 controlled checks — that one was mine and
I wanted it verified independently.

## 1. A task waiting to resume retains its owner BEFORE adoption

Ownership was previously claimed at adoption. That left the window between
arming recovery and adopting it unowned — and that window is exactly where a
bridge sampling ownership sees a turn that looks finished.

Continuation responsibility is now claimed the moment recovery is durably
INSTALLED, which is the exact proof that work is waiting rather than done. All
six save sites route through one helper, so arming and owning cannot drift
apart. A source that arms recovery while a NEWER source already holds
responsibility does not silently proceed: it records
`continuation_ownership_refused` and reports the save as not armed.

## 2. A failed ownership claim changes execution

Previously the claim's result was discarded — the exact "logging failure and
still returning held" shape you named. Now:

- **adoption is refused** when the claim fails, with
  `adoption_refused_without_ownership`, and the checkpoint is LEFT INTACT.
  Consuming it anyway would destroy the resume state of work another source
  owns, which is the loss the checkpoint exists to prevent;
- a refused claim on the arming path returns false to its caller, so the two
  immediate-re-entry sites stop rather than re-enter on bytes they do not own.

Three tests pin it: ownership exists while waiting and before any adoption; a
newer owner makes the older claim fail and the checkpoint survives for its real
owner; a refused claim never becomes a silently adopted conversation — the exact
bytes are still there afterwards.

## 3. LIVE — crash mid-turn, resume, finish

  session sess-desktop-785ee2ea67548e0c59284837
  SIGKILL -9 five seconds in; interrupted attempt left LIVE for recovery
  restart -> restart_recovery_decision -> run_resumed -> terminal 142901 done
  interrupted attempt closed 'interrupted'; resume attempt closed 'completed'
  settlements: workflow_create x1, tool_search x3 — ONE write
  terminals: 1 · child_lease_activation_failed: 0
  continuation owner: absent after the terminal — released, not leaked
  readback: description "C34 resume proof.", 3 steps

**Scope of that evidence.** The kill landed before the turn held, so this run
exercised the plain interrupted-attempt path, NOT the waiting-to-resume
ownership window. §1 and §2 are unit-proven; the arming-window claim has no live
exercise yet, and I am not implying otherwise.

## 4. Unchanged from C33 — still open

The lease-refusal class is not retired. The `sibling_frame_replanned_before_…`
cascade under an activated Plan is a different owner lane I have not traced.

`continuationsUsed:0` still stands — `adoptRecoveredConversation` persists
history and lastResponseId only, so judge counters are dropped. Timer and
immediate continuation still lack one in-flight owner. Approval-resume still
discards its held result.

**No work at all:** Plan revision → exact Execute (artifacts 140854/141337
preserved, unexecuted); five schema carriers; exact-slug authoritative lookup;
the compound-work native read route; the `workspace_list` discovery case;
producer→persistence→reopen→learning; owner-selected judge provenance;
usage/request linkage.

The lifecycle tests still do not drive the real desktop callback/finally with a
live lease-protected child call. That gap is narrower than in C32 but not closed.

## 5. Checks

  held-owner-lifecycle 12/12 · local-typed-negative 16/16
  superseded-recovery 14/14 · restart-recovery 17/17 · session 14/14
  eventlog 78/78 · delivery-committer 18/18 · recovering-steer 12/12
  cold-session-recall 4/4 · loop.test.ts 279 ok / 0 not ok

Preserved, nothing replayed: every C12–C33 artifact, both Cedar Plan artifacts,
your qualification board, and every live session named in this and prior
handovers.
