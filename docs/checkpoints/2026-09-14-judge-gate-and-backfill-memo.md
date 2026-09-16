# Judge-gate restore and per-turn backfill memo (slices 0 and 1)

Working tree at this checkpoint: the uncommitted 2026-09-14 discovery/model wave
(26 files, see `2026-09-14-workflow-default-discovery.md`) plus the two slices
below. Installed app under test: 3.18.7 (`7c757e29`) at
`~/Applications/Clementine.app`, home `~/.clementine-next`, port 8520.

## Slice 0: an action turn with attempted, unsettled work is judged again

The wave stopped `sourceWorkAttempted` from arming the completion judge on its
own, so a status-only lookup no longer waits ~29 s for a cross-family review.
Verified by direct probe before this slice: an ACTION turn that attempted a
write, settled nothing, and replied "All set on the Sheets side." / "That is
taken care of." / "Looks like it went through." ended unjudged. Only replies
matching the artifact wording ("updated", "created", a URL) were still caught.

Full-suite run of the wave then showed the narrowing also broke five existing
contracts (repair verdicts, inspection-once, warm read, continuation ownership,
checkpoint recovery), all reproducing without any slice-0 change. Reconciled
rule: attempted work is review-eligible when the turn is an action OR a business
call was attempted; the only exemption is a non-action turn whose calls were all
host control/status tools. `mcp_status` joins the host control set so the live
status-only lookup takes the cheap path. Kept from the wave: the honest
follow-up answer is not judged a second time, the `claimedCompletedWork` arm,
and the curly-apostrophe promise fix. Pins: `completion-verification-gate.test.ts`
(five probe replies, lookup and settled-write controls), `objective-judge.test.ts`,
`host-completion-contract.test.ts` (original eligibility list restored).

## Slice 1: the per-turn re-learning backfill stops re-paying not_proven rows

Measured 2026-09-09 (memory `project_turn_start_event_loop_stall_0909`): every
accepted turn re-entered `learnVerifiedWriteCapabilitiesForAcceptedTask` for up
to 64 recent terminal writes because the memo recorded only learned/replayed
rows; ~4.1 s per turn, growing with history, near zero on turn 1. File unchanged
since 08-30.

`backfillRecentVerifiedWriteCapabilities` now memoizes not_proven rows with a
15-minute recheck cadence (a not_proven row only changes when its catalog
identity later resolves) and bounds one turn to 16 learning calls; rows arrive
newest-first and the remainder is picked up by the following turns. The
function returns `{ scanned, learned }`. Pins:
`verified-write-capability-learning.test.ts` (cadence helper; bounded
first turn, remainder next turn, zero afterwards, recheck after cadence, a
learned row never re-learned via the injected learner).

## Hotpatch script

`scripts/hotpatch-daemon.mjs` hardcoded `/Applications/Clementine.app`; the
running install is `~/Applications/Clementine.app` (3.18.7) while
`/Applications` holds a root-owned 3.18.6. The script now patches the newest
existing bundle (`CLEMENTINE_APP_PATH` overrides) and its running-app check
matches either location. Pin in `hotpatch-daemon.test.mjs`.

## Verification

tsc clean. Full suite on the final tree: 16,160 tests, 16,157 pass, 0 fail,
3 skipped. Hotpatched into `~/Applications/Clementine.app` at ~22:20 PDT
(source fingerprint `9af7f06c…`, dirty build on `7c757e29`); prior daemon
retained at `daemon/dist.backup-hl8FvM`. Nothing committed.

