# Approval chain continuity and search — September 28

Base: codex/meeting-analysis-save at 7463564e5, the installed duplicate-notification fix. Framework only. Main and other worktrees left untouched.

## Implemented

Approval resume now records the delivery control source and the original execution source in a system run_resumed event after exact parked-state/card validation and resolution. Publication reopens that durable relation, validates the same session, exact control/card/decision and resolved card, and uses the execution source for captured review policy, accepted objective, completion verdict, plan and artifact verification. Public delivery identity remains the control source. Reply/objective/artifact validation remains mandatory. A changed reply or unrelated/untrusted resume marker cannot inherit a review. The verdict reference exposes the reviewed source sequence. No historical rows are rewritten.

History search now passes the already-loaded lightweight session snapshot to transcript reconstruction, including workflow members. Previously it fetched full session state for each row and scanned the entire full session table again for every workflow searched. This fixes an omitted snapshot argument; it does not change which public text matches a query or introduce a result cap before filtering.

## Verification

29 session API checks, 36 delivery/recovery checks and 74 integration/projection checks passed. The latter exercise actual host resume, carrier writes, exact grants, amended arguments, uncertain writes and existing learned-delivery floors. A real resume test proves the durable review source is recorded, not merely accepted by the consumer. New pins run against pre-fix runtime fail: full-session reloads, missing original review/policy and incorrect owner-disabled reporting.

Logs: /tmp/clem-search-fix.log, /tmp/clem-resume-review-fix.log, /tmp/clem-chain-integration.log, /tmp/clem-chain-red.log.

## Still owed — do not claim the whole approval chain fixed

Unnecessary DM setup approval remains. Current definition-level learning asks whether ANY accepted input can deliver or irreversibly change things. The actual no-creation lookup is narrower. A safe exact-call refinement must bind current definition, account, complete effective arguments and a two-model semantic verdict, invalidate on any change, preserve an already-raised card's authority across resume, and retain send/delete/admin floors. Do not add a Slack-name exception, lower the existing confidence cutoff or grant future sends based on an earlier lookup.

Installed acceptance is still owed for this candidate: verify served build fingerprint, one bounded chat-history search, controlled approval resume with review on/off, exact one provider lookup and no external send, captured policy and verdict linked to original work. Existing personal Slack approvals must remain untouched. No claim of live speed improvement or tag readiness yet.
