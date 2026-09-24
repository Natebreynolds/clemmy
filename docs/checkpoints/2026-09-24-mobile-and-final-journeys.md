# Mobile acceptance and final journey repairs — September 24

Release remains held. No main merge, push, or tag has been made in this wave.
The installed candidate at inspection was 5f347326, fingerprint
67ca4668e5387121864bc3b55e7e04b84b234af66786518d8b7d35d8d028c523.

## Live mobile evidence

Sources 297575, 297596 and 297658 in the same mobile session completed in
1.6, 24.7 and 43.4 seconds respectively: greeting, today's calendar, and declining
the Darrin meeting from the immediately preceding calendar answer. All had one
delivered terminal; no open attempts remained. Both calendar tasks had passing,
reply-bound Opus 5.5 verdicts. The decline crossed once and the retained fresh
calendar response excluded its exact event ID (three remaining events).
The requested time was “at 9”; Clem selected the previously discussed 9:30 huddle.

DeepSeek V4.1 Flash was the route on all three turns. The decline ledger also
records one Opus call under brain, so do not claim a pure DeepSeek benchmark.
Total uncached inputs across roles were 5,071 / 63,169 / 73,516. Reviewer use
is included, not hidden. Raw receipts and canonical measurements are private
ignored output under output/mobile-acceptance-2026-09-24/.

The calendar read reused the learned operation without discovery. Its first
retained-result projection supplied fields as a JSON-encoded array, which the
comma parser misread. Clem recovered with another retained-result read and a
corrected projection. The canonical repairCalls counter did not count this
class of diagnostic, so its zero is not proof of zero recovery overhead.
The greeting's intentional review skip is incorrectly projected as
`enabled_unavailable`; this metadata issue is recorded, not fixed in this wave.

## Narrow runtime correction

`normalizeFieldsInput` accepts a nonempty JSON array of nonempty strings in the
existing string carrier, as well as the prior array and comma-separated forms.
Invalid JSON, empty encoded arrays and mixed arrays cannot silently broaden the
selection to every field. The regression exercises actual retained-result
projection, verifies the requested fields, and excludes an unrequested field.
No new prompt, routing gate, or provider-specific decision is added.

## Journey contracts

The first focused group passed 41/41 checks with the app stopped and the isolated
runner on Node 22.22.0. This is not an exact final release-commit full-suite pass.
Evidence: /private/tmp/clem-final-verified-wave.log.

- Deferred planning is discovered through tool_search, then the real plan freezes
  the same exact local capability. The prefix remains stable. Other admission
  fixtures preserve their initial schema surface while keeping their actual
  plan, exact binding, write, wrong-target, partial-failure and replay assertions.
- Cold foreground read distinguishes an advertised generic carrier from granted
  capability authority: its factory remains empty until discovery. Pagination,
  settlements and terminal checks remain intact.
- The two-operation admission fixture searches the exact three operations it
  needs (create/write/readback). A create-only search no longer promises to
  disclose sibling operations. This is a known-operation admission test, not
  proof of cold natural-language discovery quality. Cold/warm schema presence
  stays consistent with each initial planning card.

Broader authority/native fixture migration remains unaccepted. Its latest
patch is preserved in ignored output/release-candidate-5f347326/
final-authority-fixtures-in-progress.patch; those two files were restored to
HEAD before building. The provider-neutral diagnostic reached 52/56 passing,
with native Workspace create and workflow create/update still invoking actual
native bodies instead of the old recording transport. Replacing or mutating
agent.tools entries did not reach the turn-owned dispatch closure. Do not
change production routing merely to satisfy the old mock. Workspace fixture
arguments also lack its required view. The balanced ordinary-channel fixture
now reaches real discovery with a recording source/account reviewer, but its
seeded catalog identity disagrees with the subsequently resolved operation;
the required read is refused as missing a frozen work binding. This is not
accepted or classified as a production regression without further attribution.
Other native skill/discovery fixtures need real JIT acquisition rather than
assuming every schema is advertised.

Nine long-task tests passed (26.2 seconds), including four concurrent 100ms
reads under 180ms p95, same-resource writes serialized, scoped worker authority,
84-step compaction, and >8MB retained-result recovery after process restart.
Only the deferred planning schema expectation changed; execution, evidence,
and timing assertions remain. Log: /private/tmp/clem-long-final.log.

The large-catalog fixture passed 6/6 (Node 22.22.0, diagnostic single-file
`--experimental-test-isolation=none` inside the normal isolated runner). This
includes 10,000 distractors, bounded retrieval, restart disclosure recovery,
and selected-definition/account drift. A later request now receives explicit
source-bound disclosure before its first card; global registry residency is
not treated as current-request disclosure. Log: /private/tmp/clem-progressive-final.log.

The 10,001-partition recurring-workflow fixture passed in 291.1 seconds. Its
recording reviewer transport is now installed in both parent and restart child;
the real workflow review runner/parser processes the verdict. The pilot and
scheduled workflow each require one review, satisfied goals, and no failed-open
workflow verdict. Pilot consent, separate recurrence consent, schedule enable,
three source pages, fresh process, 10,001 activations, bounded windows, retry,
and occurrence/authority replay assertions remain intact. This is recording
provider coverage, not a paid model/live-home run. The initial inert foreground
proposal still records an unavailable completion review and is not reviewer
acceptance. Log: /private/tmp/clem-partition-final.log.

The prior full suite passed 17,193 with six skipped, but the prior complete
journey gate had 51 failures and two cancellations. That gate is not superseded
by focused successes. Finish the remaining named failures, then run final
exact-commit full suite, journeys, typecheck, build, packaging and upgrade checks,
and installed-app acceptance. Preserve the user's main-worktree edits.

Windows signing secrets remain absent. An asynchronous owner choice is pending:
signed Mac first versus holding for both platforms. Do not add [mac-only] or
publish until that release-scope choice is resolved and the required gates pass.

## Verification before the candidate rebuild

Typecheck passed. The retained-field regression was run against the original
runtime file: exactly the new JSON-encoded-array case failed (23/24 passed).
Restoring the fix passed 24/24 under the canonical isolated runner. Logs:
/private/tmp/clem-fields-regression-red.log and
/private/tmp/clem-fields-regression-green.log. The live query fix is the only
production runtime change in this wave; remaining tracked edits are fixture
repairs and this checkpoint. No release readiness or new installed fingerprint
is implied until the rebuild and live checks complete.