Pre-patch baseline from the owner's own 18:53 PDT turn ("how did my team do
with activity today", installed 3.18.7): 11.2 s from input to first model
prompt (2.3 s to route, 7.0 s route-to-turn-start, 1.9 s memory primer),
tool_search 48.8 s, turn total 78.9 s. The trivial turn before it ("whats
6 + 7"): 2.5 s pre-model, 5.0 s total. Measurement queries live in the
session scratchpad (`measure.sql`, `measure-tools.sql`) against a copy of
`state/harness.db`; never query the live file.

## Live test for the owner (after hotpatch)

One desktop chat, four turns: "hi" / "what did we ship this week?" / "pull my
open Salesforce opportunities and put them in a sheet" (approve the plan) /
"thanks, that's all". Read turn-start timing on turns 2-4 versus the same
shape on 3.18.7, the judge verdict row on turn 3, and confirm identical tool
and memory hits.

## Live invite test (21:18 PDT, mobile, patched build): two defects

Owner: "Add time on [the invitee]'s calendar tomorrow at 9am for 1 hour to discuss
Clementine" → Clem asked invite-vs-delegated → owner answered "Scorpion cal" →
approval card → approved → event created with NO attendee → reply "Added … to
your Scorpion calendar" → judge (grok-4.6) passed it.

1. **Not invited.** Adam's address was never resolved: the directory lookup
   `tool_search` timed out (35 s, outcome `timed_out`), memory had no Adam, and
   discovery then surfaced OUTLOOK_CREATE_CONTACT (a write). The model created
   the event without `attendees_info` and did not disclose it. The judge could
   not catch it because `acceptedObjectiveForSource` returned the continuation's
   own input text ("Scorpion cal") as the objective. FIXED here: on a consumed
   clarification continuation the judged objective is the parent task plus the
   question and answer (`clarificationJudgeObjective`, pinned in
   task-continuity-runtime.test.ts). Person-to-email resolution as a read that
   discovery can find is a separate slice (Outlook exposes no people/contacts
   read in the daemon's known operations).
2. **Approval card on a plain calendar create.** `external-capability-risk.ts`
   classifies CREATE + a communication object (EVENT) as `send`/irreversible
   unless the call signal `outboundDelivery === false`, and the risk loader
   never emits `false` by contract (a missing delivery control is `unknown`).
   So every calendar create is carded, attendees or not; the 09-11 James
   Marshall invites carded the same way. The class fix is a recipient-list
   call signal (`attendees_info` absent/empty → no delivery) so a no-attendee
   create resolves to an ordinary create. That changes the attested
   `callSignals` shape read by four authority modules (workflow v3 Auto drift
   check), so it is a daytime slice with workflow proofs. NOT changed tonight.
   Policy question for the owner: should calendar invites WITH attendees stay
   under the irreversible-send floor (card), or be treated as a reversible
   create (cancel undoes it)?

## Second invite test (21:35 PDT): "Yes" re-asked the identical question

Clem asked "…invite [the invitee] (recommended), or create it directly…?"; the
owner answered "Yes"; the semantic port ruled it ambiguous ("does not identify
either visible calendar option") and the host re-offered the same question with
zero work. Owner direction: the model reasons about the answer; the harness
must not pattern-match "yes" versus "heck yeah let's do it". A phrase-regex fix
was written and reverted. The fix is one sentence in the interpreter's
instructions (`configured-brain-semantic-port.ts`): when exactly one visible
option is marked recommended or default, an answer that accepts the question in
any affirmative wording selects it; otherwise an affirmative stays ambiguous.
Pinned in `configured-brain-semantic-port.test.ts`. Not yet proven live.

Also observed: she re-asked a question the owner had answered 17 minutes
earlier in another session ("Scorpion cal"). Learning that answer as a standing
preference is the north-star "quieter over time" slice, still open.

## Third invite test (21:48 PDT): the invite went out; the account question should not have been asked

Flow: calendar question → "send him a meeting invite and add my zoom link" (semantic
port selected opt-2 "Send Adam an invite from my Scorpion calendar") → model
nominated the owner's Scorpion address to tool_search → host account judge
(grok-4.6, 32 s) did not entail → tool_search told the model "the quoted user
wording did not name this account… Ask the user which one" → she asked "Which
Outlook account should send the invite?" → owner: "my scorpion one like you just
mentioned" → approval card → event created WITH the invitee's address and the
Zoom link in the body.

Two evidence defects in what the judge was handed, both fixed here:
`consumedAccountClarification` passed the semantic port's `opt-2` id instead of
the chosen option's label (`clarificationSelectedOptionLabel`, pinned in
source-account-routing.test.ts), and the judge's instruction assumed the
clarification was an account question; it now says the question may be about
anything whose chosen option names or implies the account by address, label,
domain, or workspace, and that a supplied selectedOption is the recorded choice
(pinned in configured-brain-semantic-port.test.ts). The judge still decides.

Still open from this run: the host remembers the owner's account answer only for
READS (`READ_DEFAULT_ACCOUNT_LABEL`); the same answer for sends (given 09-11 and
twice tonight) is never learned. The 32 s judge round-trip and the 35 s / 48 s
tool_search timeouts are the latency targets after the card slice.

## Hand-off evidence for the tool-search refinement (owner: the other agent, from ~22:15 PDT)

Every tool_search call over 10 s in the last 24 h (eventlog `tool_called` →
`tool_returned`, discovery-governor category/outcome, live home):

| when (UTC) | secs | category | outcome | query |
|---|---|---|---|---|
| 09-15 01:53 | 48 | broad_discovery | succeeded | Run Salesforce CLI SOQL query for today's activity counts… |
| 09-14 05:02 | 47 | broad_discovery | succeeded | web research search public web pages via Apify… |
| 09-15 04:49 | 32 | exact_schema_refresh | succeeded | OUTLOOK_CALENDAR_CREATE_EVENT |
| 09-14 05:08 | 30 | broad_discovery | succeeded | Apify actor run Google search public research… |
| 09-14 17:17 | 25 | broad_discovery | succeeded | Google Docs read a document including comments… |
| 09-14 17:18 | 22 | broad_discovery | succeeded | Google Drive list comments for a file… |
| 09-14 17:53 | 20 | exact_schema_refresh | succeeded | GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN |
| 09-15 04:18 | 20 | broad_discovery | succeeded | create Outlook calendar event |
| 09-14 23:06 | 18 | broad_discovery | succeeded | edit the main step prompt of workflow platform-49… |
| 09-14 18:49 | 15 | broad_discovery | succeeded | create and schedule a recurring hourly workflow… |
| 09-14 23:12 | 15 | broad_discovery | succeeded | Get Google Sheets spreadsheet tab names and numeric sheet ID |
| 09-15 04:50 | 11 | exact_schema_refresh | succeeded | OUTLOOK_CALENDAR_CREATE_EVENT |
| 09-14 05:05 | — | broad_discovery | timed_out | browser_skill_list list browser harness playbooks… |
| 09-14 17:17 | — | broad_discovery | timed_out | web search competitors using specific terms… |
| 09-15 04:19 | 35 | broad_discovery | timed_out | find user by name in Outlook organization directory |

Two readings from the traces: the `exact_schema_refresh` durations (32 s, 20 s,
11 s) are dominated by the in-call account judge round trip (grok-4.6), not by
search; and the "find user by name in Outlook organization directory" query is
a missing read class (person → email) rather than a ranking miss: the daemon's
known Outlook operations are messages/events only, and the model then discovered
OUTLOOK_CREATE_CONTACT (a write). Query text and call ids are in the live
eventlog for replay.

## Lanes closed 22:20–23:00 PDT (built on top of the other agent's tool-search work in the same tree)

**Calendar create no longer cards when nobody is invited.** The risk loader now
counts recipient COLLECTIONS (array properties named attendee(s)/recipient(s)/
invitee(s)/guest(s)) as a call signal `recipientsPresent`: true when non-empty,
false when the schema exposes one and the call supplies none, null when none is
exposed. Delivery CONTROLS keep the old contract (never fabricated false). The
classifier's create-delivery rule now requires `recipientsPresent !== false`, so
a no-attendee event is `create`/`ordinary_non_destructive` and the consent
policy proceeds; with attendees it is still a `send` under the irreversible
floor (owner's policy call still open). Classifier version 2. Attestations are
computed fresh per call and never persisted, so no stored digest drifts; an
approval scope minted before the patch would re-ask once. Pins:
external-capability-risk-loader.test.ts, external-capability-risk.test.ts; the
four suites that assert the call-signal shape were updated.

**Sends remember the owner's account answer, under review.** New alias label
`default send account` (source-account-routing.ts). It is remembered when the
user answers the host's account question for a write and the judge entails it.
On a later write with several accounts and no nomination, the host no longer
asks first: it runs the account judge in current_source_default mode with
`rememberedDefault` (identity + label) and the judge's instruction says it is a
standing preference that never overrides current wording; default_compatible
resolves, conflict/uncertain asks as before. Pins: source-account-routing.test.ts
(judge reviewed, conflict still asks), configured-brain-semantic-port.test.ts.
Not proven live yet: the remember step needs a real answered question.

## Failed edit of the invite (22:19 and 23:05 PDT): wrong operation variant, empty path id, identical retries

"can you edit this event please and add a brief description about clem in the
invite" → calendar view read succeeded (event id retained) → the model asked
discovery for `OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR` BY NAME (1 result;
the by-id sibling `OUTLOOK_UPDATE_CALENDAR_EVENT` exists in the toolkit and was
never offered) → dispatched with `calendar_id: ""` → Graph 400 "Resource not
found for the segment '<event id>'" (URL was /me/calendars/events/<id>, the
calendar segment empty) → retried with `calendar_id: "me"` → same 400 → governor
exhausted → "the calendar API can't locate the event". The first attempt used
`OUTLOOK_UPDATE_USER_CALENDAR_CALENDAR_EVENT`, refused pre-dispatch for the same
empty calendar_id; the IN_CALENDAR schema does not mark calendar_id required so
the host could not refuse it.

For the tool-search owner: a query that names one operation returns only that
operation; the by-id sibling for the same verb+object should be offered beside a
calendar-scoped variant (same class as the OUTLOOK_CREATE_CONTACT miss).

Host-side candidates (not built tonight): (a) an empty-string value for an
identifier-shaped path argument (`*_id`) is provably not an identifier — refuse
pre-dispatch with the exact pointer instead of spending a provider 400; (b) the
provider-repair guidance after a 400 whose message names a URL segment should
tell the model the segment came from one of its own id arguments, so it repairs
that argument or switches to the by-id operation instead of retrying the same
object. Judge behaved correctly (three `fulfills:false` verdicts).

## Fourth edit attempt (23:30 PDT, on the other agent's build c993a374…): stale ref, no door, fabricated failure

The model skipped discovery and reused the previous turn's requirement_id for
`OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR`; the pre-dispatch catalog check
refused it twice (`catalog_entry_or_manifest_missing:candidates=0:proven=none`)
while the repair sentence, drawn from the proven list, said "do not guess a
requirement_id or repeat unchanged discovery" — no door. The model then replied
"the Outlook API can locate it but won't accept its event ID" although no
provider call was made this turn, and the completion judge marked that
fulfilled (the host's own completion blocker still stopped the turn). Fixed:
`hostProvenOperationRepair` now takes the miss reason and, for a proven-earlier
operation refused as `catalog_entry_or_manifest_missing`, names the door (one
fresh tool_search for this request, do not reuse the earlier requirement_id);
the judge prompt says a reported provider failure counts only with a matching
provider call in the evidence. Pins in host-turn-runner.test.ts and
objective-judge.test.ts. The other agent's `session-resource-locator` (locate the
calendar before a mutating call) never ran because the turn died before dispatch;
it should engage once discovery is re-run.

## Fifth edit attempt (23:52 PDT, mobile branch, build 415e2844…): two host defects, both fixed

Discovery now offered the by-id update beside the calendar-scoped one (the other
agent's fix works; the model still chose the calendar-scoped variant and used
the event id as calendar id — the locator should catch that at dispatch). The
turn died earlier, on two host defects:

1. **"edit this event" compiled as create_new.** `compileAcceptedGoal` only
   recognised "the same/existing/current <noun>" as an existing destination, so
   the model's named_existing plan was refused ("destination binding posture
   does not match admitted destination") and it re-planned the EDIT as a
   create to get admitted. Fixed: an edit verb aimed at a demonstrative
   destination ("edit this event", "add … to that meeting") is named_existing
   (`EDIT_EXISTING_DESTINATION_RE`; pinned in accepted-goal.test.ts).
2. **Unparsable carrier refused as "inner name missing".** The work_call's
   `args_json` was a 736-char string cut mid-body (HTML with quotes); the host
   could not read the inner operation and said `effective_inner_name_missing`
   with "correct the inner name", which the model could see was present. It
   gave up and reported a provider rejection; the new judge rule caught that
   three times (~50 s of judge calls) before the honest stop. Fixed: the
   refusal names the parse failure and the repair (`carrierInnerJsonProblem`,
   `hostCarrierInnerJsonRepair`; pinned in host-turn-runner.test.ts).

Still open in this flow: the model preferring the calendar-scoped update
variant and filling calendar_id with the event id (other agent's locator lane),
and the judge spending three passes on one honest failure report.

## Correction (00:40 PDT 09-15): posture from the operation, not from request nouns

The `EDIT_EXISTING_DESTINATION_RE` text rule shipped in the seventh patch was the
wrong shape (owner: "nouns aren't predictable, tool arguments are") and is
reverted. The actual defect was upstream: the resolution-proof minter stamped
every Composio write manifest `destination.posture: create_new` unless a
verified mutation target came from provider arguments, so the live manifest for
`OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR` said create_new and admission could
only accept the edit as a create. Now `structuralDestinationPosture(operationId)`
(external-capability-risk.ts) reads the operation's own verb through the
classifier's action sets: update/delete → named_existing, create/send/post →
create_new, otherwise null so the caller keeps its default. Used by the
Composio proof minter (posture is now part of definition identity, so an
installed stale posture is superseded on the next proof) and the indexed
catalog descriptor. The native-MCP minter keeps its own verb set for now (it
differs on APPEND/IMPORT/GENERATE; unmeasured). Pins: external-capability-risk.test.ts,
proof-provisioned-write-evidence.test.ts (verb → posture; stale manifest superseded).

## Sixth edit attempt (00:39 PDT 09-15, build c7819599…): plan admitted first try; the gateway then refused a property named "pattern"

The named_existing plan was admitted on the first plan_task (posture fix works)
and the other agent's locator supplied a real calendar id. Dispatch was then
refused pre-dispatch three times by the Composio file-staging preflight:
`prepared-file-upload-arguments-invalid` at
`/properties/recurrence/properties/pattern`, `unsupported_pattern`. The schema
walker treated every key named `pattern` as the JSON-schema regex keyword, so
Outlook's recurrence *pattern* object (never sent in the call) blocked every
event update. Fixed: keys under `properties`/`$defs`/`definitions`/
`dependentSchemas` are names, not keywords (staged-file-transfer-plan.ts; pinned:
recurrence.pattern passes, a real `pattern` keyword is still refused).

Time budget of that turn (2 m 47 s before the owner stopped it): 6.7 s to the
memory primer (recall itself 1.9 s), ~60 s of model composition across 48k→70k
token prompts (stable share fell from 25% to 17% as history grew), two
completion-judge passes at 22 s each, three trajectory reviews. The judge repeat
on one honest failure report and the pre-model gap are the next latency slices.

## Framework moves (01:20–01:45 PDT 09-15): one seam per gate, shape refusals become repairs

Owner direction: the harness makes the model better, not worse; no hoops; single-
model users must work; no regressions. The seventh run's discovery output finally
named the cause class: `unavailable: [{authorized_composio, search_failed,
"raised an unexpected error during discovery"}]` — the source threw, the message
was discarded, local tools were ranked over the operation the query named, and
the turn ended as "capability unavailable". Four moves, each pinned:

1. **Discovery is journaled and honest.** Every tool_search appends a
   `discovery_source_outcome` event (query, named operation, per-source count /
   elapsed / error code / error message, whether broad discovery was skipped).
   A source's unexpected error now carries its real message to the model, and
   when the query names an operation whose source failed, that failure is the
   headline: the other results are declared non-substitutes and the model is
   told to retry that operation once, never to switch tools.
2. **Provider regexes are inert where no file authority exists.** The
   file-staging preflight still validates runtime safety, schema validity,
   refs and branches exactly as before; `unsupported_pattern` is raised only
   when the schema grants file authority somewhere (pinned both ways).
3. **Admission adopts the bound operation's posture.** A mismatch between the
   request-derived posture and the selected operation's is shape, not safety;
   `carryExactDestinationBinding` now adopts the operation's posture instead of
   refusing (exported; pinned).
4. **The judge settles an honest failure after one bounce.** `honestFailureReportSettles`:
   after one negative verdict, a reply that neither claims nor promises the
   work, with no settled write, is a typed stop; no second or third judge pass.

Still open, in order: judge retry budget on 5xx and truthful `judgeModelId`
after a fallover (the verdict records the pin, not the responder); Codex-lane
history compaction (77k prompt, 16% stable); the root cause of the Composio
source throw (now visible in the journal on the next occurrence); the
single-model live script as the tag gate.

5. **The verdict names the model that answered.** `resolveJudgeResponder` reads
   the fallover wrapper's `turn_model_routed` rows written during the judge
   window; when the pinned judge was benched mid-call, the verdict records the
   responder, `substituteForExactPin`, the requested pin, and the fallover
   reason (pinned). The judge's retry budget on 5xx is unchanged tonight: the
   BYO model instance is shared with the brain, so a judge-only policy needs
   its own instance (open).

## Rerun on the tenth patch (01:46 PDT 09-15): the journal named the cause on first occurrence

`discovery_source_outcome` for the exact-slug search: `authorized_composio
count 0, search_failed, "tool_choice_remember rejected: intent is 82 chars —
intents are short canonical slugs (max 80)"`. The exact-slug path's memory
reconcile re-saves remembered memos to stamp the live schema fingerprint; one
memo's re-save was rejected by the store's slug rule, the exception escaped,
and the whole Composio source failed, so the operation the query named was
absent and the turn ended as "connector isn't publishing one". Fixed:
`reconcileExactSlugMemory` treats each memo's bookkeeping as a convenience
(per-record try/catch); a rejected memo is skipped and the operation still
discloses. Pinned: the store rejection is asserted real, and the source-level
reconcile is asserted not to let it escape. The judge ran twice, not three
times (honest-failure settle); the model composed on an 89k-token prompt with
14% stable — that is the next slice. (Correction: the host lane DOES reach
`compactSessionIfNeeded` through `runTurn`; it never fired because the budget
was the 880k window — see the twelfth patch below.)

## Full suite on the tenth patch: 16,183 pass, 2 red, both fixed

1. `ventura-email-pending-action.integration`: the other agent's new
   `session-resource-locator` ran `Object.entries` on undefined for every
   Composio call with no arguments ("Cannot convert undefined or null to
   object"), which also kills live argument-less reads before dispatch. Fixed:
   the locator passes a non-object argument value through untouched (pinned).
2. `no-hardcoded-provider-pins`: two new comments named provider slugs (theirs
   in toolkit-slug.ts and tool-search-provider-sources.ts). Reworded.

The Composio-source failure that ended the rerun was a memory bookkeeping
rejection escaping the exact-slug path (see above); the `discovery_source_outcome`
journal surfaced it on the first occurrence.

## Twelfth patch: the wire's cache RATE governs Layer 1

Measured over three days of `model_call_completed` on the Codex OAuth brain
(332 consecutive same-session pairs): a cached prefix was served on 37% of
calls — 46% when the prompt grew by ≤2k tokens, 33% when it grew more, 11%
when history was rewritten (the prompt shrank), 0 of 22 when the tool list
changed. The per-session `prompt_cache_key` is attached (the 07-04 A/B had
already shown key vs no-key both ~40%); the provider's routing is the ceiling.
Brain calls are 3–10 s each; the judge is 12–58 s per verdict.

`effectivePromptCacheSupport` flipped a seeded non-caching wire to "caches"
after five lifetime hits and never read the denominator it records (367
observed calls). Every consumer then scaled its compaction budgets to the
880k window, so a 67–72k-token history was re-prefilled on six calls in ten
and between-turn compaction had never fired on the session.

Changed (no gate, cost only):
- cache support is a rate: a seeded-false wire counts as caching only when it
  has hit ≥5 times AND at least as often as it missed; seeded-true wires
  (explicit breakpoints) are untouched.
- `layer1CompactionBudgetForModel`: Layer 1 (lossless clip/collapse of
  recallable old tool results) is measured against `min(window, 200k)` on a
  wire that does not cache in practice, the window otherwise — the same split
  the mid-turn thresholds already make. Layers 2/3 keep the window (the
  2026-08-05 pin stands). `condenser_applied` now records `layer1BudgetTokens`.

Dry run against a hard-linked COPY of the live branch session (never the live
home): 61 items / 72,153 tokens → 29,820 (clipped 14, collapsed 6 pairs, all
user/assistant messages kept). Pinned in `model-window-observations.test.ts`
(rate rule, the live 124/367 shape) and `compaction.test.ts` (budget split,
trigger honours the Layer 1 budget, clamp to the window). 354 targeted tests
green; full suite on the eleventh patch was 16,190 / 0 fail.

## Thirteenth patch: an honest continuation carries the standing verdict

In the 08:46 run the first verdict said "not updated" (58 s on the pinned
judge), the continuation made no further business call and answered "I still
can't reach a working update operation", and the judge was asked again on
identical evidence (23 s) to say the same thing. `honestFailureReportSettles`
already ended the turn after that second verdict; it was computed after the
call it made redundant.

Changed (no gate — one fewer round trip): before the judge is called on a
continuation, if the last verdict armed this continuation, no business call
has been made since it, nothing settled, and the reply neither claims nor
promises, the standing verdict is carried onto the reply as a
`goal_alignment_judged` row marked `carriedVerdict: true` (no `judgeModelId`,
`continuation: false`, the new `replyDigest`) and the turn ends exactly as it
did after the second verdict. A new call, a settled write, a claim or a
promise still buys a fresh verdict (pinned both ways in
`host-completion-contract.test.ts` with an ACTION objective — the existing
refresh fixture is `tool_intent`, which is why its follow-up was never
judged). 706 targeted tests green across the judge readers.

## Fourteenth patch: a turn clock for the pre-model ceremony

Measured on the last two live turns: engine selection → first model call took
8.9 s and 7.1 s. The rows in between timestamp themselves but nothing records
what ran between them: `turn_engine_selected` → `capability_discovered` 1.0 s,
→ `mcp_tool_scope` 1.9 s, → loop `turn_started` 0.3 s, → `turn_memory_primer`
5.6 s / 4.4 s while recall itself reported 2.1 s.

Added `turn-clock.ts`: one clock per session started at engine selection;
admission, MCP scope, loop turn start, assembly launch/await/settle,
compaction and the primer mark themselves; the `agent_context_packet` row
takes the record as `stages` (offsets in ms, plus `totalMs`). No new events,
no behavior change; unit-pinned, 595 tests across the affected suites green.
Read it on the next live turn to pick the pre-model slice by measurement.

## Fifteenth patch: a split audience keeps its own conversation

Owner ran the twelfth-to-fourteenth build from the same mobile thread and Clem
asked "which event?". The eventlog shows why: the turn ran in a brand-new
session (`session_started` at 11:55:43, 5 items, no `condenser_applied`).
The mobile thread mirrors a desktop session whose principal differs from the
mobile audience, so the selector identity-splits into a child that owns an
independent root and writes the continuity pointer under THAT root. Every
later message still enters through the desktop session, whose root has no
pointer for the mobile continuity — so every differently-worded message split
again into an empty successor; only byte-identical retries (same durable
source id) found the earlier binding. Live: two roots under the desktop
parent today, five under a workspace parent — this predates today's patches
(the file's last change is 979e4865) and explains the mobile lane's "lost
history" across differently worded messages.

Fixed in `accepted-source-session-branch.ts`: when the entry root has no
pointer for the continuity, resolve the continuity's own independent root
(same parent, same continuity digest, same mount or none; unreadable metadata
excluded) and read its pointer; the ordinary reuse/branch path then continues
it. Pinned with a mobile-shaped fixture (settled turn → reused; open turn →
successor under the same root with its prefix; retry → binding; other audience
→ own root, and continues in it). 208 targeted tests green. The fourteenth
build's full suite was 16,197 / 0 fail.

## Sixteenth patch: the phone's new-chat path, and the account question

The 14:13 run ("The Clementine discussion with Adam tomorrow at 9…") landed in
a `sess-mob-…` session that never touched the selector: the request payload
hash proves the phone sent NO session id (11:55 had sent the desktop thread's
id; 07:39–08:46 had sent the branch id). A message with no session id is a
new chat by contract (`/api/chat/send`), which is what the Home "Ask" box and
"New chat" produce; the open thread and the question card both carry the id.
The fifteenth patch therefore could not apply to this run; it applies to the
11:55 shape.

In that fresh session Clem asked "which calendar?" herself (an
`ask_user_question` before any call) even though memory carried the Scorpion
calendar connection and a remembered read default. The host resolves accounts
at the call (`source-account-routing`: read default; established route of
this conversation; send default; one question only if unresolvable) — the
model asking first is a hoop the rubric never told it to skip. Added to the
shared CONVERSE FIRST line (the live action-lean rubric sits 9 bytes under its
5,500-byte ceiling, so the line was tightened by the same amount it grew):
which account/mailbox/calendar is never the clarifying question; attempt the
call. Characterization pins updated deliberately.

First live turn-clock record (fresh session): mcp_tool_scope 1.2 s,
turn_started 1.36 s, assembly awaited 1.47 s → settled 2.37 s, primer recorded
4.40 s — so ~2.0 s sits between the settled assembly and the primer row
(context-packet build, synchronous). That is the next pre-model slice.

## Seventeenth patch: open loops carry across conversations

Owner: "why isn't Clementine finding the session history and remembering
what she needs to do to pick up where it left off". Three phone messages
arrived as three new chats (no session id on the request); each turn started
blank, Clem asked a question, and the next message — plausibly the answer —
landed in another blank room. Task continuity is exact-session and
prospective memory is captured rules: nothing carried "what I asked you and
what it was about" across conversations.

Added `open-loops.ts`: for the principal (channel + audience id, the same
identity the accepted-source selector keys on), the unanswered
`awaiting_user_input` questions from OTHER recent conversations (24 h, newest
first, ≤3, bounded text) with the request they were about. The context
packet renders them as data plus one floor — if this message answers one,
continue that work here; otherwise ignore — and records
`openLoops {count, bytes, sessionIds}`. The model decides; the harness
never routes on its own. Workflow nodes never carry chat loops.

Same turn, two more hoops closed:
- the calendar UPDATE was disclosed `account_selection_required` with the
  read default on file. A write that changes an existing record (operation
  posture `named_existing`, never wording) now resolves to the toolkit's
  remembered read account (`host:read_default_named_existing`); a create
  still asks for a send preference. Pinned both ways.
- the model wrote the host's `ASK:` marker into its ask_user_question text
  and the phone showed it verbatim; the ask tool strips the marker.

Dry run on the live ledger copy: the current mobile session sees its
principal's three open questions (14:28 wording, 14:13 calendar, 11:55
event+description). 669 targeted tests green. Reasoning effort was 'none' on
24 of 25 simple chat turns today (policy: simple → none); two ask-instead-of-
act reactions today ran under it — left as a recommendation, not changed.

## Eighteenth patch: an exhausted Plan turn publishes before it stops

Owner's pre-tag run (Sonnet 5 brain, Plan mode): "pull 10 accounts I own from
Salesforce (sf CLI), research each site's SEO with DataForSEO, draft a custom
email per account into the Scorpion Outlook drafts". The plan turn pulled the
ten accounts through the sf CLI (retained), read the DataForSEO docs, then:
- `dataforseo__api_request` (the MCP server declares no read-only hint, name
  not read-shaped → effect write) was refused as Plan-mode read-only;
- `skill_read scorpion-outbound` was refused pre-dispatch — the packet
  advertises "call skill_read" but the schema-on-demand surface defers it
  (only reachable via call_tool). OPEN.
- a discovery `tool_search` timed out (transient) and spent the last governor
  retry; the turn terminalized "I stopped before publishing" with a plan the
  model's own check-in then called ready. Zero plans published, nothing to
  execute.

Fixed: when the no-progress governor decides to terminalize a Plan turn, the
host grants exactly one more model step whose surface is publish_plan (+
ask_user_question) with a PUBLISH NOW steer (publish what you have; name gaps
as needs_input). A second exhaustion stops as before. Journaled as
`guardrail_tripped kind=plan_final_publish_step`. Runner-level pin in
`host-no-progress-governor.integration.test.ts`; host/governor/completion
suites 402 green.

Recommendation, not changed: reasoning effort 'none' on simple interactive
action turns; and the MCP effect for generic request tools (DataForSEO) —
consider the declared-effect path at connect time.

## Nineteenth patch: a provider-shaped created record settles

Pre-tag run #2 (Sonnet 5, Plan mode, eighteenth build): the plan published
after four rejected drafts (three "provider schema changed after discovery"
on the reviewed-CLI steps — the model dropped those steps and folded the
already-retained accounts into the plan; one "collection producer must be a
tool step"), 12.5 min end to end, judged complete. Execute: the DataForSEO
backlinks summary ran through the Composio connection, ten Outlook drafts
were created in the Scorpion mailbox with no consent card (plan-bound
creates), the reviewer confirmed all ten — and the run was marked FAILED:
"write settlement is missing an exact created id, handle, or receipt".
`createdPayloadOf` read only the Clementine-shaped `created:{id,handle,
receipt}` contract; the provider answered with `id`, `webLink`,
`@odata.etag`, `changeKey`, `internetMessageId`. The person saw "All 10
drafts are created" under a blocked status.

Fixed: the created record's identity is read by structural key from the
acknowledged provider envelope — the record id, an outward link (falls back
to the id), and a provider-minted receipt (entity tag, change key, message
id, revision or provider timestamp; never invented). Pinned with the live
draft shape. The "string payload settles unknown" class (OPEN since 09-03)
now closes for created records.

Also this afternoon: platform-49 failed at 15:00 and 15:02 with
`operation_version_rebind:proof_publication_expired` — the exact
re-provisioning deadline expired while this machine was running the
eighteenth build and quitting the daemon (15:02:28 restart). The run is
parked and retries; not a logic regression. The background full suite was
stopped so live runs are not starved. friday-dashboard's five Salesforce
nodes fail at 14:00 daily since 09-14 ("No current capability is registered
for salesforce_sf_soql_query" in the workflow lane) while the same operation
runs fine in chat — OPEN, predates this wave.

## Twentieth patch: a scheduled read never waits on the account reviewer

Re-triggered platform-49 manually on the nineteenth build with the daemon
idle: the step failed twice, 33 s after each start — the exact-provisioning
deadline (30 s), not load. Reproduced offline against a staged copy of the
home: `resolveSourceAccountRouting` for the Sheets read with its ONE
connected account resolves in 21 ms as `host:read_single_account` when told
the effect is a read; `provisionExactWorkflowProviderOperations` never
passed the effect, so the same read took the WRITE review path, which asks
the semantic port — the pinned cross-family judge, 20–60 s live — and the
30 s deadline expired every time ("operation_version_rebind:
proof_publication_expired"). The discovery path (tool_search) has passed the
effect since 09-08; the scheduled path did not.

Fixed: workflow provisioning derives the routing effect from the operation
(the same `classifyComposioSlugEffect` the discovery path uses) and keys its
per-toolkit routing cache by effect. Pinned: a single-account scheduled read
provisions with no reviewer installed; a scheduled write still asks. This
also explains yesterday's 19:00 platform-49 failure shape and is the likely
reason the judge's slowness surfaced as workflow "not connected" errors.

## Twenty-first patch: the scheduled step's own deadline governs its review

On the twentieth build the platform-49 read provisioned and the step moved
to its WRITE (Sheets batch update), which still expired: the write review is
model work on the pinned cross-family reviewer (20–60 s) and the provisioning
pass clamped the caller's 15-minute step wall clock to the 30 s chat search
budget. Now the caller's deadline governs when given; the 30 s budget only
bounds a pass with no caller deadline (test-only override `totalDeadlineMs`
pins both directions). A scheduled write with one connected account still
gets its review — it just gets the time the step already owns.

## Twenty-second patch: the restart placeholder no longer blocks the first scheduled read

friday-dashboard's five Salesforce nodes failed "No current capability is
registered for salesforce_sf_soql_query" on the FIRST attempt after every
daemon restart (14:00 on 09-14 and 09-15, 16:43 today) and passed on the
automatic retry ~65 s later. The supervisor log names it: the reviewed-CLI
carrier's port registration found an existing port with a shipped invoke but
no argv and no observer — the generic placeholder that
`reconstructShippedPortsForDurableSuccessors` claims for every current
durable manifest at startup (native MCP was already excluded for this exact
reason) — and refused ("observe_missing"), which retired the identity; the
retry re-minted a fresh manifest (five new reviewed-CLI manifests today).

Fixed: a shipped-invoke port with no argv and no observer is recognized as
the placeholder and the exact reviewed port replaces it
(`replaceProductionCapabilityPort`, same shipped checks, only the
identity-exists refusal waived). Real drift (`invoke_not_shipped`,
`argv_mismatch`) still refuses. Pinned with a restart-shaped fixture: no
identity retired, first acquisition succeeds, compile ok, the exact port
carries argv and an observer. 239 tests across the port registry, workflow
runner and the platform-49 effect runtime green. This is why my patch cycle
made those failures look worse: every hotpatch is a restart.

## Pre-tag reconciliation (suite 22: 16,215 tests, 7 red)

- Plan final publish step: scoped to exhaustion of discovery
  (`attemptClass === 'authority_acquisition'`); a repair loop on an
  unpublished call keeps handing its checkpoint hops to durable recovery
  (held). Restores three Plan-source repair pins.
- Provisioning deadline: provider I/O and publication keep the search
  budget (and never exceed a shorter caller deadline); only the account
  REVIEW runs on the caller's deadline, and the I/O budget is extended by
  the review's elapsed time, capped by the caller. Restores the refined
  local settlement pins; the platform-49 write review still fits.
- `catalog-production-nested-settlement` (3 s host deadline) passes alone
  and fails only under load — the known 09-09 load flake.
- The other agent's edits made after the last green suite (tool-catalog
  `skill_read` first-class, publish-plan reviewed-CLI schema, acquisition
  registry `refuseWithoutRetiring`; 8 files, 92/16 lines) broke four pins
  (native-read-argument-repair ×3, call-tool-refined-local-settlement) and
  were set aside for this tag: git stash + `scratchpad/other-agent-post-
  suite17.patch` + the new test file kept beside it. They are not lost.


## 2026-09-15 evening: Plan → Execute on the owner's own turns

Read from `state/harness.db` copies during the owner's turns, never the UI.

**Plan turn 20:05 (Sonnet 5, session …794b7bf5):** eight minutes, nine
brain calls, prompt 52k→118k tokens, effort `high`. Two consecutive calls
of ~3 min each: the first overflowed the 16k output default and was
rejected whole, the next returned empty and fell over to Codex. No write
crossed; the one execute-shaped call (a ten-domain DataForSEO batch) was
refused by the Plan boundary. Fixes: Plan effort `medium`
(`selectReasoningEffort`); the Claude request default now hands the model
its registry output window (64k for the Claude 5 family) instead of a 16k
clamp — the adapter only clamps ids in its own table, which excludes the
Claude 5 ids.

**Plan turn 20:32 (Sonnet 5, session …8c6d0d03):** two Plan turns at
`medium`, reads only, plan published at 20:38:44 and refused
("collection producer must be a tool step"). The repair turn died at
20:41:11: the Claude Code keychain probe timed out (6.5 s), the app read
that as "sign-in expired", and the fallback layer marked Sonnet dead for
15 minutes with no fallover. Fixes: a timed-out/failed probe keeps the
credential it already holds; an expired or absent CLI-owned credential
waits ≤12 s (2 s cadence) for the CLI's own refresh before failing closed;
a LOCAL credential read failure pauses a brain 60 s, a provider rejection
keeps the 15-minute cooldown. Four pins.

**Plan turn 21:02 (Sonnet 5, session …a910b449):** `medium`, skill and
memory reads, four Salesforce reads, then four `publish_plan` rejections
in a row (one structural problem per round trip, each round a ~60 s
Sonnet call re-authoring the plan) before the owner cancelled at 21:09:44.
Fixes: the collection-producer refusal is now a one-shot repair steer
naming both executable shapes (inline members held from planning, or a
tool step as producer, with per-member content authored at execute time);
every structural problem is reported in ONE response.

**Set aside, deliberately:** a repeated write over a collection authored
by a compute step needs a third universe seal (`reviewed_step_result`);
the eventlog CHECK constraint allows only `accepted_input` and
`complete_source_receipt`, so that is its own migration, not tonight.
Direct catalog calls (`skill_read`, `memory_search_facts`) refused with
"use call_tool" still cost one round trip; the host knows the repair and
should apply it itself — owed.

**The other agent's post-suite edits are IN this tree, not stashed:**
`skill_read` always loaded, a missing catalog `providerInputSchemaDigest`
is not "provider schema changed", an exact CLI identifier acquires even
when an unrelated MCP adapter cannot be observed. The four pins they broke
are repaired: the native-read repair fixture now uses `memory_search` as
its genuinely unpublished read (skill_read became first-class); the
refined-local-settlement pin passes as-is.

**Test runner:** the live DB crossed 2 GiB today and
`live-home-sentinel.mjs` hashed it with one `readFileSync`
(`ERR_FS_FILE_TOO_LARGE` took every test file down). It now hashes in
8 MiB chunks.

### Live traces on fingerprint 23e0aaa4 (build of this tree)

- **Dashboard write:** friday-dashboard-daily-refresh run
  `1789507627144-48d7aa`, queued through the dashboard door 21:27:07 UTC,
  record `source: dashboard`, `workflowSlug` set. Six SOQL reads settled
  21:27:16–21:27:21, `package_dashboard` transform and `space_set_data`
  commit at 21:27:21 on attempt 1, `run_completed` 21:27:49, 8/8 steps,
  no approval card, no "No current capability". The goal validator still
  records its replay criterion as unmet after the single committed
  observation (advisory; `needsAttention: false`).
- **Plan publish:** owed — the owner's next Plan run on this build.
- **Execute first token:** owed — the owner's next Execute on this build.

### Plan trace on fingerprint 23e0aaa4 — gpt-5.6-terra, session sess-desktop-71fd49b4af6b7b8e2b40f7a9 (21:34–21:42 UTC)

Sent through `/api/harness/chat` with `taskMode plan`; watched on the SSE
stream. Discovery 21:35:02–21:36:31: five tool_search, three carrier reads,
one direct `skill_read` (first-class now — no refusal), six file reads.
Five `publish_plan` attempts:

1. 21:36:54 refused — compute step as the collection producer for the
   Outlook writes (the same shape Sonnet chose at 20:38 and 21:08). The
   one-shot repair steer went back.
2. 21:38:26 (governor granted the final publish step) — `needs_input`
   outline making the Salesforce selection a prerequisite; the completion
   reviewer (gpt-5.6-sol) refused: "the Salesforce selection is an
   execution step, not a missing prerequisite".
3. 21:39:41 refused — five single-call draft steps, each bound to
   `/drafts/N` of the compute output (a shape the contract CAN carry), but
   the Outlook ref they cited had not been disclosed by a search this turn.
   Her first Outlook search at 21:35:02 had ranked AIRTABLE_CREATE_RECORDS
   first (ranking fragility, known).
4. 21:40:29 — `needs_input` again; reviewer refused ("unsupported
   mailbox-selection blocker despite the known Scorpion mailbox binding").
5. 21:41:42 — same; then the host ended the turn at 21:42:26 with
   "Which account should I use for outlook create draft?"

**Root cause of the question (the one the owner hit this morning):** three
searches carried `account_selection {toolkit outlook, identity
<owner scorpion address>}` and every one came back
`account_selection_required / not_entailed`. Outlook has two mailboxes, no
"default send account" alias, and a "default read account" alias = Scorpion.
With no nomination the write asks; with the Scorpion nomination the judge
sees only "put them in my Outlook drafts folder" and rules not entailed.
The model's correct hint made it worse than saying nothing.

Fixed (`resolveSourceAccountRouting`): a write with no send default is
reviewed by the judge against the READ default (the owner's own store is
where a draft/event lands), never bound by the host — wording that names
another account still conflicts; and a nomination that merely repeats the
remembered default is reviewed as the default, not as a fresh explicit
selection the wording must name. `resetAccountAliasesForTest` now clears
the file, not only the cache (the old reset leaked earlier tests' defaults).
Two new pins; the "a create still asks" pin became "a create is reviewed
against the read default".

Also: the `Step x: Step x:` doubled prefix in publish refusals is gone.

### Plan → Execute traces on builds 0a95187c / 77b81c42 — gpt-5.6-terra

**Plan, session sess-desktop-51af4e218530fe4f10fd9633 (build 0a95187c, 21:59–22:07):**
the Outlook draft operation resolved to the Scorpion mailbox through the
remembered READ default at 21:59:34 and was disclosed bound — no account
question (the routing fix, live). First publish refused for the
compute-producer collection (the steer went back); she then ran the
Salesforce and DataForSEO reads, authored all five emails inside the plan,
and inlined them as members. The one-response validation reported both
leftovers at once (an argument bound twice; a recipient bound as a string
where the schema wants a list). She fixed both; the plan was structurally
valid at 22:03:14. Then the completion reviewer refused it — "research
executed before publishing" — and kept refusing while publish steered the
opposite way. Cancelled at 22:07. Fixes: the plan-turn judge instruction
now says reads and discovery during planning are preparation, a plan may
hold members/facts/content gathered this turn inline, and only writes and
sends must not have run; the host completes a scalar bound to an
`array<scalar>` slot into a one-element list on the retained member record
instead of refusing.

**Plan, session sess-desktop-d0d11fafef0201f61f4fdfa3 (build 77b81c42,
22:08:03–22:10:29):** one refusal (the same first shape), one repair,
published as `plan-ff71585c-d497-4080-a505-9b30f6d30ff4` rev 1, readiness
ready, judge fulfilled ("without performing the research or draft
writes"). 2 min 26 s end to end. Shape: Salesforce read → compute select →
DataForSEO read → compute drafts → five single-call Outlook draft steps
bound to `/drafts/N` of the compute output. Seven prepared bindings.

**Execute, same session, 22:11:28:** died silently four seconds in —
`plan_execution_revalidation_refused` for `find_stale_accounts`
(`cap:live:v1:…`, entry present, callable, schema cached) and NO terminal.
Cause: the reviewed-CLI catalog identity carries no provider schema
digest; publication (the other agent's fix) fills that digest from the
cached schema into the stored binding; revalidation compared the two
byte-for-byte and then compared the schema against the catalog's
`undefined`. Fixes: revalidation tolerates a missing catalog digest the
same way publish does (identity compared without that field; schema
checked against whichever digest exists; a present catalog digest must
still match) and journals a `reason`; the pre-turn revalidation stop now
commits the standard typed blocked terminal ("I could not start executing
this plan: … Nothing was started. Open the plan and publish it again, or
ask me to plan it fresh."). Owed pin: a reviewed-CLI fixture without an
external definition digest — the integration fixture always carries one.

### Execute traces, builds 55d16582 → e4a5515f (22:25–22:58 UTC)

- **22:25 / 22:30 (55d16582, 7d272e17):** Execute on `plan-ff71585c` rev 1
  stopped pre-turn twice more after restarts — the durable planning card
  refused "capability drifted" for the DataForSEO ref because the resume ran
  two seconds after boot, before the provider carrier re-attested the
  manifest (no live row yet). Fixes: identity-field comparison for card
  reopen (advisory wording is re-derived per process) and, with no live row,
  the durable manifest under the same id/digest/current lifecycle counts as
  present. Pins: primary-model-planning-card-recovery (11).
  **Schema limit found and set aside:** a reviewed revision has ONE immutable
  claim (`UNIQUE(plan_id, revision)`, delete/update triggers), so an Execute
  that stopped before its turn spends the revision; the typed stop terminal
  now says so ("publish the plan again and Execute that new revision"). A
  retryable claim for never-started executions is owed.
- **22:40–22:47 (9321fd22):** Plan published cleanly on the first
  structurally sound candidate — then the completion reviewer sent it back
  seven times on wording (preferences vs assumptions, "not touched"
  semantics). Fix: a two-send-back budget; the third sound candidate
  publishes (`plan_review_budget_spent` journaled). Also: a full outline
  paired with a stale repair digest now publishes as a full submission; the
  collection steer no longer claims content is "written at execute time" (a
  reviewed write carries exact bytes: static, bound, or on the member
  record) and names the unrolled per-member shape.
- **22:49–22:58 (e4a5515f), session sess-desktop-ed932f711a5291870fee0a69:**
  Plan published at 22:55:03 (`plan-28c71317` rev 1, 10 bound steps, 5½
  min). Execute at 22:55:40: revalidation passed, first prompt at 22:55:44,
  five Salesforce CLI reads (exit 0, no approval), two compute steps recorded,
  then the five DataForSEO `api_request` steps — classified external_write
  (generic MCP passthrough, no readOnlyHint) — minted FOUR approval cards at
  once and the turn ended `bridge_runtime_failed`. Cause: with more than one
  pending approval the terminal reducer refused to name one ("would widen
  authority"), typed the pause as a QUESTION, and closing the host call
  authority threw "still owns unsettled work". Fix: a multi-approval pause is
  an approval pause naming the oldest card ("N approvals are waiting…"); the
  authority stays open. Pin owed (no unit seam; verified live below).
  Owed: DataForSEO `api_request` read classification (POST-only API, no
  annotations) — five approval cards for reads on every run.

### 23:04–23:18, session sess-desktop-b744e5006fdff7cc908c62e4 (build 2d468dcf)

Plan reached the reviewer on the second candidate; the reviewer's first two
send-backs were substantive (skill reference files unread; Salesforce step
unbound). Then: (a) a retained draft carried a `base` from an EARLIER
conversation's plan (recalled from memory) and every repair was refused with
"Plan access requires its origin conversation" — publish now drops an
inaccessible base and starts a new plan (`plan_base_ref_dropped`); (b) she
published `needs_input` asking for "the sf CLI runner" although the host had
disclosed `salesforce_sf_soql_query` twice that turn; (c) after the answer,
the NEW source inherited none of the prior source's disclosures ("discover
and cite" for every step — owed: same-conversation Plan continuations should
repack the prior source's disclosures); (d) her Outlook re-search hit
`account_selection_required` with no reason: a read routed on her words and
a write reviewed against the read default at the SAME earlier source were
treated as a conflict by `newestEstablishedRoute` — fixed: a checked default
and an explicit route naming the same account are one selection. Pinned.

**23:18–23:23, same session:** with the mailbox answer the Outlook ref bound
without a question. Two more publish hoops removed: a repair digest from
the source that asked is now honored by the answering source (drafts are
content-addressed), and the plan reviewer is told that earlier publish
refusals are the road to the candidate, not gaps in it (it had refused two
candidates for "no published artifact yet", which is circular before
publication). Plan `plan-77f982b2` rev 1 published 23:21:47 with the best
shape so far: reviewed Salesforce CLI read → compute → DataForSEO named
backlinks read (no generic request, so no approval cards) → compute drafts →
five bound Outlook draft writes → verification read. Execute 23:22:03:
prompt in 2 s, plan activated, Drafts baseline read settled (613 drafts),
then the exact reviewed Salesforce query was refused "does not uniquely
match the reviewed operation" — the byte-identical query, the same
reacquired ref — because the call attestation for a reviewed-CLI read
carries no provider schema digest while the reviewed binding has the one
publication filled in. Fixed at call admission the same way as at
revalidation (compare the cached schema's digest when the attestation has
none). The turn ended typed (`verification_required`), no spinner; the
revision is spent by the one-claim schema.

### 23:27–23:35, session sess-desktop-d16937a53574844310b99bfb (build 3edf0fb0) — END-TO-END

Plan published `plan-8a7966a7` rev 1 at 23:31:47 (4 min; one shape
refusal, two reviewer send-backs, budget published the third). Execute at
23:32:03: prompt in 2 s, plan activated, Salesforce CLI queries (shell read
path, no approval), account selection recorded 23:32:56, DataForSEO
backlinks summary read (named operation, no card), drafts composed and
recorded 23:34:00, five `OUTLOOK_CREATE_DRAFT` writes settled 23:34:12 →
23:35:00 with Graph etag receipts, no approval cards. Completion judge
(gpt-5.6-sol): fulfills=true, five settled effects. Drafts in the Scorpion
mailbox: Friedl Richardson, Inman & Stadler, Kostyo Law, Lumberg Law, Jeff
Buskirk Law. THE OWNER'S TASK COMPLETED END TO END.

Terminal honesty gap: the delivery committer downgraded the fulfilled
outcome to `blocked / verification_required` — "write has no
content-digest-matched readback" — because the plan carried no post-write
Drafts read. The create response itself echoes the written subject and body
(Graph returns the created message); that echo is the readback for a create.
Owed: count a create response that echoes the written content as its
readback so a fulfilled execution is typed done.

### 23:39–23:47, session sess-desktop-7276d935beb9eee5dd573a9d (build 89803933) — END TO END AGAIN

Plan `plan-b02a93ea` rev 1 published 23:42:26 with a clean `success`
terminal (3 min; one shape refusal, one substantive reviewer catch — the
repair had bound only `/drafts/0`). Execute 23:42:54: the reviewed
Salesforce CLI step admitted and settled at 23:43:26 (the call-admission
digest fix, live), DataForSEO named read, compose recorded, five Outlook
draft writes settled 23:45:14 → 23:46:29, verification step recorded, judge
fulfilled with five settled effects. Drafts: Friedl Richardson, Inman and
Stadler & Hill, Scanio & Scanio, Kurt Bruderly Law Offices, Pissetzky Law.

Terminal still typed `blocked/verification_required`, now "durable record
count does not match the raw collection": the audit's record-path walker
understood the MCP envelope but not the reviewed-CLI observation (records
live in the stdout JSON string), so the 50-record SOQL read audited as
zero. Fixed in `recordsAtRecordPath` (same CLI branch handle creation
uses); pinned in `result-facts-cli-records.test.ts`. The echo-readback fix
from 23:38 held (that rule no longer fired).

### 23:53–00:05, session sess-desktop-d4c2623935a06b790f5eb84a (build d7e9970e)

Plan `plan-70e673e0` rev 1 published 23:58:20 with a `success` terminal
(5 min). Execute 23:58:45: three compute steps recorded; the five DataForSEO
generic-request steps (classified external_write) minted five cards and the
pause was typed correctly this time ("5 approvals are waiting…", no crash).
Approving the cards one by one resumed a separate turn per approval that
re-paused as a question ("I need your input") because the resumed turn's
lastTurn no longer matched the cards' turn; the fifth resume ran with a
tangled plan authority and ended with a terminal typed `done/success`
whose reply says "I hit a plan execution binding error before any SEO
lookups or Outlook drafts were created" — an honesty gap (judge said
fulfills=false twice; the continuation budget then accepted the reply).
Owed: exhausting judge continuations must type blocked, never done.

**Owner directive 00:04 UTC:** "There shouldn't be approval cards unless
they are being answered by the harness … get rid of all approvals, this is
cluttering the harness." The change (business-effect approval branches in
`interactive-consent-policy.ts` resolve as `proceed` with basis
`harness_resolved`, journaled) was refused by the auto-mode classifier as a
security weakening; it is written up in memory and handed to the owner to
apply or permit. Explicit workflow human checkpoints stay as the user's own
configured gate.

### Suite on the final tree (00:20 UTC, build d7e9970e + one test edit)

16,229 tests: 16,224 pass, 3 skipped, 2 red.
- `loop.test.ts` "one request materializes distinct queued payloads…" pinned
  the OLD multi-approval typing (a question with no approval id) — exactly
  the class that failed publication at 22:58. Pin flipped to the approval
  pause naming the oldest card; passes alone and in the file.
- `workflow-runner-v3-call.integration.red.test.ts` "BARE CALL CONSENT — a
  durable queue source string is presentation metadata, not mutation
  authority" expects a mobile-queued send to PARK on a human card. It has
  failed in every suite run tonight and reproduces alone. Under the owner's
  00:04 directive (no approval cards; the harness answers) that expectation
  is the thing being removed; left for the owner's decision with the
  classifier-blocked consent change.

## 2026-09-15 late: remove the gates between intent and the first correct call

Owner's score: Clem feels at least as intelligent as 3.18.6/3.18.7, and a
straight Act/Plan job (Salesforce → SEO → Outlook drafts) reaches a first
successful attested call without a maze. Eight items, each with the gate
removed, the gate that survives, and the live pin. Nothing committed; the
tree is still the 3.18.8 candidate.

1. **Shell first call is admitted; a reviewed op is named, not guessed.** The
   `work_authority_unavailable` / "foreground read lacks its exact current host
   attestation" refusal was an effect-enum mismatch, not a missing attestation:
   shell reads classify `compute`, the host mints a `local_envelope` + `compute`
   attestation, and `graphlessForegroundReadAuthority` accepted a local envelope
   only for `read` (`work-call.ts`). Fixed at the consumer (compute admitted).
   Upstream, the packet steered her to shell: a proven cli memory row rendered
   "invoke via run_shell_command"; it now renders the reviewed operation id with
   its `args_json` map when the command head matches a callable reviewed-CLI
   descriptor (`capability-resolution.ts`, `tool-choice-store.ts`, shared
   `cliCommandHead`). If she still types shell for a reviewed op, the
   pre-dispatch check returns `reviewed_cli_shell_matched:<op>` and the repair
   names the op and the argument map (`reviewed-cli-shell-match.ts`,
   `hostProvenOperationRepair` lowercase branch). No transparent rewrite (owner's
   call: least needed, most code). Pins: work-call.foreground-compute,
   reviewed-cli-shell-match, capability-resolution, host-turn-runner.
2. **Codex first token is not a dead socket.** Body timeout 30 s → 120 s (Claude
   parity; a dead-socket guard, never the pace); a body timeout gets zero
   transparent retries (the chain owns recovery), a headers timeout one; every
   transparent retry journals the public `stall_retry_attempted{kind:
   'model_transport_retry', layer:'adapter'|'host', undiciCode, attempt, …}` row
   and the console labels it; `codex.transport_timeout` / `codex.sse_truncated`
   normalize to `model.*` inside the fallback chain so fallover and benching
   fire (`codex-dispatcher.ts`, `codex-model.ts`, `fallback-model.ts`,
   `public-presentation.ts`). Pins: codex-dispatcher, codex-model,
   fallback-model, byo-fallover-budget, host-turn-runner (public twin row).
3. **A mid-session "remember …" binds every later request.** Steer notes were
   re-projected only for the running source; the next accepted source forgot
   them. New `session-constraints.ts` reads explicit-memory rows
   (`user_input_received` + `user_steer_note`, detected only by
   `parseExplicitMemoryInstruction`) across the conversation lineage and the
   packet carries them verbatim with the preceding row as `saidBefore` (whole
   items dropped, never clipped); recorded on `agent_context_packet` as
   `sessionConstraints`. A delivered steer instruction also reaches durable
   memory under its own provenance (`user-steer:<seq>`). Durable memory still
   grants no write authority; `explicitRememberKind` unchanged. Pins:
   session-constraints, context-packet, auto-capture, host-turn-runner.
4. **One identity comparison; a never-started Execute keeps its claim.** Every
   producer seals `providerInputSchemaDigest` at registration; the reviewed-plan
   lane compares strictly through `reviewed-provider-identity.ts` at publish,
   revalidate and admit (the three cache-fill tolerances are gone); the host
   attestation minter reads the canonical identity. `canonicalCatalogIdentityOf`
   does not go null on a missing digest (that would refuse local-registry and
   native-MCP calls). `checkReviewedPlanPreparation` runs in `respond-bridge`
   before `admitPlanExecutionBridgeSource`, so a refused preflight creates no
   source, attempt, or claim and the same revision Executes next. v1 tables,
   triggers and the replay contract untouched. Pins: reviewed-provider-identity,
   reviewed-plan-runtime, host-capability-catalog-factory, respond-bridge,
   plan-execution-bridge, plan-execution-ingress, loop, publish-plan
   (behavioural reviewed-CLI pin replaces the source-regex test).
5. **A Plan continuation keeps the parent's disclosures.** `durablePlanningDisclosures`
   accepts the consumed packet's originating and root seqs (undeclined only, one
   policy predicate `continuationInheritsParentCapabilities`); inherited rows are
   re-proved against the current catalog like own rows; the account-blocker
   reader is widened the same way; `session_id` never relaxed. Pins:
   primary-model-planning-card-recovery, publish-plan, task-continuity-runtime,
   tool-search-inherited-account-blockers.
6. **Reads are not write-approval cards.** The installed DataForSEO server DOES
   annotate: named tools `readOnlyHint:true`, the generic request tool
   `readOnlyHint:false, destructiveHint:false` with a `method` enum. The
   classifier now reads an HTTP-method argument signal (`requestMethod`: DELETE
   raises to delete, PUT/PATCH to update, never lowers) and a carrier that
   declares `destructive:false` bounds an otherwise unnamed consequence to
   `ordinary_non_destructive`; the consent policy answers that shape itself with
   basis `exact_carrier_bounded_work` (journaled as `interactive_consent_decided`)
   immediately before the unknown-risk card. The explicit-checkpoint branch, the
   send/delete/admin/bulk floor and the carrier-silent card are byte-identical;
   `execution-gate` still types the frame mutating. Classifier version 3. Two
   fixtures that declared non-destructive on a verbless operation flipped from
   card to proceed by design. Pins: interactive-consent-policy,
   external-capability-risk (+loader), execution-gate, journeys.
7. **Publish batches every structural problem.** The unreachable executionDraft
   disagreement gate is deleted; unique-ID, cycle, subagent and the collection
   complete-read requirement all join one response. Pins: publish-plan.
8. **The heartbeat names only toolkits she asked for.** `CapabilityResolutionEntry.matchedTokens`
   records which of an identifier's own tokens the disclosing query or the
   accepted request contained (memory, disclosed-window, goal-catalog and
   workflow mints all stamp it); `held-inventory` marks a toolkit `named` by
   that or by a read receipt; the progress line lists named toolkits first.
   Ranking and both 20-row cuts untouched. The Platform-49 memory-primer scope
   is DEFERRED (needs write-time provenance on memory rows: a new migration).
   Pins: capability-resolution, held-inventory, run-progress,
   goal-affinity-selection, source-account-routing.

Owner's commit rule (verbatim): do not commit until Act first Salesforce hop is
the attested CLI, Execute produces a tool in well under 30s or a journaled
fallover, and a "remember this subject/list" in the same session still binds
the next request. Live pins 1–8 are NOT yet run on this build; suite result
below.

Suite on this tree: 16,296 tests, 16,287 pass, 3 skipped, 6 red on the first
full run. Three were the direct-write approval-resume pins whose "opaque"
fixture declared `destructive:false` — the carrier-bounded shape that now
proceeds by design; the fixture is carrier-silent again (`destructive: null`)
so the resume mechanics keep a vehicle that still cards, and a new pin proves
the declared-non-destructive variant dispatches once with no card and one
`interactive_consent_decided{basis: exact_carrier_bounded_work, requestMethod:
'post'}` row (host-direct-write 28/28). Two pass alone (nested settlement 3 s
deadline; SIGKILL wait) — the known load flakes. One is pre-existing: the
mobile-queued send that expects to PARK on a human card
(`workflow-runner-v3-call.integration.red`), red before this wave and left for
the owner's decision under the no-approval-cards directive. tsc clean;
public-hygiene passes.

### First live Act on the hotpatched build (02:43 and 02:58 UTC 09-16): the right call, refused as ambiguous

Owner's Act: "Pull 10 accounts I own from Salesforce … DataForSEO … Scorpion
Outlook drafts." The 02:58 turn did what the wave intended: three
tool_search calls, `skill_read`, `plan_task` admitted on the second try, and
the FIRST Salesforce hop was `work_call name=salesforce_sf_soql_query`
(the packet fix, live). The host refused it pre-dispatch:
`catalog_snapshot_ambiguous`. The source's catalog snapshot held THREE
current, callable entries for the operation (same definition, schema,
account, invoke port; three manifest ids), and the exact-entry filter
matched all three. Yesterday's good runs held one — every one of them ran
right after a daemon restart.

Cause (latent, predates the wave): the live materializer scopes a reviewed
read's manifest to the OBJECTIVE, i.e. the wording of the tool_search that
disclosed it (`manifestForAttestation` / `currentOwnedManifests(store,
prefix)`), so reuse and supersede only see manifests under the same wording.
Every differently worded search since boot mints a new `current` manifest
for the same operation (four since the 02:39 boot; sixteen across 09-15).
Two Act runs on one daemon therefore make the pre-dispatch check ambiguous.

Fixed at the check (`host-turn-runner.ts`): exact candidates that share
operation, account, definition, schema version, effect, invoke port and
provider input schema digest collapse to one (`collapseSameCapabilityIdentity`),
preferring the entry this source was shown (`capability_discovered` for the
source), else the newest issuance; different transports, accounts or
definitions stay ambiguous. Pinned in host-turn-runner.test.ts. The
per-wording minting itself is left as is (its retire semantics depend on the
objective scope); a later slice can supersede same-identity manifests across
objectives at publication.

Also seen on the 02:43 run: Terra `model.transport_timeout` after 82 s with
model activity → fallover to Claude (item 2, live) → Claude timed out three
times before content → fallover to GLM; the turn never reached a call. Both
brains dying in the same minute reads as a network event; the rows are
public now, which is the point.

### Live pin 1 PASSED on build 414ad6fb (03:29–03:35 UTC 09-16, session …a559e445)

Act, same wording. Input 03:29:22 → skill_read + three tool_search at
03:29:37 → first Salesforce hop at 03:29:55 was `salesforce_sf_soql_query`
directly (no shell, no `work_authority_unavailable`, no
`catalog_snapshot_ambiguous`); the first query was MALFORMED_QUERY (the
model's SOQL), the second at 03:30:08 returned 10 records. DataForSEO ran as
the named `DATAFORSEO_GET_BACKLINKS_BULK_PAGES_SUMMARY` through Composio —
zero approval cards. `plan_task` admitted at 03:32:27; five
`OUTLOOK_CREATE_DRAFT` writes settled 03:32:39–03:33:24; the completion judge
(gpt-5.6-sol) said 5 of 10; the continuation wrote the other five
03:34:51–03:35:29; second verdict fulfilled. 10 `external_write_succeeded`,
0 `stall_retry_attempted`, 0 `approval_requested`, 6.5 min end to end.
Remaining friction, all advisory: the lighthouse-vs-backlinks search
rankings (three DataForSEO searches), and the model stopping at five drafts
before the judge sent it back.

### Live pin 2, first attempt (03:42–03:48 UTC 09-16, mobile Plan on gpt-5.6-terra): asked which mailbox despite the remembered send default

Plan ran the Salesforce reads, then three Outlook searches nominating the
Scorpion identity came back `account_selection_required / not_entailed`, the
no-progress governor exhausted, and the turn asked "which account?" although
`memory/account-aliases.json` holds `default send account` = that identity
(the owner's own answer on 09-15 23:18). Cause: a nomination that repeats the
send default was nulled and reviewed in `current_source_default` mode (the
09-15 fix), while the judge's instruction says an explicit selection of the
live identity in default mode must return `uncertain` — so wording that
NAMES the remembered account ("my Scorpion Outlook drafts") could only ever be
bounced. Two edits: (1) `resolveSourceAccountRouting` resolves a nomination
that echoes the remembered SEND default itself (`host:send_default_nominated`)
unless the wording names another connected account of the toolkit by its
address or a recorded alias label (recorded data, not prose; reserved default
labels excluded), in which case the judge reviews as before; (2) the judge
instruction: wording that selects the very identity supplied as
`rememberedDefault` is `default_compatible`, not `uncertain`. Pinned in
source-account-routing.test.ts and configured-brain-semantic-port.test.ts
(54/54). Not changed: no-nomination writes still go to the judge with the
remembered default; a write is still consented on its own terms.
Also seen: Plan model calls on Terra ran ~80 s each (five of them) with no
stall rows — the calls completed; that is prompt size, the next slice.

### Live pin 2, second attempt (04:14–04:26 UTC 09-16, GLM 5.3 Plan): no mailbox question; twelve minutes, five publish refusals, published needs_input

The send-default fix held (OUTLOOK_CREATE_DRAFT bound to the Scorpion mailbox
on the first search, no question). What remained: (1) every GLM round ran with
extended thinking on because the harness's "medium" Plan effort mapped to the
wire's binary `thinking: enabled` — 69–115 s per round on 19k–52k-token
prompts, against 5–15 s per round for the same prompts on a Codex brain; now
only the "high" tier switches extended thinking on (`applyGlmThinking`,
pinned). (2) Five `publish_plan` refusals in a row: two "steps/N/id: expected
string, received undefined" (the model omitted the id on its draft step and
did not repair it), one collection-producer repair, one static+dynamic leaf,
and a final `step_patches/0/step_id` missing. A missing step id is now
completed by the host from the step's position (`step_<n>`, never colliding
with an authored id; journaled `guardrail_tripped kind=plan_step_id_completed`);
pinned in publish-plan.test.ts. (3) The governor's final publish produced a
`needs_input` revision (10 steps, one unresolved binding), but the blocked
terminal told the owner "What stopped me: InvalidToolInputError … session_search
… Invalid ISO datetime" — a harmless argument error from nine minutes earlier
that the model had already moved past. OPEN: the blocked-terminal composer
must not name a stale tool error as the stop cause.

Closed the OPEN item above: the stop cause is now the NEWEST tool result of
the source and only when it failed (a provider error, or a host refusal
envelope's message) — `concreteBlockerFromNewestToolResult`, pinned; and when
the loop publishes the retained outline at a blocked Plan stop, the terminal
says "I published the outline as far as it goes (N steps) … It still needs:
<gaps>" instead of "I stopped before publishing" beside the plan card
(`plan_preparation_incomplete` path in loop.ts, pinned in publish-plan.test).

### Live pin 2, third attempt (04:46–04:48 Plan, 04:49– Execute, GLM 5.3 flash): plan in 2.5 min, no question; judge pin unreachable; Execute slow again

Plan published Ready in 2 min 27 s with the Scorpion mailbox bound and no
question (send-default fix + thinking off at medium + host-completed ids).
Two things the owner saw: (1) "Verification note: Configured boundary judge
gpt-5.6-sol is unavailable … turn all-in off" in the chat — the pinned judge
is a Codex id, and a BYO brain's all-in routing keeps Codex ids on the BYO
backend, so by the authoritative-pin rule the judge made zero calls and the
turn failed open; the operator diagnosis was pasted into the reply. Now the
reply carries one plain sentence ("I could not get this result independently
reviewed …"); the reason stays on the verdict row. The remaining fix is the
owner's: pin the judge role to a Claude model (a Claude judge binding
survives all-in). (2) Execute selected effort `high`, which on the GLM wire
still enabled extended thinking: 153 s to the first tool, ~85 s per round.
No harness effort tier switches extended thinking on now; only a caller-set
`thinking` on the body is honored (pins flipped in byo-model.test.ts). Also
noted: three still-pending approval cards on the surface are yesterday's
dashboard parks (16:44/16:54/18:22) from before the auto-consent fix; they
expire today; nothing new was minted tonight.

### Execute on GLM 5.3 flash (04:49–05:24 UTC 09-16), stopped by the owner at 35 min, zero drafts

Tokens: Plan 9 calls / 189k in / 4.2k out / 133 s model time; Execute 28
calls / 933k in (213k cached) / 75.7k out / 2,070 s model time. The output
volume IS the time: extended thinking at ~40 tok/s. Fixed on the next build:
no harness effort tier switches extended thinking on for the BYO wire. Two
refusals cost rounds and now name the door: a reviewed step served by a
different operation ("step X is bound to A; this call names B") and a step
result re-recorded after its consumers ran ("that record stands; continue
from the next unfinished step"). Owner decision (option A): Plan must
validate what it will call — a carrier-bounded, non-destructive generic call
may run once during Plan as a probe and the plan binds the arguments that
worked (slice in progress; design in the session scratchpad
`slice-plan-probe.md`). The plan's SEO step had bound a guessed request path
that returned 40402 at Execute; Plan had no way to exercise it.

### Plan probes carrier-bounded calls (owner option A, landed ~06:00 UTC 09-16)

A Plan turn may exercise once, as preparation, a call the harness would answer
itself as carrier-bounded: external-write manifest, carrier declares
non-destructive, consequence unknown, no send/delete argument evidence, not a
sealed set. Consent proceeds with basis `plan_preparation_probe` and no
coverage requirement (a Plan turn has no expected-work graph); every other
external effect in Plan is refused `plan_mode_external_effect` and surfaces as
the typed PLAN_MODE_READ_ONLY repair, never a card. The Plan gate passes an
attested external write through to consent; the inner bracket seam now
re-runs the gate with the live attestation so a consent-admitted probe is not
re-refused at invoke. The plan reviewer instruction: reads, discovery and
carrier-bounded probes are preparation; a generic-request step whose path and
arguments were neither exercised this turn nor cited from documentation read
this turn is a material gap naming the exact argument; creates, sends and
deletes must still not have run. Pins: interactive-consent-policy,
accepted-task-mode, host-interactive-consent-direct (Plan bounded → proceed +
journal; Plan draft/send/delete/admin/unknown → refuse, 0 dispatches),
host-turn-runner (reviewer text), brackets suite green. Owed: an end-to-end
runner fixture for a Plan-mode probe dispatch (proven at the consent + journal
level and live).

### Plan → Execute on GLM 5.3 flash, thinking off (05:34–05:42 UTC 09-16, session …2ef2d947): END TO END

Plan: 4 min 43 s, 15 calls, 493k in (153k cached), 12k out, 278 s model
time; zero writes during Plan (ten OUTLOOK_CREATE_DRAFT attempts refused
PLAN_MODE_READ_ONLY — wasted rounds, harmless); two publish repairs
(discover-and-cite, schema mismatch) then Ready. Execute: 81 s end to end,
3 calls, 152k in, 1.5k out; plan admitted 35 s after the click, five drafts
settled in 12 s with no cards, `conversation_completed success`. Judge still
failed open (Codex pin unreachable under BYO all-in; owner to pin a Claude
model). Compared with the 04:49 Execute on the same brain with thinking on:
933k in / 75.7k out / 34 min and zero drafts. The probe build (Plan may
exercise a carrier-bounded call) was patched at 05:44; its live pin is the
next Plan run.

### The plan card no longer arrives with a second copy of the plan (~05:55 UTC 09-16)

A published Plan turn's reply was the plan's full text by design (so channels
without a card still get the plan), and the desktop/mobile card rendered the
same full text beneath it — the owner saw the plan twice with the Execute
button in between. `publishedPlanTerminal` now asks `sessionRendersPlanCard`
(the session's recorded source: desktop or mobile) and on those surfaces
replies with the plan's own title line plus one sentence pointing at the card
(and the gaps when the plan needs input); every other channel keeps the full
text. Pinned in host-turn-runner.test.ts; plan-mode/plan-first/publish-plan
suites 67/67. Note for the owner's "wrong SEO data": the plan bound the
backlinks-summary operation because discovery ranked it first for a "keyword
research" query — the known ranking fragility; the probe build lets Plan
exercise the keyword endpoint itself. Duplicate chats after restart: the
stored session table holds each chat once and no branch children were minted
tonight; the repeated titles are repeated runs of the same request; awaiting
the owner's confirmation of the surface and whether two rows open to one
conversation.

### First Plan probe live (06:08 UTC 09-16, Opus 5 Plan, session …33744f3e): admitted, ran, then booked as a write and killed the turn

The owner's novice-style prompt ("I want a prospecting board I can check
every hour…"). Plan read the skill, listed spaces/workflows, read a sibling
workspace's runner and view, searched, ran the Salesforce read (25 records),
and at 06:08:10 consent answered `dataforseo__api_request` with basis
`plan_preparation_probe`; the call ran and the API returned Ok. The write
pipeline then treated the crossing as a mutation: an `external_write`
reservation was minted pre-dispatch, the text result settled
`unknown / mutating:true / stop_and_explain`, the write was marked
`external_write_orphaned (returned_unknown)`, the frame's checkpoint
re-entry exhausted, and the turn ended `exact_checkpoint_admission_exhausted`
("failed with a known terminal result") three seconds after the probe
succeeded. Fix in progress: a probe is accounted as preparation end to end
(no reservation, settlement mutating:false with text evidence, no orphan, no
checkpoint hop); consent journal unchanged. Also seen again: a guessed docs
path (404) before the probe.

### Probe accounted as preparation (patched 06:30 UTC 09-16, fingerprint 09fa5f99…)

A call admitted under `plan_preparation_probe` is now booked like a read
crossing: the invocation kernel derives mutation accounting from the consent
basis (verified against the journaled `interactive_consent_decided` receipt
for that exact call, never the caller's claim), skips the external-write
reservation and orphan projection, and settlement records mutating:false
with the returned text as ordinary evidence (a returned probe never settles
stop_and_explain). The turn proceeds to the next model round. Runner-level
pin: host-direct-write.integration.test.ts drives the production host in
Plan mode through the call_tool carrier (0 external_write / orphaned rows,
consent receipt basis plan_preparation_probe, settlement mutating:false
succeeded, terminal not exact_checkpoint_admission_exhausted, provider text
in the next model input); Act-mode bounded call still settles as a write.
Settlement pin in attempt-settlement.atomic.test.ts (probe+receipt → succeeded;
claimed basis without receipt → unchanged). tsc clean; runner 294/294;
direct-write 29/29; settlement/invocation/consent/brackets 226/226.

Full suite on the 09fa5f99 tree (06:33–06:50 UTC): 16,313 tests, 16,307
pass, 3 skipped, 3 red — the pre-existing mobile-send PARK pin (owner's
decision), and two pins flipped by tonight's contracts and updated: the
closeout pin now asserts the reviewer's reason on the verdict row and a plain
"stands unreviewed" sentence in the chat; the native-admission pin now asserts
Plan mode yields a typed `plan_mode_external_effect` refusal with no nested
admission (18/18 after the edits).
