# Native multi-operation discovery — candidate, not installed

Live pilot authoring had to rediscover individual native operations. The catalog shortcut used find(), collapsing multiple explicitly named allowed native tools to the first result. Existing multi-operation coverage exercised external candidates only.

Candidate collects all exact allowed native identities and reserves the single-schema shortcut for singleton matches. Multiple matches use the existing result/schema path. Native exact selections still avoid provider discovery. Policy filtering stays before selection; no new execution authority or model/provider routing rule.

The new two-native-operation pin fails against a4deec372 (space_get returned, workflow_get missing) and passes with the change. A separate pin verifies that naming a denied operation cannot disclose it. Nearby own-catalog and callable-refusal suites: 23/23 pass. No paid models or provider execution. Logs /tmp/clem-native-multi-{red,green,targeted,regressions}.log.

The existing multiple exact provider identities parser test also failed in the first two full-file runs: APIFY identities returned [] because registration was absent in the disposable environment. This is an observed unresolved test failure, not attributed to the last tag; no blanket pre-existing/pass claim. The noisy-provider-result test passed. Native-only targeted run deliberately excludes the provider cases and cannot qualify them.

Installed source remains a4deec372. Native desktop notification check 3 passed immediate click, exact Inbox selection with visible body, and read acknowledgement; receipts under output/harness-acceptance/2026-09-23-notification-click/. No delayed/quit-state notification claim.

Still owed for this candidate: final typecheck, broader mixed native/provider discovery review, installed-app live acceptance with exact source/terminal and token measurements, and full release gates. No build, hotpatch, commit, tag or push in this continuation. Test runner live-home sentinel was NOT PERFORMED while daemon owns the home; isolated tests are not live acceptance.

## Follow-up: mixed request and complete focused suite

Provider parsing fixture now explicitly provisions Apify in a newly created disposable home before dynamic imports. Production parser unchanged; no substitution of the tested provider. The full parser test passes, including duplicate/lowercase names and reviewed-CLI exclusion. The earlier failure is explained by missing declared namespace state, not waived as pre-existing.

A mixed native/provider pin also failed before the next repair: a native match skipped provider sources and collapsed the result. The existing named-operation detector now prevents that short circuit when the requested operation is outside the native catalog. After discovery, singleton collapse requires exactly one match across both sources. The test verifies one provider search and both named results. This does not establish every possible mixed-language discovery form.

Final focused run:28/28 pass (multiple-exact, own-catalog-rank, callable-refusal), no skips. Both native multi-name and mixed-source tests failed before their corresponding fixes. Logs copied to output/harness-acceptance/2026-09-23-native-multi-discovery/. Isolated checks remain diagnostic, not installed-app acceptance. Source edits remain uncommitted; installed app still a4deec372. No paid calls, hotpatch, tag or push.

Final TypeScript check passed (exit0); git diff --check passed. Live acceptance, package/build identity and full release qualification are still owed.

## Provider outage review

A new negative pin showed that a native hit suppressed the missing-provider hint despite a timed_out receipt. Hint selection now distinguishes an independently requested operation outside the native catalog, so the remaining native result is not presented as its substitute. Red pin failed on the prior candidate; final four-file run passed30/30, no skips, including deferred-page outage persistence. Logs clem-native-outage-red.log and clem-native-discovery-final.log copied to the evidence folder. No paid calls.

Pre-build installed identity rechecked: a4deec372, daemon14595, source30152fe76a41. Command-center active/runningRuns/backgroundActive all0, runningWorkflows2; this alone is not clearance to restart. Full suite deferred while active video workload uses camera/audio/CPU. Native click remains accepted on installed shell; discovery candidate still requires build, installation and live proof. Commit only these two tool files and this checkpoint; main/owner UI edits remain untouched.
