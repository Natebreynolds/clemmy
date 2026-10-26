# Memory completion and learned recovery correlation — 2026-10-26

Base: `0e3e65e7bc2fe1a4782f171b09ded4006ae78dc7` on
`codex/memory-completion-refinement`. Preserve Claude's UI ownership and the
token meter. This is framework work; no personal or business data repair.

## Behavior

- A retained correction grant for target A does not satisfy a later structured
  finding that target B remains unresolved. The completion hold survives
  reopening; A's exact prewrite grant remains usable. A fresh completion
  assessment must cover all bound targets. An assessment rejected by storage
  or coverage validation cannot fall back to an older partial proof.
- Optional strategy learning correlates a refused call with a later successful
  call using the same accepted source, canonical argument contract and complete
  capability/account/effect identity. An unrelated successful use of the same
  tool cannot clear the refusal. Unavailable evidence produces `not_proven`.
  No-refusal runs avoid the correlation scan.
- Execution, dispatch authority, approval, and ordinary changed-argument
  recovery are unchanged. Coarse spreadsheet/resource identity is not used as
  exact target proof for learning.

## Validation before installation

All 122 distinct tests passed with network access denied, fresh isolated homes,
and live-home reads denied: 24 memory-obligation, 44 adjacent fact-correction and
durable-intake, 32 strategy/refusal-projection, and 22 settlement-reconciliation
tests. Original failures and final source hashes are retained under the primary
checkout's `output/end-to-end-review-2026-10-26/` in
`memory-mixed-obligation/` and `strategy-correlation/`.

Independent read-only reviews found no remaining source blocker in these
changes. Production builds, installation and live acceptance are separate
qualifications; see subsequent coordination evidence rather than treating these
tests as live acceptance.

## Limits and next work

- Existing host review phase is trusted current-review authority. This change
  does not introduce a cryptographic review ID or stale serialized completion
  replay protection. Missing/failed-open assessment fallback remains a separate
  confirmed follow-up.
- Changed arguments require stronger complete work/target proof before teaching
  a recovery route. They remain usable by ordinary execution recovery.
- The learning guard's empty-result distinction is source-reviewed; a dedicated
  behavioral test of that exact branch was not added. Existing settlement tests
  distinguish read-empty and write outcomes; the new fixtures use `succeeded`.
- Queued-message POST failure recovery still needs a real hook/browser regression
  covering one retained message, Plan mode, accepted-then-stream failure, Stop,
  and reset/unmount before implementation. No queue/UI code changed here.
- Owner-notification/send correlation, nullable provider validation provenance,
  and recovery-only file observations remain separate reviewed gaps.
- No push, tag, publication, iOS build, Windows acceptance, or savings claim is
  implied. Native and live behavior require exact installed-source attribution.
