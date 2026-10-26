# Interrupted hotpatch recovery — October 26

The guarded install of candidate `1246a9416c523bc837d27466c30fa68145e2a319`
stopped when the process guard reported the application running before mobile
replacement. No contemporaneous process inventory was retained, so the cause
of that observation is not established. The daemon,
builtin skills and console replacements had retained backups; mobile bytes
already matched the candidate. The failed transaction has no successful
installation receipt. Independent current-byte observations do not change that.

The existing current-state recovery mechanism now supports a separate bounded
`interruptionHistory` input. This takes the exact original ordinary receipt
chain and a nonempty prefix of interrupted backups in daemon, skills, console,
mobile order. It requires genuine same-generation updater evidence (version 1),
not relabelled mixed-generation evidence. Existing version-2 pristine recovery
and normal repeat installation retain their original admission rules.

The shared signed-reference/ordered-history reader verifies every original
rollback. Each interrupted backup must match the latest genuine receipt. Every
current root must match an independently rebuilt clean source; any untouched
suffix must also match the latest genuine receipt. Only the exact validated
rollback paths are excluded from the immutable signed-reference comparison.
Nested recovery and anchored histories are outside this new variant.

Capture is read-only evidence, not installation authority. Closed-app admission
repeats the proof and creates a private capability. A durable genesis and the
existing per-root journal remain required before replacement. Only a new fully
verified four-root transaction can write a completion receipt. Future repeats
must revalidate the original history pins, interrupted backups and untouched
suffix provenance. No old success receipt is reconstructed and no backups are
deleted. Process, updater, signature, native-byte, mode, alias, source and staging
checks remain in place.

Independent review also found that future recovery repeats under version-1
applied-update evidence lacked the closing process check already present in
current-state admission. A real replacement-helper regression reproduced two
renames before the later refusal. Recovery repeats now use the existing final
applied-update observation and process check before returning staging authority.

Evidence is retained under
`output/end-to-end-review-2026-10-26/question-connection-bundle/hotpatch/` in
`recovery-tests/` (independent original v1/new-input RED) and
`interruption-implementation/` (portable RED/GREEN and adjacent validation).
The tests use private synthetic bundles, actual replacement helpers and clean
Git source, with platform signature/process checks controlled at their existing
test boundaries. Node 24 runs deny network and live-home reads. They do not
qualify the actual application signature, current install admission, runtime,
live task semantics, or successful recovery. Those require separate evidence
from the authorized lifecycle owner.
