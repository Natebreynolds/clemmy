# Planned tools, learned writes, and release qualification — September 28

## Verified source changes

Built on `312e95e2d` in the owned `codex/release-journey-0928` worktree.
Main's owner edits and the installed app are unchanged during these checks.

- Failed business reads use the existing bounded repair allowance. Two distinct
  Salesforce query errors no longer terminate merely because both project to
  the same known-terminal consequence. Writes, reconciliation, authority
  changes, and retry ceilings retain their existing rules.
- A thrown catalog invocation records a nominal execution failure, while still
  showing the actual diagnostic to the brain.
- Completion review records the provider-reported model ID. A response from
  `glm-5.3` cannot qualify a pin requesting `glm-5.2`. The selected setting is
  preserved and the receipt records the mismatch; fallback is not enabled.
  Invalid verdicts also retain the observed responder without claiming that
  a review completed.
- A carried planning control may share its frame with its exact dependency-root
  read. Invalid carriers and write siblings remain refused.
- Expected-work admission and tool wrappers reopen the exact host binding for
  effect classification. Reclassifying an already-attested read from a generic
  transport name must not convert it back into an unknown mutation.
- Planned provider calls retain their sealed capability selection when another
  current manifest names the same operation. Risk projection reopens the exact
  selected manifest instead of requiring global operation/account uniqueness.
  Native local-envelope admission stays separate. Fresh schema/account/port
  checks and changed-definition refusals remain in place.
- Read and unique-workflow nominations survive a deferred `call_tool` carrier.
  The old history matcher recognized only direct `plan_task` calls, so a prose
  stop could consume a turn without executing the nominated operation. Exact
  call/result pairing and the existing one-continuation budget are preserved.
- Verified write learning validates the host-root digest and frozen catalog
  digest in their respective domains. Comparing those different digests had
  rejected genuine planned writes. It also uses the authenticated binding to
  connect the normalized callable name to the exact provider operation ID.
  Learning remains advisory and does not authorize the next invocation.
- Ordinary warm turns keep the full planning schema deferred, as cold turns
  already did. A remembered tool must not add thousands of planning-schema
  tokens. Explicit act and surfaces lacking discovery doors still expose it.

## Checks and evidence

Artifacts are under `output/release-blockers-0928/` in the release worktree.

- `read-repair-green.log`: 93 governor/projection tests passed.
- `catalog-failure-green.log`: 42 failure-settlement/repair tests passed.
- `judge-identity-green.log`: 113 judge tests passed.
- `planned-effect-safety.log`: 150 effect, grant, and admission tests passed.
- `expanded-safety-final.log`: 396 tests passed, including the host loop,
  selected risk, write learning, indexed freshness, and exact catalog dispatch.
- `balanced.log`: the generated ordinary-channel stop corpus passes all four
  capability-order rotations. It uses the production Composio wrapper with a
  recording raw provider, current account reviewer, and recording completion
  reviewer. Reads and reversible creates complete; irreversible effects stop
  for approval; a post-dispatch connection loss remains uncertain.
- `balanced-plan.log`: all eight explicit Plan/Execute tests pass, including
  reopen and no duplicate saves. The older balanced fixture in that particular
  run failed; its subsequent corrected run is `balanced.log`.
- `journeys-two.log`: the natural cold, warm, and bounded-collection journey
  passes. Cold uses four brain frames; warm uses three, no discovery call, one
  read and one create. The deterministic recording-cache budget is <=70% of
  cold uncached input. This is not a provider-billed production speed claim.
- `judge-final.log`: 38 reviewer/fallback checks passed, including an invalid
  verdict from a provider-reported model different from the requested pin.
- `final-journey-pins.log`: six natural-task and exact-risk checks passed,
  including altered account/operation/capability/source/binding negatives.
- `deferred-continuation-green.log`: 11 continuation checks passed. The carried
  plan journey and a separate pure pin both failed before the history fix.
- Typecheck passed in `typecheck-final.log`, including the final continuation
  edit.
- The serialized broad journey run finished: 175 passed, 26 failed, 201 total.
  Two failing contracts subsequently pass in the focused runs above (exact
  risk selection and the plan-surface continuation). The remaining groups are
  ordinary-conversation zero-tool routing, provider-neutral local/external plan
  fixtures, and the cold natural-request byte ledger. These are unresolved
  release gates, not a green journey run or a blanket pre-existing waiver.
  A separate unchanged-main run at `312e95e2d` reproduces all 23 ordinary-chat
  and provider-neutral plan failures (`remaining-journeys-head.log`). Last-tag
  attribution and repair are still owed; no release waiver is implied.

Do not add these overlapping test counts together.

## Fixture corrections and traps

The old balanced fixture assumed a first-class planning schema before discovery,
omitted the account-review wire, and used a stub gateway without the real
physical-dispatch bookkeeping. Its random operation names need an explicit
recording effect-model answer; otherwise an unavailable Jev fixture makes all
unknown names conservatively write-shaped. Its provider definition must use
the same invoke-port identity as discovery. None of these fixture repairs
changes live accounts or manufactures live approval.

The natural journey's reviewer mock originally intercepted standing-memory
scope review and asserted that it was a completion prompt. That assertion can
send Node into expensive source rendering. The fixture now distinguishes those
lanes. Missing review is never counted as a positive verdict.

Advertised schemas are intentionally append-only for cache stability. After
plan activation, a retained schema does not imply the control is executable.
The long-task check now proves the settled plan remains present and the schema
prefix remains stable. Existing host-loop tests prove retired tools cannot run.

Large results may stay below compaction thresholds because durable handles keep
them out of the prompt. Requiring a condenser event in that case is incorrect.
The journey retains every raw byte, exact member bindings and crossing counts,
and enforces the existing context ceiling. Forced compaction/restart needs its
own checks. Its deliberately unavailable large-task reviewer remains explicitly
unreviewed; this is not acceptance of a successful large-task review.

## Still owed

1. Final typecheck, exact-candidate broad unit gate and serialized journeys.
   Do not call the old aggregate journey debt green. The current serialized
   run and each named failure must be retained and attributed.
2. Build after the commit, coordinated Terminal hotpatch, and verification of
   the served source fingerprint and both web trees.
3. Live-home Salesforce read repair, requested/served judge identity, real
   workflow author/enable/execute, approval correction, continuation and no
   replay. Use the matched existing prompts and canonical token accounting.
4. Jev responsiveness on an idle installed candidate. Existing traces contain
   both fast decisions and timeouts; no deadline was increased in this wave.
5. Signed package/upgrade qualification before a release tag. A runtime-only
   patch does not repair the bundle's complete resource signature.

Rechecked installed state: `312e95e2d`, fingerprint
`0c03c031b6b90756053b546047a07f609d3b7965b530c11af39bd9ee10a4384c`.
DeepSeek V4.1 Flash remains brain/worker/memory; judge is selected GLM5.2;
Jev1.13.0 is enabled and configured. No model setting was changed in this wave.
