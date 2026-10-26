# Memory capture and retained-request compatibility

The controlled q11 memory request saved all four facts, but also saved the
instructions to preserve existing memory, confirm the save, and avoid unrelated
work. Its original source and canonical record were inspected; no existing
memory was edited or cleaned up.

The existing literal-aware suffix parser now excludes a contiguous, fully
recognized save-operation suffix. It keeps every requested fact, the exact
source span and project scope, and the complete original source episode. Quoted
text, named or conditional restrictions, later facts, and lasting procedures
remain part of the claim when the boundary is ambiguous. Explicit claims still
require complete retention. No additional model, reviewer, store, or retry is
introduced.

Changing extraction without preserving its producer would invalidate old frozen
candidate identities. The existing source-session context now retains a memory
capture edition alongside its question-tool edition. Historical missing fields
mean legacy extraction only after validating the original stored bytes and
digest. Fresh requests select the new extraction; helper requests inherit their
validated parent. Unknown editions fail. No historical identity, candidate,
origin, decision, fact or receipt is migrated. Both capture replay and receipt
verification use that retained edition, including the narrower completion gate.

Validation before installation:

- Genuine q11/ordinary-suffix and procedure regressions preceded the parser fix.
- 200 memory and receipt tests pass, including all 33 new suffix cases.
- 29 source-context tests pass, including 13 edition/recovery cases.
- A separate process using actual source `0ad07d8ad` created old accepted
  requests, contexts, queue rows, controlled canonical outcomes and a genuine
  old completion receipt. The current reader initially failed four of nine
  checks: old saved/pending evidence disappeared, and a coherently rewritten
  new-prefix candidate was wrongly accepted for an old request. Those checks
  now pass without changing the historical stored rows.
- The portable regression uses the same explicit legacy extraction and immutable
  historical context shape. It also verifies that replay reuses the original
  candidate and episode. Actual prior-producer evidence remains separately
  retained under `output/memory-task-suffix/extractor-compatibility/` in the
  primary checkout; no output-only helper is required for routine tests.
- Final compatibility checks pass 10/10 in portable mode and 10/10 with the
  actual previous producer, with no skipped cases or changed source inputs.

These are isolated source/storage checks, not model semantic or installed-app
acceptance. The new candidate still needs a clean build, guarded Mac hotpatch,
and one fresh named memory fixture. The communicated Claude merge boundary
remains `cc30bc481`; newer question work has correct delivered output but an
unqualified review. No release, push, tag, physical-device, Windows, exact
provider identity, cost or savings claim follows from these checks.
