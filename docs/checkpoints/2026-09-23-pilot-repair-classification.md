# Pilot contract repair classification — 2026-09-23

## Live failure

Installed 6fdc2703d, source292990: preview refusals at293050 and293075 were
classified as execution:unknown_read. The control call consequently named no
repair capability; recovery admitted retained-output readers only. A later
pilot request with corrected evidence paths was refused at293092 before its
arguments could reach normal validation. The host reprompt rebuilt context,
then Together returned402. This recovery defect is separate from provider
billing; a zero balance has not been established. The user reports credits.

## Candidate

Preserve typed preview issue codes from the read-pilot control plane as a
repairableArguments marker. Only dataset-contract, Workspace-binding-contract,
and tool-kernel-binding representation failures qualify; arbitrary provider
messages, missing capabilities, stale proposals and unknown outcomes do not.
The chat tool emits existing invalidArgumentsTextResult for those failures.
No governor permissions, mutation authority, consent or retry bounds change.
The existing invalid-argument recovery can now name the failed operation and
revalidate a repaired request normally instead of confining it to old evidence.

Regression: original approved documentation inventory fixture requires the
invalid-arguments marker for its invalid preview, no dispatch, then the same
valid pilot follows existing review/execution/replay assertions. Red observed
false versus true before fix. Focused pilot/bridge35 and recovery/projection72
checks passed. Typecheck and the final pilot-file rerun passed.

## Owed

Commit/build, coordinated Terminal hotpatch and installed-app
live acceptance. No new paid call, no business workflow changes, no tag.
Source7f829641d diagnostics candidate was built but is not installed. Keep the
full section6 release scope open. Do not count diagnostic fixtures as live
acceptance or Together billing verification.
