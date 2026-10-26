# Refresh an unpublished memory answer after its save settles

The installed q13 fixture retained all four requested facts, but its answer
still described the save as pending. Its last memory read finished at
10:27:53.294Z, the canonical fact was created at 10:28:04.229Z, and the terminal
followed 222 ms later. No memory-consolidation wait event was emitted. The
retained evidence therefore does not establish a pending-to-saved transition
inside that wait. The later answer review timed out and remains unqualified.

Two actual-host regressions reproduce the problem: the same accepted candidate
can settle during answer generation or during the existing bounded wait, yet
the host publishes the draft written against the pending notice. The tests use
real accepted attempts, source contexts, candidate promotion, and canonical
receipts, with controlled resolvers and no provider or network access.

The existing memory notice now carries the status that selected its text. Only
an ordinary request that actually received the queued notice retains a local
owner binding. If the same source and objective have verified retained memory
by completion, the host holds that unpublished draft and uses its existing
next-step directive to provide the fresh evidence and full useful draft. The
next request receives the current saved notice; no second save, readback,
reviewer verdict, retry budget, store, or model route is introduced.

The directive remains bound to the source, attempt, objective, and accepted
owner instructions. Newly adopted steering discards that stale memory prefix
while preserving unrelated continuation guidance. Questions, plans, writer or
format replacement requests, recovered frames, and deferred reviews cannot
borrow the ordinary request's observation. Existing model limits and review
qualification remain authoritative. Storage evidence is not proof that the
whole compound request is complete.

Validation receipts are retained in the primary checkout under
`output/end-to-end-review-2026-10-26/memory-settlement-timing/`. The corrected
owned-attempt baseline has two intended failures and two passing controls on
pristine `d845972b4`; the final seven cases pass with the patch. They cover both
save timings, already-saved and still-pending controls, the existing turn limit,
steering during the wait, and whole-objective rejection when a refreshed answer
omits an independent result. The steering case preserves the existing
`memory_correction_unverified` stop for an amended memory objective; it does not
grant a positive completion. Adjacent memory tests pass 96/96, and 34 selected
existing host regressions pass. No source inputs changed during those runs.

The communicated Claude merge boundary remains `cc30bc481`. This source fix
does not qualify the previous timed-out review or the newer branch tip for
release. A clean build, exact guarded Mac installation, and a fresh named live
fixture remain separate evidence. No push, tag, publication, native-device,
Windows, provider-quality, cost, or savings claim follows from source tests.
