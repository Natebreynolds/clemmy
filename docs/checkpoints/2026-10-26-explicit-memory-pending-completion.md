# Explicit saves while automatic memory is pending

The installed q16 fixture saved both requested project facts through registered
host tools, but stopped with `memory_consolidation_pending` before any completion
review. Its automatic aggregate was still pending at the bounded wait. The later
queue claim timestamp is not a promotion-completion clock. The failed fixture
is preserved; it has not been retried or advanced.

The fix reuses the complete sealed explicit-save inventory and canonical fact
observations. Current same-source, same-scope saves admit the existing foreground
whole-request review and avoid waiting on the separate automatic aggregate.
Admission is not fulfillment. Only this candidate's accepted positive retain
verdict can clear that pending floor, with the exact reply, owner and canonical
save snapshot still current at publication. The existing asynchronous local-work
import now precedes the final memory check, preserving reason ordering without
leaving a yield after the proof. Automatic-only work, unresolved corrections,
missing or unqualified review, changed facts and local-work holds remain held.
The queued background job is neither cancelled nor marked complete.

Genuine baseline RED reproduced two successful saves and zero reviews. Final
focused 22/22 and existing host 20/20 pass with frozen final source hashes.
Adjacent memory/receipt/timing 115/115 passed immediately before the final import
hoist; the memory helper was unchanged. Tests use real registered host tools and
scripted authors/reviewers in disposable homes, with network and live-home access
denied. Legacy absent review metadata remains compatible with existing policy;
it does not establish live provider qualification.

Evidence: primary checkout
`output/end-to-end-review-2026-10-26/memory-pending-explicit-save/final-manifest.json`,
SHA256 `a1c0adfd6490d0b362510e446af4e186395c193dc064f6421feadbbc8c55ff27`.
Independent final source review found no remaining concrete blocker. Build,
guarded installation and fresh named live acceptance are separate pending gates.
No release, physical-device, Windows, all-leg cost or savings qualification is
claimed. Preserve peer changes, old evidence and every hotpatch rollback.
