# Current framework state — September 19

Read this summary before choosing another weekend task. The dated acceptance
ledger is chronological: its opening table is an early snapshot, not the current
backlog. Recheck source ownership and running bytes before patching.

## Scope and ownership

- Shared framework only. No personal/business Space migration, integration
  repair, or personal-memory cleanup. Use controlled named fixtures.
- User reiterated this boundary: “We should only be doing framework work.”
  The installed personal app is the required acceptance environment, not a
  separate app-repair objective. Changes must address reusable framework behavior.
- Installed app/live-home acceptance is required. Never point destructive test
  fixtures or isolated proof provisioning at the live home.
- Shared checkout: `~/clementine-next`, `main`, HEAD `e5a75f5a` with uncommitted
  work. Claude process 80577 was still active here at this checkpoint.
- Preserve the other agent's work and `apps/usage-sidecar`.
- Latest user priority: Clem's native Space creation and workflow creation,
  execution, and run/status tools must be first-class framework capabilities
  she can discover and use. Prioritize this native-tool path next. The user
  plans to run the same question in a simple Claude Code project session later;
  do not launch an unsolicited comparison now. Evaluate whether durable memory
  improves reasoning, reduces repeated explanation/tool work, and achieves
  correct results with better speed/token use. No efficiency advantage is proven.
- Latest verified installed fingerprint:
  `f2ba7a89294d99b4750cb9456491467541335538ef783b5e5ca2ddaf1a04ac7d`.
  App `~/Applications/Clementine.app`, v3.18.17, schema 81/81; direct native
  authoring candidate, reverified through the running build-info endpoint.
  Version/HEAD alone do not identify the patched bytes. Both web trees were
  installed and digest-verified; rollback copies remain.

## Existing bounded evidence — do not restart these investigations

These checks passed on the builds recorded in the ledger. They are not a claim
that every scenario has been rerun on the latest build.

| Framework area | Proven scope | Receipt or ledger section |
|---|---|---|
| Plan/Execute and Act | Exact approved local artifact; reviewed local execution | `plan-execute-result.json`, `act-result.json` |
| Read scope | Three calendar and three inbox repetitions, independent result checks | “Three calendar repeats passed”; `inbox-independent-verification.json` |
| Memory | Capture filtering, correction, fresh-session recall, one cross-project isolation case | `memory-scope-independent.json`; exact synthetic facts soft-forgotten |
| Compaction | Original requirements and exact old tool-result digests recovered; 24 codes survived pressure case | `compacted-result-independent-verification.json`, `compaction-workload-after-independent.json` |
| Workflow recovery | Create, append, overwrite survive one real mutation/receipt crash boundary without duplicate write | `workflow-live-gap-independent-verification.json`, `workflow-gap-{append,overwrite}-verification.json` |
| Space framework | Controlled source transforms and metadata-only config reads | Source-transform and bounded-config sections in ledger |
| Leaner procedure context | Grammar no longer anchors unrelated tools; no-match scoped requests omit irrelevant recency backfill | `scoped-tool-context-result.json`, 7 focused checks |
| Task switching | Read/hold A, complete B, resume A with original filter; repeat A survives app restart | `scoped-context-continuity-result.json`, `retained-review-skip-result.json` |
| Duplicate delivery | Concurrent identical request executes once; completed replay survives clean restart with no new model/tool work; conflicting key returns 409 | `live-idempotency-result.json`, `live-idempotency-restart-result.json` |
| Review reporting | Intentional conversational/retained-context skips are distinct from unavailable review; fresh work still reviewed | `retained-review-skip-result.json` |
| Model reporting | API projects exact-source primary route; recorded real fallback projects Claude, fresh normal response reports Terra | `accepted-response-route-installed-replay.json`, `accepted-response-route-live-evidence.json` |
| UI | Neutral update labels; supported mobile repair prompts; built and served assets agree | `mobile-repair-served.json`; desktop visual checks in ledger |

Receipt filenames above are under `output/weekend-harness-2026-09-19/`.

## Remaining work and limits

**Direct file discovery regression fixed:** the registry now preserves separate
create/append/overwrite planning modes and explicitly declares the workflow's
full-argument recovery semantics. Live source241274 passed concurrent append,
readback, review, completed replay, and replay after clean app restart with one
physical write and no extra model calls. Final-build workflow create/append/
overwrite also passed; the synthetic workflow was restored and disabled.
See `live-append-idempotency-modes-result.json`, `append-restart-result.json`,
and `workflow-modes-final-*-result.json`. A temporary broad-ref candidate was
superseded because it weakened mode distinctions; do not restore it.
The original plain-language query now ranks write_file first (source241382),
after restricting unrelated replacement priority and folding ordinary plurals.
See `discovery-ranking-plurals-result.json`. This is bounded ranking evidence;
broader semantic discovery is not fully qualified.

1. **Broader efficiency comparison.** The same local-read pair used 24,394 then
   23,442 input tokens (3.9% less), but uncached input increased because cache
   hits differed. No general cost win or Claude Code advantage is proven.
   Earlier compaction before/after runs had different tool surfaces and one
   cancelled baseline; do not reuse them as a clean causal comparison.
2. **Long-horizon reliability.** Concurrent/multistep recovery and other crash
   boundaries remain unqualified. Existing compacted-history success is bounded.
3. **Memory quality.** Capture, correction, cross-project isolation, and fresh
   application of paraphrased conventions passed (latest source241518;
   `memory-semantic-independent.json`). Synthetic facts3745–3747 were then
   soft-forgotten. Attribution now confirms both current facts were exposed by
   the main task-ranked fact block; the obsolete rule was absent. Unified recall
   separately retrieves both facts but ranks them19/20 behind six fixed-score
   entity stubs. Next investigate cross-store relevance without enlarging the
   prompt budget or losing roster/identity lookup and supersession safeguards.
   See `memory-semantic-attribution-diagnosis.json`; historical diagnostics are
   not an exact original-turn replay. Long-horizon conflicts remain open.
4. **Physical mobile acceptance.** Served bytes match the candidate; physical
   phone navigation and cache state have not been verified.
5. **Release parity.** A local installed-app hotpatch is proven. Signed release
   packaging and another user's installed app are not qualified. No push or
   release publication has been performed for these changes.
   Subsequent audit fixed missing `builtin-skills` desktop resource mapping and
   added post-pack byte verification (24 packaging checks passed). Installed
   instruction bytes already match. A new signed installer has not been built.
6. **Fresh fallback acceptance.** A recorded real fallback verifies projection,
   while the fresh API check exercised normal routing. Do not force a provider
   outage or change the user's global provider settings just to get this test.

## Measurement rules that prevent repeated false conclusions

- Reuse `scripts/session-comparison.ts::measureAcceptedTurn` and
  `npm run measure:turns`. They read SQLite/usage readonly with exact source
  attribution. Do not write another token-accounting implementation.
- `canonical-framework-measurements.json` contains seven certified recent
  sources. Source 241015 actually used **Claude Opus 5 after Terra HTTP 5xx**;
  source 240995 used Terra. They are not comparable same-model legs.
- API route metadata was wrong for that historical source and was not rewritten.
  Check actual served usage, review verdicts, call counts, tool-schema identity,
  cache state, and completed work when comparing runs.
- Existing broad `scripts/proof` scenarios provision test homes and may write
  synthetic provider or identity state. Audit a scenario before adapting it;
  do not run it against the live home by changing a path flag.
- Clem owns Claude OAuth. Standalone CLI login is not its authentication
  authority. Never equate a substitution or failed-open review with requested
  provider validation.

Full evidence and chronology: [live acceptance ledger](2026-09-19-live-acceptance.md).

## Memory candidate failure and follow-up

The named-entity recall ranking candidate is **not accepted**. Fresh live
source241642 exposed two paraphrases of the original synthetic preference.
Correction superseded only one; the reviewer used the surviving obsolete copy
and changed an initially correct answer into an incorrect one. Investigate
framework duplicate capture and correction handling before requalifying ranking.
Do not solve this by cleaning up the user's personal memories.

Evidence: `memory-semantic-fixed-failure.json`. Only synthetic test facts
3748–3751 were soft-forgotten (`memory-semantic-fixed-cleanup.json`). Installed
daemon assets were rolled back (`named-entity-recall-rollback.json`); runtime
fingerprint ae71fabaf was subsequently confirmed on daemon49950. Later patches
below supersede that rollback. Do not restore the original b706 ranking-only
candidate or mistake its historical ranking check for fresh acceptance.

The framework now supplements semantic conflict lookup with unembedded lexical
candidates, using the embedding coverage snapshot from before the async query.
Unknown similarity prevents the novelty fast path from silently adding a fresh
duplicate. A partial correction surfaces still-active related candidates to the
foreground caller; it never automatically retires every related fact. Curated
wording such as “replaces the previous” and “supersedes the prior” preserves
explicit correction intent. Nine pure checks and the builds passed.

Live four-stage source241666/241695/241737/241767 on dbf5800b passed: one original
fact, one corrected successor, neighbor preference intact, correct fresh answer
with Sol review. Final answer survived restart on 41278543 (source241788).
The controlled installed-module partial-correction check preserved both the
remaining duplicate and complementary fact while reporting unresolved candidates.
This used an injected resolver, not provider validation.

A full pre-existing duplicate test then FAILED on 41278543 (source241809): the
tool paraphrased the correction without the literal word “Correction,” bypassing
the notice. After the wording fix, source241853 on current26b05a86 passed: both
obsolete synthetic copies3763/3764 inactive; complementary timestamp fact3765
active; corrected fact3766 active. The host exposed the residual conflict and
the brain explicitly soft-forgot only3764. Sol reviewed successfully. Actual
usage: 7 Terra and 4 Sol calls, 106,415 input / 38,016 cached, 50,215ms. This is
correctness evidence, not an efficiency win or proof that all duplicates resolve
automatically. All test facts3752–3766 were soft-forgotten with exact-ID receipts.

Ranking remains incomplete: the automatic primer on source241767 included the
Cedar rule but not Quartz; the final answer was still correct. Do not claim that
both rules were supplied by unified recall. The next memory work is broad scope
precision and reliable correction intent beyond lexical paraphrases, followed
by completing fact relevance ranking without increasing the context budget.
Related-candidate notices can include other projects; they are suggestions for
comparison, not authority to erase them. No personal memory cleanup is in scope.

Receipts: `memory-coverage-live-evidence.json`, `memory-coverage-restart-evidence.json`,
`memory-partial-correction-result.json`, `memory-duplicate-live-events.json`,
`memory-duplicate-wording-evidence.json`, and their corresponding cleanup files.

## Native-tool priority: actual surface gap, rejected keyword promotion

Installed read-only surface audit confirms ordinary fresh Space creation,
workflow create/run, and run-status queries expose no matching native schemas
through resolveHotSet. Authoring schemas are large: workflow_create18,753 bytes
plus2,574 description bytes; space_save10,694 plus7,354 description bytes.

A bounded lexical product-family promotion was tried as c1805deb and rejected.
Although short pure cases passed, the real longer request selected
workflow_schedule from the prohibition “no schedule,” and omitted workflow_run.
Also orchestrator.ts visibleFirstClassNames removes plan-bound local mutations
on carrierWork turns, so hot-set promotion alone cannot expose native creation.
Source helper/test were removed; prior plural ranking edits preserved. Installed
assets rolled back to26b05a86 and runtime fingerprint reconfirmed. That stale-dist warning was superseded by the subsequent fb8583b8 build below.

Live source241939 created and repaired a synthetic workflow but did not execute:
/api/message binds channel=webhook, which lacked a workflow report-back target.
The tool correctly refused before queueing. This is not evidence of a desktop
workflow-run failure, and should not be “fixed” by bypassing reply-target binding.
Use the actual desktop chat endpoint POST /api/harness/chat, with clientRequestId,
attachments, and optional taskMode:{version:1,kind:'normal'} for chat-launched
background workflow acceptance. A successful initial response is HTTP202;
follow its session/run identity rather than resubmitting.

Desktop source242076, session sess-desktop-c9223b1535971f7f546b7fb3, directly
called workflow_get and workflow_run on the restored build. Exactly one child
run1789859134707-730a15 completed; file content independently matched; goal review
passed with judgeFailedOpen=false; workflow report-back delivered to the source.
Synthetic workflow harness-native-firstclass-1789858855239 was then disabled.
See native-workflow-desktop-result.json and native-workflow-disabled.json.

Next: solve native authoring affordances at the actual carrier/surface boundary,
preserving normal and reviewed execution receipts. Do not substitute another
keyword-based operation selector or claim that catalog membership proves a
model-visible callable. Verify the actual model surface, full natural request,
native creation, run/status, and desktop report-back. Compact schema cost matters;
no speed/token advantage is proven. The workflow report-back currently exposes
raw receipt internals in its reply; record that as a shared UX issue for later.


## Direct native authoring candidate — latest live finding

Framework-only scope reaffirmed. Shared main remains e5a75f5a; Claude process
80577 is alive. User-owned usage-sidecar work is preserved. No benchmark win
or broad acceptance is claimed.

Installed fb8583b8 adds stable native product tools to the first-class catalog.
Normal-mode carrier visibility exposes space_save, workflow_create and
workflow_update. Host-bound current tool definitions prepare exact calls and
retain execution/consent receipts; missing authority fails closed. Plan and
reviewed Execute retain their existing path. No prompt-keyword promotion.
New native-product-surface.ts and direct-native-preparation.test.ts accompany
changes to tool-catalog, orchestrator, host-local-call-preparation and
host-turn-runner. Three pure preparation checks and the backend build passed;
installed daemon and both web asset trees were hotpatched with rollback retained.

Desktop source242121, session sess-desktop-06e46a7e2a9e55774abd8518, directly
called workflow_list, workflow_create, workflow_get and workflow_run (no generic
discovery/dispatch wrapper). Exactly one child1789859807131-49021a ran the saved
literal transform and returned NATIVE_DIRECT_OK. However final workflow outcome
was BLOCKED/needsAttention: inferred legacy goal review objected to the framework's
Markdown step heading around the exact result. The desktop received the result
plus this warning. This proves direct native creation and dispatch, NOT clean
end-to-end acceptance. Investigate goal evidence/presentation mismatch without
weakening review. There was no explicit authored goal in this fixture.

Synthetic workflow harness-direct-native-1789859774727 is now disabled and kept
for review. Evidence: native-direct-chat-final-events.json,
native-direct-chat-progress.json, native-direct-current-build.json,
native-direct-disabled.json under output/weekend-harness-2026-09-19/.

Next: resolve shared result/review formatting mismatch, live-test direct Space
creation and workflow update/status, and verify Plan/Execute parity. Native schema
size and broad workflow_list before unique creation are efficiency concerns.
Memory correction has bounded live proof; recall ranking and scope precision
remain incomplete. User's later Claude Code comparison should measure correct
completion, total/cached tokens, latency and repeat explanation across fresh,
warm and memory-assisted sessions; no unsolicited comparison is running.


## Native product tools and delivered-result review — live continuation

Latest installed fingerprint 0291d8a020072f9e425d65bab8deba160273542d5809e3c48507768f9b81f234
supersedes fb8583b8. Both webtrees installed/digest-verified; backups retained.
Shared main remains e5a75f5a; other Claude process80577 alive. No commits/push.

Fixed workflow target review input: JudgeWorkflowTargetInput.deliveredBody carries
the actual host-rendered baseSuccessBody, while authenticated execution evidence
remains separate. Internal step headings no longer masquerade as delivered text.
28 pure objective-judge checks passed, including exact literal output and a wrong
delivered output despite a correct internal rollup. Build passed. On installed
c1d15e29, source242179/session sess-desktop-c3dcd7fa3050d3145293562f directly
created and ran workflow harness-direct-native-1789860224322. Exactly one child
1789860260424-44bf15 succeeded, returned NATIVE_DIRECT_OK and delivered that exact
text without the prior warning; completed verdict reviewed/verified. The fixture
was disabled afterward. Measurement: 145212 input,33792 cached,52318ms,5Terra+3Sol.
This is bounded correctness proof, not efficient performance or broad qualification.

Initial Space source242194 on c1d15e29 saved correct static desktop/mobile data
but took4 discovery calls and used work_call for space_save. The first-class
schema was present; native-authoring-catalog still instructed discovery for it.
Removed already-visible tool names from that deferred-authoring catalog, built
and hotpatched 0291d8a0. Fresh source242345/session
sess-desktop-ddd71444f69f29c8caf7a076 used skill_read, direct space_save, then
one tool_search and space_preview for verification. Saved Space
harness-direct-space-1789860419557 contains both pending checklist items in HTML
and _mobile, dataSources/actions empty, no automation. Sol completion review
passed. This verifies stored mobile content, not physical phone rendering.
Earlier saved fixture harness-direct-space-1789860237996 remains for review.
Measured initial vs fresh:391946→152456 input,63104→64512 cached,
101574→50898ms;7→4 canonical calls. Different fresh sessions/model behavior;
this observed improvement is not a controlled benchmark or general cost win.

Source242360/session sess-desktop-27670c7d4471166904b4fad5 directly used
workflow_get, workflow_update, workflow_run_status. Independently read saved
workflow: only requested description changed, enabled=false, manual trigger and
literal step retained. Existing child status/result correct; no rerun requested.
Sol review passed.96367input/44544cached/41823ms;4Terra+1Sol.

Receipts: native-deliverable-review-{tests,build,hotpatch},
native-deliverable-retest-{events,run,measurement,disabled},
native-catalog-consistency-{build,hotpatch,assets},
native-space-{chat,retest}-{events,measurement}, native-space-retest-stored.json,
native-workflow-update-{events,measurement,saved.md} in weekend output.

NEXT: Native schemas currently contribute ~28137 estimated prompt tokens even
for simple tasks. Reduce schema/description overhead while preserving first-class
usable native capabilities, no keyword routing or hidden execution policy bypass.
Preview still needs discovery; consider an intentional compact native product
surface. workflow_step_result in the always-loaded list is a worker output channel,
not a run-result reader (not exposed in these orchestrator policies); remove the
misleading catalog entry during next surface cleanup. Workflow run status already
returns step results. Revalidate Plan/Execute parity for the changed surface,
then continue memory relevance/scope work. User's Claude comparison remains later.
Framework-only, live-home acceptance, no isolated/reset fixtures remain binding.


## Compact native guidance — installed/live verified

Installed fingerprint c4138b0d4414480d9c9e24901668da88f3d4cbbdd09fc659f305656c650fd9d0.
Build and3 pure native-preparation checks passed. Both web assets recopied with
digest verification and rollback retained. Shared main e5a75f5a/Claude80577 unchanged.

space_save root guidance condensed7354→2798bytes; retained mobile shape,
static atomic commit/revision rules, sandbox/approval constraints and preservation.
workflow_create no longer demands workflow_list before every creation; duplicates
already reject without changing existing definitions. Removed workflow_step_result
from always-loaded list: it is the worker result submission channel, not a reader.
Installed-before vs built-after parameter schemas are deeply equal for all3 native
authoring tools (native-guidance-schema-comparison.json). Prompt composition's
estimated tool schemas fell28137→26879tokens,1258 fewer per model call. This is
still large and parameter schemas remain the main overhead.

Live desktop workflow source242448/session sess-desktop-2725f44d5c13acd19226c58a:
direct workflow_create,get,run; no list or discovery. Exactly one child
1789860796382-2a8e51 succeeded and delivered NATIVE_DIRECT_OK; fixture
harness-direct-native-1789860762017 disabled afterward. Canonical measurement:
96255input/15872cached/44335ms,4Terra+2Sol; prior comparable request145212input,
33792cached,52318ms,5Terra+3Sol. Observed reduction; not controlled benchmark.

Live Space source242452/session sess-desktop-ce1e2a5c32a83c4e3e960faa:
skill_read then direct space_save only. Completion reviewSol passed; independently
verified savedHTML and_mobile contain both requested pending items, no sources or
actions. Fixture harness-direct-space-1789860762017 retained.86977input/14464cached,
44273ms,3Terra+1Sol. No space_preview call this time; stored content was independently
read, physical phone/rendering still unverified. Do not claim all speed improvement
is from description shortening: call choice and provider behavior differ.

Receipts native-guidance-{compact-build,compact-tests,compact-hotpatch,
compact-assets,schema-comparison}, native-compact-{workflow,space}-{events,
measurement}, native-compact-workflow-{run,disabled}, native-compact-space-stored.
Next: Plan/Execute surface parity and memory relevance/scope; further schema
reduction must preserve supported authoring contracts, not replace inputs with
opaque strings or keyword selection. No broad efficiency/Claude comparison claim.


## Native workflow Plan → Execute acceptance on c4138b0d

Live desktop session sess-desktop-a5684ea2c56d1d88b3f43cf9:
Plan source242537 published ready plan-00571b20-53b0-4161-9b65-696f3c61222f,
revision1,digest51367a3eaad4d201d893d5e133799d737c1ecb7713dd1cabf5d9666b00d759b6.
Reviewed exact static arguments: single literal PLAN_NATIVE_OK step, no external
calls/resources, manual-only, no execution. Independently confirmed definition
absent before Execute. Planning tool calls were discovery and publish_plan only.

Execute source242577 applied reviewed operation create_manual_test_workflow via
work_call. Saved definition harness-plan-native-1789860936276 matches the plan;
workflow_get readback and Sol completion review passed. No workflow run records
exist for this fixture. Replayed the same desktop execution request/id: returned
replayed=true and original runId, one distinct creation call after replay.
Fixture disabled after acceptance, retained for review. No source changes or
hotpatch in this continuation; installed c4138b0d remains current.

Receipts native-plan-workflow-{start,response,events}, native-plan-execute-
{request,response,events,replay}, native-plan-independent-verification,
native-plan-disabled, native-plan-measurement-{242537,242577} in weekend output.
This is workflow authoring parity, not all Space/graph/recovery coverage.
Execute still did a tool_search for already-exposed workflow_get before direct
readback; record redundant lookup as efficiency issue, not correctness failure.

Memory follow-up source inspection: explicitCorrectionSubjectKeys captures only
one token after project/account/etc, so names sharing a prefix (e.g. Harness)
can look compatible. Do not make project isolation depend on this lexical shortcut
or retire facts from a guessed name. Next inspect stored entity links and scoped
candidate evidence before choosing a correction/retrieval fix. Existing primer
ranking still incomplete and no general memory-quality claim is justified.


## Neighbor-first memory acceptance; grounded identity defect narrowed

No source changes/hotpatch; installed c4138b0d remains current. Live four-stage
fixture1789861204041 saved Cedar bounds-first3769, then Quartz bounds-first3770,
then corrected only Cedar.3769 superseded by3771;3770 remained active unchanged.
Fresh application returned exactly Cedar:18(14–23), Quartz:40–51(44). All4 Sol
completion reviews fulfilled. This ordering is stronger than prior correction-
before-neighbor case. No wrong cross-project correction was reproduced.
Exact synthetic facts3770/3771 soft-forgotten after evidence;3769 alreadyinactive;
all3inactive confirmed. No personal-memory cleanup.

However direct fact-entity capture conclusively overclaims identity:3769 links
as extracted to3 Cedar identities and an older Harness Cedar Observatory timestamp,
plus its actual current canonical project4565.3770 similarly links to older
Quartz test-project identities plus actual4566. Shared short aliases explain this.
1069 project fact edges have extracted/source evidence overall (an initial query
for literal link_type='stored' was invalid: stored is a presentation truth label;
actual table uses extracted/inferred_text). Do not treat all graph links as
unambiguous project authority or prune correction targets using them blindly.

Relevant source: facts.ts captureDirectFactEntityLinksBestEffort uses
resolveEntityIdsForText(fact.content,8), then marks every returned alias/name
match extracted at full fact confidence. relations.ts resolver matches aliases
without ambiguity filtering. Next implement grounded direct-link selection:
full canonical-name evidence must outrank overlapping shorter aliases; ambiguous
aliases must not create multiple stored identity assertions. Preserve potential
recall matches as inferred, do not delete existing owner links or infer subject
identity from a project-name first token. Add pure matching checks and validate
new synthetic facts in installed/live home. Then revisit correction notices and
ranking using trustworthy scoped candidates.

Receipts memory-neighbor-first-{application-result,entity-evidence,events,
cleanup}.json and live.txt. Script first attempted Electron with repo-native
SQLite and failed ABI loading before requests; reran under Node22 successfully.
Terminal process10792 completed0; no running test or unfinished stage.


## Grounded direct-memory entity mentions — implemented and live accepted

Latest installed fingerprint64a29b52d3f755c705621e7f56ed672222f7468356862209d23f69753dab79a3.
Backend build and7 pure matching tests passed; daemon and both webtrees patched
with rollback. Shared main e5a75f5a and Claude80577 preserved, no commit/push.

New grounded-entity-mentions.ts selects nonoverlapping maximal name mentions,
rejects same-span shared names/aliases across identities, and keeps independent
short mentions elsewhere. relations.ts matcher cache retains names and new
resolveGroundedEntityIdsForText requires a unique mention in BOTH fact content
and surviving evidence excerpt; result limit is applied after disambiguation.
facts.ts direct capture now uses this resolver. Broad recall alias/identifier
matching remains intact; this change governs new stored name-backed assertions.
Identifier-only direct claims no longer get a stored link from name matching;
identifier recall remains available. No bulk repair of existing links performed.

Installed read-only resolver against live identities: exact Harness Cedar
Observatory1789861204041 matched broad ids3873,3955,3958,4557,4565 but grounded
only4565; ambiguous Cedar alone matched no grounded identity. New real chat
probe-grounded-entity-1789861553649 created fact3772 for the requested archive
prefix CedarTrial. Independently read DB: exactly one extracted source-backed
edge, entity4565; no older project/short Cedar identities. Sol review242809passed.
Fresh session probe-grounded-recall-1789861613279 returned exactly CedarTrial,
Sol review242830passed. Exact synthetic fact3772 soft-forgotten afterward and
active=0 confirmed. This is bounded new-write/link/recall proof, not blanket
historical graph repair or general correction-scope completion.

Receipts grounded-entity-mentions-{tests,build,hotpatch,assets},
grounded-entity-installed-result,grounded-entity-chat-{start,result,evidence,events},
grounded-entity-recall-{start,result,events},grounded-entity-cleanup in weekend output.

Remaining memory work: correction-related candidate notices still use lexical
project-prefix relation, old links can remain ambiguous, broader reflection and
backfill link admission need review, named-entity primer ranking still incomplete.
Do not now trust every historical extracted edge as an unambiguous scope anchor.
Continue precision/ranking with actual source evidence and bounded context.


## Automatic primer coverage for two named projects — live improvement

Latest installed86402bb62b6699fdc44f26edfc5d37a0eedce0b637a371ba65146cf3a1e1a844.
recall-memory.ts now puts unambiguous grounded mention IDs before broad alias
IDs within the SAME perStore limit, and reduces incidental alias-only entity
scores when unambiguous mentions exist. No hit/context budgets increased; broad
recall candidates remain available. Eleven focused matching/ranking checks and
build passed; daemon and both webtrees hotpatched/digest-verified with backups.

Read-only pre-fix exactquery with two fully named projects returned8 broad IDs
but omitted Quartz4566. Grounded lookup included4565 and4566. Earlier automatic
primer had only Cedar current fact plus short/older entities. Receipts:
recall-entity-crowding-before.json, recall-entity-priority-{tests,build,hotpatch,assets}.

Live four-stage fixture1789861904594 saved Cedar3773 and Quartz3774, then corrected
Cedar3775 (3773retired,3774preserved). Fresh final response Cedar18(14–23),
Quartz40–51(44); all4 Sol reviews passed. Crucially automatic_primer
mr-501bda9a-eeb7-4a84-8123-53462463fa32 includes BOTH current fact refs3774/3775
among6returned hits. This closes the previously observed two-rule primer gap for
this bounded case. No extra recall tool was needed. Same unchanged context cap.
All synthetic3773–3775inactive after exact-ID cleanup.

Remaining defect found during new-identity admission:3773 initially linked old
entity4557 via its unique alias 'Harness Cedar Observatory' BEFORE new canonical
entity4567 was registered; later new full identity link appeared too. The prior
64a29 fix passed for an already-known canonical identity but does not solve this
new-identity timing case. Preserve this limitation, do not claim historical graph
repair or complete identity isolation. Evidence memory-primer-both-links.json.
Next examine direct alias grounding when no complete canonical identity exists:
ambiguous/new names should remain candidate evidence, not confident stored links
to an old project. Revisit reflection/backfill admission and correction scope.
Primer also still admits weak unrelated entity/deliverable hits; relevance remains
an efficiency target without simply growing context.

Receipts memory-primer-both-{application-result,recall-evidence,links,events,
cleanup}.json and live.txt. Script97990terminal0; no active test. Shared main
and other-agent edits preserved. No commits/push, no model comparison claim.


## New-project alias timing — installed/live fix

Latest installed eae80719f0a19c4b77fcf28ca42f1bac9554581563c737779db2c1867404c726.
Added canonicalOnly selection to grounded-entity-mentions/relations; matcher cache
retains canonical name. Direct fact capture requests canonical-only proof in both
claim and surviving source excerpt. Aliases still participate in longest-span
ambiguity resolution BEFORE admission, preventing an old longer alias from
exposing a nested unrelated short canonical name. Broad recall and grounded
recall prioritization keep alias candidates; no additional model call introduced.
Alias-only direct claims await normal entity extraction for stored identity links.
13purematching/ranking checks andbuild passed. Daemon andbothwebtrees installed,
digestverified, rollbackretained. Sharedmain/otheragentedits preserved.

Live new project Harness Cedar Observatory1789862279505, source session
probe-new-project-identity-1789862279505: new fact3776 for archive prefixCedarTrial
has exactlyone extracted link to new entity4569, both early and final DB snapshots.
No priorproject/shortalias link. Entity extraction established correctfullidentity.
Fresh session probe-new-project-recall-1789862314953 returned exactlyCedarTrial.
Sol review243000 and243021fulfilled. Exacttestfact3776softforgotten;active0verified.
This accepts the reproduced unknown-new-project timing case. It does not certify
all reflection/backfill identity paths or repair historical wrong links.

Receipts new-project-identity-{tests,build,hotpatch,assets,chat-start,chat-result,
early-links,final-evidence,recall-start,recall-result,events,cleanup} in weekend output.
No active test handles:51408 and88498terminal0. No commits/push.

Next: inspect correction-related notices for cross-project noise using canonical
source evidence, not historical links indiscriminately; review broader reflection/
backfill link grounding before claiminggraphidentitysoundness. Primer relevance
still contains weak unrelated entities/deliverables and tool schemasremainlarge.
Preserve full framework backlog, liveacceptance requirement, later userbenchmark.


## Deliverable primer relevance — live candidate with review limitation

Latest installed73d3eb3b9424a5adf25f18f0df46c2367860e6a0dbe08ea90ceb0cb4e594a528.
New deliverable-recall-score.ts preserves raw index relevance instead of adding
0.55+0.4*score; ambient deliverables below0.45 omitted, targeted recall remains
broad. Relevant missing files retain capped0.4 negative evidence (admit before
missing-file confidence cap). deliverable-index.ts gives exact target/filename
matches score1 regardless of surrounding prose; boundary checks reject prefixes.
Sixpurechecks/buildpassed, daemon+bothwebtrees installedwithrollback.

Initial d7962166 candidate removed irrelevant hits but FAILED natural-length
exact-filename primer recall: correct answer came from other context, no direct
file ref in automatic primer. Fixed exact-target scoring before accepting that
behavior; do not reuse initial correct answer as passing primer evidence.

Installed-module live-home comparison: unrelated two-project query deliverable
hits6→0; final natural-language exact filename query returns1 correct artifact;
targeted broad query retains6candidates. Final fresh public chat session
probe-deliverable-primer-1789862864825 returned correct existing local path with
zero tool calls. Crucially automatic_primer contains exact file ref now; filesystem
existence independently checked. However completionReview=enabled_unavailable,
no completionVerdictRef on both initial/final chats: NOT a successful provider
review. Treat this as bounded independent recall/content proof, not reviewed
completion or broad acceptance. Investigate framework review-disposition reason
if relevant; do not alter personal auth/config to make the test green.

No fixturefacts created/modified in this test; saved artifacts unchanged. Runtime
schema/tool/memory budgets unchanged. No global token/speed/Claude comparison claim.
Receipts deliverable-primer-{before,after,final}, deliverable-primer-score-
{tests,build,hotpatch,assets}, deliverable-exact-target-{hotpatch,assets},
deliverable-{primer,exact}-chat-{start,result,events,recall} in weekend output.
Final process64156terminal0; no unfinished test. Sharedmain/Claude80577preserved.

Remaining: primer unrelated entity relevance, semantic deliverable matches across
long task prose (threshold tradeoff requires broader coverage), correction scope,
reflection/backfill graph admission, reviewed UI/mobile/release backlog. Exact
artifact matching was added to prevent the known false negative; do not simply
lower all scores further or claim comprehensive relevance solved.


## Lookup review disposition corrected; real read remains reviewed

Latest installed f2ba7a89294d99b4750cb9456491467541335538ef783b5e5ca2ddaf1a04ac7d.
The prior lookup's enabled_unavailable was NOT a provider outage: classifyMessageIntent
returnedlookup/actionIntentfalse; path reply triggered claimedCompletedWork=true.
Existing shouldRunObjectiveJudge correctly skipped this non-action/no-work turn,
but completion-review-skip metadata refused to describe it. Added narrowly bound
non_action_without_new_work reason when other conversational skip conditions hold.
No review eligibility or execution gate changed. Skip remains source/objective/
reply-digest bound and never certifies content.4purechecks/buildpassed;daemon and
bothwebtreeshotpatchedwithrollback.

Live source243066/session probe-lookup-review-1789863145572: correct existing path,
0tools, exact completion_review_skipped243082record, terminalcompletionReview
not_required/captured (not reviewed or unavailable). Gate recorded allsourceeffects0,
noattemptedwork, actionIntentfalse, claimedCompletedWorktrue. Actual currentgate
metadata verifies diagnosis, not only reconstruction.

Countercheck session probe-lookup-action-1789863191347 explicitly read current
file once: read_filecalled, NATIVE_FRAMEWORK_OK returned, Sol review243110fulfilled.
Independentdiskcontentmatched. Thus realreadworkstillreviewed;0toollookupskip
metadata does not waive it. No userfiles/memorychanged.

Receipts lookup-review-disposition-{tests,build,hotpatch,assets},
lookup-review-{chat,action}-{start,result,events} inweekendoutput.
Bothprocess44722/4555terminal0. Prior73d3 recallproof remains independentlyvalid;
its review-unavailable label was a metadata mismatch, not successfulproviderreview.

Next return to framework acceptance backlog: correction-scopeprecision and broader
memorygrounding, nativeSpacePlan/Execute parity, longhorizon/multisteprecovery,
physicalmobile/releaseparity, and meaningful efficiencymeasurement. No broad
completion claim or unsolicited Claude comparison; user's benchmark remainslater.


## User priority reaffirmed; Space Plan ready, Execute pending

User reaffirmed framework-only work: first-class native Space/workflow creation, execution and status; useful durable memory; speed and token efficiency. User will later compare the same question with a simple Claude Code instance. Do not claim that advantage before matched measurement. Preserve usage-sidecar work.

Space Plan source243115/session sess-desktop-f67759c8e0ba5e8fd483f0ff completed with actual Sol review243164 fulfilled. Published plan-fbc1ce6b-3058-4c1a-be48-8fe717a223dc revision1 digest71a0acbec4eeab4524b7689307a77af10cd4f30c385860d5f64bc046a911be93. Independent live-home check confirms harness-plan-space-1789863281227 absent before Execute. Exact reviewed plan contains one static space_save and two previews, matching desktop/mobile stored content and no sources/actions/automation. Execute has NOT yet been submitted; do not claim end-to-end Space Plan/Execute passed. Events saved in native-plan-space-events.json.


## Space Plan → Execute live acceptance; preview transport follow-up

Installed f2ba7a89294d99b4750cb9456491467541335538ef783b5e5ca2ddaf1a04ac7d.
Session sess-desktop-f67759c8e0ba5e8fd483f0ff: Plan source243115 left fixture absent;
Execute source243173 completed243287, actual Sol review243273 fulfilled.
Space harness-plan-space-1789863281227 saved once via reviewed work_call/space_save;
transport mirror shares same call ID. Independent disk comparison: exact reviewed
HTML and initial data including _mobile, version1, empty sources/actions. Fixture
retained. Same clientRequestId replay returned original run desktop:d0d2043f38ae227c9b50d1cd7a824afb626f9a9d, replayed=true.
Receipts native-space-execute-{request,response,events,replay}.json and
native-space-independent-verification.json under weekend output.

LIMITATION / NEXT FRAMEWORK ISSUE: space_preview produced image-bearing results,
but work_call returned a JSON text digest omitting the image; model used two extra
tool_output_query calls which returned base64 inside text. Rendering success does
not prove visual inspection. Narrow desktop preview does not prove physical mobile.
Inspect multimodal image transport across reviewed work_call and result formatting;
fix generic first-class image result handling rather than prompt-specific workaround.
No speed/token superiority claimed. Memory reflection/backfill identity and correction
scope, long-horizon recovery, UI/mobile/release coverage remain open. No source edits
or hotpatch this turn; current installed build tested. User usage-sidecar preserved.


## Media carrier patch installed; read-only Execute does not qualify it

Changed src/tools/work-call.ts to preserve successful isToolMediaContent arrays
before JSON.stringify, guarded by !frame.refusalKind; refusal semantics unchanged.
Changed work-call-mcp.ts to return media content blocks. Existing call_tool and
host-turn-runner already support images. Two pure media-recognizer/projection tests
passed; build passed; installed fingerprint
0b298e10dc02c62b42de5450fa9662ac7ec3597c4a5d92c58d611e84a50f1ba3.
Daemon+bothwebtrees backed up and patched; readiness fingerprint verified. No live
leases at quit. Other Claude80577 alive/sharedmain; usage-sidecar preserved.

Live read-only preview Plan session sess-desktop-71d2e986d52b36907f302c6c,
source243288, plan-ab68cefe-a842-4d28-baef-68081f310750 rev1 digest
041281dbe6a8fffdae7f6963aa91db1fde8fe27b3211417755b25c0023b678d3.
Execute source243335/run desktop:0a2c424ded202e88c7bb83bb7f64584f563cc330
completed243397; Sol243393fulfilled. Report described readable labels, Pending
badges/right-aligned status. NO tool_output_query/base64 rereads, but preview ran
through call_tool after work_call refused plan activation. THIS DOES NOT validate
changed work_call media path or Claude adapter. Do not claim that patch accepted.

Next: qualify actual work_call media path with normal action Plan/Execute fixture
(as prior Space creation + previews), inspect accepted provider image history.
Also investigate read-only Execute surface inconsistency: orchestrator deliberately
withholds plan_task/plan_step_result when reviewedReadOnlyExecution, while work_call
still refuses without plan_task; prompts/model attempted both missing controls and
wasted searches. Preserve read-only semantics, fix coherent surface/steering rather
than gratuitously activating business graphs. Current run terminal, do not restart.
Receipts work-call-media-{tests,build,hotpatch,assets}, media-preview-{plan-start,
plan-response,plan-events,execute-request,execute-response,execute-events}.
Broader original framework/memory/efficiency/recovery/UI scope remains active.


## Media action qualification uncovered plan-repair friction; continuation active

Current INSTALLED remains0b298e10dc02c62b42de5450fa9662ac7ec3597c4a5d92c58d611e84a50f1ba3.
SOURCE/DIST now also contain uninstalled orchestrator guidance branch for
reviewedReadOnlyExecution: explicit direct read/call_tool path, no plan_task or
plan_step_result, no reviewed-step work_call requirement IDs; compute findings
synthesized directly. Existing action-plan instruction unchanged. Build passed
(process35268terminal0), receipt readonly-execute-guidance-build.txt. Not hotpatched.

Media action Plan session sess-desktop-82c6f967223ccb3c70d47805 source243398
fixture harness-media-space-1789863972809. Plan repaired static/dynamic slug conflict
and mobile record format; Sol243476 rejected max-width760px centered layout per
workspace-builder. Model repaired width:100%, but plan_review_budget_spent rounds2
at243484 cut off re-review. Terminal243493 blocked, not a passing plan. Saved
plan-b2c442fd-cae4-46bc-9857-5478e040c4e7 rev1 digest
db69daf8551e2b0cb0877e094c67017ce7d7ad7c06e3fb22e9e1f41992e54f90.
Do not execute stale unverified plan blindly or count this as media acceptance.

ACTIVE followup same session, run desktop:66d1b037f3b35c21ffeba5abd5c7e28f0a120620,
HTTP202 accepted; asks review current repaired revision, publishready, no creation.
Poll this exact run; don't resubmit. Receipts media-action-plan-{start,response,events,
followup-request,followup-response}.json. Next inspect fresh reviewed plan, execute
matching localfixture, verify actual work_call image history/no base64 rereads.
Then hotpatch built read-only guidance when idle and qualify that independently.
Two-round repair cutoff is additional framework recovery/efficiency issue, not
proof that user action is required. Original broad goal remains incomplete.


## Reviewed work_call images LIVE PASS (Codex); pending read-only guidance patch

Installed0b298e10dc02c62b42de5450fa9662ac7ec3597c4a5d92c58d611e84a50f1ba3.
Followup source243494 passed Sol243525; currentplan plan-b2c442fd-cae4-46bc-9857-5478e040c4e7
rev2 digest2ed0e9a5f9ac9a31b1a03ffdf61cbeec812e480b4493d7f5146d61d044619c6d.
Execute source243535/run desktop:6f7f699f779c1de46e801a302693c743cd5dfd5a completed,
Sol243633fulfilled. Same session sess-desktop-82c6f967223ccb3c70d47805.
Space harness-media-space-1789863972809 created version1, empty sources/actions,
mobile records Native tools/Memory scope verified. Retained fixture.
CRITICAL evidence: sessions.metadata_json.__conversation.items has two work_call
function_call_result outputs with input_text + input_image, calls
call_HvIq44CB13QlvIVNPuyLwhVY and call_qL2yYxPPWd0hpRcpYGhuz9Ib.
No tool_output_query/recall_tool_result in Execute. Text event records name image
instead of base64. Saved actual image bytes from accepted history, inspected narrow
preview independently: readable labels and Pending badges, unclipped. These are
actual model images, not inference from a successful renderer or reply.
Receipts media-action-{followup-events,execute-request,execute-response,execute-events,
image-history}.json, media-accepted-call_*.png. Claude adapter remains unqualified;
physical mobile app not qualified by narrow desktop image. No broad speed/tokenwin.

Source and dist also contain built uninstalled read-only Execute guidance change
in orchestrator; next idle hotpatch and fresh read-only Plan/Execute validation.
No live run remains from media acceptance. Do not redo completed image test.

Correction to prior interpretation of review cutoff: publish-plan.ts intentionally
publishes third structurally sound candidate with last review advisory; delivery
still used prior negative digest and marked blocked. This is publication/delivery
review-disposition inconsistency, not simply a hard stop in publish_plan. Fix stale
negative handling without inventing successfulreview for unreviewed revisedbytes.
Original memory/reflection/backfill, recovery, UI/release, laterbenchmark scope stays.


## Read-only Execute guidance hotpatched and LIVE PASS

Latest installed66fe5e9392f6a241e6d7ea18fc5806db9cf1da3c385952ce85d765f513bdb067.
Rebuilt beforepatch: docs/checkpoints participate in sourcefingerprint, so checkpoint
updates invalidated earlier buildidentity. Build/rebuildpassed; daemon and bothweb
trees installedwithrollback. No activeleases at quit; sharedmain/Claude80577 intact.

Initial attempt reusecompletedread-onlyplan withchangedinput correctly409
PLAN_EXECUTE_CONFLICT; no execution began. Fresh Plan session
sess-desktop-e1601daa17718e94d3fec58d completed243697 withpositiveSolreview.
Plan339d9447-cde5-44c3-9335-df7e96388bd7 rev1 digest
81823131c875113d0abc85f62bfca7a00a1588dac4e20324b06448abb4aa284a.
Execute run desktop:6230f9e19fce03a78d9e57d0a4f97a241a8b9f09 completed243732
positiveSolreview. ExactlyONE top-level call: call_tool/space_preview. No
plan_task/work_call refusal, no plan_step_result/tool_search/image-reread inExecute.
Actualinput_image presentin acceptedhistory. Independentdiskcheck matches original
reviewedHTML/data andversion1, no contentchanged. Correctreportedvisible labels
andPendingstates. Thisqualifiesnarrowread-onlyguidancefix, notglobalperformance.
Receipts readonly-execute-{rebuild,hotpatch,assets}, readonly-fresh-{plan-start,
plan-response,plan-events,execute-request,execute-response,all-events,verification}.
Runterminal; nothingpending. Nextbroaderbacklog: publication/delivery stale-negative
reviewdisposition, memoryreflection/backfillidentity/correctionscope, longhorizon
recovery, Claudeimageadaptervalidation,physicalmobile/release; lateruserbenchmark.


## Final plan candidate review freshness patched; normal live publication passes

Installed8aef439b6934afea9473f6830c261dc068f47e551c98c42b4a809382d5c0d62c.
Changed publish-plan.ts: every structurally prepared candidate receives its own
review, including candidateafter2sendbacks. Repairbudgetstillboundsadditional
sendbacks; finalnegative remainscurrentnegative, never synthesizedsuccess.
New pure plan-review-repair-policy.ts drives this decision;3puretests pass
(finalrepairedreviewcalled, finalnegative noextra-loop, reviewerrorpropagates).
Buildpassed; daemon+bothwebtrees hotpatchedwithrollback; noactiveleasesatquit.

Live normalpublication session sess-desktop-7252e3805ed66b6cb56bc770,
source243733/run desktop:7252e3805ed66b6cb56bc770fb381ef557415885,
terminal243791 positiveSol243783, planMatches/replyMatchestrue.
Plan plan-de947000-2007-4c8f-b437-b36d03346c7d rev1 digest
ff4a69eafe7b7b74177bc8c7b412dd4edbeedf4aa3cc5a6e1c4815027cb607d0.
NoExecute requestedforthisregression; runterminal, noactiveworkfromit.
Thisprovesnormalpublication, notliveexhaustedbudgetbranch; thatbranchcurrently
haspurepolicycoverageonly. Do not claim end-to-end exhaustedrepairacceptance.
Receipts plan-review-freshness-{tests,build,hotpatch,assets},
review-freshness-plan-{start,response,events}.json.

Remaining UXfinding: hostplanreply derivedfromfirstparagraph truncatesmidword
when noheading (visible replyends 'and v'); notaddressedhere. Keep main priorities:
firstclassnative tools, usefulmemory correction/groundedreflection/backfill,
long-horizon recovery, actualClaudeadapter andphysicalmobile/release qualification,
lateruser-controlledtoken/speedbenchmark. NextfocusmemoryratherthanendlessSpace
fixturepolish. Sharedmain/otheragent/tokenmeter preserved. No globalwinclaimed.


## Background memory grounding patched; fresh live identity/recall passed

Latest installed e39e9ead49c77723ae0fa5ea14ec0c5ba44a97f1fcfe44001eadd4246702d9a5.
reflection.ts now uses whole-registry resolveGroundedEntityIdsForText canonicalOnly
for claim+sourceexcerpt, then intersects extractionIDs. Replaces per-extraction
any-alias regex that could promote incidental nestedshortnames. relations.ts
backfillGroundedFactEntityLinksInDatabase nameadmission likewise uses global
canonical maximalmention intersection; retains existing specific/unique checks
and strongidentifier route. buildEntityGroundingIndex includes aliases_json as
well as entity_aliases for ambiguity; cachesclaim/evidencementionsonceperfact.
No broad historicalrewrite/backfilljobrun. Existingpersonalgraph untouched.
9puregroundedmentiontests/buildpassed; daemon+bothwebtrees installedwithrollback.

Live newproject Harness Cedar Observatory1789865200708, fact3782, onlyentity4571
extractedlink. Session probe-background-grounding-1789865200708 saved; fresh
probe-background-grounding-recall-1789865255845 returnedCedarGrounded. ActualSol
243816/243837fulfilled. Exactsynthetic3782softforgotten, active0verified.
Receipts background-grounding-{tests,build,hotpatch,assets,chat-start,chat-result,
recall-start,recall-result,evidence,events,cleanup}. Noactiveprocess;20209/76212exit0.

LIMIT: liveuser-facingnewidentity/recallpassed; thisdoesnotprovehistoricalbackfill
branchran or everyreflectionpath. Backgroundadmissioncoverage stillneedsfocused
proof; no broadmemoryperfection/efficiencyclaim. Identifier-grounding boundary
and partialcorrection scope remainreviewtargets. Originalnative/workflow/recovery/
UI/mobile/release/Claudecoverage and laterbenchmark scope retained.


## Identifier boundary grounding patched; installed matcher/live-data check passed

Latest installed8bcdbb51afb3279bb5539bd6f5865703b2452e720bf7422e064f6b1275d51542,
schema81/readinessverified. New grounded-identifier-match.ts wholeemail/domain
boundary matching replaces includes() in relations.ts exactIdentifierMatch.
Reject mailboxprefix/domainextension/subdomainlookalikes; allow sentenceperiod,
casefolding, exactdomainasemail/URLhost. Legacy missingevidencereconciliation now
uses sameglobalcanonicalmaximalname matching asbackfill (no legacyjobrun).
12purechecks/buildpassed; daemon+bothwebtrees installedwithrollback.

Read-only liveaudit:2384activestored/extractedlinks;896 lackcanonicalname inclaim
or excerpt, NOT896provenerrors (aliases/identifiers mayexplain);0legacyextracted
linksmissingevidence. Saved background-grounding-readonly-audit.json; no rewriting.
Installedmatcher imported directly and checkedALL259distinctliveidentifiers
(169email,90domain):259exactaccepted;518prefix/suffixlookalikesrejected.
No valuesprinted, no databasewrites. Receipt identifier-grounding-live-readonly.json;
check-installed-identifiers.mjs usesSQLite readonlytrue, noisolatedhome.
Thisqualifiesinstalledidentifierpredicateagainstliveinputs, notwholebackfilljob.
Fullbackfillintegration andglobalhistoricalrepair remainunproven/notperformed.

Receipts identifier-grounding-{tests,build,hotpatch,assets}, buildproc94654exit0.
Noactiveforegroundtests. Next return to broader long-task/multi-step recovery;
do not spend everyturnonadditionalnarrowSpace/memoryfixtures. Preservealloriginal
frameworkscope, usertokenmeter andlatermatchedbenchmark, Claude/mobile/release gaps.


## Three-step workflow input-change test found non-reusable goal; repair active

Latest installed cbb68e5dd1872c5c6aac21c758bc83b6de5e21c86e1fc47037140fc52d598673,
readinessverified. Build91830exit0;daemon+bothassets patchedwithrollback, idleleases0.
Changed orchestration-tools.ts create/update project descriptions distinguish
verifiedconfiguredproject fromoutputfolder; savedgoalcriteria describecurrentinput
invariants, samplespecificvalues belonginacceptance unlessconstantrequiredforallruns.
No schemas/authoritychecks relaxed. Receipts reusable-workflow-guidance-{build,
hotpatch,assets}. Thisguidancechangehasnotyetpassedfreshcreationregression.

Workflow harness-multistep-1789865560731, session
sess-desktop-41e5bf90b8d41e2070b3aa8d, initialsource243842. Nativecreate/run:
firstrefusalunregisteredproject=outputfolder; modelrepairedviaworkflow_update and
queued1789865622228-11215b. 3steps readJSON→calculate→write; completed/succeeded,
3/19newlinecorrect, goalreviewpass/nonfailedopen. Storeddefinitionsnapshotchecked.
ChangedONLYsyntheticinputfile (ready4+7,hold500), APIqueued1789865718845-a0d9fb.
3stepscomputed2/11correctbutterminalOutcome blocked: savedgoalhardcoded3/19.
Thisisreusableauthoringfailure, notarithmetic/stepdatapropagationfailure.
Bothrunrecordsretained. Fixtureinput/outputfilesunderweekendoutput. Workflow still
enabled/manual-onlyforactivevalidation; disablewhenfinished. No schedules/apps/sends.
Receipts multistep-workflow-{start,response,events}, multistep-first-result,
multistep-second-{start,snapshot}.json. Sourcegraphpromptsteps(usemodels), not
fullydeterministictransformgraph. Notlonghorizon/crashcoverage.

ACTIVE repair request afterhotpatch, same session,
run desktop:3e15576d2d9a861d91d30e551e724bc1545aa1ac HTTP202.
Asks goal-only reusablecurrentinputcriteria, preservessteps/paths/manualbehavior,
runonceverify. Receipts multistep-repair-{request,response}.json.
Pollthisexactsession/childrun; do notresubmit. Verifyupdatedsavedgoalnohardcoded
sampleanswer, stepsunchanged, newchildterminalsuccess+file2/11, then disablefixture.
Later freshcreation regression neededforguidance; recovery/crashboundary stillopen.
Originalframeworkmemory/token/UI/mobile/release/Claudequalificationscope unchanged.


## Reusable workflow repair PASS; fresh authoring guidance FAILED

Installed remainscbb68e5dd1872c5c6aac21c758bc83b6de5e21c86e1fc47037140fc52d598673.
Repair child1789865946243-ef1d3e completed/succeeded, all3steps; goalreviewpass,
failedOpenfalse; summaryexact2/11newline. Definitionstepsbyte-structureequal first
run; goalonlychangedto currentinputinvariants. Evidence multistep-repair-child.json,
multistep-repair-verification.json. Oldfixture harness-multistep-1789865560731
DISABLED viaAPI200, receipt multistep-disabled.json. Manual-only retainedforreview.

Freshsamepromptafterguidance FAILED authoring regression. Session
sess-desktop-4905efeba13b73e2fa45f72b, run
desktop:4905efeba13b73e2fa45f72b3a31fe9d87a63a3e, fixture
harness-multistep-1789866053091. At244271 workflow_create againusedoutputdirectory
asprojectandgoalhardcoded3/19. At244282runrefusedmissingconfiguredproject;
modelworkflow_updateremovedbinding andqueuedchild1789866113164-f3144f at244300.
All3stepsmodel-driven despite available deterministic call/transform descriptors.
Do notclaimguidancefixedfreshcreation or token efficiency. Installedregistry
schemas inspected withElectron/liveenv: workflow_create HAS bothnewproject and
sample-specificgoaldescriptions; thisisnotstaleinstalledschema. workflow_update
hasnewgoaldescription; project textdifferentwording. Saved workflow_{create,update}
-live-guidance-schema.json. Needinspectactualorchestratorschema/recallranking if
relevant, avoidjustaddingmorepromptbulkuncritically.

Freshchild stillneeds authoritativeterminalcheck anddisablefixturewhenfinished;
latest snapshot multistep-fresh-child.json. Do notstartduplicate. Receipts
multistep-fresh-workflow-{start,response}, multistep-fresh-events.json.
Task remainsbroadframework; recoverycrash/longhorizon notyettested bythis3stepcase.

Fresh child1789866113164-f3144f nowverifiedcompleted/succeeded3steps; fixture harness-multistep-1789866053091 disabledAPI200. Noactivechildremains. Successonoriginalsampledoesnotreversefreshauthoringfailureabove.


## Prompt-only workflow authoring retry failed again — change approach

Installed7f25be9edf2569aa07fe7c42c9bc571a72dfb99acccce680c5a7e38a7ebebaf4.
workflow_create rootdescription shortened/reordered: reusablegoals/currentinputs,
nooutputfolderproject, exactcall/puretransformbeforemodel, retainedconsent/dependency/
outputcontract/graphsemantics. Schemaunchanged. Build98907exit0, idlehotpatchwith
rollback/bothassets/readinessverified. Receipts workflow-authoring-surface-{build,
hotpatch,assets}. NOT a demonstratedbehaviorfix.

UNCHANGEDrequestfreshsession sess-desktop-090f522c5dcf6110d3800a8f,
run desktop:090f522c5dcf6110d3800a8fb98e35b8617bf81a,
fixture harness-multistep-1789866361222. Firstworkflow_create244416 again
outputfolderproject, sample3/19savedgoal,3modelsteps(no call/transform).
Child1789866421104-1514a0 ran3steps; latestauthoritativestatusin
multistep-surface-child.json. FixtureDISABLEDAPI200 whilefinalizing; disabling
preventsnewrunsanddoesnotcancelcurrentrun. Receipts multistep-surface-{start,response,
events,child,disabled}.json. Checkterminalbeforeanyrestart; noresubmit.

STOP adding/retrying near-identical prompt instructions. Needstructuralrootcause
investigation: native schema/executorchoice/authoringvalidation and actualprovider
surface. getCoreTools liveinstalledschemas DO contain previousguidance; host
serializedTools uses tool.description pluscompactAdvertisedJsonSchema. Noevidence
ofstaleschema. Researchactualproviderprojectionorhost-nativeboundarybeforeclaiming.
Memoryautomaticprimers for priorworkflowsteps included unrelatedSalesforcefacts
3690/2471 andentity4238; relevanceproblemconfirmed, notcausalproofauthoringerror.
No personalmemorychanged. Bothpriorfixturesdisabled. Repairedfirstworkflowworks
acrossinputs; freshauthoringstillfails. Noefficiencywin/longhorizonqualification.

## Project preflight installed; fresh workflow exposes operation identifier mismatch

Installed source fingerprint: 2a228fedccb45c288919bd2ddddb41e4c52ff3abbfb6ac174cdc243f60a26c7b.
Shared main remains e5a75f5a; Claude PID 80577 was reverified in this checkout.
Daemon and both web assets patched with rollback; reopened correct ~/Applications
bundle and authenticated build-info verified before starting the live request.

New workflow-project-preflight.ts reuses execution readiness to reject a confirmed
missing project before saving a NEW enabled workflow. Disabled drafts, unknown
inventory, and other readiness items retain prior behavior. Three pure tests and
build passed. Installed commitAuthoredWorkflow invoked with live inventory and a
unique nonexistent project returned an actionable error; neither the workflow
record nor its directory was created. Receipt workflow-project-preflight-installed.json.
This is installed authoring-core proof, not an LLM repair-path test.

Fresh unchanged three-step request: session sess-desktop-7bb4bed06e09cfabab7555fb,
source 244540, workflow harness-multistep-1789867033991, child 1789867074749-42f8ae.
Clem chose project:null and a reusable current-input goal this time. No project
repair occurred, but that single stochastic observation does not establish the
new rejection branch caused improved authorship. All three steps still use models.
It first searched for workflow schema, then native workflow_create and workflow_run.

The created allowedTools contained cap:local:read_file:read and
cap:local:write_file:overwrite. Readiness reported both missing; execution warned
and continued. The write worker received no write carrier, produced no summary
file, and the child ended status=blocked / terminalOutcome=blocked despite
stepsCompleted=3. This is FAILED end-to-end acceptance, not success. Fixture now
DISABLED (API200). Receipts multistep-preflight-{start,response,events,child,disabled}.

Next investigate schema/capability identity consistency: workflow_create's
allowedTools description says operation id; materializeCitedStepOperations only
acquires read operations and the downstream tool scopes receive the cited strings.
Do not casually strip cap variants into broader tool grants. Establish the canonical
operation identity and preserve exact effect authority through authoring and execution.
No more prompt-only reruns to hide this mismatch. Sample-goal and deterministic
executor choices remain broadly unqualified. No efficiency comparison claim.
User reiterated framework-only focus, first-class native tools, useful memory,
and their own later side-by-side Claude Code benchmark. No personal app/auth fixes.

## Controlled tool-citation repair proves the missing write surface
Same session, source 244668, follow-up run desktop:468cb6b457eaeb0cfcbb19671d768d4fbb2610e1.
Native workflow_get/update plus discovered workflow_set_enabled and native workflow_run
produced child 1789867347719-0c29b1. Definition snapshots compared exactly: ONLY
read_records.allowedTools and write_summary.allowedTools changed, from capability
references to read_file / write_file. Prompts, outputs, goal, paths and dependencies
unchanged. Child completed/succeeded, three steps; actual file exactly
READY_COUNT=3;TOTAL=19 plus newline. Goal validation passed, judgeFailedOpen=false.
Fixture disabled again (API200). Receipts operation-identity-repair-{request,response,
events,child,verification,disabled}. No running test remains.

Root confirmed: workflow-step-agent.makeStepToolAllow matches tool names; cap:local
references are planning variant identities and are not operation names in
operationIdentity. Plan scope also matches semantic tool names. Do not blindly
strip variant suffixes: that would lose the variant distinction. A framework-wide
typed reference design would have to preserve it in execution authorization.

SOURCE-ONLY change, NOT BUILT/HOTPATCHED: orchestration-tools create and update
allowedTools descriptions now explicitly use discovery result name, not capabilityRef
or variantId. Both direct call.tool descriptions no longer claim Composio-only;
registered local calls are supported. This corrects misleading schema documentation.
Do not claim this prompt/schema wording establishes fresh-authoring reliability.
No automatic capability-reference normalization or new refusal added this turn.
Next build/publish this documentation correction if appropriate alongside a substantive
framework change; avoid another near-identical prompt-only authoring retry. The
structural operation identity mismatch remains an authoring reliability concern.

## Native workflow lifecycle installed; temporal review evidence gap found
Installed fingerprint 9d77f3645bf1c0cd111363e9b2516483287b618e10ed0fcee9b655b643b472b1.
Added workflow_set_enabled to NATIVE_PRODUCT_AUTHORING_TOOLS so normal chat uses
existing direct native preparation/nomination, explicit policy restrictions intact.
Also ships the prior accurate create/update operation-name descriptions.
Three direct-native tests passed (explicit live-home config flag after first guard
refused imports; these inspected tests contain no DB fixture/reset operations).
Build passed; idle leases=0; daemon/skills/both assets patched with retained backups.
Receipts native-lifecycle-{tests,build,hotpatch,assets,request,response,events,verification}.

Fresh session sess-desktop-f5e2c2ec5fed6ac1ebbe82dd, source 244826:
workflow_get(false), direct workflow_set_enabled(true), workflow_get(true), direct
workflow_set_enabled(false), workflow_get(false). No discovery or work_call.
Installed readWorkflow compared to prior child definition after normalizing JSON
undefined fields: exact unchanged except enabled=false. Fixture remains disabled;
no workflow executed. This proves direct lifecycle calls, NOT full reviewed acceptance.

Completion Sol review 244887/244889 NEGATIVE: claims intermediate enabled state
and preserved settings not verified. Earlier identical-argument workflow_get reads
are contentDisposition=superseded_read and shownByteCount=0, despite the task
explicitly requiring the intermediate state. Conversation terminal blocked at244893.
Next inspect superseded-read evidence selection: temporal state transitions need
both relevant observations, not only the last read. Do not weaken the judge or
claim negative review as success. All live test handles terminal; no restart needed.

## Distinct state evidence retained; lifecycle mutation receipts missing
Installed fingerprint f79a3472e7fb7a0b881b963acbec9648ea91282543d49555e69ac343171828f6.
host-completion-work.ts no longer discards earlier successful results solely
because the same exact call later ran again. Keeps distinct payloads in settlement
order and deduplicates identical bytes by authenticated digest. Existing answerer
bounds and incremental advisory windows unchanged. Updated relevant regression in
host-completion-contract.test.ts but did NOT run its fixture-based suite against
live home. Build passed. Replayed exact live source244826: previous installed code
omits enabled=true; candidate includes enabled=true/false and references the third
identical disabled payload. Receipt temporal-review-{installed,candidate}. Candidate
replay uses Node22; Electron24 with repo native dependencies returned empty evidence
(ABI mismatch), so it was rerun successfully with the matching runtime.
Daemon/skills/bothassets patched with rollback. Live build verified before request.

Fresh identical lifecycle request session sess-desktop-e1903774a0cb1e5044a7acfa,
source244894, completed terminal244961. Same five native calls, state false→true→false,
no discovery, no workflow execution. Full saved definition independently equal prior
snapshot except disabled flag (verify-native-lifecycle script). Judge244953 now
explicitly verifies BOTH states, proving temporal evidence fix in live review.
Still NEGATIVE for unchanged prompts/settings: metadata reads omit them, and native
workflow_set_enabled emits plain text with NO host-local-write receipt. Artifacts
show promised_receipt_missing_or_malformed, empty handle/digest for both writes.
This remains failed end-to-end acceptance. Fixture is disabled, no active test.
Receipts temporal-{review-build,review-hotpatch,review-assets,lifecycle-request,
lifecycle-response,lifecycle-events}. Native lifecycle verification regenerated.

Next fix workflow_set_enabled handler in orchestration-tools.ts1714–1793:
- successful enable and disable should use existing withWorkflowCommit(entry.name,...)
  like create/update, attesting reopened exact saved bytes;
- two branches that SAVE a disabled definition while requesting/queueing verification
  also need receipts for their actual writes;
- pre-write invalid-input/not-found/invocation-plan/validation returns need existing
  nonWriteTextResult classification, not false successful writes.
Inspect full handler first; preserve existing enable/verification/consent semantics.
withWorkflowCommit is in execution/workflow-commit.ts and uses exact file receipt.
Do not weaken reviewer to obtain pass. Temporal fix is live; receipt fix NOT written.

## Native lifecycle receipt fix PASS in live completion review
Installed source fingerprint 4433ef78196a669de3df66091e51035300dbe41630d45b8299ba189b86e9806c.
workflow_set_enabled now uses withWorkflowCommit on all four branches that save
workflow bytes (normal enable, disable, disabled awaiting inputs, disabled queued
verification). Four pre-save refusals use nonWriteTextResult (invalid inputs,
not found, invocation-plan consent, invalid definition). Enable/run/consent semantics
unchanged. Build passed; zero active leases; correct app quit; daemon, skills, both
web assets patched with retained rollback. Readiness fingerprint verified before test.
Receipts lifecycle-receipts-{build,hotpatch,assets}. First readiness GET raced startup
and ECONNREFUSED before any POST; second attempt accepted one request only.

Fresh identical lifecycle request, session sess-desktop-e997c6a8abbc4ad022f4a280,
source244962. Exactly FOUR direct native calls: set_enabled(true), get(metadata),
set_enabled(false), get(metadata). Both writes returned exact saved-file receipts.
Sol completion245014 fulfills=true; terminal245018 done/success, delivered=true,
reviewed, verified=true, artifactsMatch=true, actual model gpt-5.6-sol. Earlier
write receipt is correctly marked superseded; final receipt matches current bytes.
Both state reads remain visible. No discovery, no work_call, no review repair.
Independent installed readWorkflow comparison verifies complete definition unchanged
except enabled=false. Fixture remains disabled; no workflow executed and no active
acceptance task remains. Receipts receipt-lifecycle-{request,response,events,verification}.

This qualifies direct enable/disable lifecycle with real receipts and temporal
state review. Verification-wait and refusal branches were code-reviewed/build-checked,
not separately live exercised. Do not infer broad workflow-authoring reliability,
Claude-adapter parity, physical mobile parity, release parity, or efficiency wins.
Resume broader framework tasks (native authoring operation identity, deterministic
execution choice, relevant memory, long-horizon recovery); do not repeat this passing
lifecycle case without a new change/failure. User benchmark remains later/user-run.

## Ambient complete-set boost removed; installed retrieval checked
Installed fingerprint 9a3720fa7d76e8a1be3cfdf08c2131b5d5b14a56cd1badfe82b46054896220db.
Traced real workflow:1789867347719-0c29b1:calculate_ready recall objective. Unrelated
fact3690 had lexical relevance0.08 but ranked0.99; unrelated roster2471 and policies
3335/2828 also0.99. Cause: preferDurableCompleteSetHits treats any complete/all/list
word in whole task text as a stored-list request, then floors list-bearing facts
at0.99 regardless topical match. Required-output instructions contain these words.

recall-memory.ts now applies that complete-set promotion only for targeted recall.
Ambient context keeps existing relevance/entity/utility ranking; no store disabled,
no facts deleted, targeted complete-list behavior unchanged. Build passed.
Candidate replay of original live query: relevant workflow facts3784/3786 first,
irrelevant facts lose0.99floor. Installed replay after patch also ranks3784 first.
Actual semantic leg can time out; installed run did not include3786, so do not
claim deterministic identical ranked lists. Unrelated entity4238 (Opportunity Status)
still ranks0.72 through alias matches; unrelated facts can remain lower in top8.
This is a bounded ranking correction, NOT comprehensive relevance qualification.

Positive control: exact Salesforce roster question retains fact2471 in BOTH targeted
and ambient recall. Targeted keeps complete-set boost; ambient does not. Both candidate
(Node22) and installed(Electron24) checks passed against live memory. No fixture resets,
no new user-model run, no token benchmark. Daemon/skills/bothassets patched with rollback;
running API fingerprint verified. No acceptance run active.

Receipts ambient-set-ranking-{build,hotpatch,assets,live-build},
workflow-recall-relevance-{audit,candidate,installed-after},
ambient-set-roster-{candidate,installed-after}. Scripts audit-workflow-recall.mjs,
check-roster-recall.mjs. Next follow generic-alias/entity relevance or broader
long-horizon recovery; preserve all native/Claude/mobile/release/benchmark scope.
Do not repeat passing lifecycle test without new reason. Never erase personal facts.

## Ambient canonical-name ranking above aliases — installed checks PASS
Installed fingerprint 3a28e238cb1f4782d6e145320a1c9980a8c19e06ccd287416dfb2a2ed4908c4b.
Entity4238 canonical Opportunity Status has stored alias Status. Unique alias matches
were treated as grounded full-name matches and ranked0.72 even in unrelated tasks.
recall-memory.ts now orders canonical matches before alias candidates in ambient
recall, preserving the bounded candidate limit. Ambient entity score: canonical0.72,
unambiguous alias0.62, incidental broad alias0.52. Targeted behavior unchanged.
No aliases removed; no personal memory records modified. Canonical matching reuses
the existing global overlap/ambiguity resolver, canonicalOnly=true.

Build passed. Candidate and installed live-home checks:
- Status still finds4238, ambient0.62; Opportunity Status finds4238 ambient0.72;
  targeted Status retains0.72.
- Original workflow calculation query ranks relevant workflow facts3784/3786 and
  canonical project4573 first; entity4238 no longer in top8.
- Actual Salesforce team query retains roster2471 in targeted and ambient recall.
No global relevance/efficiency claim: unrelated facts still appear lower through
stored graph/utility signals, and semantic leg deadlines can vary returned candidates.

Zero live leases before patch; daemon/skills/bothassets patched with backups;
reopened correct installed bundle; API fingerprint confirmed. Receipts
ambient-alias-ranking-{build,hotpatch,assets,live-build}, alias-ranking-{candidate,installed},
workflow-recall-relevance-{alias-candidate,alias-installed},
ambient-set-roster-{alias-candidate,alias-installed}. No active acceptance run.
Next broaden to workflow execution/recovery and memory application in real turns,
rather than indefinitely tuning individual ranking fixtures. Keep full original
framework/native tools/memory/token/desktop/mobile/Claude/release scope active.

## Fresh-session reuse verifies memory application; goal review lacks read provenance
Current installed remains3a28e238cb1f4782d6e145320a1c9980a8c19e06ccd287416dfb2a2ed4908c4b.
Changed ONLY retained synthetic input of harness-multistep-1789867033991 to ready4,
ready7, hold500. Fresh session sess-desktop-f95484d1a39af2cbbf5ae03b source245019
(verify exact user source in events if needed), native get→enable→run (3calls),
child1789868700159-b68de5. Definition snapshot exactly equals prior successful
1789867347719-0c29b1 (no recreate/update). Actual output is READY_COUNT=2;TOTAL=11
plus newline, all3steps completed. Goal generic/current-input criteria preserved.

Actual worker memory_recall_runs now show read and calculate context as facts3784,
3786 and project4573; write context actualdeliverable+3784/3786. Previous unrelated
Salesforce3690/2471/4238 absent from those injected worker snippets. This is live
model-turn context evidence beyond isolated retrieval replay; no efficiency claim.

Run status completed BUT terminalOutcome blocked. Goal review failed criterion
"Reads the specified JSON input file": judge saw records but no file path proving
origin. Other3criteria passed, judgeFailedOpen=false. Actual read_file call245078
in workflow:1789868700159-b68de5:read_records contains exact input path/max_chars50000,
then workflow_step_result245085 carries actualnewrecords. So provenance exists
upstream but is absent from goal review's step-output-only evidence source.
Fixture disabled API200 after terminal; no runactive.

Receipts workflow-reuse-{start,response,events,memory,child,read-events,disabled}.
start-workflow-reuse.mjs changedinput and submitted one accepted request.

Next: expose retained source-bound step read provenance to workflow goal review.
goal-validate.ts stepOutputEvidence currently exposes only model step outputs and
write receipts (workflowFileEvidence), no read receipts. workflow-runner.ts14935
passes objective/successCriteria/evidenceText/publicRawStepOutputs only.
Reuse sourceSettledReadEvidence from runtime/harness/host-completion-work.ts,
which reopens authenticated handles and exact/recorded invocation scope.
For run scoping follow existing auditWorkflowRunSettlementTruth (~1453):
user_input_received sources with substr(session_id,1,prefix.length)=
workflow:<runId>:, ordered sources. Do not infer paths from model prose or arbitrary
judge-provided files. Prefer a bounded/lazy JudgeEvidenceSource alongside step outputs
so large source content does not inflate every review. Judge lookup budget4.
No source fix written this turn. Keep failed review honestly failed; do not weaken it.

## Workflow goal read provenance built; hotpatch waits for unlocked Mac
SOURCE change built successfully, NOT INSTALLED:
- new execution/workflow-read-evidence.ts enumerates nonmutating settlements only
  for exact workflow:<runId>: session prefix. Exposes read_receipts/<step>/<source>
  refs; resolves lazily via sourceSettledReadEvidence, retaining authenticated
  handles/digests and invocation scope. Unknown refs resolve undefined; no arbitrary
  path reader and no provider execution.
- goal-validate.ts accepts optional readEvidence and composes it with step output
  evidence, avoiding collisions with authored step ids. Existing callers unchanged.
- workflow-runner.ts passes workflowRunReadEvidence(run.id) at goal validation.
No review weakening, no larger evidence lookup budget, no eager payload expansion.

Build22432 exit0, receipt workflow-read-evidence-build.txt. Candidate checked against
actual failed child1789868700159-b68de5/live home: read_records source245066 exposes
verified read_file receipt with exact synthetic input path. Refusing unknown refs,
lazy resolution and step-id collision preservation checks passed. Receipt
workflow-read-evidence-candidate.json; script check-workflow-read-evidence.mjs.
Not a model verdict or installed acceptance yet.

Zero active leases before intended quit. CUA quit attempt returned Mac locked,
automatic unlock failed. Async user request sent for manual unlock. App NOT quit
or patched; running installed remains3a28e238cb1f4782d6e145320a1c9980a8c19e06ccd287416dfb2a2ed4908c4b.
First genuine lock blocker turn; do not mark goal blocked yet. Don't bypass UI lock
with CLI kill/OS security changes. CUA binding aliasApp still refers correct app.
After unlock recheck live leases, rebuild (this checkpoint changes fingerprint),
quit via CUA, patch daemon+bothassets, reopen/fingerprint, run installed receipt
check, then repeat changed-input native workflow reuse using new expected fingerprint
and fresh receipt filenames. Existing synthetic fixture disabled, input2/11 retained.

Independent review while waiting: final workflow target judge already has
workflow-target-evidence authenticated results/current artifact content. The new
fix specifically fills goal-validate's step-output-only evidence gap. Broader
recovery/authoring/memory/mobile/Claude/release scope stays active; no new model
acceptance task is running. Original failed reuse was correctoutput but blocked
review; do not relabel it success.

## Workflow goal read provenance installed; changed-input reuse PASS
Mac access recheck succeeded (no user response needed); prior lock blocker cleared.
Rebuilt after checkpoint edits, build15098 exit0. Zero active leases, correct bundle
quit via CUA, daemon/skills/bothassets patched with retained rollback, reopened.
Installed fingerprint 3fd7372d3ca168c7ba602e2c3608a96de0aaf28b697abc8ea75766ed4a74cc04.
Installed read evidence check passes same source-bound/lazy/unknown-ref/collision
checks as candidate. Receipts workflow-read-evidence-{build,hotpatch,assets,installed}.
No security setting changed.

Fresh unchanged reuse prompt on ready4+7/hold500 fixture:
session sess-desktop-3926ecabd37afd1e417ae972,
foreground run desktop:3926ecabd37afd1e417ae97281c8ab4ebf40ddf3,
native workflow_get→workflow_set_enabled→workflow_run, no recreation/edit/discovery.
Child1789869300542-11671e completed/succeeded, all3steps.
Definition exactly equals prior successful snapshot; actual output2/11newline.
Goal validation pass=true, judgeFailedOpen=false, all4criteria. Input criterion
explicitly cites authenticated read receipt showing specified JSON path/all3records.
This demonstrates reviewer consumed newly available provenance; no missing-origin
rejection. Read receipt source is exact run, not prior-run output or model prose.
ReportBack outcome done acknowledged by origin observer at2026-09-20T01:56:31.697Z.
Fixture disabled API200 afterterminal; complete definition independently compared
unchanged except enabled=false. No acceptance task remains active.

Receipts workflow-read-reuse-{start,response,events,child,disabled,verification}.
Retained child receipt snapshot may predate reportBackAcknowledgedAt; current
authoritative runfile contains ack and should be reread if proving reportdelivery.
Start script start-workflow-read-reuse.mjs asserts running fingerprint first.

This qualifies the three-step reusable workflow under changed input, native lifecycle,
live goal provenance and terminal report acknowledgment. Does NOT qualify long-horizon
crash recovery, arbitrary fresh authoring, deterministic executor selection, Claude
parity, physical mobile, signed release parity, or comparative token/speed wins.
Broader goal remains active. Avoid repeating this passing small case without new cause.


## Framework scope reaffirmed; direct-call authoring gap observed
User reaffirmed native Space creation, workflow creation/execution/status as first-class
framework tools. Memory must improve reasoning and reuse across sessions. User will
run same-question Claude Code token/speed comparison later; no comparative win claimed.
Continue framework work; personal app repair is outside scope.

Rechecked main/e5a75f5a and Claude PID80577 cwd same shared checkout. Installed
fingerprint remains3fd7372d3ca168c7ba602e2c3608a96de0aaf28b697abc8ea75766ed4a74cc04.
Direct-read fresh authoring session sess-desktop-56d389ddb0d97227a94d05fd terminated
at conversation_completed245484. Child1789869630086-ab9019 creation_test terminalOutcome
blocked, report acknowledged. Synthetic workflow harness-direct-read-1789869610061
left disabled by creation test. Actual workflow_create call245316 already had args:{};
repeated workflow_update calls also args:{}. Do not claim storage dropped supplied args.
Creation test independently reports no current capability registered for read_file.
No direct-call success or efficiency improvement established. Updated full events receipt
output/weekend-harness-2026-09-19/direct-read-workflow-events.json.
Next diagnose model-visible arbitrary argument schema and native local read acquisition
for structured workflow calls. Repair loops are an observed framework efficiency issue.
Do not repeat unchanged successful three-step reuse test or launch benchmark now.


## Direct workflow argument contract repaired in source, not installed
Previous goal turn classified progress: terminal direct-read evidence changed next action.
Confirmed actual SDK strictToolSchema sets object additionalProperties=false, closing
call.args record to {}. Reproduced with @openai/agents tool construction; not speculation
that storage discarded supplied data. Added optional call.args_json to create/update
schemas, decoding in normalizeWorkflowSteps via new workflow-call-arguments.ts before
persistence. Retains legacy args; rejects non-object/malformed JSON or conflicting
nonempty carriers. Empty legacy args alongside explicit JSON accepted because strict
schema emits that shape. Preserves nested values/types and execution templates.
Pure tests3 passed, including real SDK projection, no DB fixtures or isolated acceptance.
npx tsc --noEmit passed before adding final SDK projection test; rerun typecheck after
further edits. Receipts workflow-call-arguments-{tests,typecheck}.txt.
NOT BUILT/HOTPATCHED. Installed fingerprint still3fd7372d... unchanged this turn.

Remaining direct native read acquisition: workflow-live-call-compiler.ts uses
production-live-read-acquisition-registry default adapters, which include configured
MCP and reviewed CLI only. Native read_file localPlanningRead supports chat planning
but does not itself materialize a workflow capability. Need extend actual supported
native read carrier via existing attested capability/execution boundary; do not bypass
workflow-v3 ledger or route through a model prompt to manufacture a direct-call pass.
Current source changes intentionally partial until that executor path is implemented.
Then build, hotpatch proper bundle+assets, fresh authoring live acceptance with receipt.
No benchmark or other agent/token meter edits. Broader goal active.


## Native structured file reads installed; execution passes, final receipt drift remains
Implemented local_file_read_v1 registry execution contract. READ_FILE_PARAMS shared
by core read_file and transport observation. executeLocalFileRead extracted from the
existing core handler, preserving path checks, redaction, ingestion and retained output;
workflow failOnReadError turns sensitive/ingestion refusals into failed execution.
Reviewed local transport derives explicit read identity, validates exact args/current
manifest, declares read effect/no mutation reconciliation. Host storage seam executes
same implementation; sealed local_registry invoke supports read as well as write.
Workflow normalization omits null max_chars and adapter supplies normal null default.
No model step or permission fallback; existing workflow-v3 dispatch/settlement retained.

Typecheck passed; source contract checks validated identity, read/write effects,
argument types, unknown fields, default max_chars, identity mismatch refusal. Three
argument-carrier pure tests previously passed. Both full builds passed.
First installed3011dc75... test proved args_json saves exact path/numeric1000, actual
read executed but result envelope lacked data completeness path. Session
sess-desktop-95939a6b5fe662818d60a5d5 source245487: creation children
1789870484954-0075f5 and1789870553694-99229d blocked. Cancelled this exact foreground
via returned cancelEndpoint HTTP200 to stop further repairs; terminal245598 cancelled,
zero leases before patch. Native-read-workflow receipts retain failed outcome.

Corrected adapter envelope to {result:{data:{path,content}},complete:true} using
existing evidence projection/data completeness contract. No verifier weakening.
Installed e45310846edf3e73535d0eccf8efcd1138fc33f55d4c67429002ecb51f7cb029.
Rollback dist.backup-8zP0Ev, skills.backup-r3X8TY. Both web assets installed, same prior
digests. Correct app quit/reopened with CUA; no other active work interrupted.

Fresh authoring session sess-desktop-49c88d2967a2e97073cdb384 source245599
foreground desktop:49c88d2967a2e97073cdb384853ec946f6684226.
Synthetic workflow harness-direct-read-1789870639826. First create args_json correct,
then workflow_get and workflow_run, no authoring repairs or discovery. Creation test
1789870661545-754fe9 passes; explicit run1789870670886-4f301c completed/succeeded,
one directcall step, actualcontent DIRECT_READ_ACCEPTANCE_29 newline, goalpass true,
judgeFailedOpen=false, report observer acknowledged. No worker model step.

OVERALL CHAT STILL BLOCKED: final completion245663 verificationDetail
completion_review_artifact_drift. Actual Sol review245662 fulfills=true, but creation
receipt names saved disabled workflow; automatic successful creation-test enable changes
SKILL.md. Independent comparison of creation/explicitrun definitions proves ONLY enabled
changed. Do not relabel overallrequest success. This is next framework issue: trace
creation-test auto-enable (~workflow-runner14172) lifecycle receipt ownership and final
artifact verification. Need authenticate successor state, not ignore all drift or weaken
review. Fixture disabled HTTP200 afterterminal. native-read-envelope-{start,response,
events,child-final,disabled,build,hotpatch,assets} receipts. Build3011 failure receipts
native-read-* separate. Current installed source contains corrected envelope.

No efficiency win/Claude/mobile/release/longhorizon qualification. Broad goal active.
Docs updated after build; rebuild before any further patch.


## Workflow automatic enable receipt lifecycle — installed live PASS
Prior goal turn was progress: native read execution succeeded but final source artifact
recheck failed. Implemented source/call-bound activation successor receipt:
- workflow-run-queue queueWorkflowCreationTest captures currentDispatchLease exact
  session/sourceUserSeq/logicalToolCallId as creationTestSource (no inference later).
- workflow-runner successful guarded activation captures before/after reopened file
  receipts; only disabled→enabled with unchanged admitted definition/code records
  workflow_activation_committed host event in original source session.
- host-turn-runner settledSourceArtifacts replaces original facts only via exact
  workflowActivationSuccessor match of system role/source/call/prior digest/handle/id.
  Ambiguous/malformed/cross-source candidates rejected. Current bytes still independently
  hashed during review and delivery. No general enabled-field drift exemption.
- new pure workflow-activation-successor.test.ts passed (positive and cross-source,
  othercall, olddigest, changedhandle, malformedhash, duplicateevent, nonhost negatives).
Typecheck/fullbuild passed. Installed fingerprint
1c60f5943c42c5e538c7ca22dea385d6c65ed277db8d1d9a1af6fef33bb1b276.
Correct app quit/reopened with CUA afterzero leases; bothassets installed with retained
backups. Daemon rollback dist.backup-l0j31i, skills.backup-OkN2pO.

Fresh same natural-language authoring request accepted session
sess-desktop-eb1db2681fad43831ee3c227 source245666,
foreground desktop:eb1db2681fad43831ee3c2276b15424360ba0400.
Workflow harness-direct-read-1789871073719. Native calls exactly
workflow_create→workflow_get→workflow_run. No tool_search/update/repair/modelworker.
Creationtest1789871094745-5970ba passed; hostactivationevent245703 exact original
create call_A8P8cDmC1Ccp0k4PAH3DvW5U: prior439b259c...→successor310e8158...
Explicitrun1789871105288-74b384 completed/succeeded; directread actual
DIRECT_READ_ACCEPTANCE_29 newline. Goal pass=true, judgeFailedOpen=false.
Final Sol245726 fulfills=true, judged successor digestMatches=true.
Conversation245727 done/delivered, verified/reviewed, artifactsMatch=true/currentMatch=true,
reply/objective matchtrue. Report observer acknowledged. This is an overall live pass.
Two physical reads across creation-test and explicitrun; don't describe as totalone read.

Receipt verification then disabled ONLY this fixture API200. Prior successor matched
beforecleanup; independent disable makes readCommittedArtifactContent(successor).verified
false afterward, proving later state changes still invalidate it. No livefixturesreset.
Evidence workflow-activation-{start,response,events,child-final,verification,build,
hotpatch,assets,typecheck}; start-workflow-activation.mjs assertsfingerprint.
First start failed GETbuild ECONNREFUSED duringstartup BEFORE POST; retry acceptedonce.

Next broaden direct workflow coverage beyond small text read: typed transformations and
reuse/current-input behavior, large read retained-result boundaries, long-running recovery,
useful cross-session memory. Do not repeat this passing small authoring case withoutcause.
No comparative benchmark/Claude parity/physicalmobile/signedrelease/longhorizon success
claim. Broad user goal remains active; user's later tokenmeter comparison preserved.


## Native workflow read preview boundary — installed live PASS
Previous turn progress: creation/enable/directread/finaldelivery passed with exact
activationreceipt. Next larger changedinput test revealed real data loss.
Reused harness-direct-read-1789871073719, max_chars1000 unchanged. Replaced only its
syntheticinput with300recordlines+TAIL_COMPLETE_READ_83newline, total4852chars.
set-enabled returned202 and queued creationtest1789871258971-0d5342 (start script
wrongly asserted200 and stopped BEFORE explicitrun POST). Followed that exactchild;
creationtest returned succeeded despite retaineddata.content only1000-charpreview.
Authenticated settlement245734/result rh_71d7a67dfcd5233e55bd7a37025b0bf0 explicitly
contains omitted3988chars, missingtail, whilecomplete=true. large-native-read-before.json
retains full redemption proof. Do not call old creationtest a full-content pass.

Fix executeLocalFileRead internal completeOutput option: returns full REDACTED content
for machine execution before chat preview formatting. reviewed-local-storage-carrier
requests it; workflow kernel retains all data in its authenticated settlement. Core
foreground read behavior unchanged/bounded. Candidate actualfile check: full equals4852
chars, normalpreview<=1000 and excludes tail. large-native-read-candidate.json.
Build passed. Installedfingerprint
2624deade2b1021144bb5a02a01ee5e7329036f1e587541206d55f4724742100.
Daemonbackup dist.backup-JNQ9yC, skills.backup-UiQ2c4; bothassets shipped/samedigests.
App quit/reopened CUA afterzero leases and terminalpriorchild, main/e5a75f5a and
Claude80577 stillpresent. No outsideapp/auth/OSchanges.

Explicitrun API200 queued1789871423540-ae6a8d. Same savedworkflow/input, single direct
read settlement. Completed/succeeded, goalpass=true judgeFailedOpen=false. Authenticated
retainedresult rh_43c18d3cfc28ba058c3181962c8d7d02 exactlyequals actualfile4852chars
includingtail. Judge independently mentionsfullcontent throughmarker. This was direct
consoleAPI run, not a newchatdelivery test. Fixture disabledAPI200 afterterminal.
Receipts large-native-read-{response,child,verification,disabled,build,hotpatch,assets}.

Next: deterministic data transformation using complete upstreamread without modelworker;
then broader longhorizon/recovery/usefulmemory. 4852char result proves previewboundary,
not arbitrarysize/no-limit claim. No benchmark/Claude/mobile/release qualification.
Broadergoalactive. Docsupdatedafterbuild; rebuildbeforefuturepatch.


## Native read + deterministic aggregate fresh authoring — installed live PASS
Prior goal turn progress: fullread versus boundedpreview proved live. Fresh two-step
request on240JSONrecords (amount1..240 alternatingteams), no DSL or expectedtotals in
prompt, exposed authoring contract gap. Oldsession sess-desktop-b8d7e9060510183d3416fb39
source245742; create245761 had aggregate metrics {op,count/as} instead of {fn,column?}
and readoutput.content instead of data.content. optionalTransform preserved invalid
rawJSONtext, then canonicalvalidator misleadingly said "transform must be an object".
Cancelled exacttest API200 after confirmed error to avoidrepairs; terminal245802,
zero leases/no childworkflow persisted. Native-transform-{start,response,events,cancel}.

Fix: optionalTransform now throws precise parse/semanticerror beforewrite rather than
masking it by returningrawstring. Create/update tool descriptions disclose aggregate
metrics fn/column and output count/sum_amount; native read_file output data.content
path disclosed. No DSL/validator weakening or invented semantics. Candidate replay
invalidcall throws metrics errors; validtypedexpression computes expectedA120/14400,
B120/14520. native-transform-contract-candidate.json. Fullbuildpasses.
An initial script assertion caught create/update description strings differing; final
edits inspected/rebuilt beforepatch. Installedfingerprint
f717ef428bb599adfef08b27a6ea5c7fbc93e0a0ead0f99e87201dc102e6049c.
Rollbackdaemon dist.backup-cTPZOc, skills.backup-Csa95o; bothassetsinstalledsamedigests.
Appquit/reopenCUA afterzero leases; shortcut ambiguity resolved viaactualQuitmenu.

Freshsession sess-desktop-4dcc62a319fbe237accab03a source245803
foreground desktop:4dcc62a319fbe237accab03ad27d94cd432cd761.
Workflow harness-native-transform-1789871824775; firstcreatecall correctcallargs,
data.content, metricsfn. Native create→get→run, no discovery/update/authoringrepair.
Creationtest1789871854456-290cb6 passed. Explicitrun1789871881804-48bb8e
completed/succeeded, exactlyread_json directcall +group_by_team transform, no modelprompt.
Large upstream13024byteJSONstaged as authenticatedartifact in rollup; transformation
uses actualcompleteinput. Actualaggregate equals independentlyheld expectedvalues:
A count120 sum_amount14400, B count120 sum_amount14520.
Goalpass=true judgeFailedOpen=false; Solcompletion245867 fulfills/verified,
final245868 done/delivered/reviewed/artifactsMatch. No worker_started events in exact
workflow sessionprefix. Definitionhasno modelstep; reviewstillusesmodel, notzerotokens.
Fixture disabledAPI200 afterfinal; receipts native-transform-contract-{start,response,
events,child-final,verification,build,hotpatch,assets,candidate}.

Output UX remainsnoisy: reportback includesread_json inputpreview ahead of finalaggregates.
Framework opportunity: select actualterminaldeliverable for user presentation while
retaining intermediateevidence forreview; don't hidepartial failures or drop requested
multipleoutputs. Next also unchangedworkflow changedinput reuse, longhorizon recovery,
crosssessionmemoryuse. No comparativeefficiency/Claude/mobile/release claim.
Broadgoalactive, docsupdatedafterbuild.

## Changed-input reuse and terminal-result presentation — execution PASS, delivery FAIL
Reused unchanged harness-native-transform-1789871824775 with 303 current records.
Expected A count101/sum20200, B101/20402, C101/20604. Reuse child
1789872100257-a86586 succeeded with exact results and non-failed-open goal review,
but final245961 blocked because input records were included.
Receipts transform-reuse-* preserve this negative result. Asynchronous enablement also
caused an early run to receive generic disabled/direct-work guidance before creation
verification finished; this remains an efficiency and lifecycle gap.

Added workflow-result-steps.ts and two pure tests: terminal dependency outputs selected,
independent outputs and false/zero preserved; missing final outputs preserve available
partial evidence. workflow-diagnosis renderSuccessBody uses selection; retained run
intermediate evidence unchanged. Full build passed and installed fingerprint
6f7c46748d4243e70f85de1f567cc557dc25d63d8bd4b9bef2edcdcf785e3d15.
Backups dist.backup-eWig18 / builtin-skills.backup-IzmAaW; both web assets installed.
Fresh session sess-desktop-df64100a3a55d3c0a2f5a178 source245964 called only get→run.
Child1789872320899-e32819 completed/succeeded, actual aggregates exact and goal
pass=true/judgeFailedOpen=false. Input preview removed from reportback. However final
Sol246008 rejected extra execution metadata under results-only request; final246009
blocked/completion_review_negative. This is NOT an overall acceptance pass. Next fix
user-facing reportback metadata presentation without weakening review or losing evidence.
Latest installed fingerprint rechecked and exact synthetic fixture disabled API200.
Receipts workflow-result-steps-{start,response,events,child-final,disabled,build,hotpatch,assets,candidate}.
User requested status; no benchmark run or comparative efficiency claim. Framework scope
and later user-owned token-meter comparison remain unchanged. Checkpoint edit after build.

## Concise workflow report — installed live PASS
Removed automatic positive goal-validation badge and duplicate output counts from
workflow-runner terminal body. Structured run_summary and goalValidation retained;
files/URLs still surfaced for access, failure/missed-goal/advisory paths unchanged.
Full build passed. Installed fingerprint
27c5c4b294b13b003358e04fc29d2bb782786d9c2aec40b9ec6157d8718326ce,
backup dist.backup-tWXDb5 / builtin-skills.backup-aMDtoC; both assets same digests.
Confirmed main and Claude80577 alive; zero leases before normal UI quit/hotpatch.
Enabled only synthetic fixture through API202 creationtest1789872769135-c75159;
followed its success before launching fresh test (enable/run race remains unmodified).
Fresh sess-desktop-48b04e160bf9fa635e9b3442 source246035, get→run only.
Child1789872801516-fb6f16 completed/succeeded, actual303-record aggregates exact,
goalpass=true judgeFailedOpen=false. Final Sol246079 fulfills;246080 done/delivered,
verified/reviewed, reply/objective/artifacts match, deliveredTextIsJudgedText=true.
Actual final is ONLY A101/20200 B101/20402 C101/20604 JSON; no metadata/inputpreview.
Independent final JSON equality assertion passed. Fixture disabled API200 afterterminal.
Receipts concise-workflow-report-{start,response,events,child-final,verification,enable,
build,hotpatch,assets}; start-concise-workflow-report.mjs. No benchmark claim.
Next: workflow-run-queue resumeWorkflowRun disabled branch always directs direct work
and never retry, even while creation verification is running. Need lifecycle-aware
response and preserve user's explicit saved-workflow intent. Broad goal stays active.

## Workflow verification lifecycle guidance — installed API PASS, automatic continuation OPEN
Prior turn made progress: concise final workflow results passed live. This turn traced
misleading disabled→do-work-directly instructions in both admit-named-workflow-run and
resumeWorkflowRun. New workflow-verification-state pure matcher requires same filename/id,
workflow, definitionHash, creation_test status, no finishedAt or terminalOutcome. Pure
negative cases pass (finished, terminal, unrelated identity, changed definition, malformed).
pendingWorkflowVerification scans current live records read-only. Both shared admission
paths now preserve explicitly requested saved-workflow intent, distinguish pending tests,
and state requested execution has NOT been queued. Does not grant execution or claim that
creation verification fulfills execution. Ordinary disabled guidance honors prior enable
authorization instead of unconditional ad-hoc substitution.

First build/hotpatch f56255d168e3a83333eaf2fbe53aa26f1d12f7015db53e3267ab45796ed7e0be
revealed console /run early disabled gate bypassing shared path. First test assertion
failed honestly, receipt workflow-verification-state-pending.json, creation child
1789873061785-2350b0 succeeded; disabled fixture before next patch. Added console response
409 status=verification_pending + exactverificationRunId for current unfinished tests;
ordinary disabled remains409. Build2 passed and installed fingerprint
3e3bec71c8df6c2c360decbe44e1bca94210300df3361544614dbfd4dd43dcf9.
Backups dist.backup-xBu03U / builtin-skills.backup-swe7tb, bothweb assets same digests.
Zero leases before normal app quit. Main and Claude80577 rechecked alive earlier.

Live API check: beforeenable409disabled; enable202 queues1789873195562-e32d65;
immediate run409verification_pending exactsameID, no execution queued. After that
creationtest terminal success, explicit run200 queues1789873216561-d00d68. Completed/
succeeded, exact A101/20200 B101/20402 C101/20604, goalpass/nonfailedopen. Fixture disabled
API200 afterterminal. Receipts workflow-verification-state-{before-2,enable-2,pending-2,
creation-final,run,run-final,cleanup,build-2,hotpatch-2,assets-2}; check script-2.
First script-2 GET failed during startup BEFORE any POST; reran after startup once.

Scope: installed API lifecycle acceptance, not a fresh native chat pending-state proof.
Automatic durable continuation from requested run through verification is still OPEN:
this patch corrects misleading fallback, but does not persist/defer that requested run.
Need exact request/definition/input binding and existing origin dispatch seal semantics;
do not introduce unbound auto-run or model polling to fake completion. Also audit duplicate
enable attempts, failed/cancelled verification, and restart behavior. No broad efficiency
win/benchmark claim. Framework goal remains active; docs updated after build.

## Deferred workflow execution through verification — installed live PASS (bounded)
Prior turn progress: lifecycle guidance/API distinction. This turn adds durable
verificationRunId to normal requested run records/options. Both native admitNamed and
resumeWorkflowRun permit queueing disabled definitions ONLY when current exact definition
has pending creation verification. Existing normal queue owns inputs/snapshot/dedupe;
chat dispatch still uses existing exact origin preparation/seal. Console pending gate
now allows shared admission rather than409. Native reply explicitly explains dependency.
No acceptDisabled bypass, no model polling, no second kernel.
Runner reopens exact verification and current saved definition before steps: pending
returns without model work, ready requires succeeded terminal + enabled + same definition
ignoring enabled + same code revision. Missing/cancelled/failed/drift/disabled blocks via
existing durable terminal/report-back path. Pure matcher/dependency tests passed; full
build passed. Installed fingerprint
62faa5388c337de827ba564dbb87671a0ee751a62bb9f433074e453975611329,
backups dist.backup-6tJ3rj / builtin-skills.backup-hbNPUN, both assets same digests.
Main/Claude80577 rechecked, zeroleases beforepatch; normal Quit delayed but process absent
confirmed beforehotpatch. No other agent edits/tokenmeter/auth/global defaults changed.

API acceptance: enable202 verification1789873482226-084da4; immediate execution200
1789873482360-3b7e35 stores exact verificationRunId. Immediate duplicate returns SAMEID,
duplicate=true. Restarted installedapp afterverification terminal but beforeexecution
started (saved pre-restart receipts: execution queued, no startedAt/finishedAt). Same run
resumed and completed/succeeded, correct aggregates, nonfailedopen goal. Exactworkflow
session prefix contains one tool_attempt_settled and no worker_started. No resubmission.
Cancellation attempt: verification1789873583260-b27739 finished before cancellation
arrived (cancel409alreadyterminal). Dependent1789873583361-ff3d2b then succeeded.
This does NOT validate cancellation; recorded inconclusive and followedexactexecution.

Fresh nativechat sess-desktop-eaf98f239da71c00e944136f, source246129, tools246145get→246154set_enabled→246161run only. Actual child
1789873662255-ac4e1a stores dependency1789873659969-1e6429, queued beforeverification
completion, then executes. Completed/succeeded, exact A101/20200 B101/20402 C101/20604;
goalpass/nonfailedopen. Sol246190 fulfills; final246191 done/delivered/verified/reviewed,
reply/objective/artifactsmatch/currentMatch=true. Independent assertion exact finalJSON,
unchangeddefinition exceptenabled versus original successfulauthoring, exact3toolcalls.
Syntheticfixture disabledAPI200 afterterminal. Prompt explicitly requests submitting
execution during pendingverification; ordinary uncoached naturalchat remains broadercase.
Receipts workflow-verification-dependency-*; verification-cancellation-*;
verification-native-chat-{start,response,events,child,child-final,verification}.

Remaining qualification: live cancelled/failed verification and definition-change cases;
restart whileverification itself pending (tested restart afterverificationbeforeexecution);
normalchat phrasing, otherproviders/effectful workflows. Broad memory/longhorizon/mobile/
release and user-owned comparative benchmark stillopen. No broad efficiency claim.
Docsafterbuild invalidate nextcandidate; rebuildbeforepatch.

## Deferred verification negative paths — live failure and drift PASS
No source or installed-byte changes this turn; confirmed fingerprint62faa5388c337de827ba564dbb87671a0ee751a62bb9f433074e453975611329,
main/Claude80577 alive. Prior turn progress was durable dependency+nativechat+restartpass.
Moved ONLY synthetic input harness-native-transform-1789871824775.json to reversible
.verification-backup beforeenable. Verification1789873816683-226225 terminalblocked
(missinginput); dependent execution1789873816851-0cad8c terminalfailed with explicit
pre-step dependency error. Exact execution sessionprefix has ZERO tool_called,
tool_attempt_settled, worker_started events. Restored original input afterbothterminal.
Receipts verification-failure-{enable,run,verification-final,execution-final}.

Changed-definition case: enable queuesverification1789873882370-bfc782 and immediate
requestedexecution1789873882480-c3d436. PATCHed only synthetic workflowdescription via
live consoleAPI200. Verification passed for originalversion; dependentexecution failed
beforesteps becausecurrentdefinitions no longer match. ZERO exactexecution tool/worker
events. Restored original description AND disabled viaAPI200 afterterminal. Receipts
verification-drift-{enable,run,patch,verification-final,execution-final,restored}; combined
verification-negative-checks.json. This validates drift afterverificationbeforeexecution,
not concurrent drift whileverification running. No destructivehomefixtures/reset.

Cancellation livecoverage remains inconclusive from previousturn (finishedbeforecancel).
Pure tests cover cancelled dependency but not a live cancelled-verification transition.
Restart whileverificationpending and ordinary uncoached chat also remain unqualified.
Move beyond repeating these successful aggregates: next broader memory usefulness and
longhorizon evidence should target failures/relevance rather than benchmarkwin claims.
User's tokenmeter comparison remainsuser-owned; broadgoalactive.

## Fresh-chat rule application and partial correction — live correctness PASS; duplicate write FOUND
No source/hotpatch change this turn. Main/Claude80577 rechecked; running62faa538... verified.
New synthetic Harbor/Dune Batch1789874020453 rules in ONE owner utterance: Harbor sums
onlycompleted duration inminutes; Dune sumscompleted+pending inseconds; cancelledexcluded.
Seed sess-desktop-2e93a06e403436549874437b final246227 acknowledged conversation-only,
but automaticcapture actually persisted compoundfact3789. No invented not-persisted claim.
Freshapplication sess-desktop-5fd8db01433a2b97975e622e source246228 final246249 returned
Harbor1.5minutes/Dune120seconds from newrows without instructionsrepeated. No toolcalls;
primer injected1619bytes, recall419ms. Actualroute ClaudeOpus5. No completionverdictref;
independent knowninputs/results check is acceptance, not claimed Solreview.

Freshcorrection sess-desktop-0e6a5986f40b05a2a34c44d0 source246250 final246301: Harbor
now includespending; Dune unchanged. Auto consolidation retired3789 and wrote3790 preserving
bothprojectrules. BUT native model additionally tool_search246267 +memory_remember via
call_tool246277(inner246279) +memory_list_facts246285(inner246287), generating duplicate
active3791. Correctness preserved, efficiencygap proven (extra discovery/write/readback).
Source capture246259 reasons=['explicit user preference or feedback'], conversationOnlyfalse,
hostReceiptIdnull. auto-capture.ts isExplicitDurableCorrectionRequest only recognizes
"correction for later/future reference" with a declarative claim; natural "Correction to
my saved reporting preference for ...: from now on, include ..." misses explicit durable
admission and falls to general preference. Existing rubric says avoid duplicate explicit
captures, but does not convey this exact committed/captured correction in currentpath.
Next investigate shared explicit correction parser + exacthostmemoryreceipt eligibility,
not blanket blocking memory_remember or dropping unrelated work. Preserve imperative
current-artifact edits/secondarywork exclusions. Need newpurechecks and hotpatchedliveproof.

Fresh correctedapplication sess-desktop-423a5aa8184abdc8db154ebe final246323 returned
Harbor3minutes/Dune60seconds for NEW rows, no tools. Thus learned correction transferred,
untouchedproject survivedcompoundfactcorrection; no broadmemory superiority claim.
Soft-forgot ONLY active syntheticfacts3790/3791 API200; original3789alreadyinactive.
Receipts memory-rule-{application*,correction*,corrected*}; application-verification.json
contains exactresponses/cleanup. No personalmemorydeleted, no tokenmetercomparison.
Goal remainsactive. Current nextaction is reduce duplicate durable correction work using
source-bound receipt, thenbroaderlonghorizon/mobile; workflowcancelcoverage stillopen.

## Source-verified memory intake context — memory-only live PASS; mixed-review gap FOUND
Prior turn progressed by proving ruleapplication/correction and discovering duplicate
memorywrites. This turn added saved-memory-correction.ts (pure saved/stored preference/
rule/fact/convention subject parser). auto-capture recognizes explicit saved correction
with from-now-on claim, retainsfullcandidate; currentartifact edits/secondarywork remain
excluded/separate. Puretest1pass + read-onlyactualparser assertions (secondaryfile-read
hasSecondaryWorktrue, current-immediate-sendnull). Initial testimport auto-capture under
node:test was refused bylivehomeguard; no bypass/noisolatedhome used. Refactoredpuretest
imports onlypurehelper; parser assertions run asordinary read-onlysourcefunctions.

host-turn-runner adds verifiedMemoryIntakeContext for exactacceptedsource beforemodel
request. Informationalsystemnotice says intake durable, avoidduplicatecapturedclaims,
consolidationmaypending, continue separatework, doesnotcompletetask. Getter independently
replays sourceprovenance/candidates, checks exactsourceevent, episode content/hash/metadata,
callID/sourceURI and candidate count/hash/text/kind/reason/authority/trust/pin/status.
Only pending/promoted accepted. No issue/redeem/completionreceipt rules changed. Getter
initially reused graph-bound deriveExactEvidence withcontextpurpose; livecheck showed no
persistedgraph for ordinarymemorychats, so noticeabsent. Replacedwithindependentreadonly
intakevalidation; original deriveExactEvidence and acknowledgementcompletionchecks restored.
Wrong-sourcechecknull, exactsourcecontextpresent againstactualrows. Need broaderformal
negativecoverage later; no blanket memorytoolgate.

First build/hotpatch53379ceb8858d5702c46032cc2151263f4406d9da0d7c33e74aaff5140af7bd1
seedHarbor/Dune1789874637178 sess-desktop-1c4e7a22c4183e6633a65686 source246324; fact3792.
Firstcorrection sess-desktop-8dd9fbb8b81b092512d52b3f still discovery/write/readback because
noticeunavailable. Auto retired3792→3793; memory_remember deduped this time (oneactive),
so inefficiency is extra calls, notalwaysduplicatedrows. Do not claimfirstpatchfixedit.
Finalbuild3pass installed b2753c245dcaaef3555c1e126ed1ef726d8026476ebac72814aa2f66cc406f23,
rollbackdist.backup-wCWsQQ / builtin-skills.backup-ma1jue; bothassets same digests.
Zeroleases beforeUIquit; one delayedquitverifiedprocessabsent. StartupGET refusal before
seedPOST retried once afterstartup. Defaults/auth/tokenmeter unchanged.

Fixedcorrection sess-desktop-06fb8d9ec14d8af2a3819513 source246398 final246420 returned
accurate Harborcompletedonly/Duneunchanged acknowledgement, ZEROtoolcalls. Auto retired3793
and saved3794, exactlyoneactivecompoundfact. Exactsourcegetterpresent/wrongsourceabsent.
Freshapplication sess-desktop-0e42f5cade343d4a63b36ab1 final246442 returned Harbor2minutes,
Dune60seconds for newrows, ZEROtools. Independentexpectedassertionspass. No Solreviewclaim
for these no-toolanswers; no comparativebenchmarkclaim.

Mixedtest sess-desktop-99b72a1485704214e2f413c5 source246443 requested correctionbackto
Harborcompleted+pending PLUSreadlocalrandommarkerfile. Firstmodel ONLYread_file246460 and
correctmarker. Sol246467 rejected: noverifiableevidencepreferencewassaved. Triggered
extra discovery, memory_remember, memory_forget(oldsynthetic3794), memory_list_facts;
Sol246521passed final246526done withaccuratemarker andbothrules. This is correctnesspass
AFTERrepair, NOTefficiencypass. Next fix is share exact durableconsolidation/canonical
fact evidence with completionreview for mixedtasks; do not weakenreview or claimintake
aloneprovescanonicalupdates. Need retain independentfileevidence and failed/pendingcases.

Receipts memory-intake-{context*,live*,correction*,fixed*,application*,mixed*,final-facts,
verification}. Active3795softforgotAPI200afterterminal; 3792/3793/3794alreadyinactive.
All synthetic inputfilesretained, no personalfactsmodified. Broadgoalactive; docsafterbuild.

## Automatic consolidation evidence for mixed completion review — candidate built; LOCK blocks hotpatch
Prior turnprogress: memory-onlyzero-tool pass; mixedreviewmiss triggeredduplicates.
Current source refactors verifiedMemoryIntakeContext underlying checks into shared private
verifiedMemoryIntakeRows, preserving exactsource/provenance/episode/candidatevalidation.
New verifiedMemoryConsolidationEvidence reopens resulting_fact_id and currentcanonical
fact, requires promotedcandidate +activefact +fact_evidence linking EXACTepisode/sourceURI
+fullshowncontent <=12000chars for verified=true. Includes actualcandidate/currentcontent,
disposition, activeflag, digest/update time; pending/inactive/unlinked notverified. Reviewer
mustcomparecontent to requestedcorrection (promoted/ignore alone notsuccess). Existing
completionreceipt/ackonlygates unchanged. Host completion toolCallSummary now receives this
memoryevidence separately fromsettledfiles/reads; eventstoresjudgedMemoryResults.
Fullbuild passed output/memory-consolidation-evidence-build.txt (session14088 exit0).

Read-only sourceassertions against oldcleanedtest source246398: inactivefact3794 linkedbut
verifiedfalse; wrongsource246324 null. No DBmutations forassertions.
CUA getAXState twice reported MacLOCKED/autounlockfailed; asyncuserinput asksunlock.
No appquit/hotpatch attempted whilelocked; noauth/OS/securitysettingschanges. Current
installed still b2753c245dcaaef3555c1e126ed1ef726d8026476ebac72814aa2f66cc406f23.
Do not callnewreviewintegrationlivepassed. This goalturn changedcode and gainedevidence;
first goalturn withthislock, noteligibleblockedstatus. Afterunlock rebuild (docschanged),
normalquit/hotpatchbothassets/reopenverifyfingerprint, thenlive mixedtest.

Prepared nexttest throughrunningliveAPI whilelocked (authorizedfixtureonly): fresh
Harbor/Dune Batch1789875299635, sess-desktop-022794054539f695b31cd990 source246527,
final246548. Activecompoundfact3796 holds Harborcompletedonly/minutes and Dunecompleted+
pending/seconds, cancelledexcluded. Leave this syntheticfact ACTIVE for nextmixedtest;
softforget onlyitsresultfacts afterterminalacceptance. Sourcecandidategettervalidated
actualpromoted3796 active/sourceLinked/verifiedtrue, wrongsource refused. Receipt
memory-evidence-positive-candidate.json; memory-evidence-live-{start,seed-response,
seed-events}; start-memory-evidence-live.mjs. Actualtestseed usedinstalledoldreviewer.

Next exact mixedtask: correct Harbor to completed+pending, Duneunchanged, thenreadnew
randommarkerlocalfixture andreturnit. Expect ONEread_file, no memorytools/discovery, final
Solfirstreviewpass withjudgedMemoryResults verifiedcanonicalfact, exactmarker. Follow
acceptedhandle, noresubmit. Ifconsolidationpendingatreview, reporthonestlyanddesignbounded
continuationwithoutduplicatememorywrite; do notgrantcompletionfromintakeonly.
Broadgoalremainsopen, benchmark/mobile/release/longhorizon/cancelqualificationunresolved.

## Consolidation evidence installed + mixed-request first-review PASS; bounded wait added
Mac unlocked on nextgoalturn; no blockedgoalstatusset. Main/Claude80577/zeroleases checked.
Preparedbuild installed8648addfb81c0d8a4685b9a2c9f6ca97a8f9801a6faf9a8d140717855e045467,
backupZE6VX4/h7aZjs, bothassets. Freshmixed sess-desktop-2c85cb524d5eec1a20ca0e86 source246549
read_file246566 then Sol246573 rejects correctly: candidate2166401 pending, nofact yet.
New judgedMemoryResults provedactualpendingstate (notmissing-evidencebug anymore). Auto
consolidation laterpromoted3797, but modelrepair addedduplicate3798 +readback and verbose
reply; reviews246606/246608 rejectextra text, final246612 negative. Do NOTclaimpass.
Consolidation resolved_at usesdrainstarttimestamp, notactualfinish; updated_at3797 was
03:40:21Z, firstreviewfinished03:40:32Z butevidencecaptured earlierwhilepending.

Added bounded15sec host wait (500ms checks, abort-aware) foralreadyrunning sourcebound
memoryconsolidation beforecompletionreview. Startsno newjob/modelcall. Pendingafterdeadline
stillunverified; nofailedopen. Emitsmemory_consolidation_review_wait ifwaited. Buildpassed;
installed6c45f4d436504b01b150756ef988a0d17ba453fd5e657e13bc7837e5c9b7c6db, backupYXw7S4/fT9IdS.
SoftforgotONLY syntheticduplicate3798 API200, retainedbaselinecompound3797 fornewcorrection.
Initialcleanup importdistduringbuild failedbeforeaction becausecleandistinprogress; retried
readonlygetFactfromsource+APIcleanup, nouncertainmutationretry.

Freshoppositecorrection +randomfile mixedrequest sess-desktop-3abaab5647f1293b7b910ca3,
source246613 (seeeventsifneeded); ONLYread_file246630. Sol246637 firstreviewfulfills=true,
judgedMemoryResults promoted3799 active/sourceLinked/verifiedtrue contains Harborcompleted
only/minutes and Dunecompleted+pending/seconds unchanged. Final246641success, exactrandom
filemarker included. No discovery/memorytools/readback/repair. No wait event: consolidation
finishedbeforethisreview, so this is liveevidenceintegrationPASS, NOTlivewaitbranchcoverage.
Independentassertonefilecall/onepositivejudge/exactmarker. Softforgot3799 API200; all synthetic
factscontaining1789875299635 nowinactive (3796/3797superseded,3798duplicatecleaned).

Narrowedwait to explicitMemoryInstructionFor(objective)!==null soincidentalbackgroundlearning
cannotdelayordinaryrequests. Candidateassertactualmixedobjectiveeligible, ordinaryfileread
ineligible. Fullbuildpassed thenhotpatched/reopenedverifiedfingerprint
92e4e903fa9d92ba455157ba78595840332ab758857f3a792fc9ba9758272f71.
Backupdist.backup-ovvAqb / builtin-skills.backup-zLMHrV; bothassetsidenticalpriorhashes.
No repeatmodeltest afterthisonepredicate narrowing; livefirstreviewpass ispreceding6c45build,
finalbuildidentity+predicatechecks verified. Receipts memory-consolidation-{evidence*,wait*,
wait-scope*}, memory-evidence-{mixed*,wait*,repair-duplicate-cleanup}. No broadtokenspeedwin.

Next: qualifyactualpendingwait/timeout/cancelwithoutduplicatememorywork, thenbroaderlong
chatandmemoryuse; don'trepeatpassingaggregation. Plan/Space/nativeworkflow successesretain
scope; physicalmobile/signedrelease/otheruserparity/comparativebenchmarkstillopen.
Goalactive; docsafterbuild meanrebuildbeforefuturehotpatch.

## Mixed remember requests hid native tools — fixed and live accepted
Continuation after status check: main e5a75f5a; Claude PID80577 still cwd
~/clementine-next. Installed92e4 fingerprint verified.
New live request sess-desktop-a671c5024c94eb37b231a424 source246642 began
"Remember this reporting preference ... Then read [absolute local file]".
Memory3800 correctly saved, but localMemoryBuiltinScope treated prefix "Remember
this" as a memory-only request: only15 tools, no read_file/tool_search/native
Spaces/workflows. Model used memory_read then memory_recall; falsely asserted
existing file missing. Sol246674 BLOCKED, final246678 blocked. Not a pass.
No actual consolidation wait occurred. This uncovered a capability restriction,
not a reason to weaken completion review or force memory timing in the live DB.

Changed src/agents/orchestrator.ts: restrict to memory-only builtin surface only
when user explicitly requests local memory only. Implicit remember/recent-recall
phrases retain ordinary stable native capabilities and schema-on-demand discovery.
Updated existing tool-search-surface regression expectations for mixed file,
workflow, Space and ordinary memory requests; explicit local-only/no-write retained.
Did not run that suite's isolated-home fixtures. Read-only actual exported function
assertions passed for mixed cases and explicit local-only/no-memory-write.
Full npm build passed. Zero active leases before normal UI quit. Hotpatched
44f310b0f58a6f5eb0223769ac2f1c1f34cc7aa27956da44449de3430aaf0013;
rollback dist.backup-YYjxT3, builtin-skills.backup-GrYtTI. Both web assets installed,
console bdc760ab2001155dc0079523238e8c6d1b785cb99b6ecd1edb5b08bbc302f32b,
mobile 90b53d15d6b1df9ff7fdf8432ffa13b8e6fad3e6a9b615dec30309318eee7d8d.
Reopened proper user Applications app and verified running fingerprint before test.

Fresh same-objective request sess-desktop-1d2d3af65137282c027de784 source246679:
26 native tools available incl file/Space/workflow/discovery. ONLY read_file246696;
Sol246703 first-review fulfills=true, verified canonical fact3800 reinforced with
exact source evidence, exact random file marker returned; final246707 done with
verified reviewed verdict reference. Assertions one call/one positive review/exact
marker passed. Softforgot only synthetic3800 via API200 after terminal.
Receipts memory-pending-live-* (failure) and memory-mixed-surface-* (build/patch/pass).
No speed/token comparison: changed tool surface and warm memory affect costs.
Actual pending/timeout/cancel memory wait remains unqualified. The memory_read
"Not found" result refers to vault resolution, not arbitrary filesystem absence;
review accepted that unsupported blocker in failed run. Surface fix prevents this
observed route; broader evidence-scope clarity remains a possible follow-up.
Goal remains active; no commit/release, usage-sidecar untouched. Docs after build.

## Multi-field correction passes; memory lookup miss now reports its scope
Main and other Claude PID80577 rechecked. Initial installed44f310 verified.
Seed sess-desktop-8c07934f5abe0a5d0d7b0e31 source246708/final246729 stores synthetic
Harness Cedar1789876794321 compound reporting rule in3801. Correction source246730,
sess-desktop-50b5460ba31aca619acd1fff, changes seconds->minutes, completed+pending->
completedonly, descendingtotal->alphabetical, preserves grouping/count/final rounding.
Only read_file246747, first Solreview246754 fulfills=true, final246758success;
canonical3802 supersedes3801 and contains preserved rules. No memory wait event:
consolidation completed before review. This does NOT qualify actual wait/timeout/
cancellation. Stop repeating fast correction variants to hunt timing by chance.
Softforgot3802 API200 after terminal;3801/3802 both verified inactive. Receipts
memory-slow-correction-* include exact marker, independent call/review assertions.

Followed observed earlier failure's misleading memory_read evidence. Its generic
Not found response for a vault lookup was treated as arbitrary file absence.
Changed src/tools/memory-tools.ts description to identify vault scope and read_file
for workspace paths. Missing/unreadable vault target now explicitly says this
lookup does not establish whether the requested local filesystem path exists,
and names read_file for recovery. Missing fact/policy references identify durable
memory scope. No path-access change, reviewer exemption, or global/auth setting.
Full build passed (memory-read-scope-build.txt). Zero leases before UI quit.
Hotpatched and reopened proper installed app, verified fingerprint
2e5a054b0834fd78d0fb94f239805b8bb17829343878bb18219e5c5406b2c149.
Rollback dist.backup-9LZbkP/builtin-skills.backup-ZrOMXJ; both webassets identical
previous digests, backups recorded in memory-read-scope-assets.json.

Live explicit recovery request sess-desktop-04eb66260263b5e84d7b11ff source246759
asks try memory_read first, then use available tool to return local file content.
Calls memory_read246775 -> scoped fallback246779 -> read_file246782 exact marker.
Sol246789 firstreviewtrue; final246793 done/verified/reviewed. Independent assertions
pass. Zero memory candidates from this opt-out test. This validates coached recovery
from the precise tool miss, NOT an autonomous choice or comparative efficiency test.
Receipts memory-read-scope-live-* and build/patch/assets. Cedar tests cleaned;
local input/evidence files retained. Goal active; no release/commit; docsafterbuild.
Next broader long-chat/task continuity is more valuable than repeated passed tiny
memory/file checks. Slow-save timeout/cancel remains explicitly unqualified and
should use a targeted controlled qualification, not live DB manipulation or an
isolated-home acceptance claim. Physical phone/other-user install parity and
user-owned side-by-side benchmark remain open.

## Long-context audit and cross-chat memory supersession
Installed2e5a fingerprint reverified; source review/read-only work this turn, no patch.
Reviewed last400 condenser events: seven Layer2/3 applications, newest Layer2 on
Sept5 (seq132581). Current weekend24-code pressure pass was Layer1 tool-result
collapse, not full conversation summarization. Receipts long-chat-higher-layer-audit.
Read-only week prompt audit found top history-heavy calls up to250916 estimated
prompt tokens (history224631), largely older Plan/research/Space repair sequences.
No inference that their old failure paths remain unfixed today.

Replayed CURRENT collapseOldCompletedToolPairs with retainPairs3 against stored
snapshots of12 highest-prompt sessions, without saving snapshots or model calls.
Asserted source arrays unchanged and ALL user messages deep-equal/in-order.
Every collapsed call reference remained in its resulting summary in these cases.
Examples:196203->74978 estimated history tokens,297370->30806; one9-item/104036-token
snapshot had no eligible older pair to collapse. These are readonly potential
projections, not actual provider savings or changed production thresholds.
Receipts long-chat-pressure-audit.json and long-chat-collapse-replay.json.

Source finding: compaction Layer2 preserves every user message, earlier compaction
summary and tool pairs; summarizes assistant/system prose. buildForkRequest forms
summary+lastUserMessage but loop.ts at10639 only injects a capacity warning asking
user to start a new chat; no automatic fork occurs there. Full-window continuation
is unqualified; inspect any adapter overflow recovery before treating warning path
as the complete capacity behavior. Do not switch models/global thresholds simply
to force a test or silently fork the user's actual conversations.

New materially different memory test: obsolete rule remains in an old chat, later
correction made in another chat, then original chat resumed without re-stating rules.
Original Cedar seed sess-desktop-8c07934f5abe0a5d0d7b0e31 source246708 contained seconds,
completed+pending, total-descending rule. Separate correction
sess-desktop-12b04d6b5011f6af8627c997 source246794/final246815 promoted3803: minutes,
completedonly, alphabetical, preserve count/group/finalrounding. Confirmed active
canonical row before resuming. Old chat newsource246816 requested current saved
conventions on new rows. ZEROtools; current corrected rule present in injected
memory; Sol246833 firstreviewtrue; final246837 table Alpha2/1.0minutes,Beta2/2.5minutes.
Independent table/order/count/unit assertions passed. Actual ClaudeOpus5 route.
Limitation: final also gratuitously computed obsolete alternative seconds totals;
correct current result but unnecessary work/ambiguity, not efficiency qualification.
This is short cross-chat supersession, NOT full long-window handoff acceptance.
Softforgot ONLY synthetic3803 API200 afterterminal. Prior Cedar3801/3802 inactive.
Receipts memory-old-chat-{correction,resume}-*. Goal active, no new code changes.
Next qualify and improve actual context-capacity continuation; separate targeted
pending-memory wait/timeout/cancel stillopen; mobile/release/benchmark boundaries
unchanged. Preserve current source and sidecar. Checkpoint appended after lastbuild.


## Snapshot preservation and local Plan binding fix — latest status
Shared checkout remains main/e5a75f5a. Latest recheck finds Claude PID47978 in this
same checkout (earlier PID80577 ended). Preserve shared edits and usage-sidecar.
Running installed app fingerprint be0f901ff3ee6b44947a9b929cd4351a6fedeb348d6b33a9e5c128bc63e5fd5c,
version3.18.17/schema81 verified from live endpoint. No release or commit.

Fixed HarnessSession.updateConversationSnapshot overwriting newer sibling session
metadata from a stale session object. It now atomically json_set's __conversation
and refreshes the row. Installed before/after helper reproduced metadata loss then
preservation; candidate and installed checks pass. Existing session regression added,
isolated-home suite not run. Receipts snapshot-metadata-{before,candidate,installed}.json.
Other metadata setters were not broadly rewritten; do not claim all races eliminated.

Actual installed checkpointGoalStage on live test sess-desktop-3f470fbb78675aff366300c6:
initial snapshot had no eligible prose (no-op, not pass). After two discussion turns,
Layer2 summarized two assistant prose items, preserving every user message, exact
requirements and newer sibling metadata. Actual Luna usage verified. This was an
explicit stage checkpoint, NOT automatic full-window overflow qualification.
Receipt compacted-plan-live-discussion-checkpoint-result.json. Tiny estimated history
reduction5647->5605 is not a comparative efficiency win.

Execute source246957 then failed binding sealing, with no artifact written. Original
immutable graph incorrectly changed validated cap:local:read_file:read to an unrelated
:exec: successor. An attempted plan-tools frozen-catalog fallback did not solve this
and was REVERTED. Production-configured binding diagnosis showed no frozen entry for
that substituted reference. Initial standalone missing_factory was helper setup,
not an app bootstrap bug. Old attempt ended interrupted; immutable seal recovery
remains held. Do not rewrite that graph, resubmit it, or claim execution recovered.

Root fix: admitted-capability-ref.ts preserves exact source-revalidated local refs
before generic successor resolution; admit-turn-semantics.ts uses it. Unknown refs
still resolve normally. Two pure tests and full build passed. Installed be0f above;
rollback dist.backup-LMX8qH / builtin-skills.backup-fkwF9g; both webassets installed,
receipts local-ref-preservation-{build,hotpatch,assets}.

Fresh replacement Plan accepted once: sess-desktop-87e7aac2946d516d9ce9d403,
source247007, final247071 success with verified Sol review247062, actual Opus5 author.
Plan plan-9bb65c2e-f5ee-4d8c-88ff-cbcc43c7807d revision1 digest
57f70baca6d5f756f7b75602b4ab0b5d458779f70d4a4517a8ac2fd6483b77fd.
Correct original local write/read refs in published plan247063. Separate output file
local-ref-preservation-live-artifact.txt remains absent as required during planning.
Receipts local-ref-preservation-live-{start,response,events}.json. Execute NOT yet
submitted: next qualify fresh execution and exact create-once/read-back with genuine
review; optionally stage compaction after discussion for combined continuity test.
Do not mistake successful Plan publication for executing the admission fix.

Lease checks must compare ISO lease_expires_at to current ISO UTC, not Date.now().
Reuse existing test handles; never repeat POST because observing a result timed out.
Still open: automatic full-window continuation; memory pending-save timeout/cancel;
physical mobile and other-user release parity; user's later Claude Code/token-meter
comparison. Current result is framework progress, not general superiority or release
readiness. This checkpoint was appended after the latest installed build.


## Fresh Plan execution passes on installed be0f build
Executed the already-reviewed replacement plan exactly once: source247072,
attempt:desktop:50b8f768e6471ab392a44f3845cf4b7ff5dacb3c. No new Plan submitted.
plan_task247092 succeeded; write_file247105 (top-level work_call) and read_file247116
were the only business calls. Transport mirrors are not additional calls.
One settled write with writeOrdinal1; direct independent disk-byte comparison and
retained read result match the expected82 bytes, including trailing newline.
Sol review247126 fulfills=true with verified complete read evidence and matching
artifact; final247138 success, no continuation. Actual usage records four Opus5
calls plus one Sol call, all trace-linked to source247072. This qualifies fresh
Plan->Execute after the local-reference fix; no compaction was inserted in this
fresh test. Old immutable bad graph remains a separate interrupted test.
Receipts local-ref-preservation-execute-{request,response,events,assertions,usage}.

Planning-efficiency finding from source247007: first publish_plan used read_file
as capabilityRef without discovering its exact local planning reference. Correctly
rejected; draft retained and repaired after tool_search(read_file). The write tool
had already been discovered. Existing description says discovered capabilityRef,
but that field has no dedicated description. Potential improvement: make each
first-class native tool's exact planning identity directly available so selecting a
known native read need not rediscover it or retry publication. Do not accept guessed
aliases or bypass source-authority checks. No source edit made for this finding yet.

Execution cost: {"promptTokens": 143001, "cachedReadTokens": 66074, "uncachedInputTokens": 76927, "uncachedWorkTokens": 77749}. These totals include review and
cache reads; they are one qualification case, not matched benchmark savings. Initial
calls still carry substantial repeated schema/history overhead. Next prioritize
native planning identity availability and context overhead, alongside open true
full-window continuation qualification. Goal remains active; no new patch this turn.


## Native reads carry their Plan identities — installed and live accepted
Main/e5a75f5a and active Claude PID47978 same checkout rechecked. Changes this turn:
orchestrator.ts issues current local planning disclosure candidates only for native
read tools in the final policy-filtered Plan surface, publishes through the existing
source authority, and adds returned exact refs to cloned model tool descriptions.
No tools added, no guessed aliases accepted, no invocation/permission checks removed.
The same decorated tools now supply the sealed universe and model surface.
publish-plan.ts capabilityRef field explains exact supplied ref vs bare tool name.
Normal/Execute descriptions unchanged. Current native Plan disclosure observed only
read_file and space_get; do not claim every Space/workflow reader is covered.

Initial candidate cb203886 introduced a model/envelope description mismatch: live
sess-desktop-41c51111b8e67b6e8b2912b7 source247142 ended blocked247160 with
model_surface_not_exactly_bound BEFORE any model/tool/business call. Fixed universe
assembly to use modelTools as active instances, not original toolPolicy.tools.
Builds passed after one TypeScript narrowing correction. Envelope test suite refused
live-home config at import; no override, reset, isolated run, or passing-suite claim.
Receipt native-plan-ref-envelope-tests.txt. This is distinct from live acceptance.

Corrected installed fingerprint:
0be64b54dfd143bc3ca16c2f4b9f0d65b2f37d46340a312321c4cf47f00893af
Schema81/version3.18.17. Rollback dist.backup-HnQJUA / builtin-skills.backup-7Q6SsA.
Both console/mobile assets installed and retained rollback in native-plan-ref-fixed-assets.
Fresh Plan sess-desktop-c97e4c9178927f410c002b13 source247167 final247213:
read_file/space_get disclosed before first model call; exactly same22 callable tools
as previous reference test. Only tool_search(write_file)247184 and publish_plan247198;
first publication succeeds with verified Sol review247204, NO read discovery/retry.
Published plan-71352a37-1927-45f4-a98b-f822b557e56e revision1 digest
b52ffe232f77d6ef35824cc378b8a782ec4a2d12f7851b9c38073b106169c51f.
File absent throughout planning. Actual Plan usage:2 Opus5 +1 Sol calls,
prompt64199/cache19158/uncachedWork46512. Previous matched-shape plan used5 tool calls;
current2 includes also skipping directory listing, which is model choice, not proof
all three saved calls are caused by annotation. No comparative benchmark win claim.

Execute source247217 once, attempt:desktop:93574d802eaf128539a388654b14179b99bc3991:
plan_task247237 -> write_file247250 -> read_file247264. One physical write, exact79bytes
independently compared on disk and retained read result, one trailing newline.
Sol247274 verified true, final247286 success. Actual Opus5 and Sol usage confirmed.
Receipts native-plan-ref-fixed-{live,execute}-* and assertions.json. Initial failing
native-plan-ref-live-* retained. No user files or usage-sidecar modified, no release.
Goal active; this closes native read identity's tested file path. Broader first-class
workflow/Space Plan surfaces, automatic full-window continuity, pending-memory timing,
physical phone/release parity and user-owned benchmark remain open. Docs after build.


## Workflow definition/status are native selectable Plan reads
Rechecked main/e5a75f5a and ClaudePID47978 same checkout. Installed observation helper
inspect-native-workflow-planning.mjs uses actual configured runtime with no tool
execution: read_file/space_get citable; workflow_get/workflow_run_status configured
but refused not_declared. Added localPlanningRead:true to ONLY those two workflow
registry declarations after confirming read-only bodies. Generic current-schema
observation, source disclosure, reviewed work_call binding and execution checks
remain intact; no new wrapper, alias normalization, or global settings.

Full build passed. Zero live leases before quit, hotpatched installed app and both
webassets, reopened and verified source fingerprint
9a2fcf564b12bd5f81e3cd951950da5aeea7af5afdb3bec34c984c2f6fcdf5b7
Version3.18.17/schema81. Backups dist.backup-pssbuJ / builtin-skills.backup-5ARvyx;
webassets retained in native-workflow-planning-assets.json. Installed observation
now yields cap:local:workflow_get:read and cap:local:workflow_run_status:read,
effect read, carrier work_call. Before/installed receipts retained. No isolated test.

Live report Plan sess-desktop-9d6bb6969da7daa22d4d947e source247332:
Current policy same22tools. Four native reads disclosed at247339, including both
workflow readers before first model call. Preparation calls workflow_get metadata
and workflow_run_status exact known test run, only search write_file, then first
publish_plan247383 succeeds. Sol247388 true, final247396 success.
Plan plan-8749f3ce-c556-4f4d-9d33-349ce1694f16 revision1 digest
155568137434e8dfcd7dd0aa1479e705dca11f7bdec68a82654dab2cb79bf82f.
Required graph steps read_workflow and read_run use exact native refs, compose_report
uses both fresh outputs, write_report binds /markdown dynamically, then readback.
No frozen preparation values substituted for execution reads; no Plan writes.

Execute source247403, attempt:desktop:b100d80e5be50d66809ae8f797b78e024ce5853d:
plan_task247428, workflow_get247439/workflow_run_status247440 (fresh calls),
plan_step_result247460 and correction247470, write_file247479, read_file247494.
Both compute calls succeeded; model self-corrected unnecessary timestamp21:5x to
just the current date before any write. No retry failure, but avoidable token work.
Sol247506 firstreviewtrue with fresh native read evidence; final247523 success.
Independent report/readback equal; A101/20200,B101/20402,C101/20604 and total303/61206;
current disabled/manual-only distinct from historical completed run. Original run
1789873662255-ac4e1a SHA256 unchanged; no workflow mutation/run calls occurred.
Native fixture harness-native-transform-1789871824775 remains disabled. Actual
Opus5 and Sol usage recorded with exact accepted-source attribution. Receipts
native-workflow-planning-{live,execute}-*, assertions.json, usage.json.

Framework change accepted in installed/live environment. No release/commit or
personal integration edits. Do not claim broad speed wins: dynamic content was
retyped in write args even though host binding can supply it, and compute correction
added overhead. Next major scope is genuine long-context continuation/context
cost, plus remaining Space native Plan coverage, memory timing/recovery, physical
mobile and other-user release parity; user-owned comparison remains later. Goal
active. Checkpoint appended after installed build; rebuild before another patch.


## Context capacity audit — next continuation boundary
Read-only turn; no source edits/hotpatch/model calls. Rechecked main/e5a75f5a,
ClaudePID47978, running9a2fcf fingerprint saved long-context-capacity-build.json.
Inspected current loop and adapters: compactSessionIfNeeded runs before current
options.input is appended; Layer3 returns ForkRequest but loop only injects a
start-new-chat warning. No automatic handoff consumer established. buildForkRequest
keeps only the last summary block and last STRING user message; this is NOT adequate
as a durable handoff contract (array-content user messages excluded, prior exact
requirements absent). Do not wire this seed directly into automatic new sessions.
Current host/recovery accepted-source/graph identity must survive any future rollover.

Scanned last1000 condenser events:10 Layer2 applied events found; all whole-pass
before/after estimates decreased. This does not isolate Layer2 cost where Layer1
also applied. Existing proposed non-shrinking-summary issue has NO observed failure
in these results; no speculative patch made. long-context-layer2-size-audit.json.

Read20 largest persisted snapshots (all-time, NOT this week's active prompts),
computed category estimates with installed estimator. Largest512605 estimate:
493889 tool results,16536 tool args,124 user,1780 assistant. Other examples371835 and
297370 dominated by tool outputs. Installed current context observations Opus5=200000,
Sol=712800, not registry nominal1M; source compaction uses effective observations.
Receipt long-context-capacity-breakdown.json; raw private snapshots only under output.

Replayed exact installed DEFAULT Layer1 algorithm on independent clones:
clipOldToolResults retain6 + collapseOldCompletedToolPairs retain18, actual session IDs
for lossless parked-output checks. All original arrays unchanged; every user message
exact/in-order in resulting arrays.20/20 after estimates <=92862. This is a readonly
projection, NOT actual provider savings or a live automatic full-window pass.
Receipt long-context-current-layer1-replay.json; scripts audit-context-capacity.mjs
and replay-current-layer1-capacity.mjs. Earlier12-snapshot replay used retain3;
this one uses current production defaults and a larger all-time sample.

Several largest residual estimates include old encrypted reasoning (e.g48084 of92862).
Estimator intentionally counts encrypted wire bytes as text although comment says
not provider prompt tokens; Claude headless drops reasoning and direct transport
handles it separately, Codex replays encrypted reasoning state. Do not call those
numbers billable savings or indiscriminately drop reasoning needed by tool frames.

Next engineering target: a durable, source-preserving capacity continuation, with
current objective/reviewed plan and completed/uncertain effects kept authoritative;
original dialogue and parked results recoverable by stable identities; complete
outgoing prompt (current input + instructions/tools + history + output allowance)
considered. Current Layer3 seed/warning is insufficient. Existing deterministic
compaction works well on sampled tool-heavy histories, so do not tighten its normal
thresholds blindly or spend huge model tokens merely to fill a window. Need a
controlled installed/live boundary qualification before claiming automatic recovery.
Other remaining memory timing, mobile/release parity and user benchmark remain open.
Goal active. This turn gathered new size/category/default-replay evidence only.


## Final-frame capacity handling — installed, overflow handoff still open
Rechecked main/e5a75f5a and activeClaudePID47978. Prior turn was progress via new
read-only capacity evidence; this turn implemented a prerequisite, NOT the entire
long-context handoff. Current objective and all broader requirements unchanged.

New context-capacity-policy.ts calculates pressure from estimated full outgoing
input versus90% effective model window. Normal frames preserve original cache-aware
thresholds. Under pressure, existing deterministic recallable-pair compaction keeps
one newest completed result pair, retires older recallable pairs; no user messages,
active task/graph metadata or side effects are rewritten. No extra model job.
loop.ts moves the existing in-flight compaction block to publishPromptComponents,
after current user input, instructions, tools, memory/context and retry injections.
It runs once per model-input projection and maintains the existing stable checkpoint
state. Telemetry adds capacityPressure/outgoingInputTokens/contextWindowTokens on
new capacity-triggered compaction. Existing kill switch remains, exceptions preserve
best-effort uncompacted behavior. Ordinary configured thresholds remain in force
below genuine capacity pressure. Estimates are NOT an exact provider token count.

Both compactInFlightToolContext variants now decline a replacement if its recall
ledger is not smaller than the existing input, avoiding expansion for tiny results
when capacity pressure comes from other context. Three pure policy tests passed;
full build passed. No isolated-home suite or destructive fixture reset.

Hotpatched proper installed app, both webasset directories and builtin skills,
reopened and verified fingerprint
407f71656b9582a26a5063d526b2e0a8f4a7bddd224b7e8882276e734395f3d0
Version3.18.17/schema81. Backups dist.backup-Yw9aSS / builtin-skills.backup-IVxBqi;
assets receipts context-capacity-assets.json. Zero live leases before patch.

Installed functions tested against COPIES of10 actual high-pressure snapshots from
the prior20-snapshot audit, with fixed200k window plus20k overhead for this structural
qualification. All original arrays unchanged; every user message and newest result
preserved; every collapsed call ID still present for recall; stable replay produced
identical projected input with no new checkpoint on repeat. All projections shrank.
Tiny synthetic two-result input rejected an expanding summary in both variants.
This script makes NO provider calls or session writes, does NOT prove a foreground
capacity-triggered turn, and is not measured live savings. Receipt
context-capacity-installed-checks.json/.txt; check-installed-context-capacity.mjs.

Normal live regression sess-desktop-9ab3ef829191d3b5f160d278 source247656:
read_file247675 only; requested existing test report values A101/20200 B101/20402
C101/20604 and disabled state. Sol247682 verified true firstreview; final247686success.
Actual Opus5/Sol usage recorded in context-capacity-live-usage.json. No compaction
pressure was induced in this small turn. This checks moved filter's ordinary path.

Automatic OVERFLOW CONTINUATION REMAINS OPEN. The new reduction may still leave
huge user messages, one giant newest result, schema overhead or nonrecallable state
above budget. Layer3 still warns rather than completing a durable handoff. Do not
call this full-context acceptance. Next need controlled installed/live foreground
pressure qualification and source-preserving continuation for irreducible context;
no global model/window overrides, no personal-session truncation, no invented result
receipts. Existing session_history reconstructs public accepted sources; active-task
context is bounded and not a lossless substitute for all task requirements. The
legacy last-summary/last-string-user ForkRequest must not be wired as-is.
No release/commit. Preserve sidecar and other edits. Goal active; docs after build.

## Live foreground capacity pressure and retained-result recovery — passed
Previous status-only turn was no progress; resumed with an actual installed/live
qualification. Rechecked main/e5a75f5a, Claude PID47978 cwd clementine-next, and
running fingerprint407f71656b9582a26a5063d526b2e0a8f4a7bddd224b7e8882276e734395f3d0.
No additional source patch, model/window override or personal-session mutation.

Fresh synthetic fixture sess-desktop-144969081139e6188ff5adf7 source247762 read a
720305-character archive (explicit730000 preview), then a small selection file
whose path occurred at the archive end. Selection required an unpredictable UUID
in the archive middle. Only3 tool calls: read_file247778, read_file247788,
file_query247796 targeting the first read's exact call ID. Foreground checkpoint
247794 recorded capacityPressure=true, outgoing267805 against harness budget200000;
one old pair collapsed, newest retained, history estimate234921->975. Full archive
still present in durable result handles. file_query recovered the requested entry
from the retained earlier result. Final247807 exactly matched the independently
created expected UUID; Sol247803 firstreview fulfills/verified, no failed-open.
Actual usage4 Opus5 calls +1Sol, all certified. Provider prompt counts in call order
40949,274360,41449,42191,10474; total uncachedWork308028. These are test costs, NOT
matched benchmark savings. The giant newest result was sent once before it became
eligible for collapse. The successful274360 provider input exceeds the conservative
200000 harness pressure budget, so this was NOT a provider hard-overflow test.

Receipts capacity-pressure-foreground-{start,response,events,usage,assertions}.json;
creator start-capacity-pressure.mjs refuses to submit twice if its start exists.
Fixture archive/selection under output/weekend-harness-2026-09-19/capacity-pressure-fixture.
Independent assertions verify exact final, verified judge, actual models, tool order,
pressure event before retained lookup, exact original call ID and full retained bytes.
All read-only model work; no memory save, workflows, resets or external sends.

Next: source-preserving continuation for irreducible context is still open. This
pass qualifies automatic pressure-driven old-tool-result reduction and recovery,
not Layer3 rollover. Legacy fork seed remains insufficient; accepted source/graph,
exact requirements and completed/uncertain effects must survive continuation.
Physical mobile, memory timing/recovery matrix, release parity and user's matched
Claude Code token benchmark remain open. Goal active. Documentation changed after
installed build; do not misidentify source fingerprint as including this appendix.

## Claude learns proven context capacity — hotpatched and live verified
Prior turn made progress with real foreground pressure recovery. Continued tracing
capacity continuation: same-session accepted source/graph identity should remain the
authority; current Layer3 fork seed and warning remain insufficient. During tracing,
found a concrete budgeting defect: raw Claude successful responses never invoked
recordWindowAcceptance, although Codex and BYO do. Existing Opus5 observations had
cache evidence only and registry fallback200000 despite the prior274360 accepted
provider input. This caused unnecessarily conservative capacity handling.

src/runtime/harness/claude-model.ts RawClaudeUsageRecordingModel now records proven
capacity on completed single raw-Messages responses, using normalized inclusive
input (fresh+cache writes+reads). It skips zero input/inconsistent cache totals,
records streamed response_done once, and isolates observer failure from response
and usage recording. Optional injected observer permits focused checks without
modifying real observations. Deliberately not using headless aggregated run totals
as evidence of a single accepted context window. No arbitrary catalog/modelwindow
change; provider success supplies evidence. Current turn budget remains frozen;
subsequent turns resolve learned capacity normally.

Build passed; candidate and installed wrapper checks passed for inclusive totals,
stream once-only, failed requests excluded, invalid cache totals excluded and
observer failure preserving response. Check script check-claude-capacity-learning.mjs
injects observers and does not call providers or mutate live window observations.
No isolated-home acceptance. Zero active leases before patch, CUA quit/reopen.
Installed fingerprint2423342b5087710d5b1ef680f34239bd8d0ecdca06f29ff12eeb6019cf3dd7c6,
version3.18.17/schema81, backup dist.backup-IjCmZV / builtin-skills.backup-nU3uGc.
Both console/mobile assets installed with receipts claude-capacity-learning-assets.json.

Fresh installed/live repeat sess-desktop-07d7ec1df445ed8623dd31ad source247862:
read_file247881/read_file247888, capacity checkpoint247894, file_query247896 exact
first call ID, Sol247907 verified, final247911 exact expected UUID.4 actual Opus5
calls +1Sol, uncachedWork306146 (test cost, not a savings claim). Real successful
Claude prompt274302 caused provenAcceptedInput274302 to appear automatically.
Installed readonly effectiveContextWindow now274302, verified separately. This is
a proven floor, not discovery of the provider maximum; no hard-overflow occurred.
Current test's checkpoint still used its start-of-turn200000 budget as intended.
All receipts claude-capacity-learning-{build,hotpatch,candidate-checks,installed-checks,
live-start,live-response,live-events,live-usage,live-assertions,effective} under output.

Next remains irreducible-context continuation preserving full requirements, source,
settled/uncertain effects; no new session from the incomplete legacy seed. Raw Claude
capacity rejection learning is also absent, while acceptance learning is now proven;
trace exact provider errors before changing rejection classification. Do not assume
headless aggregate usage is one prompt. Memory timing, mobile/release parity and
matched user-run token benchmark remain open. No commits/release, shared main and
other-agent/sidecar edits preserved. Goal active; documentation appended after build.

## Continuation recovery-source audit — exact request archive already exists
Prior turn was progress: Claude capacity-learning patch installed and live passed.
This turn inspected current source and installed read-only reconstruction paths to
choose a faithful continuation implementation. No source mutation or provider calls.
main/e5a75f5a unchanged. Automatic irreducible-context continuation remains open.

Audited exactSessionHistoryForTool against45 model-facing user items in20 copied
all-time largest snapshots:39 exact text matches,6 incomplete/missing. These are
NOT six lost public user requests; some are framework-expanded/synthetic context.
Two background items contain the same472-character accepted input inside3770/2908
characters; other mismatches are3377,36311,39280,41726 characters. Therefore do not
replace all older typed user messages with public session_history pointers and
claim lossless objective recovery. Receipts continuation-history-coverage.json/.txt
and continuation-history-source-coverage.json. No raw private excerpts in reports.

Found existing durable encrypted model_request_provenance snapshots. Its installed
projectModelRequestProvenance opens sealed payloads and validates source, request
and host-result references. Latest request from4 affected chat/branch sessions
reconstructed successfully and contains the4 missing exact typed user texts.
Latest request from historical background:bg-mtxgda57-b45f11 refused with
host_result_source_mismatch; this does NOT prove the archive bytes are absent, and
must not be bypassed or counted as a successful projection. All4 exact requests of
fresh live sess-desktop-07d7ec1df445ed8623dd31ad source247862 reconstruct statusok,
including before/after pressure projection (task layer730545->4355bytes).
Receipt continuation-sealed-coverage.json/.txt and audit-continuation-sealed-coverage.mjs.
Helper first imported workspace better-sqlite3 withwrongElectronABI; corrected
createRequire to installed daemon module; successful installed run above. No rebuild
or dependency mutation. Decrypted request bytes were not written/exposed by report.

Next implementation direction: preserve same session/source/graph while reducing
model-facing context, with exact relevant typed message spans recoverable from
validated encrypted request references where available. Reuse this existing store
rather than invent a second full archive. Do NOT expose whole decrypted request
layers as a model tool (policy, memory, catalog and host authority are distinct);
select authorized conversation/task content and retain exact reference/digest.
Current source/full requirements and completed/uncertain effects stay authoritative;
prior request data is historical evidence, not a new grant. Legacy/unvalidated
histories require preservation/fallback, never silent omission. Final-frame giant
newest result, huge current input and schema overhead also need handling; an old
history projection alone is insufficient. This audit establishes available recovery
material, NOT implemented or accepted automatic rollover. Broader goal stays active.

## Exact archived task-message recovery tool — installed and live passed
Implemented archived-task-message.ts pure selector/pages: returns only selected
user role/content, exact JSON including typed parts; stable digest and UTF16-safe
paging. Excludes neighboring system/assistant/tool frames, rejects invalid indexes,
offsets/budgets. Two pure tests passed. archived-task-context.ts validates current
accepted source event, same-session archive identity, source ordering and exact
request digest, then uses existing projectModelRequestProvenance validation before
selecting a message. No direct decryption bypass, no new archive store.

Registered session_context_read in session-tools and tool-registry as discoverable
read/control tool (not a new always-on schema). Takes record_id/request_digest/
item_index plus offset_chars/max_chars. Response header+raw JSON page avoids JSON
escaping expansion; pages <=16000 content chars. Tool description and evidenceOnly
header separate historical content from current authority. No cross-session access,
policy/memory/catalog/tool frame exposure or fetching image references. Full typed
content survives, but automatic host archive references/projection not wired yet.

Candidate and installed readonly live archive checks: exact seven-page roundtrip,
wrong session/source event/digest/item denied. Initial pure tests no isolated home.
Build passed, no live leases before CUA quit; hotpatch fingerprint
88e13b3c84bfc7cb0816879754e082dac1cef7dff881447dbf9cbeb8c64b09ab,
backup dist.backup-kn4MhT / builtin-skills.backup-PRFlsG. Both web assets installed.
Receipts archived-context-{build,hotpatch,assets,candidate-checks,installed-checks}.

Live followup in existing fixture sess-desktop-07d7ec1df445ed8623dd31ad source248005:
asked to read exact old archive locator and report old max_chars and first filename,
without carrying out old task. Onlytoolcall session_context_read248026, return248030
complete647-character serialized oldmessage. Sol248034 verified; final248038 correct
730000 and exact archive.txt path. Actual Opus5/Sol (plus Luna compaction). No oldfile
reads/writes/workflows/memory actions. All archived-context-live-{start,response,
events,usage,assertions}.json. This is instructed retrieval qualification, NOT an
unprompted rollover test. Same source session preserved after restart/hotpatch.

NEW measured efficiency defects to address next:
1. Layer2 event248017 summarized one assistant item and grew estimate235009->235023.
   Earlier audit had not observed growth; now evidence exists. Reject non-shrinking
   Layer2 replacement while retaining source inputs, not just reported improvement.
2. Inflight checkpoints248023 and248032 both say capacityPressure against raw
   pre-checkpoint input269355/269765. First shrank history235697->1760; second created
   another checkpoint although replayed working context already fits. Current
   loop computes pressure before replaying existing stable checkpoints. Next compute
   pressure on replayed projection, then apply normal/capacity thresholds; preserve
   frozen checkpoints and avoid repeated prefix churn. A readonly projection helper
   can reuse replayInFlightCheckpoint without changing state; verify repeated input
   and extending small result do not create additional forced checkpoints, while
   genuinely growing unprojected tail still triggers. Keep provider cost claims scoped.

Automatic irreducible-context continuation remains open after this recovery
prerequisite; current request and accepted graph/effects remain authoritative.
Goal active, no commits/release. Docs appended after build. Preserve other edits.

## Compaction efficiency fixes — installed; multi-frame live qualification open
Previous turn made implementation/live progress. Fixed measured issues in source:
projectInFlightCompactionCheckpoints exposes a read-only replay of frozen ledgers;
loop now measures pressure on that working projection before choosing thresholds.
Actual compaction still takes original SDK input and same checkpoint state. Thus
retired giant outputs no longer force a new checkpoint for each tiny new suffix.
Normal policy/kill switch unchanged. summarizeOlderMessages now rejects replacement
when summary alone is >=summarizable input estimate, retaining all original items
and modelUsed with error summary_not_smaller; reasoning deletion cannot mask a
larger summary. This prevents prompt expansion, not the worker call's already-spent
cost. No fixed minimum/heuristic summary cutoff introduced.

Build and candidate/installed checks passed: initial pressure checkpoint, replayed
projection fits, small suffix no new checkpoint (raw old algorithm still falsely
pressured), genuinely huge new suffix still pressured, source arrays/checkpoint
projection not mutated, growing summary refused despite large reasoning savings,
shrinking summary accepted with exact user messages. Helper check-compaction-efficiency.mjs
uses synthetic in-process inputs and injected summarizer, reads real ownfixture
call IDs only; no providers/session mutations/isolatedhome. Candidate check's generic
scope label says Installed algorithms but that run used workspace dist; installed
check separately ran exactappdist afterpatch. Do not conflate them.

No active leases before CUA quit; hotpatch fingerprint
62f05a4fe04c64a57f4cab6a7593e07575bd01489d6249d05b3c7a753870b68b,
backup dist.backup-g5nhL6 / builtin-skills.backup-oKyPBg, bothwebassetsinstalled.
App reopened and API fingerprint verified. Receipts compaction-efficiency-{build,
hotpatch,assets,candidate-checks,installed-checks}.

Live ordinary repeat samefixture sess-desktop-07d7ec1df445ed8623dd31ad source248084
checkpoint248098 pressure270015/window274302 history236288->1907. Model answered
correctly from retained prior answer WITHOUT a fresh toolcall. Sol248104 verified,
final248108success. This qualifies ordinary answer regression, NOT multi-frame fix.
A separate explicitly fresh-read qualification source248118 was accepted once,
checkpoint248132, then provider refusal before any toolcall; final248135failed.
No judge/pass; no retry, model substitution or weakening refusal handling. Actual
usage/event receipts saved forboth sources. Only attributed usage for failed source was Luna worker186input43output; there is
no completed Claude usage row for that source. Do not attribute worker counts to
the refused Claude call or infer full-frame provider processing from them.

Multi-frame live qualification remains OPEN. Do not claim live two-checkpoint->one
win based on a single-frame repeat or pre-tool refusal. Installed structural test
covers exact mechanism but isn't foreground acceptance. Next inspect provider refusal
only as needed, then complete a legitimate multi-call live qualification without
restarting an uncertain handle (this attempt is authoritatively terminalfailed).
No evidence patch caused provider refusal, so no speculative rollback. Automatic
irreducible-context continuation plus broader goal remain open. No commit/release;
docs appended afterbuild, goal active. User informed of precise failed qualification.

## Multi-frame compaction pressure live qualification — now passed
No new patch this turn; installed62f05a4fe04c64a57f4cab6a7593e07575bd01489d6249d05b3c7a753870b68b
verified before requests; main/e5a75f5a and activeClaudePID47978 unchanged. Previous
turn made implementation and structural progress; live extra-checkpoint scope was
explicitly open after terminalproviderrefusal248118 (not a wait/retry).

New ordinary two-file task on that old entry branched automatically to
sess-branch-1455a63eb0bd7f1444353142b04fb15a45491aea source248162 due earlier failed
source. Two read_file calls248181/248183, Sol248193 verified final248197success,
but no pressure in successor, so counted normal recovery only. No repeated POST.
Receipts compaction-two-read-live-{start,response,events,usage}.json.

Then reused earlier SUCCESSFUL pressurefixture sess-desktop-144969081139e6188ff5adf7
(no new giant read or invented history) for same two-file task, source248204.
Kept original session, initialcheckpoint248218 measured269220 against274302budget,
history236052->2115, collapsed2oldpairs retained1. Two fresh read_file248224/248226
read native-workflow-planning-live-report.md and selection.txt. Subsequent model
call reused existing checkpoint and created NO redundantcheckpoint. Final248240
correct A101/20200 B101/20402 C101/20604, selected-orchard; Sol248236 verified.
Independent assertions require exactly1capacitycheckpoint beforeboth actualreads,
at least2 actualOpus5calls, exactrequestedfacts and verifiedSol. Receipts
compaction-retained-pressure-live-{start,response,events,usage,assertions}.json.

This closes foreground multi-frame acceptance for measuring pressure AFTER replayed
checkpoints. Does not claim token benchmark superiority or provider hardoverflow.
L2 no-growth guard remains installed structural-tested; no new natural worker
summary acceptance/rejection specifically asserted by this run. Earlier refusal
remains failed, not reclassified. Broader automatic irreducible-context continuation
is stillnext; recovery tool exists but host must select and inject validated exact
archive references while preserving accepted task/graph/effects. Mobile, memory
wait/recovery, release parity and userbenchmark remainopen. Goal active; docs afterbuild.

## Automatic archived historical-user projection — installed/live passed
Implemented archivedTaskMessageReferences in archived-task-context.ts: selects up
to3 mostrecent same-session model request archives strictly beforecurrent accepted
source, validates complete provenance, indexes exact string user content only.
Unverifiable/unknown history is preserved. New archived-context-projection.ts reduces
old >=8000-char string user messages only under pressure and with exact archive
reference. Keeps lastuser, exactcurrent/semantic/activeTask input, system action
evidence, all toolframes, typed/nonstring usercontent and unarchived messages.
Preview contains first/last384chars and exact session_context_read reference,
explicit incomplete/historical labeling. Model projection only; no stored history,
source, graph or action mutation. It stops once history fits90% minusoverhead.
loop caches available references onceperturn and replays chosen references BEFORE
toolpressure measurement, avoiding repeated artificialpressure/checkpoint churn.
New condenser telemetry archivedUserMessages contains reference IDs/digests only.

Build initially failed due TS lib findLastIndex; replaced with reverse loop. Final
build passed. Candidate/installed pure projection checks passed current/lastuser,
action/unknown-history preservation, source unchanged, stable replay with newtooltail,
normalframe unchanged. Hotpatch fingerprint
d7f4a0de6bc94d1cd7fc28e697fb6df6c59f0eb265cc92da0688b7c1139bc145,
backup dist.backup-1Spa00 / builtin-skills.backup-YeOZxf. Bothwebassets installed.
Zeroactiveleases beforeCUAquit/reopen. Receipts archived-projection-{build,hotpatch,
assets,candidate-checks,installed-checks}; helper check-archived-projection.mjs.

Fresh live fixture sess-desktop-533dc46a35231b3c1e14ba18 seed248313 supplied940306char
synthetic message with unpredictable UUID near middle, requestedACKonly. Sol248336
verified final248340ACK; actualOpus prompt317802 andSol115809. This automatically
raised learnedClaude floor317802 (not a maximum). Needed nextturn ~107kadditional
syntheticbackground to reach pressure at newfloor; no globalwindowoverride.
Recall source248353 asked earlier ARCHIVE_SAMPLE_VALUE, supplied approximate
serializedpageoffset only (expectedUUIDnotincluded), noarchiveIDsupplied.
Host automatically archivedoldermessage at248368:history262574->27825, oneevent.
Model used hostprovidedreference via call_tool/session_context_read. First248374
used wrong key offset andwasinvalid_arguments; repaired248381 withoffset_chars,
nestedtransportmirror248382 notanadditionaltop-level call. Read3000charpage contained
exactUUID; Sol248394verified final248398exact. Actualusage3Opus+2Sol forrecall, includes
repaircost. Independent assertions verify old/current storedusertextstillbyte-exact,
onesession/no taskfork, exactlyonearchiveevent, onlyhistoricalreadtoolattempts.
No oldtaskreexecution, filesystemread, memorywrite, workfloworreset.
Receipts archived-projection-{seed,recall}-{start,response,events,usage}.json and
archived-projection-live-assertions.json. Pureandlivechecks distinct.

Qualification is automatic projection/recovery of older EXACT archived usertext;
pagepositionwascoached, so NOT autonomous archival search benchmark. Giantcurrent
input/latesttool/nonrecallable/schemaoverhead stillcanremainabovebudget. Nohard
providercontextrejection tested; nofullrollover claim. Improve archive pointer's
pagination hints to avoid offset/offset_chars error; larger archive search need
wouldbenefit literalquery orindex ratherthan many pages. No new permission grants.

## User steering: first-class assistant that learns and becomes proactive
User asked howthis work getsClemcloser to growing/learning withtheuser andproactivity.
Explained completedfoundation(memorycorrections/nativeactions/continuity) andgap:
end-to-end learn->applylater->recognizerecurringneed->prepareauthorizedwork->feedback.
Fresh /api/console/settings confirms proactiveWorkAllowed=false, quietHoursActive=false,
autoApproveScope=yolo, requireWorkflowApprovalForExecution=true. No settingchanged.
Nextmajor acceptance priority should exercise thatcomplete learning/proactivitycycle
with controlledfixtures aftercurrentcontinuityqualification; don'tgetstuck exclusively
polishing compaction. Need inspectexisting proactiveengine/trigger/memory feedback
ownership andenablementpolicy ratherthan inventingparallel machinery or silently
turningon broadbackgroundexecution. Currentuserquestion is scope steering, notcancel.
Broader mobile/release, memorytiming, nativeworkflowrecovery andmatchedbenchmark goals
remainactive. Docs appendedafterbuild; no commit/release.

## Learning cycle acceptance: real compound-preference loss found
Rechecked main/e5a75f5a; active Claude PID47978 cwd is this shared checkout.
Installed fingerprint remains d7f4a0de6bc94d1cd7fc28e697fb6df6c59f0eb265cc92da0688b7c1139bc145.
Previous status turn only restated scope; this turn made new live acceptance progress.
Goal resume already calls normal runConversation/buildOrchestratorAgent; do not add
another background engine. Broad proactivity remains disabled; no settings changed.

Live new synthetic project preference: sess-desktop-7e57b2ce598291b7aa3680f3,
source248477. Asked remember completed-only reports, alphabetical owners, minutes,
local drafts, no automatic send/schedule, scoped to Orchard Learning Cycle 2026.
Candidate2169417 / fact3804 saved only prefix through alphabetical order. Sol
248505 correctly rejected incomplete memory; final248509 is blocked, NOT pass,
although acknowledgement claimed all clauses. No follow-up task submitted yet.
Full events/start/response/attributed usage under learning-cycle-preference-*.

Installed pure parser reproduction learning-cycle-parser-reproduction.json confirms
minimal failure: 'Remember that weekly reports should show completed items and show
duration in minutes.' drops 'and show duration in minutes'. In auto-capture.ts,
SECONDARY_MEMORY_TRANSITION_RE treats coordinated standing-rule predicates as a
separate current action; isolateMemoryFromSecondaryWork retains only prefix. Control
'Remember that reports use minutes. Then show the current report.' correctly splits.
Do not simply save whole mixed turns or remove secondary-task isolation. Fix needs
preserve compound standing clauses and full exceptions while still separating true
one-off actions. Existing standing semantic review may provide a bounded ambiguity
path, but no implementation selected/changed yet. Keep source evidence for exact
span validation. No new hotpatch this turn. Only test fact3804 may be cleaned up
later by exact ID; no broad personal memory cleanup.

User next priority: AFTER this memory fix tackle token efficiency and speed,
including Clem delegating bounded work to smaller worker models by default.
Count coordination, retries, reviews and latency; no efficiency claim from model
size alone. This refers to Clem's worker architecture, not authorization to spawn
unrelated Codex agents. Preserve usage-sidecar work. Full goal remains active.

## Compound explicit preference fix — hotpatched and live passed
Changed standing-memory-review.ts + durable-consolidation.ts. Explicit remember/
correction candidates with trailing source content now receive exact-source scope
review in the existing durable queue; complete candidates keep direct consolidation.
Explicit review must keep original candidate and quote source exactly, preserving
connected clauses/exceptions while excluding one-off actions. Invalid review retries,
never rejects explicit authority or silently promotes an incomplete reviewed claim.
This adds a boundary-model call to ambiguous/mixed cases; no overall cost win claimed.
The lexical parser remains conservative for routing; canonical promotion expands it.

Build passed. node --test initially refused live-home config before tests executed;
no bypass/isolated home used. Separate direct pure candidate/installed helper passed
6 scope/source assertions (learning-scope-*-checks.json), no DB writes/providers.
Zero leases before CUA quit. Installed fingerprint
abd154dcb87b5955a6cea8dd601c95fb9d13c443071115001d7386e2e5d517e9,
backups dist.backup-KNkhZr / builtin-skills.backup-f9Z064. Both web asset trees
installed with digest receipts. App reopened and running fingerprint checked.

Live new Birch project source248567/session sess-desktop-3c081edacbcd437547fcf0ee:
candidate2169536 fact3805 includes whole preference, minutes, local draft handling,
no sending/scheduling and project-exclusive scope; excludes acknowledgement request.
Sol248588 verified persisted content, final248592 success with zero continuation.
Original failed source248477 remains failed/incomplete fact3804; not reclassified.

Separate fresh conversation source248599/session sess-desktop-1249f0f24a0cb55bda561777
requested report without repeating format rules, explicitly referenced saved project
preferences. Artifact orchard-birch-weekly-report.md has Alpha A1=2min, Beta B1=3min,
B2=1min, total3 completed/6min; pending A2 excluded from table (mentioned exclusion).
Tool search/write/readback only; Sol248679 verified, final248684success. This proves
cross-conversation application on prompted report, NOT spontaneous proactive action.
Recall credit248683 named older fact3804; provenance check of all5 model requests
statusok confirms complete Birch3805 in memoryContext alongside older3804; older
preference also in tasklayer. Credit/ranking correctness remains open; don't overclaim.
No raw private archive text written by helper, only source presence booleans.

Independent mixed-task source248623/session sess-desktop-6bfed2fbc4e4dcf2b63033d7:
remember Maple project minutes, then calculate17x19. DBfact3806 exactly scopedminutes
claim, no calculation/task appended; final248656323success. Completion review here
not_required (do not call it a Sol-reviewed pass); verified stored content independently.
Receipts learning-scope-{live,apply,mixed}-{start,response,events,usage}.json and
learning-scope-provenance.json. Attributed usage4/7/3rows respectively, not yet cost
comparison. No active live test handles remain. Goal active; docs after build.

USER STEERING: after memory fix prioritize token efficiency/speed, Clem bounded
subagents on smaller workers by default; include local MCP, CLI, Composio as well
as native tools in LIVE runs. Discovery/reads must not have unnecessary gate stops;
external email/calendar/social writes must respect already-granted action authority.
Do not interpret as permission to message others or bypass security wholesale.
Next inspect worker routing/context costs and connected tool availability using
sanitized settings; exercise existing read-only paths, preserve token-meter edits.
Full proactive cycle/restart, memory ambiguity negative cases, recall credit mismatch,
mobile/release parity, broader native recovery, benchmark remain open.

## Efficiency baseline and non-native tool discovery live run
Previous goal turn was progress: memory patch installed and live accepted. Current
turn inspected actual sealed request, not guessed schema overhead. Shared main,
Claude PID47978 unchanged; no source edits/hotpatch this turn.
Audit-prompt-tool-cost.mjs uses readonly validated request provenance from source
248599. Native schemas: workflow_create21565chars (description14036), workflow_update
20808(12457), space_save12685(8496), run_worker4571(1945). Total native authoring
three55058chars,34989descriptionchars. Full report turn provider firstprompt41319tokens;
reported toolSchemas27523estimate. Character counts are not billable token savings.
Native tools must remain first-class; next inspect concise descriptions retaining
complete parameter contracts, or sound on-demand schema exposure, before changing.
Do not use keyword routing to hide native abilities. Receipt prompt-tool-costs.json.
Worker dispatch already defaults resolveRoleModel(worker); uses per-session override,
packet/intent route, then default; rate-limit fallover includes MODELS.primary.
Need live actual small-worker execution and overhead accounting, not only settings.

Live read-only tool route discovery source248724/session
sess-desktop-41707f177baae46ec7c09e02, final248855success. MCP status, CLIlist,
Composio status/list worked. Actual dataforseo__docs_list_sections executed and
returned sections; local_cli_list inspected installed sf binary/version. No business
CLI query or actual Composio data operation executed, so not full route acceptance.
COMPOSIO_CHECK_ACTIVE_CONNECTION attempted248817 with invented cap:resolved ref;
subsequent tool_search returned no authorizing connection. Recovered to status/list.
Assistant claimed run_shell_command sfquery needs per-call approval: inspect actual
path before treating as proof of universal read gate. No external writes/auth/setup.
All events and attributed usage saved tool-route-readiness-{events,usage}.json.
No live handle remains. Next use concrete bounded read invocation tests for CLI and
Composio; diagnose discovery/authority mismatch without bypassing exact authorization.
Broader goal active; next efficiency implementation and live worker tests stillopen.

## First schema reduction installed; real CLI execution passes
Changed only twelve descriptions in orchestration-tools.ts (six shared field texts
in workflow_create/update): prompt, intent, forEach, forEachNewOnly, allowedTools,
args_json. Removed1420 literal characters, retained guidance and all schema contracts.
Build passed. Candidate-vs-prior installed registration comparison with z.toJSONSchema
has exact equality excluding descriptions; serialized pair39139->37705chars. Initial
helper used zod-to-json-schema against Zod4 and emitted empty schemas; caught by
size assertion, corrected to native converter. No empty-schema check counted as pass.
Installed candidate equals built schema exactly. Check helper captures registrations
only, invokes no tools/providers; no isolated home or reset.
Zeroactiveleases before CUAquit. Hotpatch running fingerprint
7bf2176f4c39515875b911ccabc12e566bf7c2681b0167a3a63517f69c25bdff.
Bothwebassets copied/verified, receipts concise-workflow-schema-{build,hotpatch,assets,
candidate,before,installed,assertions}. No reduced capability exposure.

Beforepatch live CLI source248880/session sess-desktop-a623aba484814709b1e18f54
actually ran exact sf --version exit0 via shell route without extraapproval.
Sol248919 verified final248923success. Earlier claim universalCLIreadapproval false.
This is actual CLI version execution, not authenticated Salesforce data query.
Receipts cli-read-live-{start,response,events,usage};4actualOpus/Solusage rows.

Afterpatch source248960/session sess-desktop-2562211e6953ea5bc29cbb5d authored
harness-concise-schema-birch via directworkflow_create248981; final249053success.
Tool schema estimate27523->27116 =407estimatedtokens saved permodelrequest, NOT
measured end-to-end speed/cost win. 11actualOpus/Solusage rows includes repairs.
Created one directread_file step with non_empty data.content; manual-only, noproject.
Finalworkflow_get confirmsdisabled after correction. Live test exposes unrelated
realdefault mismatch: create surface has noenabledinput, implementationline1201
sets enabled:true and creationtestautoenables. User explicitly askeddisabled; Clem
needed workflow_get/list/get/set_enabled(false)/get tocorrect it. Do not blame this
on shorterdescriptions or callit cleanminimalroute. Preservefixturedisabled.
Next examine authoring state intent/default toavoidthisrepair churn (not merely
strip safety checks). Worker actualsmallmodeluse and Composio dataread acceptance
stillpending and remain priorities alongside larger schema/context reductions.
Alllivehandles terminal; no uncertainresubmission. Goalactive; checkpointafterbuild.

## Live small-worker execution and Composio data read — passed
No source changes/patch this turn. main/e5a75f5a and ClaudePID47978 active. Running
fingerprint remains7bf2176f4c39515875b911ccabc12e566bf7c2681b0167a3a63517f69c25bdff.
Previous turn progress was installedschema reduction +liveCLI/nativequalification.

Small-worker source249074/session sess-desktop-286e868dd5176802f0fe80f6 explicitly
requested one4itembatch of synthetic support classification, toolsnone, no model
pin. One run_worker topcall toolu_01KPWg2dwZPnmyz9K6KxBZEx, fourchildren executed
actual gpt-5.6-luna, nofallover, all4worker_result oktrue. Correctcategories A bug,
Bfeature,Caccess,Dbug, hypotheses/diagnosticsteps; Sol completion fulfills=true,
final249163success. Workerusage rows selected by exact childSessionIds linked by
worker_model_executed plus parentacceptedSource (no timestampguessing).
4Lunacalls prompt16100/uncachedWork16285; 2Opuscalls prompt97249/uncachedWork57929;
2Solcalls prompt8953/uncachedWork9510. Parent+review prompt106202, so coordination
is substantial. No matched directbaseline, no claim delegation saves tokens/time
on these small cases; capabilityqualification only. Receipts small-worker-live-*.

Composioread source249119/session sess-desktop-61fe78060e87e2335d9c0da7 actual
GOOGLEDRIVE_FIND_FILE249192, result249198 JSONsuccessfultrue anddata.fileslen1.
Exactargs pageSize1 fields files(id,mimeType), qtrashed=false, corpor user,
includeItemsFromAllDrivesfalse/supportsAllDrivesfalse. No documentcontent, writes,
configurationchanges. Three discoverycalls beforeexecution (249150/171/184):
firstreadquery rankedcopy/move operations, secondpagefoundfindfile, thirdschema.
OneSoltransportretry249157 codex.sse_truncated, existing handle recovered.
Firstdraft included account/actionidentifiers against narrow reportingask, repaired;
Sol249211verified final249215success reports onlycount. Keep repair/reviewcosts,
9attributedusage rows. Local full eventreceipt private, do not quote metadata in
user-facingoutput. Receipts composio-read-live-{start,response,events,usage}.

This closes bounded actual execution of localMCPdocsread, CLIversionread, Composio
metadataread alongside nativeactions; not universal tool/provider/effect coverage.
No extraapproval gate on these reads. Native authoring enabled-state bug remains:
workflow_create has noenabledparameter, createstrue, creationtest autoenables;
fix preserving ownerrequesteddisabled without laterrepair remainsnext. Larger
schema/context reduction, discoveryranking/callcount and smallworker overhead
are concreteefficiencytargets. No full comparative benchmark performed. Alltest
handles terminal; broadgoal active, mobile/release/proactivitycycle stillopen.

## Effect-compatible discovery ranking — installed/live passed
Previous turn progress: liveactual Luna4workerbatch andComposioread. Thisturn changed
tool-search-tool.ts combinedranking: compute existingrequestedCapabilityEffectScope;
for authorizedComposio use existingrememberedCapabilityEffect andcompatibility to
prefercompatible effects AFTER selectedprovider but BEFORE lifecyclepriority.
No candidate filtered, unknown/mixedstaycompatible, exactnamepathunchanged, noauthority
or dispatchchecksmodified. Fixes copy/move lifecyclepriorityoverreadquery.
Existinghelpers used, no newkeyword classifier/provider-specifictool list.
Buildpassed. Injectedcandidatechecker fails oldinstalledfirstcopy, passescandidate
andnewinstalledreadfirst; all3remainavailable; explicitcopyquery/exactname stillcopy.
NoDBwrites/provider/isolatedhome inchecker. Noactiveleases atCUAquit.
Hotpatch fingerprint f85ddfab24021e3d0a491696d6705ad41d2507e5d48e5c9959f2bde5a3d62f6c,
bothwebassetsinstalled, appreopened fingerprintverified. Receipts discovery-effect-ranking-*.

Live source249276/session sess-desktop-fef3bdf77725761707c07e29 exact priorquery
Google Drive list files metadata read-only limit8. Oneactualtool_search, firstpage
GET_FILE_METADATA, LIST_FILES(deprecated), FIND_FILE, LIST_CHILDREN_V2,
LIST_TEAM_DRIVES, GET_TEAM_DRIVE, GET_CHANGES_START_PAGE_TOKEN, COPY_FILE_ADVANCED.
FIND_FILE now3rd onfirstpage; before neededsecondpage behindwrite replacements.
Terminal249314success verifiedSol. No businessactions; bounded discoveryqualification,
not freshendtoendComposioefficiencybenchmark. TopGET_FILE_METADATA notactual listing;
same-effectdeprecatedpredecessor stillprecedesFIND_FILE, remainingrankingwork.
Liveassertions verify onequery, FINDbeforecopy/firstpage andverifiedcompletion.
No claims writesshouldvanish: deliberately retained peruseralltoolaccessrequirement.
Allhandles terminal. Broadgoalactive; no commits/releases. Workercoordinationoverhead,
workflowdisabledcreation, largercontextreduction, proactivecycle/mobile/release remain.
Assertion qualification: tool_returned journal preview clipped14911chars to8000,
so initial JSONparse failed. Corrected assertion uses uppercaseoperationnames from
retainedprefix, proves FIND_FILErank3 +singlecall +verifiedterminal. FullpageCOPY
position8 is reported by finalanswer, not independently parsed inassertion. Do not
claim completepage parsing; fullretainedoutput remains recallable bycallID
 toolu_01Pd6ESMuiUnZhAHGWeAbf62. Usage receipts now saved.

## Disabled workflow creation intent — installed/live passed
workflow_create now accepts optionalenabled, setsdefenabled=enabled!==false, passes
activateAfterCreationTest tocreationqueue. Queue persistsfalse inrunrecord. Runner
keepsverification, skipsactivationpreparation/commit whenfalse, carriesflagthrough
stalere-test, reportsverifiedbutdisabled. Omittedflagbackwardcompatibletrue; native
capabilityremainsdirect. Buildpassed. Noactiveleases beforeCUAquit; runningfingerprint
3efc5515353a7c251f9b0c0488839b8897522246fa26f6ebf2a5586707a0714a.
Bothwebassets installed. Receipts disabled-workflow-{build,hotpatch,assets}.

Live source249366/session sess-desktop-e18527393b3eff68f1dd3e56 repeatedpriorask
withnewfixture harness-disabled-intent-birch only. workflow_create249387 explicitly
usedenabledfalse; workflow_get249394; Sol249411verified final249416success.
Creationtest1789885572245-032b2b terminalpassed withpersistedactivateAfterCreationTest
false. Independently read vault/00-System/workflows/harness-disabled-intent-birch/
SKILL.md aftertest:enabledfalse. No set_enabledrepair. Same-shaped priorfixture
source248960needed6calls, now2. Parentaccepted-sourceusage11->4calls,
prompt453823->145226, uncachedWork153269->106931. Cacheconditions/modelvariation
mean singlepair is not generalbenchmark. Completeelapsed inassertionsreceipt.
Default-omission activation and restart/retestfalse branch notnewlivequalified;
priorbehaviorpreservedbyoptionalflag butneedsbroadercoverage.

Passivebackgroundreport-back synthetic source249429/final249430 hasnojudgeverdict
(enabled_unavailable); NOT foreground249366. Initialassertion selectedlastterminal
andfailedKeyError. Correctedtosource-boundterminal249366. Do notmisclassifybackground
notificationas foregroundtestreview. All events retained disabled-workflow-live-*.
No otherpersonalworkflowsmodified. All testhandles terminal. Goalactive; continued
largercontext/discoveryefficiency, proactivecycle/mobile/release stillopen.

## Per-item worker context — installed/live passed
Previousgoalturn installeddisabledworkflowfix +liveaccepted. Currentturn inspected
actualpriorrun_workerpacket: everyworkerhadall4cases +ignoreothers instruction.
AddedoptionalitemContexts[{item,context}] toWorkerToolCallSchema. Existingcontext
becomessharedfacts whenprovided. workerItemContexts validatesexactpartition before
anymanifest/childdispatch: unknown/duplicate/missing/blankrefusedtypedpredispatch.
Null/omissionkeepsoldbehavior. Dispatcher stripswholearrayfrompacketbase and injects
onlyshared+owncontext forbothbatchandsinglepaths BEFOREworkerPacketKey. No tools,
models,authority,orworkflowbehaviorchanged. Namechoicesmodelowned; noheuristicsplit.
Buildpassed;9purecandidate/installed checksinclude sourceunchanged, invalidpartition,
backwardcompatibility andpacketidentitychange. No isolatedhome/providerinhelper.
Zeroactiveleases beforeCUAquit. Installedfingerprint
b1231996e5337b0f99453d7f07038d2809948ab4bd2c6ae5c064b1ffeaa7ecbd,
bothwebassetsinstalled. Receipts worker-item-context-{build,hotpatch,assets,*checks}.

Exactsameuserpromptasprior4caseworkerfixture freshsession
sess-desktop-b2226a1fc400fc2fe9795051 source249479. Onebatch249498; parentusednew
itemContextswithoutcoachingfieldname. All4actualLuna/nooverride/nofallback, successful
results249522/524/526/528; batch2495314/4, final249543verifiedcompletion.
Readonlyprovenancechecker projects eachchild's actualsealedtasklayer statusok,
assertsownfullcontextpresent andeachsiblingsfullcontextabsent. No rawarchiveexport.
4childrenIDs inworker-item-context-live-assertions.json; fullparent events/usage saved.
PriorLuna4calls prompt16100/uncachedWork16285; now4calls15765/15979. Modest335prompt
reduction on tinysyntheticcases, notgeneralbenchmark. Parent2Opusprompt97249->84031,
uncached57929->51275, but otherprompt/schema/context changesconfoundcausality.
Bothruns2Solcalls. Do notattributeentireparentdifference toitempartition.

NEW reviewdefect: trajectoryreview249538 verdictdrift says onlyCaseA started and
B-Domitted, yet actual4children succeededandbatchreturn249531precededthe verdict.
Reviewevidence snapshotmayhavecapturedpartialbatch; stale:false meansnotinvalidated.
Finalanswerignoredfalsepartialclaimandcompletionreviewpassed, so no livefailure.
Nexttrace async reviewevidence freshness andbatchinflight awareness; avoidfalse
repair/no-progress escalation. Don'tcallthisworkerdelegationfailure. Allhandles
terminal. Goalactive; broaderproactivecycle/mobile/release/memory/efficiencyremain.

## Worker trajectory review freshness — installed/live passed
The asynchronous watcher launched at the first worker start and only invalidated
its verdict when the objective changed. Added a captured worker-progress summary
and comparison on judge return, plus a second comparison before pending advice
is injected. Stale telemetry identifies worker_progress_changed. No authority,
review budgets, provider selection, or execution gates changed.
Build passed. Installed fingerprint
0d25ea0602ba05ea3780e957553ab047e8203c170fa5eb8be0112a5fffedc029;
both web assets installed; app reopened through CUA. Receipts:
worker-review-freshness-{build,hotpatch,assets,live-*}.
Live same four-case prompt: sess-desktop-ae2eb386e28866fe7bde4c50,
source249604. All four actual Luna workers succeeded without fallback. Review
249663 reproduced the erroneous "only A" drift but now stale:true with reason
worker_progress_changed; no stale advice injected. Final249668 verified by Sol,
foreground actual Claude Opus5. This exercises invalidation upon judge return;
the later pending-advice invalidation branch is not separately live-qualified.
Usage: Opus2 calls prompt84085/uncached51389; Luna4 prompt15917/uncached8930;
Sol2 prompt8957/uncached9520. Cache/model variation means no speed/token win claim.
User requested Claude validation too: separate read-only Claude source/evidence
review launched sess-desktop-3fe82e3d6000ea5d44d4cdf8; results pending below.
Claude independent read-only review finished source249690/final249801; actual
usage confirms claude-opus-5 (Clem-owned auth), Sol completion verification.
Verdict: capture/compare/discard is sound and caught the observed failure.
Limits: ordinary tool/artifact changes are outside worker freshness; final
model-request guard only rechecks objective; helper granularity was not inspected
by Claude; stale checks still consume review budget; pending-steer path untested.
Our direct helper inspection confirms cumulative started/result/checkpoint counts
change with these worker events. No measured performance improvement claimed.
Full review and usage retained worker-review-claude-validation*. Next efficiency
candidate: avoid paying for a guaranteed-partial review at first worker start,
while retaining meaningful review during long batches; first examine cadence and
in-flight evidence before changing policy. Broader framework goal remains open.

## Delayed in-flight worker review — installed, mixed live acceptance
Previous goal turn was progress: freshness patch and independent Claude review.
Current branch still main; other Claude PID47978 active. Modified only fan-out
watcher mount in host-turn-runner.ts: first worker schedules review after 30s,
parent scope restored at timer firing, normal caps checked then. Invocation
finally unsubscribes and cancels timer (including errors). No worker means none.
Build passed; installed fingerprint
40d51b2049741fae2c523ff88329de83eb801bfafdb4b5c7a288cb285c98ec56.
CUA quit/reopen with zero leases; both assets installed. Five pure lifecycle
checks exercise actual extracted function with scaled timers and assert actual
30000ms argument: quick completion/rejection cancel, long fires once with parent
scope, caps respected, disabled untouched. No home or provider in these checks.
Receipts worker-review-delay-{build,hotpatch,assets,checks,live-*,long-*}.

Live short same four-case prompt: sess-desktop-1da86e7d670ebc03231ad5bb,
source249841/final249906 verified success. Four actual Luna; zero trajectory
reviews. Actual Opus2 prompt84088; Luna4 prompt15989; Sol1 prompt5410.
Previous same-prompt run had Sol2 prompt8957: one judge call removed; whole-run
prompt totals 108959 ->105487 (3472 fewer). Single paired synthetic observation,
not general speed/token benchmark. Final completion review retained.

Long live fixture source249907 sess-desktop-eb2e916c99606e0f9548468d asks ONE
four-item batch; each worker executes /bin/sleep35 once. First worker249952
06:52:03.860; watcher24998906:52:33.864 (30.004s); timer path live qualified.
It exposed a NEW framework defect: parent supplied work_call-wrapped shell tool;
A/D refused effect_unknown:run_shell_command:unknown and returned host recovery
objects, serialized as text by normalizeWorkerOutput and marked worker success.
B/C used native direct command and actually ran it. Parent attempted repair with
second A/D batch, then third A/B/C/D batch, violating single-batch acceptance.
Final250126 blocked by Sol (correctly); NOT a successful CLI worker acceptance.
Cancellation attempted only after repeated batches observed; API409 states
attempt already terminal, so no cancellation occurred. All handles terminal.
Later pending-steer invalidation branch DID exercise live: review250030 drift
parked, then discarded250047 reason worker_progress_changed after batch ended.
This also shows indiscriminate invalidation can discard persistent valid findings
(e.g. duplicate batches); do not claim semantic correctness of every discard.

Next fix: worker-host-runner.ts awaits hostRunRunner once then checks only
hasInterruptions / terminal.blocked before normalizeWorkerOutput(outcome).
Host recovery_continuation outcomes (recovery_surface_reprompt) have no final
text and JSON fallback leaks full history as successful output. Investigate
serializedRecoveryState handling and exact resumable continuation (loop.ts does
this); preserve child authority/turn budgets and never replay settled command.
Do not merely convert all recoverable states into success or bypass effect checks.
Also parent tool discovery contract needs direct native worker transport instead
of inventing work_call wrapper. Raw child events saved for exact replay analysis.

## Worker recovery continuation — installed; evidence gap prevents full acceptance
Previous turn progress: delayed review installed, found recovery-object false
success. Current source main, Claude47978 active. worker-host-runner.ts now
re-enters exact HostRecoveryState on hold+serializedRecoveryState, with same
runner/options/source, preserved checkpoint step/no-progress state and tool
history. Repeated identical state or 2*maxTurns+2 recoveries breaks to ERROR;
abort prevents re-entry. All holds, interruptions and terminal statuses return
ERROR; normalizeWorkerOutput receives finalOutput only, never whole history.
Delegated-item credit remains finally-owned. No effect/approval bypass.
Build +11 worker-output tests +3 pure actual-loop checks passed. Checks cover
exact checkpoint/history + original cap, repeated-hold bound and abort. No
home/provider/fixture reset. Installed fingerprint
8782c68fa22d81017714ead850976d14a421f64dfcdb45b97df9259cffad3bcf;
zero leases before CUA quit/hotpatch/assets/reopen. Receipts worker-recovery-*.

Live repeat original sleep fixture: sess-desktop-fc2ebc0e808ec437fbd817e9,
source250169. ONE batch, four actual Luna children, each one physical direct
run_shell_command dispatch and succeeded settlement, ~35sec. Final250274 BLOCKED
by Sol: parent's/judge's worker evidence unavailable. Do NOT call full pass.
This run used native direct tools, so checkpoint re-entry branch not exercised.

Targeted refused-wrapper probe: sess-desktop-8989bd5ce300e6d8e5861f03,
source250278. One worker (actual Luna), child
sess-worker-f28d69c44793d4a5b5960716ab5615b1632eebf8 source250300.
Refusal250307 effect_unknown, then same-child native dispatch250309/settled250310,
succeeded settlement250311. No duplicate command and no second worker. However
no recovery_surface_reprompt event: ordinary internal recovery exercised, NOT
proof that new checkpoint re-entry loop ran. Pure loop checks cover it only.
Final250330 BLOCKED for same missing child transcript evidence. All handles
terminal, parent actual Claude Opus5. Parent/child events +usage +assertions saved.

Next priority: completion evidence only reads parent's settled results and cannot
follow exact child lineage to worker native command result handles. Child
settlements already have resultHandleId and physicalDispatchId (e.g.
rh_1b5c2e7c2be7d8de4901d90ed2fb1e5d for first sleep child); use exact parent
source/call -> child source binding and read-only evidence projection. Do not
rerun successful command to satisfy verification. Also still need live forced
checkpoint continuation (not just ordinary refused-call retry). Broader goal open.

## Exact worker read evidence — installed/live acceptance passed
Previous turn progress: recovery handling installed and diagnosed missing child
proof. Other Claude47978 still main cwd ~/clementine-next. Current change only
host-completion-work.ts: sourceWorkerEvidenceScopes follows worker_started and
matching child user_input_received delegatedWorker lineage. Verifies parent
session/source/acceptedTaskId/logical run_worker call + child session/source,
packetDigest and item. Prose cannot authorize a child lookup. Child settled READ
results projected through existing authenticated redemption, nested expansion
disabled. Source evidence lookup adds namespaced child refs and result handles;
wrong source and unknown refs unavailable. No execution or write authority added.
Build passed. Read-only existing-live-source comparison: old installed 0 child
results/refs, candidate+installed 4 verified results +4 resolvable refs; wrong
parent source cannot open their handles. No fixture/reset/new provider calls.
Hotpatch fingerprint
f12aeb5542a1a5a26ff4b326bedb00f900cc376d8cee3725d5944c5115629e45;
zero leases before quit; daemon+assets/reopen. Receipts worker-evidence-*.

Fresh EXACT original sleep prompt: sess-desktop-eb331aecb46eea88bc4393a7,
source250385. ONE batch, four actual Luna workers/no fallback, exactly one physical
native run_shell_command dispatch+successful settlement each. Measured dispatch
intervals35.037–35.603s. Sol250489 explicitly verifies all four exit statuses;
judgedReadResults has four verified run_shell_command rows/handles. Final250493
success, fulfills/verified=true. Actual parent Claude Opus5 via Clem auth.
No repeated batch or command. Child IDs/handles/events/usage/assertions retained.
This fixes the prior 250169/250278 missing-child-evidence blocker; those prior
terminals stay blocked and must not be retroactively reclassified as passed.
Current usage: Opus3 prompt144856/uncached106117; Luna8 prompt36024/uncached18381;
Sol2 prompt15718/uncached15950. This is an acceptance result, not general efficiency
benchmark (read evidence adds truthful context; repair savings require matched
measurement). All handles terminal.

Scope: child read evidence only; does not yet project child writes/artifact
verification or arbitrary descendant workers. Pending live checkpoint re-entry
remains (ordinary refused-call retry is not that branch). Next useful coverage:
small workers executing native local MCP + Composio reads with exact tool leases,
plus parent verification; direct parent versions already passed earlier. Keep
framework-focused and preserve shared changes/token meter. Broad goal active.
Paired observed accounting vs prior blocked same prompt250169: total model calls
15->13; prompt257517->196598; uncachedWork120861->140448 (INCREASE). Cache variation
means lower total prompt is not a billed-cost/token-efficiency win; report both.

## Delegated MCP/Composio acceptance — catalog-visibility defect fixed, retest pending
Previous turn progress: child read evidence passed actual CLI batch. Current
branch main and other Claude47978 active. One mixed two-worker test source250521,
sess-desktop-9bfa5004c7fe9ddac2ad658f: Composio worker actually executed
GOOGLEDRIVE_FIND_FILE (limit1, id/mimeType only); native MCP worker had correct
exact lease dataforseo__docs_list_sections but all attempts refused before MCP
server invocation. Final250623 blocked; no second parent worker batch. Underlying
exception in supervisor: native MCP preparation refused: live definition drifted.
Public settlement only says revoked_before_physical_admission (less diagnostic).

Root cause production-mcp-read-carrier freshSnapshot providerVersion hashed the
ENTIRE VISIBLE tools list. Parent catalog sees all; exact worker lease sees one.
Same tool's operationVersion unchanged, but providerVersion differs and exact
preparation rejects it. Changed providerVersion to mcp-config-v1:hash(config),
retaining provider identity/config/account + complete per-tool operationVersion
and all snapshotMatchesManifest checks. Scope/lease checks are unchanged; no
metadata enumeration bypass or write authorization change. Existing version
prefix assertion updated. Pure injected metadata-only check reproduces old
failure then candidate+installed pass: visibility stable, own-schema and actual
configuration changes still detected. No tool/provider execution in that helper.
Build passed; zero leases; CUA quit/hotpatch/assets/reopen. Installed fingerprint
d04b5ce33b289d386ecc03ef5458ae44f85b05079e88f17d6d7359aca44ecc6a.
Receipts mcp-scope-* and worker-mcp-composio-live-* preserve baseline failure.
Exact same prompt retest started sess-desktop-389410d2fd8a33cb669e21d5;
worker-mcp-composio-retest-* contains handle. Inspect same handle; never resubmit
just because observation times out. Result to follow below.

Retest source250669/final250770 BLOCKED. The definition-drift refusal disappeared;
MCP actual physical dispatch250738/return250739, but settlement250740 unknown
(evidence=text) and no result handle; worker claimed13sections. Composio again
succeeded with retained handle. This is progress in admission, NOT full MCP pass.
Second root cause: returned MCP tools/call omits optional isError. Installed SDK
node_modules/@modelcontextprotocol/sdk/dist/esm/types.js explicitly documents
omitted=false/success. executeWithRuntime preserved omission, so generic outcome
classifier called a successful text response unknown. Added narrow exported
normalizeProductionMcpResult at this trusted MCP-return boundary: valid arrays
and content envelopes get explicit false when omitted; true throws original
error detail; malformed flags throw; arbitrary non-MCP payload unchanged;
structuredContent/_meta retained. Contradictory business failure data still
classifies unsuccessful. No text-based success inference.
Build +7 candidate/installed pure checks passed, no provider/home fixture writes.
Hotpatch after zero leases, daemon+assets/reopen. Fingerprint
ec41cdfd3d870744f42d385be6bdc2d8be9eb1967ee9977fb170a29493dfc7b6.
Receipts mcp-result-*; same mixed two-worker prompt now running
sess-desktop-82ff0fc34e227f8910eba0bd under worker-mcp-composio-final-*.

Final mixed-tool retest source250807, sess-desktop-82ff0fc34e227f8910eba0bd,
final250905 success/verified Sol. Exactly ONE two-item worker batch. Actual child
native MCP dispatch recorded in child-events; settled250879
succeeded with handle rh_4c2bcc833c68cefa7dd06480abe3d467; 13 sections. Composio
settled250885 succeeded with handle rh_f17d577e97298624f5e08519a7bff451; 1 metadata
record. Each exactly one physical business dispatch. Both handles present as
verified judgedReadResults. No external mutations or second worker batch.

IMPORTANT routing qualification: first assertion requiring two Luna workers
FAILED. Inspected attribution: MCP worker
sess-worker-01286065f8e593b7f641425082bf56e674488f8a source250867 fell from Luna to
Claude Opus5 at250876, reason model.http_5xx. Composio worker
sess-worker-e15d44fa2422b491ed2df0b7c8cdf0b2ef2f6fa8 stayed Luna. Corrected receipt
explicitly toolExecutionAndReviewPassed:true, smallWorkersThroughoutPassed:false.
Never silently treat that fallback as small-worker validation. Parent actual
Claude Opus5. Both framework MCP defects fixed and actual execution/review passed;
small-only worker routing remains unfulfilled. All handles terminal.
Next inspect src/runtime/harness/fallback-model.ts (harness_fallover event around
1224) and worker model construction. User wants small worker models; current
transient 5xx fallback escalates a worker to foreground Opus. Prefer same-role
small fallback without disabling provider resilience, and validate actual routes.
Artifacts: worker-mcp-composio-final-{events,child-events,usage,assertions}.

## Small worker fallbacks and host-model routing — installed, final check pending
Previous turn progress: MCP identity+result fixes, detected Luna->Opus on 5xx.
RouterModelProvider.buildBrainChain was using foreground brain defaults for
workerScope. Added dedicated connected-provider worker rescues Luna/Haiku,
retaining all_in isolation and explicit primary selection. Claude nested overload
fallback disabled in worker primary/rescue to avoid its Sonnet/large Codex chain.
New DEFAULT_CLAUDE_FAST_MODEL=claude-haiku-4-5. Orchestrator cooldown fallback now
DEFAULT_CODEX_FAST_MODEL instead of MODELS.primary; legacy worker-tools cooldown
fallback now Haiku instead of getClaudeBrainModel. Configured worker/intent pins
remain honored. Not a claim that arbitrary explicitly selected workers are small.
Controlled actual Router/FallbackModel with fake provider503: old installed chose
Opus; candidate+installed chose Haiku; reverse worker chain Haiku->Luna; foreground
chain unchanged. These use no real providers and do not simulate live acceptance.
Build passed and hotpatch b8845f... installed daemon+both assets after zero leases.

Live same mixed MCP/Composio prompt source250987/final251149 BLOCKED: both actual
workers Luna/no fallback, both read paths executed. Judge says Drive response
included extra fields and invocation scope unavailable. No second batch; preserve
as failed full acceptance. Need inspect actual request projection/response shape,
not assume either model error or provider error. Artifacts small-worker-fallback-live-*.

Haiku explicit actual availability source250994/final251087 BLOCKED: model was
actually Haiku (SDK telemetry), but explicit Claude selection chose legacy SDK
worker path sharing parent source; native shell refused exact live attestation.
Parent additionally exhausted exact checkpoint admission. Fixed orchestrator
selection: hostFreshPlanning parents use host-owned children for ALL models;
legacy SDK path remains only outside hostFreshPlanning. Build/hotpatch219505... .
Retest source251165/final251232: actual Haiku host child, one shell dispatch exit0,
but terminal BLOCKED because reviewer lacks actual model receipt. Do not call it
full accepted. Ordinary sourceSettledReadEvidence shows child reads but no route.

Added executedRoute to mutually bound child evidence scopes, using parent
worker_model_executed event matching source/call/child/packetDigest after that
child source. Review summary explicitly distinguishes host telemetry from worker
self-report, and says receipt unavailable if absent. Read-only helper on actual
prior runs: no routes before, candidate/installed identifies Haiku/no fallback
and earlier Opus/fallback honestly. No rewriting past verdicts. Build+hotpatch
2080aa8c1b555decea5185a90771c718b7990619d275859ef4c2a6bb03d78b64,
zero leases before quit; daemon+assets/reopen. Receipts worker-route-evidence-*.
Exact same Haiku single-command prompt now running
sess-desktop-5211ba47fe8f45cae3421ae9 under small-worker-haiku-final-*.
Current router fallback transition is proven with injected model503 in a separate
installed-library process; no actual app-provider failure forced or global auth
settings changed. Live actual Haiku command and reviewer acceptance pending below.

Haiku final source251260/final251305 SUCCESS, verified/fulfills Sol. Actual host
child worker_model_executed251290 claude-haiku-4-5/no fallback; actual source-bound
usage confirms Haiku. ONE run_worker +one physical native shell dispatch,
successful retained settlement, exit0. IDs/handle/assertions and child/parent
usage saved small-worker-haiku-final-*. Final prose includes an inaccurate stale
caveat saying runtime model attestation unavailable; runtime DOES attest it and
the judge evidence now carries it. Parent answerer still only sees worker prose,
so exposing a concise model receipt in run_worker result is a useful follow-up.
Do not represent this as a live forced Luna503->Haiku transition. That transition
is separately checked in installed Router/FallbackModel using mock503/no provider;
actual Haiku auth/tools and actual Luna tools are verified in live app.
All handles terminal. Current build2080aa8..., no settings changed. Remaining:
Drive projection discrepancy from250987, parent-facing route receipt, forced live
checkpoint re-entry coverage, broader memory/proactivity/mobile/release/speed.

## Independent Claude review — 2026-09-20
User requested Claude cross-check. Installed fingerprint still2080aa8c..., live
Claude configured and activeBrain=claude_oauth. Read-only review source251369,
session sess-desktop-7d0ccfa11128499566f1e20e completed251547; actual usage Opus5,
completion Sol251543 verified. First response was incomplete and repaired.
Artifacts claude-worker-routing-review-{start,response,events,usage}.json and .md.
Confirmed by local source: legacy SDK worker catch orchestrator.ts3167 still
uses falloverBrainModelIds, outside corrected hostFreshPlanning path; all_in
worker isolation tests guardrailScopeId while ordinary chain tests workerScope.
Host child evidence cannot cover SDK workers lacking child lineage. Follow up
with reachable-path checks before representing these as observed live failures.
Claude review needs qualifications: its opening says live Haiku used an
unprotected lane, contradicted by its own body and actual host-child evidence.
It also conflates the route-evidence helper with the separate injected503
check-small-worker-fallback.mjs, which DOES assert executedFallback.id=Haiku.
Do not discard controlled fallback evidence or call it forced live503 coverage.
Further receipt risk from local inspection: worker-host-runner.ts can emit
executed:true using requested input.modelId if no turn_model_routed exists.
Needs execution-proof hardening, not merely wording. No source edits/hotpatch
in this review turn; all review handles terminal. Prior parent receipt and
Drive projection follow-ups remain open.

## Legacy small-worker fallback patch — 2026-09-20
Previous goal turn: progress (actual Claude review identified actionable gaps).
Rechecked main, active Claude PID47978 cwd same checkout, preserved shared edits.
Added falloverWorkerModelIds in model-role-options: connected Luna/Haiku only,
all_in remains isolated. Orchestrator legacy SDK commit-safe catch now calls it
instead of foreground falloverBrainModelIds. all_in Router isolation recognizes
workerScope as well as guardrailScopeId (SDK children only set the former).
Build passed. Candidate + installed helper checks live connected rescue Luna,
three all_in scope shapes isolated, no providers invoked in helper. Installed
fingerprint74987f035c3d98ccf145e7a9887bb917e59eda8702e0deb928b6cb48555dbbe7
after zero active leases, quit/reopen via CUA; daemon+both web assets installed.
Receipts worker-legacy-fallback-*. Initial live test source in
worker-legacy-fallback-live-events stopped asking clarification: my prompt
incorrectly requested two different per-item pins in one shared-model batch.
Not a product regression/pass. Corrected to separate exact single-item tests:
Luna sess-desktop-64c4b8cf0098327f664d17e9 final251713 verified Sol;
Haiku sess-desktop-bb1f18078ef7d6ff16c808c9 final251703 verified Sol.
Each one child/one physical native shell command, successful retained settlement,
actual child usage confirms requested small model, no fallback, exit0. Assertions,
events, child-events and usage saved per label. All own handles terminal.
Not a forced live provider-failure test. Parent Haiku answer still lacks runtime
model receipt; planned/executed telemetry distinction remains next patch.
Drive250987 historical request authority lookup returns typed authority payload
missing, not proof of correct/incorrect fields. No external reread performed;
check-drive-projection.mjs and drive-projection-retained-check.json saved.

## Completed-response model receipts — 2026-09-20
Previous goal turn progress: legacy fallback patch installed/live small runs.
Model-route-metrics now emits worker_model_response_completed only after actual
completed provider response, worker role+workerScope+exact source+runAttemptId.
No receipt for failed/cancelled response, incomplete stream, judge role, missing
attempt; new event type in eventlog. Host worker aggregates only exact child
source+attempt receipts, removes requested-model fallback pretending execution.
Parent worker_model_executed now carries completed_model_response evidenceKind
and modelCallId. run_worker appends concise verified model/provider receipt after
reduce (ERROR/PARTIAL prefixes unchanged; reuse distinguished).
Build passed after correcting optional session type/new event enum. Seven pure
extracted compiled model wrapper checks passed candidate+installed, no isolated
home/provider execution. Hotpatch zero leases +assets+CUA reopen fingerprint
99cfa375b518c32d94b580eb9d595989f91a8bc24e23a911e5ad29e64259129d.
Existing host-worker-executed-route.attack.test mock updated AFTER patch to emit
completed-response evidence because it replaces provider instrumentation; its
isolated-home fixture was NOT run. Only test-file change since installed build.
Live Luna source251765/final251857 and Haiku source251769/final251852: receipts
recorded actual responses, matched source+attempt+modelCallId; parent tool result
and final prose now both independently identify actual model. Actual usage agrees.
BUT both terminal full checks unverified: reviewer cannot see exact command args.
Do not call full live acceptance passed. Receipts worker-response-receipt-*.
Both tools settled success but host physical_dispatch rows have authority_digest
null/staged null and no physical_dispatch_authority_sealed rows. Old completion
read projection only opens legacy sealed authority or tool_called invocation,
while host-native child calls have neither. Same structural request-evidence gap
likely explains historical Drive projection uncertainty (not yet verified).
Next trace host-tool-invocation.ts beginPhysicalDispatch at1588/1762 and retain
exact admitted request scope bound to physical digest, then project to reviewer.
Never weaken review to accept missing request scope; avoid repeat external reads
when existing retained result suffices. All own handles terminal.

## Host admitted-request evidence — installed and live accepted
Previous goal turn progress: real worker-response receipt and parent visibility,
full checks failed because native request arguments were unavailable to reviewer.
Confirmed host crossings have no legacy physical_dispatch_authority_sealed rows.
Added optional encrypted requestEvidenceCipher on existing provider_dispatch_started
event, in same admission transaction, only compatibility non-typed/non-staged
non-preparation crossings. Exact source/task/logical/physical/tool/digest sealed
with admitted args. Evidence failure never blocks execution or invents scope.
New loadPhysicalRequestEvidence joins exact returned physical row to its start
event, decrypts and checks all bindings. It never grants execution authority.
Completion reviewer uses VERIFIED ADMITTED REQUEST SCOPE fallback after legacy
typed authority; explicitly does not claim provider-added defaults.
Build passed.13 in-memory DB checks against compiled candidate+installed cover
all binding mismatches, wrong scope, tamper, incomplete crossing, missingreceipt.
Initial candidate Electron helper ABI mismatch corrected using Node for workspace;
installed helper uses Electron. No dependencies rebuilt/isolated home fixtures.
Hotpatch after0 leases +both assets+CUA reopen fingerprint
243040aa5dfb39b5c439b478a2afe13a038826575edd355a3b32d0f6a1d7ceef.
Same live Luna check sess-desktop-7d08cd927b494a345aa7ea91 final252043 passedSol;
Haiku sess-desktop-cc1f33461db93221b7be57ca final252048 passedSol. Each one
command, exact admitted /usr/bin/true independently reopened, exit0, actual
model verified by completed-response receipt+usage; no fallback.
Same MCP+Composio test sess-desktop-17bdea3075bddfe913b7880f final252104
passedSol. One two-worker batch, both actualLuna, one physical read each, MCP13
sections, Drive1record. Retained admitted request fields=files(id,mimeType),
pageSize1,q=trashed=false. Returned file object also carries display_url and
link_label, so do not claim literal two-key provider response. Correct projection
is proven for this request; no historical250987 verdict rewritten. Nofilecontent
and no externalwrite. Actual returned file field names (no values) saved in
host-request-evidence-live-scope-checks.json. Wrong-source lookup rejected.
Artifacts host-request-evidence-* contain source assertions and total usage
including judge/repairs, all own handles terminal. Next broader token/speed
work, memory/proactivity/long-chat acceptance and physical mobile/release remain.

## Efficiency baseline — measured, no new hotpatch
Previous turn progress: host-request evidence installed; live nativeCLI/MCP/
Composio accepted. Audited actual accepted-source totals including workers/judges
in efficiency-source-audit.json. Opening simple worker request had approx27308
tool-schema component tokens of41360 total (estimates, not independently billed).
Current installed hot-schema inventory efficiency-current-hot-schemas.json: native
workflow create/update and space_save dominate, kept first-class per user.
Examined independent tool-cache boundary candidate in claude-model.ts; build and
7 pure actual-envelope checks passed. Normal node test runner refused live-home
binding before any tests; did not override or run isolated-home fixtures.
Two sequential SAME-prompt installed-app baseline turns both verified Sol:
a sess-desktop-0d06fdf688fa2c1815292845 source252156,
b sess-desktop-5a53f4c8c7218678954d6aef source252213. Parent b cached41324tokens
on BOTHcalls, proving warm cache already effective. Candidate not demonstrated
beneficial, so reverted ONLY own cache-condition/comment and added test changes.
No hotpatch this turn; installed build remains243040aa5dfb39b5c439b478a2afe13a038826575edd355a3b32d0f6a1d7ceef.
CAUTION dist still contains unshipped cache candidate; rebuild from source before
any future patch. Baseline totals +allusage in tool-cache-sequential-baseline-
summary.json /tool-cache-baseline-{a,b}-*. No broad speed/ClaudeCode win claim.
Opening prompt grew~41360->48860; provenance first-request schemas changed24->26,
adding plan_task/work_call; other24digests identical. Both baselines26andidentical.
Orchestrator policy resolved26 in both old/new sources, so variation occurs AFTER
assembly at host request projection. Next trace host-turn-runner native planning
surface filtering/when carrier plan_task+work_call are exposed, and optimize
based on actual coverage instead of hiding first-class product tools.
All own live handles terminal; broader memory/proactivity/long-chat/mobile/release
and matched benchmark remain open.

## Warm planning catalog relevance — installed, live prompt reduction
Previous turn progress: measured sequential baseline, rejected unproven cache
change. Traced 24->26 first-request schemas: plan_task/work_call isEnabled uses
nonempty planning card. Warm global Drive entries from unrelated prior task
filled the simple /usr/bin/true worker card (8caps), cold card had0. Index
nominations for same request did NOT nominate Drive; global fill was the source.
Added pure planning-nominations.ts selector: initial live card only current
proof/index operation nominations or exact revalidated learned IDs. Index stable
operation IDs match versioned live definitions; historical bytes never become
authority. Full live map remains available for exact revalidation and foreground
discovery; durable same-task disclosures still added. No native product tool
removed; no new call/admission block. Four pure no-home tests passed; build passed.
Installed module matches candidate and unrelated/versioned checks passed.
Daemon stopped but desktop shell stalled in normal quit. After0 activeleases,
closed idle shell via macOS Force Quit UI (PID66317 gone). No shell UI scripting.
Patched daemon+both assets, reopened. First API read before bootready refused;
no task submitted then. Subsequent actual fingerprint verified:
6a932164c96cd9564613cf69957e6e6332c54cb03b7ed70a35f247a74c4234bb.
This rebuild also replaced prior unshipped dist cache candidate; cache proposal
remains reverted. Main other-agent/token-meter work preserved.
Warmup same MCP/Composio request: sess-desktop-4cc2adc64e4fbcf4ed0328d4
source252351 final252452 verifiedSol, twoLuna/no fallback, one read each.
Then SAME simpleworker prompt as baseline: sess-desktop-8489bf00a0e32464b752a5dc
source252465 final252512 verifiedSol, oneactualLuna/onecommand/exit0.
Initial warm card now0 caps, 24schemas; native space_save/workflow_create/update/
run still present. Parent prompt41367+42116; all5calls prompt97225 versus
baselineb112196 (about13.3%reduction), uncachedwork23425vs25226. Elapsed29.193s
versus baselinea29.884s/b35.094s; onecomparison is NOT a general speedclaim.
Warmup11calls264564prompt138213uncached, so do not generalize simple-task saving
to all MCP discovery. Accounting includes sourcebound parent/worker/judge calls.
Evidence planning-nominations-{warmup,live}-*, comparison.json, puretests/build/
hotpatch/assets/installed checks; all own handles terminal. Next improve main
tool schema cost/memory relevance and broader long-horizon/proactivity/mobile
acceptance, with matched ClaudeCode benchmark still open.


## Claude memory correction and scope acceptance — 2026-09-20
Rechecked shared checkout main/e5a75f5a; other Claude PID47978 cwd matches.
Installed fingerprint remains6a932164c96cd9564613cf69957e6e6332c54cb03b7ed70a35f247a74c4234bb.
Live settings Claude configured=true, active claude_oauth, brain Opus5,
worker Luna, judge Sol. No config/source/hotpatch changes this turn.
Pending synthetic Birch correction session c1753e4a2555049584eb3b25 completed:
source252549 final252574 verifiedSol. Readonly memory DB independently confirms
fact3805 inactive superseded_by3807; active3807 hours, all other clauses retained.
Fresh Birch recall sess-desktop-0f3f9a2e41fda63dc338259b source252632 final252704
verifiedSol: hours/completed-only/owner alphabetical/local drafts/no send or
schedule/project-only scope recovered. Fresh Cedar negative-scope check
sess-desktop-5c67bcfd74df1dda77024051 source252636 final252838 verifiedSol:
no Cedar-specific rule found; explicitly did not carry Birch/other projects over.
Cedar answer qualifies incomplete history backfill; no exhaustive absence claim.
Actual source-bound usage shows Claude Opus5 +Sol on all three, not substituted
Codex foreground. This is Claude runtime validation, Sol completion review,
not an independent Claude review or matched Claude Code benchmark.
Correction3calls48827prompt/47539uncachedWork; recall4calls135348/66610;
negative15modelcalls588174/288229 and15top-level read tools. Cedar initial recall
labels related different-project material supported, then model performs many
searches to establish scoped absence. Correct final scoping but substantial
memory-retrieval/negative-lookup efficiency gap; next investigate coverage and
answerability evidence, not arbitrary read gates or direct live-memory repair.
Evidence memory-{birch-correction-live,birch-recall-claude,cedar-scope-claude}-*
and memory-correction-claude-validation-summary.json. All three handles terminal.
Only explicitly synthetic correction mutated a fact; no external writes.
User reiterates Claude checks and native/local MCP/CLI/Composio coverage, with
external-write care and first-class tool availability. Preserve token meter.


## Memory search coverage guidance — hotpatched and checked with Claude
Previous goal turn progress: scoped correction/recall passed and Cedar search
cost isolated. Further trace: first Cedar completion rejected categorical absence
because ranked lookups had unknown completeness; one repair expanded to15tools.
Added shared coverage guidance to actual memory_recall_all and memory_search_facts
results, including empty/archive branches. Relevance/support is not project scope
or exhaustive coverage; report qualified not-found and widen for concrete leads
or requested exhaustive audit. No tools/gates/limits changed, no extra modelcall.
Backend build passed;0activeleases; normal CUA quit succeeded; retained rollback,
hotpatched daemon+both assets and reopened installed app. Candidate/installed
memory-tools.js exactly match; served fingerprint verified:
9e58377c7627b4ed10b832783e3fee93adc53dc977b2c17d2c754cb438e982e7.
Same Birch prompt sess-desktop-74405273a87250cb9bc42d89 source252878 final252920:
actualOpus5,1call40990prompt7406uncachedWork, complete correct preference from
loaded context. No tools or completionVerdictRef; this is independently checked
recall, NOT a Sol-reviewed pass. No savings attribution from that changed route.
Same Cedar prompt sess-desktop-0aee3353c8e2f70d04543d1c source252882 final252959:
actualOpus5+Sol, verified reviewed completion,3top-level tools versus15 baseline.
Coverage guidance seen in actual settled unified+fact results. First categorical
answer still rejected; repair qualified coverage without another search loop.
7modelcalls233048prompt/63717uncachedWork versus15calls588174/288229 baseline.
~60.4%prompt reduction for this matched case; cache/retrieval state differ,
not a broad speed/efficiency or Claude Code benchmark claim. No externalwrites.
Artifacts memory-coverage-{build,hotpatch,assets,live-summary,comparison} and
memory-{birch-recall,cedar-scope}-claude-coverage-{start,response,events,usage}.
All own handles terminal. Next address retrieval support labels/negative-lookup
coverage at structured evidence level and evaluate additional scoped cases,
then broader memory/proactivity/long-chat/mobile and matched benchmark work.


## Memory evidence labels — installed; first-answer confidence still open
Previous turn progress: coverage guidance installed/live measured fewer searches.
Root inspection: recallMemory support is evidence+rank threshold, not semantic
entailment/project match; model header incorrectly advertised answerability.
Unified recall/primer now labels ranked candidates, non-exhaustive coverage,
check cited scope. Legacy answerability retained internally for compatibility
and ranking/telemetry. Both formatters mark truncated snippets with reopen ref;
primer additionally marks formatter-created clipping. Visibility budget uses
same labels, preserving bounded output/visible attribution. Existing assistant
core assertion updated for honest header. No extra provider calls/read gates.
Build passed;7 compiled projection checks candidate+installed via extracted actual
functions (no home fixture); installed module equals candidate.0activeleases,
normal CUA quit, hotpatch with rollback+both assets, reopen verifiedfingerprint
 dbacc7f392477e6ffa9d6f8978c299678ab4cb6e64bc2745f0d6180468d40f28.
Same Cedar: sess-desktop-9bf0897c8fc4e69ac039487d final253107,2tools,
Sol verified after one overbroad-absence rejection. Additional Sequoia variant:
sess-desktop-266d0061af43ff4844f31e0a final253098,2tools, first Solreviewpassed,
BUT answer opens categorical "nothing is saved" before later non-exhaustive
caveat. Independent inspection does NOT qualify first-answer confidence solved.
Birch: sess-desktop-f67bffae4775c87230207145 final253085, no tools/reviewref,
correct complete preference from context; independentlychecked, not reviewedpass.
All actualforegroundOpus5; usage includesSol whereused. Artifacts memory-labels-*
include receipts/events/usage/purechecks, live-summary.json totals and actual
label exposure. All handles terminal, noexternalwrites/personalconfigchanges.
Next structured scope/search coverage or review confidence consistency rather
than further broad prompt growth; keep larger proactive/memory/long-chat/native
and MCP/CLI/Composio/mobile/matched-efficiency acceptance objective open.


## Explicit project identity at memory intake — installed/live accepted
Previous turn progress: honest labels and bounded negative search demonstrated;
first-answer absence calibration remains open. Readonly graph audit found Birch
facts3805/3807 only linked to entity1649 thing:test, no Birch project entity.
Added pure grounded-user-projects parser for explicit quoted names or delimited
multiword titles after project; preserves numeric distinctions/no aliases, no
inference from generic prose. Other phrasing remains semantic extractor's job.
Grounded-user-entities attaches project observation+fact link only when exact
name present in both user episode and stored fact, retains episode evidence.
Durable consolidation invokes this alongside existing grounded people capture;
records observations/links/failures in candidate reason. A mention is NOT proof
of exclusive applicability. No historical graph rewrite/personal memory cleanup.
Four no-home parser regressions pass, build passes.0activeleases normal quit,
rollback hotpatch+bothassets, installed three modules match built candidate.
Served fingerprint7f70ba66696793be7b274cf8bf57ae6bc882288b102857b9ad3507128ccb578b.
Live seed sess-desktop-32a60bcc62e5ab85f16102b0 final253185 reviewedSol:
synthetic Alder Archive 2041 fact3808, projectentity4575, extractedlink with
originalepisode call:ddcf9fe1b3f91fb4e708c9e1 independently read from live DB.
Fresh application sess-desktop-fd6bd8f2134f2afa77017585 final253245: Amy1hour,
Zoe1hour, alphabetic, pending/cancelledexcluded, correct project-only scope,
no tools/reviewref; independently verified calculations, not reviewed pass.
Near-name2042 sess-desktop-62f43711c93976d1889932ed final253276: 3readtools,
two rejection/repair cycles then reviewedSol qualified no-found;2041 not applied.
This does NOT resolve negative-search confidence or prove an efficiency win.
ActualforegroundOpus5, Solreviewwherepresent, receipts+allusage project-grounding-*
including seed-memory.json/live-summary.json; all own handles terminal.
No added modelcall in capture; explicit quoted/delimited syntax is precision
fallback not universal project extraction. Next evaluate concrete structured
store coverage for negative lookups and broader proactive/long-horizon work;
first-class native/MCP/CLI/Composio and user token-meter scope preserved.


## Conversational correction preserves grounded identity — installed/live pass
Previous turn progress: explicit project capture installed, near-name scope check.
Same-session followup without projectname corrected Alder3808->3809 (minutes),
final253332 reviewedSol, but readonly DB proved only3808 retained project4575link.
Thus graph traversal lost active preference despite correct answer/text.
New retained-fact-entities.ts runs inside both markFactSupersededBy and supersedeFact
transactions AFTER direct old->new transition. Carries only existing stored/
extracted links with original episode+excerpt, canonical name present in old/new
fact and originalexcerpt. Never copies values, resource permissions or implied
applicability. Newexplicit longer project names suppress contained old names.
INSERT OR IGNORE retains independently established successor evidence; replay
idempotent. In-memory SQLite regression covers provenance retention, changed
numeric/name scope, longer unknownname, inferredlink, missinggrounding, wrong
supersession. No fixturehome. Build passed;0leases, normalCUAquit, rollback patch
+bothassets; installed facts/retained helper match candidate; servedfingerprint
8f3955a70d9ddd0b3710f28911dad82618aeba873eb8e3bb2e7c597455ac028f.
Fresh Willow Archive2041 seed sess-desktop-c7bd4bcbbb4592cea82e1d52 final253397:
fact3810 project4576 originalepisodecall:120f94eb9d3c6d2be79e731f.
Same conversationalcorrection as failing Alder case final253438 verifiedSol:
3810inactive supersededby3811,3811active minutes/allclauses, BOTH linked4576 with
original identity episode. Independently inspected live DB; no manualDBrepair.
Fresh report sess-desktop-ab3b532feaa5e018269ca7d7 final253469: Amy60minutes,
Zoe60minutes, completedonly/alphaorder/projectscope correct. ActualOpus5; no
completionreviewref on simple no-tool report, independentlychecked math/scope.
Artifacts project-correction-identity-* plus original project-grounding-context-
correction events/usage. All ownhandles terminal; no externalwrites/configchange.
This proves bounded correction/identity/recall path, not universal semantic
scope resolution or negative-lookup confidence. Original missing Alderlink left
historical, no silentbackfill. Broader proactive/longchat/mobile/benchmark remain.


## Proactive timer audit — local delivery added, live timer host path fails
Previous turn progress: correction identity fix installed/live verified.
Investigated timers/prospective scheduler for restart and duplicate acceptance.
Timers default to configured notification destinations; no local-only tooloption.
Added optional set_timer delivery=local|configured (default unchanged), local
persists metadata.inboxOnly=true through timer into notification. Existing
shouldQueueNotificationDelivery returnsfalse before outboundroutes for inboxOnly.
Compiledfunction checks candidate+installed confirm localqueueexcluded/default
preserved. Buildpass,0leases normalquit, rollbackhotpatch+bothassets, servedbuild
 ebdb00991e461631d34cea7e91564055442494da272abdbb7e91e2f86eb80b01.
First live genericreminder sess-desktop-137b26a425e1ff56558076bb source253518
final253554 claimedtimer/reviewedSol but actualtoolworkflow_create. Created
syntheticworkflow juniper-continuity-2041-reminder due09:02:30Z; no local delivery
contract proven. Disabled ONLY that syntheticfile enabled:false atomically at
09:02:24.702675Z (before due), preservingbody. Do NOTcountas timeracceptance.
Explicitset_timer sess-desktop-1bcceaa88d97d887a764752e final253621: no timer,
actualpre-dispatchcoverage_missing. Model reports3attempts (violatesexactonce),
terminalfailurequalified. tool_search initiallyreturns unrelatedresults; native
registered but filtered/coveragepath blocks. No timerid/no pendingtimer exists.
No matchingnotification/outboundqueue receipts on checked ownfixtures; artifact
local-reminder-no-delivery-audit.json. Allownchat handles terminal. Do not retry
same blocked test without frameworkchange. Next trace local-planning-capability
registry, hostLocalPreparation/configuredtool filtering, and connect native timer
through correct host effect+coverage path. Restart/firing/exactonce liveacceptance
still NOT done; generalproactivepolicy notchanged. Localdelivery implementation
is installed but endtoendunqualified. Artifacts local-reminder-* savebuild/tests/
patch/assets/events/usage. Noexternalmessagesauthorized or deliberatelysent.


## Native local timer coverage — execution/restart passes; review gap remains
Previous turn progress: local reminder delivery added; discovered predispatch
coverage_missing and workflow substitution. Traced set_timer missing registry
localPlanning declaration. Added runtime_configuration/create_only semantics,
exact structural safeMode delivery=local, capabilityRef cap:local:set_timer:local_inbox.
Uses existing preparation/consent/dispatch; no host_only bypass. Configured/
external/default delivery NOT admitted by this local variant and remains open.
Actual current registry/schema observation candidate+installed confirms local
matches, configured/null/omitted do not. Buildpass,0leases, normalCUAquit,
rollbackhotpatch+bothassets, servedfingerprint
 e0427ce0a4607ed0670f13aa75721ab22919fb1907197be438d4f0e4c5d2f070.
Same explicitprompt sess-desktop-c3a1c9335b25cfce6b4c12b7 final253720 executed
one timer timer-50be19ac, livehome .timers.json metadata.inboxOnly=true, due
09:09:06.790Z. ActualOpus5+Sol. Completionreview UNVERIFIED: timerwrite result
not available to reviewer. Do not count fullturnreviewpass.
After terminal+0leases, normalCUAquit and reopen beforedue. Actual notification
id timer-fired-timer-50be19ac created09:09:08.609Z,1.819s late; exactlyone retained
local record, inboxOnlytrue, no outboundqueue entry, timerremoved frompending.
Prospective row completed with matchingnotification receipt. Laterread still1.
Evidence native-timer-{coverage-*,restart-delivery,prospective-receipt}.json/txt.
No ownpendingtimer/run remains. Firstgeneric syntheticworkflow staysdisabled.
Next fix reviewer evidence: sourceSettledReadEvidence/sourceEvidenceLookup in
host-completion-work filters mutating=0; successful non-file timerwrite has
settlement but result arguments/id absent inreview. Retain authenticated write
receipts with exact acceptedsource/call binding, without treating promise of
future execution as alreadydelivered. No repeatphysicaltimer torepair evidence.
Restart/basicfuturecommitment accepted narrowly; broad autonomousproactivity,
externaltimerdelivery/nativefirstclassdiscovery and other fullgoals remainopen.


## Authenticated write receipts — installed Claude live review passes
Rechecked other Claude PID47978 cwd this shared main checkout, HEAD e5a75f5a.
Current host-completion-work evidence now includes successful parent-source write
receipts with exact sealed request arguments and authenticated result redemption.
No new execution authority: source/call/handle/digest validation unchanged.
Plan preparation and linked worker evidence remain read-only. Every write receipt
explicitly says saved/queued does not establish later execution or delivery and
must not be repeated just to obtain evidence. Legacy API names retained.
Candidate+installed regression opens historical timer receipt, exact arguments,
excludes it from explicit read-only projection, rejects wrong-source lookup.
Build passed. Normal quit with zero leases; rollback hotpatch and both assets.
Served fingerprint b06fe33f76357376fbd0c6c21dee0d9a1bbcff8654ae9ac60a89168974da2312.
Actual live configuration Claude Opus5 foreground, Luna worker, Sol judge;
Claude vault configured, global proactive policy still false. No settings changes.
Fresh identical timer request sess-desktop-4757e2112a1263161e35608f source253772
final253816: one physical set_timer, timer-8546ce67, first Sol review verified
receipt/arguments, no repair. Actual usage confirms 3 Opus5 calls + 1 Sol call.
20.637s accepted input to final; 143329 prompt,39928 cached,103934 uncached-work.
Prior same request used6calls/198235prompt/119680uncached-work with failedreview;
this single improvement is not a ClaudeCode benchmark or broad efficiency claim.
Timer due09:18:06.326Z fired09:18:18.895Z (12.569s late), exactlyone local inbox
notification, inboxOnlytrue, no outboundqueue, no pendingtimer, prospectivecompleted.
Restart was covered in preceding increment, not repeated this run.
Artifacts write-receipt-review-* contain build/patch/evidence/usage/delivery.
Historical failed reviewer verdict remains unchanged. All own handles terminal.
Next focus repeated prompt overhead (initial Opus prompt40338 tokens for this
small task), discovery efficiency and smaller-worker matched cases across native,
local MCP, CLI and Composio. Keep authentication, effect safety and full usage
accounting intact. Timer precision/prospective session identity, longchat,
proactivity, physical mobile and matched ClaudeCode benchmark remain open.


## Native schema prose reduction — installed; live authoring reveals receipt mismatch
Prior turn progress: authenticated write receipts, actual Opus5 timer passed.
Audit shows initial timer schema estimate27308tokens, memory1691injectedbytes;
workflow_create/update + space_save schema descriptions alone total~28KB.
Repeated structure comparativelysmall, so no tool deferral/removal or new $refs.
Shortened shared workflow input/output/call documentation and output-contract
field descriptions, retaining source syntax, direct-call result paths, forEach
semantics and effect restrictions. Changes only descriptions in orchestration-
tools.ts and workflow-output-schema.ts. Structural schema comparison (preserves
actual property named description) exact candidate/installed;1454UTF8bytes less
each create/update,2908total. Space schema unchanged. No broad efficiency claim.
Buildpass,zeroactiveleases,normalquit,rollbackhotpatch+bothassets,servedfingerprint
8b86323271b78fe2fdc7e171392cc0b770c4fca46be1303ae4de38763d77062b.
Claude foreground verifiedsettings+usage. Live sess-desktop-486d89fab877624377907f5d
source253895 created manualonly harness-compact-native-1789896268232 with exact
read_file + aggregate transform, final array contract, no model computation,
no schedule/externalapps/sends. Creationtest1789896294492-4492e0 passed.
Requestedrun1789896301331-7aa310 output A:count2,sum30;B:count2,sum12 correct.
Sol rejected fresh-read evidence and automatically repursued1789896328084-42d434;
secondrun also terminalblocked. Not a clean acceptance and violates requested
single run. Parentfinal254003 also rejected pendingsecondrun/noresults.
All ownrunhandles nowterminal,zeroactiveleases; manualonly savedfixture retained.
Exact root evidence: durable_result_handles + logical_tool_calls both bind read
workflow:1789896301331-7aa310:read_records source253980 to acceptedTaskId
workflow-authority:e1b24ba42a8e7525abd20101d50d261024fdd5b6553583f0ea69d4decb0a73f6.
sourceSettledReadEvidence instead supplies acceptedTaskIdFor(session,source)
(chat identity) to redeemSuccessfulSettlementResultForHost; verifier correctly
refuses mismatch as another acceptedtask. Fix reviewer authority resolution via
actual trusted workflow authority, preserving task-boundary checks; do not weaken
verifier or replay business action to repair proof. workflowRunReadEvidence should
also explicitly remain read-only after recent parent write-receipt expansion.
Next fix this mismatch and hotpatch/retest nativeworkflow, then broaden MCP/CLI/
Composio + smallerworkers and matched efficiency. Evidence prefix
compact-native-descriptions-*; prompt-schema-* audit.14matchingusage rows captured
(includes parent/reviews and workflowrelated costs),350545prompt, actualOpus5/Luna/
Sol. No latency/token comparison against differenttask or failedrun claimed.


## Workflow receipt identity — hotpatched and live Claude pass
Previous turn progress: compact native schema prose installed; actual workflow
read succeeded but reviewer tried chat acceptedTaskId, causing false rejection
and duplicate run. Rechecked shared main HEAD e5a75f5a; other Claude PID47978alive.
Added evidenceAcceptedTaskId in host-completion-work.ts: reopen exact source via
acceptedTurnCallAuthorityFor, use identity only for verified workflow_v1_read_only,
workflow_v2_paginated_read or workflow_v3_call authority with exactsession/source.
Ordinary chat derivation remains fallback and cannot redeem workflow receipts if
workflow authority missing/conflicted. Both summary and on-demand lookup use it.
No changes to result-handle verifier or invocation authority. workflowRunReadEvidence
now explicitly includeWriteReceipts:false/includeWorkerResults:false.
Candidate+installed checks reopen historical authenticated workflow receipt;
wrong chat identity remainsforbidden, wrongsource lookup and crossedrun reference
remainunavailable. No modelcall or fixtureDBreset for these readonlychecks.
Buildpass;0leases normalquit;rollbackpatch+bothassets; servedfingerprint
c61122752a5ce8d404e9fb33e1968dd661cb1d0d3cda42d5ac3ce2bcbe01cf0b.
Changed ONLY our synthetic input file values (before/after retained in start)
for saved manualonly harness-compact-native-1789896268232. Asked fresh Claude
session sess-desktop-0d0cb85bf53726f91a35d9b8 source254056 to runexactlyonce.
Run1789896641535-8fd3b6 succeeded, read_file + deterministicaggregate, new totals
Acount2sum42/Bcount2sum22. Goal review all3criteria passed failedOpenfalse,
final254100 reviewedSolverified. Onephysicalworkflow_run, noautorerun.
ActualmodelsOpus5+Sol;5matchingcalls inclworkflowreviews,89604prompt/32768cache/
57331uncached-work;29.272s inputtofinal. Compared task is rerun, not creation;
do not present preceding350545tokencreate+retry as matched speed/tokenbenchmark.
Allownhandles terminal,0leases. Historicalfailedruns unchanged. Local fixture
stays manualonly, noexternalmessages/configchanges. Artifacts workflow-receipt-
identity-* savebuild/checks/patch/assets/run/events/usage/summary.
Next matched smaller-worker toolmatrix across native/localMCP/CLI/Composio,
keepallreview/repaircosts; broader longchat/proactivity/physicalmobile and ClaudeCode
comparison stillopen. First-classschema prose reduction remainedinstalled.


## Four-lane small-worker matrix — actual Luna/Haiku verified, native gap found
Prior progress: workflow identity fix installed/live passed. Currentfingerprint
c61122752a5ce8d404e9fb33e1968dd661cb1d0d3cda42d5ac3ce2bcbe01cf0b unchanged.
Ran samefouritem read-only batch, defaultLuna thenexplicitClaudeHaiku4.5 viaClem.
Native read_file ownsyntheticfile, CLI /usr/bin/true, MCP dataforseo docs_list_sections,
Composio connectedDrive metadata1record id/mimeTypeonly. Parentdiscovery allowed,
workersmustexecute. Noexternalwrites/configchanges/install/authentication.
Luna sess-desktop-8b828875a793a5824736a446 source254125:4actualLuna nofallover,
CLIexit0/MCP13sections/Composio1file. Nativeworker6072d... usedrun_shell_command
instead ofrequestedread_file, so NOT nativepass. Solcorrectlyrejected. Finalstill
opens allfour succeeded thenappendsnegativeverificationnote: reportingdefect.
15source-boundcalls incl4childscopes,291401prompt/148814cache/146480uncached-work,
74.620s. Workers8calls35267prompt10674uncached;Opusparent4calls233109prompt
112429uncached;Sol3calls23025prompt23377uncached. Parentdominatescost.
Haiku sess-desktop-27896b06931fa81ec237b3be source254289:4actualHaiku nofallover.
CLI/MCP/Composio actualsameoutcomes. Nativechild5faaceb... source254375 actually
calledread_file toolu_01HeShw14rsU6AFYBCa6GZrg, providerreturned, modelcounted4records;
logicalsettlement kindunknown/evidencetext/stop_and_explain, no durable resulthandle.
Solrejects nativecall notsuccessfullysettled. NOT anallpass. Finalagainallpassed+
contradictoryverificationnote.16calls319091prompt200070cache123996uncached-work,
75.579s. Ordered trials/warmcache/failedqualification precludeproviderwinnerclaim.
Artifacts small-worker-matrix-{luna,haiku}-{start,response,events,usage,summary}.json
pluscomparison.json. Childusage selected byexactworker_started childsourcebindings.
Bothparents andallworkers terminal;0leases. No sourcemutation/hotpatchthisturn.
Next concretefix: direct SDK read_file executes executeLocalFileRead returningraw
formatRecallableToolText; brackets has typed hostsignals for shell but successful
filetext stays unknown. Workflow read_file uses its reviewedcarrier andpassedlast
turn; worker/direct path differs. Add trusted producer-owned read outcome evidence
without classifying arbitrary content as success (error-looking file contents are
still bytes; actual missing/denied/ingest errors must stayerrors). Thenpatch+repeat
nativeworker beforefullmatrix. Also delivery-committer.ts1450-1470 appends blocked
review tooriginalauthoredsuccess; needtruthful terminalreport withoutreexecuting
one-batch-limited work. Preserveoriginalfailedcases/receipts; no broadwinclaims.


## Direct native read outcome — installed Haiku live pass with hostile-looking data
Previous matrix exposed direct SDK read_file returned plainbytes but settledunknown.
New HostLocalReadSuccessResult in attempt-settlement.ts is nominal producer proof,
unwraps to unchangedtext; attemptSignals returns hostExecuted+hostReadCompleted.
computer-tools executeLocalFileReadForTool wraps onlystring aftersuccessfulread;
failOnReadError:true retains missing/sensitive/ingest failures as typednegative.
Workflow executeLocalFileRead completeOutput contract unchanged.
Both bracket invoke/execute paths forward alltyped signals (formerly onlypre-
dispatch typedfailures); settlement treats marked nonmutating read_file bytes as
content, skipsprovider-refusal/corrective-error/serialized-envelope sniffing.
Typed truncation and explicit failures stilltakeprecedence. Spoofed plainobject
cannotproduce nominalproof. HostReadCompleted ishostsignal, nevermodelinput.
Candidate+installed actualproducer checks error-shapedJSON preservescontent,
spoofedobjectignored, missingpath remainsinvalid; buildpass.0leases normalquit,
rollbackhotpatch+bothassets; servedfingerprint
213c3126a87431112fc6cab4bd25df3a2b5686c4d37603874ecb8a8403825c1d.
Live sess-desktop-32c9913e987252ed942616d0 source254496 final254543: exactlyone
Haikuworker child8b7357...source254518, actualclaude-haiku-4-5 nofallover, one
read_file to own native-read-outcome-fixture.json withmax_chars1000. Rootok:false
and ERRORtext aretestdata; fourrecordscorrect. Actualsettlementsucceeded/nominal,
durableresulthandle retainscompletefilecontent. Solfirstreview254539 verified.
All5parent+worker+judgecalls captured101879prompt32768cache70590uncached-work,
32.119s; no efficiencywinclaim fromsmalltest.0activeleases/allownhandlesterminal.
Artifacts native-read-outcome-* checks/build/patch/assets/start/events/usage/summary/
settlement. Fullmatrix notrerun yet; priorfailedLuna/Haiku stillfailedhistorically.
Next fix contradiction when blockedreviewappendedtooriginalall-succeededanswer,
then fullfourlane smallworkeracceptance and parentoverhead. Needbroaderemptyfile,
conversionfail/truncationcoverage; noisolatedhomeacceptance used.


## Blocked presentation replaces rejected draft — hotpatched/live verified
Previous progress: nominal SDKreadreceipt fixed, positiveHaiku error-shapeddata
passed. delivery-committer.ts completionReviewPresentation nowreturns matching
BLOCKED reviewfinding ratherthan appendingwarningafteroriginalsuccessclaim.
Requires exactobjectiveMatches/replyMatches. Otherqualifications/stalereviews and
ownerjudge-unavailablepolicy unchanged. No extra modelcall or operation retry.
Purecandidate+installedchecks replay BOTHhistoricalLuna/Haiku contradictory
all-succeeded drafts; mismatchedreply/objective stillretainqualifiedoriginal.
Hostcontractregressionupdatedbut fixturehomesuite notrun.
Firstpatch1c529b11210bd3512acae159182d38d99446256632949d8a86a47e78883c2225:
Haikumissingfile sess02905... source254580 final254631 truthfulblockedafterone
read. Auditmetadata wasFILTERED byterminalwhitelist, caught bypostcheck; thisfirst
patchdidnotretainrejecteddraft. Correctedretention to internalguardrail_tripped
kindcompletion_review_rejected_draft withsource+replydigest dedupe. Publicterminal
metadata nevercarries arbitraryrejectedprose. No historicalrewrites/backfill.
Finalbuildpass,0leases normalquitrollbackpatch+bothassets, servedfingerprint
04501c1e911391758ccf16e7da61eccebb305ab1284af6db64393804c34ecdc3.
Haiku auditcheck sess-bc6a07834e3086a6ffb03ed7 source254662 final254713:
onefailednative read_file, accuratefailure reportreviewedtrue (prompt explicitly
allowedaccuratefailure); thusdidNOT exerciseblockedoverride.7calls106726prompt,
67200cache41502uncached,39.832s. ActualHaiku+Opus+Sol.
DirectClaude negativecheck sess-desktop-79419ec7a8dc2a3180a44149 source254720:
read missingtestfileonce, noalternate/delegation/retry. SolBLOCKED254748; final
254753 exactlyfinding no count/filemissing. Internal audit254752 exists exactly
once retainingdifferentauthoreddraft; publicterminalcontainsno rejectedtextfield.
4calls86764prompt65536cache21421uncached-work,13.071s, actualOpus5+Sol.
Thisprovescorrectnegativepresentation, notfileaccesssuccess. Allownterminal0leases.
Artifacts blocked-presentation-* includeoriginal/finalpatches,checks,liveaudit/
direct events+usage. Detailedpartialresultspresentation remainsfuturework; original
prose retainedforauditonly. Next rerunfour-lane smallworker matrixafterreadfix,
thenreduceparentdiscovery/orchestrationoverhead; fullbroadergoal remainsopen.


## Patched four-tool matrix — Luna and Claude Haiku live passes
Rechecked shared main HEAD e5a75f5a and other Claude process 47978 cwd in this
checkout. Start helpers verified installed fingerprint 04501c1e911391758ccf16e7da61eccebb305ab1284af6db64393804c34ecdc3 and foreground Opus 5. No source or global settings changed.
Luna sess-desktop-e4cc0cdb431e77b1f36a0e32 source254769: four actual Luna
workers, no provider fallover; read_file 4 records, CLI /usr/bin/true exit0,
local MCP dataforseo docs_list_sections 13 sections, Composio Drive metadata
listing one record. One batch, Sol review254893 verified with matching reply/
objective. 14 parent+worker+judge calls, 218030 prompt,63268 cached-read,
158308 uncached-work tokens,77.678 seconds.
Claude sess-desktop-7802daab57c7610d91f90b6e source254944: four actual
claude-haiku-4-5 workers through Clem authentication, no fallover; same four
actual tools/counts, one batch, Sol review255075 verified and matching.
14 calls,315106 prompt,167031 cached-read,152357 uncached-work,79.991 seconds.
Parent mentioned a self-corrected Composio argument warning; the saved child
events did not contain that wording or invalid_arguments, so do not assert
that warning as independently established. Actual dispatches were one each.
Both runs terminal. These validate bounded tool use across both worker providers;
ordered cache states and different parent discovery do not establish a provider
efficiency winner or any comparison with standalone Claude Code.
Artifacts: small-worker-matrix-patched-{luna,haiku}-{start,response,events,usage,summary}.json
and small-worker-matrix-patched-comparison.json. Next framework work: reduce
parent discovery/orchestration payload overhead, including duplicate Composio
connection aliases identified in small-worker-parent-overhead-audit.json; no
implementation of that optimization yet. Broader memory/proactivity/recovery
and physical mobile acceptance remain open.


## Compact Composio status and exact carried-operation recovery
Previous turn made progress: both patched four-lane worker matrices passed.
composio-tools.ts compactComposioStatusPayload removes only JSON-identical
connectedAccounts/connections aliases from the model-facing status. Canonical
usableConnections and suppressed rows/counts stay intact; inactive distinct
connections stay. Original builder/API shape unchanged. Captured historical
payload minified bytes 5514 -> 2484 (55% smaller), not a task-token win claim.
Actual live status retained all14 usable connections and no duplicate arrays.
Candidate+installed checks cover empty, active, inactive, suppressed, differing
alias lists and immutability. Build and rollback patch+both assets passed.
First fingerprint e72d609277df0b1859812cce103f85b068a265658170fa798e07ed18068b5e67
Live sess-desktop-b0d51893c5ed5804bd3478cf source255102 failed honestly: actual
Haiku put account id inside arguments, schema refusal255160; corrected wrapper
call255164 blocked because recovery named GOOGLEDRIVE_FIND_FILE but available
carrier was composio_execute_tool. No provider dispatch. Solblocked255179.
10calls264250prompt117705cache149655uncached-work66.915seconds.
Fix host-turn-runner.ts hostRecoveryCallMatchesOperation admits a carried exact
inner operation after not_started+repair_model refusal, before normal schema/
authority/account/effect checks. It does not admit different operations, unknown
effects or required questions. Replay captured corrected call plus negative
cases passed candidate+installed. Built and patched both asset trees,0leases.
Current fingerprint f90c7c4b4674d8db91e4098ed993af886c56a117af3c0484a02c9d8a98a1411c.
Deliberate failure/retry test sess-desktop-55146e9e24f63cfa55495f8b source255212
DID NOT pass its full objective: worker started with invented nested
composio__composio_execute_tool, not required argument shape. After two such
misses, actual composio_execute_tool was recovery-refused255278 with exact
inner operation GOOGLEDRIVE_FIND_FILE. Next corrected call did reach provider
dispatch255281, returning one record. This exercises carried-operation recovery
but not the requested exact first-refusal scenario. Solblocked255296 correctly
for unverifiable requested first refusal. Actual Haiku nofallover,9calls203392
prompt128192cache78702uncached-work94.604seconds. Keep this failed qualification.
Normal follow-up sess-desktop-2fd851966f5a93b9020e920f started, final pending.
Artifacts compact-composio-status-*, composio-recovery-carrier-*, compact-composio-final-live-*.
No global defaults/auth/provider changes, external writes, fixture resets or
isolated acceptance. Next inspect final follow-up, retain failures, then address
remaining discovery/carrier naming and larger parent schema/history overhead.

Normal follow-up completed: sess-desktop-2fd851966f5a93b9020e920f source255311,
actual Haiku child83d040...source255353 nofallover, one googledrive_find_file
dispatch returned1record. Initial final included MIME type/extra details and
Sol rejected output scope; parent corrected text without another provider read.
Final Sol review255378 verified with reply/objective matching.8totalcalls249188
prompt153231cached-read99003uncached-work61.344seconds, including repair/reviews.
This qualifies compact status discovery through actual Claude worker read; it
does not prove a task-level speed/token win. Broader goal remains active.


## Inline schema guidance — installed; live review boundary defect exposed
Previous turn made progress: compact status and carried-operation recovery were
hotpatched and normal Claude read passed after response repair. Shared main
e5a75f5a remains; other Claude process47978 alive.
tool-search-tool.ts previously created durable handles for EVERY inline schema
then told model handle presence meant schemas were absent and must be reread.
Now schema_read_required names only evicted/compacted schemas. Full inline
schemas explicitly usable immediately; handles retained as optional rereads
after context loss. Large schemas still require ordered local chunks.
Actual compiled tool handler checks small and40k enum schema: original handle
retained, inline equals original, oversized losslessly reopened, provider fixture
search invoked once. Candidate+installed passed, no isolated-home fixture suite.
Build,0leases,normalquit,rollbackhotpatch,both web assets installed. Fingerprint
41c941e1386501178c72d56174ae296a4612d4cdc6fb75ca7bcf3c6bf88c59e6.
Live sess-desktop-c676a3505afd423046f9945c source255419 DID NOT PASS full review.
ActualHaiku child987a6a...source255474, nofallover, one Drive find_file dispatch
returned1record. Discovery did one broad search with leading GET_FILE_METADATA
inline, FIND_FILE/LIST_FILES required; then one legitimate full-schema chunk
read. Saved discovery audit confirms schema_read_required truthfully marks
those absent schemas. Does not prove eliminating an unnecessary read in this
case because chosen FIND_FILE really was deferred.
Sol rejected3times alleging identifiers/personalmetadata in appended evidence
were disclosed in final answer. Final answer itself contained no actual ids/
personalmetadata but did contain extra discovery details beyond requested
model/success/count. Do not label whole review groundless or markpassed.
13calls436487prompt268955cache171720uncached-work94.298seconds. Review255504
verifiedfalse. Strong nextaction: buildObjectiveJudgePrompt in objective-judge.ts
labels toolsummary authenticated evidence but does not explicitly distinguish
private reviewer evidence from user-delivered response for output restrictions.
Need stronger boundary and live verification, retain actual output-scope checks.
Also inspect worker past-tool suggestions: all4workers in both matrix runs
received PAST-task tools despite resolved tool packets (4.2–4.9kchar packets).
Artifacts inline-schema-guidance-* build/check/patch/assets/start/events/usage/
summary/discovery. No task efficiency win claim. Broader goal active.


## Completion review output/evidence boundary — installed and live checked
Previous turn made progress: installed inline-schema distinction and live trace
exposed false disclosure reviews. Confirmed judgeHostCompletion passes judgedReply
separately from authenticated toolCallSummary; buildObjectiveJudgePrompt did not
clearly terminate candidate or explain private evidence is not delivered prose.
objective-judge.ts now labels END OF CANDIDATE RESPONSE and PRIVATE REVIEW
EVIDENCE and adds rubric: output restrictions apply to candidate and actual
deliverables, not private tool/diagnostic evidence; still enforce restrictions
on reads/writes/sends/storage and verify factual claims. Disclosure rejection
must identify offending text in candidate or actual deliverable. No evidence
removed, no judge bypass or changed provider/defaults.
Build passed;0leases normalquit rollbackpatch+bothassets. Current fingerprint
251e5123913db6a691b8317187aa01fa2a24cdd62b31fc586906272bffbed44f.
Installed strict Sol paired review using synthetic evidence containing an id:
clean Count:1 accepted; candidate actually including synthetic id rejected
specifically for that disclosure. Neither failed open (strict calls throw).
Artifacts check-judge-output-boundary.mjs and judge-output-boundary-paired-review.json.
Same normal live prompt: sess-desktop-4005beae01bbf8678cc0094d source255545;
actualHaiku child3b54f...source255595 nofallover, one googledrive_find_file
dispatch returned1record. Sol FIRST review255618 verifiedtrue reply/objective
matching.7calls240999prompt151229cache92261uncached-work59.701seconds vs prior
13calls436487prompt171720uncached94.298s; bounded observed runs with different
cache/discovery, not causal benchmark or providerwin. False private-evidence
disclosure loop did not recur. Independent output check: candidate still included
connection counts/schema/discovery beyond requested model/success/count, so strict
format fidelity NOT fully qualified despite Solpass. Do not erase that gap.
Artifacts judge-output-boundary-live-* contain exact trace/usage. Next inspect
worker past-tool suggestions and task-specific worker context; parent discovery
schemas remain dominant and strict output adherence remains open. Broad goal
(memory/proactivity/longchat/recovery/mobile/ClaudeCode comparison) remains active.


## Worker recall scoped to resolved contract — hotpatched, four-lane Claude pass
Prior goal turn made progress: review output/evidence boundary fixed with paired
Sol and liveClaude checks. Inspecting recorded matrix workers showed native file
read worker received remembered GOOGLESHEETS_VALUES_GET from broad objective.
Added pure tool-choice-resolved-context.ts exact identifier boundary matcher.
renderToolChoicesForContext optional fourth resolvedContract filters advertised
choices by identifiers present in that contract BEFORE normal relevance/effect
selection. buildWorkerJobPrompt passes its resolvedTools. Parent/general recall
and durable memory remain unchanged; no tool access/dispatch change or added
authority. Missing-capability discovery remains in worker instructions.
Candidate+installed helper checks case-insensitive exact names, boundary/prefix
confusion, regex escaping, none-needed; replays all4historicalHaiku packets and
confirms data identical and irrelevantSheets removed.461charsremoved perpacket
(4465->4004,4353->3892,4693->4232,4922->4461). Not a billing-token claim.
Buildpass0leasesnormalquitrollbackpatch+bothassets, currentfingerprint
20c06e09d4dab00004a60d569685967e189f808589e300efe82f6c118dc2c1be.
Live sess-desktop-c706efecceecd1c5c351933e source255662: actual4Haiku4.5workers
no fallover, one batch, native read_file4records, CLItrueexit0, localMCP13sections,
Composio Drive1record. Solfirstreview255789verified, reply/objective match.
All4newrecordedworkerprompts no PAST-task tools block orSheets suggestion.
16totalcalls312222prompt126775cache189297uncached-work68.531seconds. Earlier
Haikumatrix14calls315106prompt167031cache152357uncached79.991seconds: latency
lower but calls/uncached-work higher; no overall efficiency-win or causalclaim.
Artifacts worker-resolved-recall-* includecheck/replay/build/patch/assets/live
events/usage/summary/packetinspection. Globalrolesunchanged. Oneproviderlive
requalificationthispatch; earlierLunapass predatesit. Next largerparent-schema
anddiscoverycost, exacttoolchoice/ranking, outputformatfidelity remainopen, plus
broader memory/proactivity/longchat/mobile/ClaudeCodebenchmark requirements.


## Shared discovery planning instruction — hotpatched/live Plan checked
Prior turn progress: worker resolved recall and four-laneHaiku passed. Parent
schema audit confirmed nativeworkflow/Space descriptions carry realcontracts;
no tools hidden or parameter schemas changed. Recent8rowdiscoverypages repeated
planArgumentsHint perrow1558/1936characters. tool-search-tool.ts moves instruction
to one planning_arguments_hint perpage iff anyrow hasplanningref, preserving
refs/effects/schemas/accountbindings/invocationexamples. Updated existing
deferred-provider-page test expectation; isolated suite notrun. Compiledhandler
8row check retainedrefs/schemas anddirectinputguidance,5442->3679bytes(-1763).
Candidate+installedchecks/buildpass0leasesnormalquitrollbackpatch+bothassets.
Currentfingerprint94d8e72ad62f051b20f756bed2a255e786efa4507f85598dba2f1c61fa3f3897.
LivePLAN sess-desktop-f0498b33464e953031a1d130 source255864 actualOpus5+Sol;
8calls182670prompt98392cache88324uncached-work83.234seconds. NoHaikuworker
(the helperfilenameargument haiku is inherited, not proof of executed model).
One8rowsearchpage has sharedhint andzero rowhints. Planpublished255935 ready,
finalreview255934verified, exactstaticarguments {fields:files(id,mimeType),
pageSize:1,q:trashed=false}, noexecutionwrappernested, static_schema_checked
preparedbindingaccountpresent. Providerdispatches onlytool_search twice,
composio_status, publish_plan twice; businessDrive read didNOT execute.
Initialreview rejected for not distinguishing a remembered acceptance-workflow
preference; repairedplan passed. Preserve this additionalreviewcost, and inspect
that preference's applicability/source before treating it as a standingrule.
Plancompute action mentionsrecordingid/mimeType withcount although requested
count; taskprohibitedIDs in planprose, not specificallyinternal computation.
NoExecute validationthisturn; do notclaimfullPlan-to-Executecoverage.
Artifacts shared-planning-hint-* checks/build/patch/assets/liveevents/usage/
summary/plan-check. No broadtoken/speedwinclaim. Broadgoal remainsopen.


## Fresh inferred memory provenance and reviewer scope — hotpatched/live Plan pass
Previous turn progress: sharedplanninghint installed andPlanpassedaftermemory
repair. Readonlyauditfoundfact3813kindproject generatedrecursive_reflection
2026-09-20T10:00:55.326Z trust/confidence0.5 depth1: generalized acceptance
workflows to manual/local-only/no-connected-apps from a100fact batch including
syntheticprojectprefs. This is derived inference, notownerinstruction.
observationProvenanceSuffix previously hid provenance on freshfacts untilage
threshold, so patternlookedbarefact. Now derivationDepth>0 orrecursive_reflection
alwaysrenders inferredpattern+factid+verify-source-scope/notexplicituser-rule.
Explicituserfacts remainunchanged; no storedfactsmodified/deleted.
model-memory-evidence nowdescribes mixedcontext andrequiresapplicabilityto
currenttask/resource/project. Pasttaskrestrictions/inferredpatterns arenot
standingrules; commonkeywords donotproveapplicability. Onlymaterialunverified
assumptions actuallyreliedon needdisclosure, notrecap ofunadoptedmemory.
Candidate+installedread-onlychecksactualfact3813 andretainedsource255864 passed;
buildpass0leasesquitrollbackhotpatchbothassets. Currentfingerprint
3a4b7af7a7816208d78e0d80f9084483b57353ad9d026d9f79b44026654c44c4.
Live samePLANprompt sess-desktop-f3ed0826f9e6e81d8824a24a source256000, actual
Opus5+Sol (noHaiku despitehelperargument). Modelmemoryeventcontainsactual
inferredpattern fact3813label. FIRSTSolreview256053verified. Plan256054ready
exactreadargs fieldsfiles(id,mimeType),pageSize1,qtrashed=false, accountbound.
NoDrivebusinessreadexecuted, no local-onlyinferencerecapinplan.6calls120836
prompt55508cache67654uncached-work46.856s vsprior8calls182670prompt88324uncached
83.234s. Boundedobservations, notcausalbenchmark; benefitisfirst-reviewcompletion
withvisibleinferenceprovenance andcorrectscope. Artifacts inferred-memory-scope-*.
NEXT ROOTCAUSE: reflection.ts RECURSIVE_PROMPT asks patternswithoutsourceids;
runRecursivePatternExtractor sanitizes text+importance only. runRecursiveReflection
sets everypattern derivedFromFactIds=ALLrows andepisodecontent=ALLrows, target
depth=maxdepthofALLrows; groupRolledUp then demotes eligibleatoms fromALLrows.
Need per-pattern >=2validatedsourceids, scoped claims preserving projectbounds,
source-specificdepth/evidence/demotion; no blanket historicalcleanup orlive
destructivetests. Thisgeneration/source-lineagefix notyetimplemented. Broadgoal
(memoryquality/proactivity/longchat/mobile/efficiencycomparison) remainsactive.


## Recursive reflection per-pattern source lineage — hotpatched/live checked
Prior turn progress: freshinferenceprovenance andscope-awarereview passedlive.
reflection.ts nowextracts source_fact_ids perpattern, promptrequires2+actual
supportingfacts andpreservedproject/resource/timebounds, notbatchgeneralization
orstandingrules. Newpure recursive-pattern-sources.ts validatespositiveinteger
IDs,2+distinct,allmembersofinputbatch; invalidcitationsnofallbacktobatch.
Evidenceepisode,derivedFromFactIds,andtargetdepth use onlyselectedsources.
Onlycitedeligibleatoms fromADDED/SUPERSEDEDpatterns aredemoted; failed/NOOP
patterns demotenothing. Invalidcitationgroups incrementgroupsFailed andnoop,
logdiagnostic insteadofsilentlywritingunsupportedpattern. Sourceparser retains
legacytextaliases butmissingcitationscannotpersist. Exportedrealextractorfor
directnonmutatingvalidation. Updatedexistingreflectionfixturetest for2cited
derivedatoms anduncitedpreservation; isolatedsuiteNOT run.2pureselectiontests
passed; buildpassed.
Installedfingerprint38e9a1d3ffb009cb4907da18ef19c7d9a48ad38987d94f87e368994e1c365f7f
normalquit0leasesrollbackpatch+bothassets. Installedruntime/livehome testhelper
seeded5clearlymarkedsyntheticreferencefacts3814..3818; pattern3819 citesONLY
3814/3815, depth1 despiteuncitedhigher-depthfixture. InvalidunknownIDcandidate
wrote0patterns,demoted0,groupsFailed1. Validpatternadded1,demotedonly2cited
atoms. Exactevidenceexcerptscontainonly2sources. SnapshotofALLpre-existing
facts(content,importance,active,depth,lineage)unchanged;3uncitedfixturefacts
unchanged. Noresets/deletions, oldfact3813notrewritten.
Actualinstalledextractor tested onin-memory5factmixedprojectbatch via configured
Solroute: generatedAmberpatternciting90001/90002 andVioletpattern90003/90004,
retainingproject-specifichours/completed vsminutes/pending differences; excluded
unrelatedone-timefact90005. Generatedtestpatternsnotpersisted.
LiveClaude recall sess-desktop-3b39992c47f501831c862f54 source256140: Opus5+Sol
firstreview256271verified. Answerfact3819 inferredcobaltpattern, support3814/
3815, explicitlyexcluded3816..3818quartz, notuserpreference.12calls425717prompt
289839cache138547uncached-work51.591s. Noefficiencywinclaim.11memorytool
dispatches (recall_all,read,read,search_facts,recall,search_facts,search_facts,
read,read,read,read), nohostpredispatchrefusals; inspectexactfact/source reopening
next for avoidableretrievalloops. Validate actual toolresults beforeblamingmodel.
Artifacts recursive-pattern-sources-* fixturestart/ids/live-log/live-summary,
recursive-extractor-live-* output, recursive-pattern-recall-live-* trace/usage.
Broadgoalactive; livegenerationselectedsourcecontractpassedboundedcase, not
universalsemanticproof ofallfutureinferences. Nohistoricalpatterncleanup.

## Exact fact reads expose lineage — installed/live Claude pass

Confirmed shared main at e5a75f5a; other Claude process 47978 remains in this
checkout. Preserved existing edits and usage-sidecar. Previous installed
fingerprint was 38e9a1d3ffb009cb4907da18ef19c7d9a48ad38987d94f87e368994e1c365f7f.
Root cause: memory_read(fact:id) returned only content, omitting recorded
source IDs. Prior successful Claude recall took 11 memory calls to reconstruct
support. Added pure fact-read-provenance.ts formatter and wired memory_read:
root content/status, inferred-pattern label, exact recorded source references,
up to six one-hop source previews capped at 600 characters each. Explicitly
labels truncated/omitted previews and unavailable lineage. No recursive search;
inactive/superseded source content is omitted, successors are not silently
substituted. Stored lineage is not claimed to independently prove support.
Description now explains fact: prefix. Three pure checks passed; full build
passed. No isolated-home suite used as acceptance.

After zero active leases and normal installed-app quit, rollback-preserving
hotpatch and both web asset trees installed. Current fingerprint:
2a9ef67f56122426c279ca47e104b14009f34fc059e4eb5d40dc3b11e42d8dd5.
Actual installed memory_read handler against live home returned fact3819 and
source3814/3815 previews in 832 bytes; all three stored facts unchanged.
Live identical read-only recall prompt: session
sess-desktop-2443da3a52b00b1d36f29335, source256367. Actual models Opus5 and Sol;
no substitute provider and no Haiku worker (helper filename suffix is legacy).
First completion review256404 verified true, delivered text matches reviewed.
Correct inferred cobalt pattern, exact lineage3814/3815, excluded quartz facts.
Two memory dispatches: memory_read and memory_search_facts. Three total model
calls, 87531 prompt tokens, 32768 cache reads, 55212 uncached-work tokens,
17.980 seconds. Prior identical prompt: 11 memory calls,12 model calls,
425717 prompt,289839 cache,138547 uncached-work,51.591 seconds. Bounded live
improvement; one before/after pair with different cache state is not a general
provider benchmark or evidence of superiority to standalone Claude Code.
Artifacts: output/weekend-harness-2026-09-19/fact-read-provenance-* and
check-fact-read-provenance.mjs. No settings changed, external writes, commits,
or destructive resets. Broader framework work remains: scoped useful memory,
long-running recovery, proactive behavior, mobile acceptance, and matched
sidecar efficiency trials across native/MCP/CLI/Composio paths.

## Delegated exact-memory acceptance — actual Claude Haiku pass

Previous turn classified progress: installed exact fact provenance and measured
live Opus recall improvement. This turn rechecked main/e5a75f5a and running
fingerprint 2a9ef67f56122426c279ca47e104b14009f34fc059e4eb5d40dc3b11e42d8dd5
through the acceptance helper before submitting. No additional code/hotpatch.
One explicitly requested Haiku worker tested the installed memory behavior:
parent sess-desktop-95f29059757eb93bacdc4ff7/source256425;
child sess-worker-fdd2d98e5884ffdc55387813c48fcd541d376ddc/source256450.
Executed-route receipt confirms claude-haiku-4-5, executed=true, fallover=false.
Child read fact3819 then3814/3815 (three actual memory_read dispatches), correctly
reported exact source lineage and inference rather than user preference.
Parent did not substitute its own read. First Sol review256482 verified and
matched delivered answer. One worker, no retry; no writes requested/executed.
Total including parent/child/judge:6calls111569prompt32950cache80522uncached-work,
38.043seconds. Haiku3calls20024prompt20434uncached; Opus2calls82957prompt51453
uncached; Sol1call8588prompt8635uncached. This delegated tiny task cost more than
prior direct read(3calls55212uncached17.980s); no delegation efficiency win.
Artifacts delegated-fact-provenance-live-haiku-{start,response,events,usage,summary}.

Next concrete efficiency investigation: parent prompt_composition reports
26651 toolSchema tokens (measured serialized accounting, not provider billing),
35226 total composition, toolCount0 because measured schema accounting was
passed without tool names. Event lane is labeled codex despite actual Opus
usage; do not use this label as provider evidence. Need inspect exact serialized
schema distribution before changing exposure. TOOL_SEARCH_ALWAYS_LOADED in
src/agents/tool-catalog.ts deliberately exposes native product/space/workflow
operations and acquisition tools to prevent search/refusal loops. Preserve
first-class native instruments and same-turn access to MCP/CLI/Composio.
Favor reducing redundant schema representation over hiding tools. Broad goal
remains active; no settings/provider changes, commits or resets this turn.

## Retained parent request schema audit — source of overhead identified

Prior turn classified progress: actual Haiku delegated memory qualification and
cost attribution. Current shared HEAD remains e5a75f5a. Read-only installed
runtime projectModelRequestProvenance reopened BOTH retained parent requests
for sess-desktop-95f29059757eb93bacdc4ff7. Both validated status ok, layered
boundary,25tools,76593 catalog bytes. No private request text was printed or
exported; audit output contains tool names and byte counts only.
Top schema costs: workflow_create19655bytes (13094 description fields incl JSON
encoding), workflow_update18682(11499 descriptions), space_save12693(9109).
Together51030bytes, about66.6% of catalog. run_worker5032bytes. Largest parameters:
create.steps11902bytes, update.steps11586, space_save.data_sources3901,
space_save.actions1848. Same catalog on both requests. Existing loop composition
estimate26651tokens comes from estimateAgentToolPromptComponents over assembled
agent schemas; it is not provider-reported exact schema token billing.

This supports a concrete next change: carefully compact repeated authoring
field prose, preserving all argument names/types/constraints, executor choice,
scoping, binding shapes, and failure/consent semantics. Native authoring tools
must stay first-class; do not drop them from TOOL_SEARCH_ALWAYS_LOADED merely
to shrink the meter. Need inspect full field descriptions, compare semantic
contracts, then hotpatch and live authoring/execute validation with Claude and
small workers. Do not claim this read-only audit itself reduced runtime cost.
Helper audit-parent-schema-cost.mjs; artifact parent-schema-cost-audit.json.
No model calls, provider settings, source modifications or app restart this turn.

## User-requested daytime stopping point
User requested a stable hotpatched Clem to test throughout today. Rechecked
live fingerprint2a9ef67f56122426c279ca47e104b14009f34fc059e4eb5d40dc3b11e42d8dd5,
version3.18.17, Opus5/Luna/Sol roles, zero active leases, responsive desktop.
No pending source patch from the schema audit. Pause autonomous edits/hotpatches
and acceptance runs until user resumes. Full handoff:
docs/checkpoints/2026-09-20-daytime-testing-handoff.md.
Broader goal unfinished; do not mark complete merely because testing is handed off.

## Daytime reported workflow failure — Salesforce Keychain access
User reported a workflow failure after testing handoff. Identified scheduled
friday-dashboard-daily-refresh run trigger-03e2c0191eb9d145c45936783a7485f6,
started2026-09-20T14:00:05.359Z; failure report14:00:17.830Z. Five independent
Salesforce SOQL read steps failed with reviewed CLI nonzero_exit and
NamedOrgNotFoundError for configured Salesforce username. These were five
parallel steps, not five retries. Dashboard update depends on failed reads and
did not execute. No workflow rerun, definition, credential, or app changes.

Saved ~/.sfdx account file exists and has access/refresh token fields (values
not read into output). Standalone sf org list auth returned zero accounts.
Installed Salesforce core AuthInfoConfig.create for same username, without
printing config contents, reproduced deeper SetCredentialError:
security: SecKeychainItemCreateFromContent (<default>): The user name or
passphrase you entered is not correct. Global.DIR and os.homedir resolve to
actual ~/.sfdx and ~, respectively.
This establishes local Salesforce credential/keychain access failure; it does
not establish revoked remote credentials or a wrong HOME from Clem. The CLI
OrgAccessor catches this auth-file initialization error and then AuthInfo
reports missing account. Do not request new Salesforce login solely from the
misleading NamedOrgNotFoundError. Next: user unlock/check login Keychain, then
repeat sanitized read-only CLI auth discovery; dashboard run still needs an
actual successful live run before reporting recovered. Framework diagnostic
should eventually surface credential-access causes more clearly without
exposing secrets or bypassing Keychain. Keep unrelated optimization paused.

## Recurrent authenticated CLI issue — deeper nonmutating diagnostics
User reports recent recurring Keychain errors; not sure whether correlated with
screen lock. Do not dismiss as simply requiring unlock. Direct Security.framework
SecKeychainOpen and SecKeychainGetStatus succeeded, reporting login keychain
unlocked/readable/writable. Metadata-only security find-generic-password for
service sfdx/account local succeeded, proving item exists. Secret read probe
captured/discarded output and reported exit51, no value, immediate failure.
security show-keychain-info also fails with passphrase/authentication error.
All probes from Codex execution context; standalone sf outside Clem is not a
control for an independently launched interactive Terminal security context.
Requested user run sf org list auth in normal Terminal (no secrets displayed)
to distinguish interactive/background access failure. Answer pending.

Installed Salesforce core source: darwin keyChainImpl treats nonzero password
read except exit128 as PasswordNotFoundError. crypto.init responds by trying to
create a new encryption key; that fails SetCredentialError. OrgAccessor.read
swallows most initialization errors; AuthInfo then throws NamedOrgNotFoundError.
Thus present credentials can be reported absent. Avoid more AuthInfo init
probes, as SDK initialization can attempt key creation on access failure.
No reset, credential migration, reauth, ACL changes or keychain setting changes
performed. No new hotpatch. securityd system log read denied Operation not
permitted; no escalation attempted. Existing repair-keychain console endpoint
imports ONLY Clem legacy credentials into its vault, so it is not a Salesforce
or OS Keychain repair and must not be used as one. No repository source matches
for altering default/unlock/lock/delete keychain found in searched app/runtime
sources. Root cause of recent OS credential access change not yet established;
do not claim latest patch caused it or that all authenticated CLIs are broken.

## Interactive Terminal control confirms Salesforce Keychain failure
User supplied normal Terminal output from `sf org list auth`: No results found;
both saved Salesforce accounts reported invalid auth files due to
SecKeychainItemCreateFromContent (<default>) passphrase/authentication failure.
This independently reproduces the symptom outside Clem and Codex-launched
processes. It rules out an exclusively Clem background-launch failure; it does
not establish the original cause of the recent change or prove all CLIs affected.
Prior direct probes established present account files, present sfdx keychain
entry and an unlocked login keychain, but secret retrieval failed. Do not label
this expired Salesforce OAuth, missing credentials or simply screen lock.
Updated AGENTS scope is framework only: no repair/migration of personal Spaces
or integrations. Preserve credentials/keychain settings. Future framework work
should distinguish inaccessible local credential storage from absent/revoked
authentication, preserve actual CLI failure evidence, and validate any shared
change using named controlled fixtures in installed app/live home. No patch
or personal integration changes made in response to this Terminal evidence.

## Failure reporting audit while user restart check pending
Prior turn supplied recovery guidance; no runtime change or recovery proof.
Preserve daytime baseline while awaiting user restart result. Read-only code
trace found actual framework defect: workflow-runner.ts graph scheduler preserves
one typed step error but wraps multiple epoch.failures in a plain Error with
only semicolon-joined messages (around10959). It drops step IDs and structured
failure type. Terminal catch (around16146) recognizes only
DeterministicWorkflowStepError; unstructured failures then enter
rewriteWorkflowReportInVoiceImpl (around16222). Actual retained report for the
Friday run says "all five attempts" whereas activation receipts show five
independent step IDs, not retries. Raw error string contains five copies of the
same cause with no step names. Rewriter also converted "See more help" into
"Next step: See more help", which is not actionable.
Next bounded shared fix: preserve batch failures as typed step-indexed evidence,
render grouped deterministic summaries without model paraphrase, preserve full
causes/individual step details and distinguish retries from sibling failures.
Validate named controlled multi-step failure fixtures in installed app/live home;
do not rerun or alter personal workflow for acceptance. This audit made no
source edit or hotpatch. Underlying OS Keychain issue remains separate.

## Resumed efficiency goal — 50 California PI firms, Composio/MCP Plan live
User explicitly resumed other goal work while Salesforce issue remains separate.
Requested speed/token efficiency, workflow through Composio and Plan-to-Execute
using Composio/local MCP (DataForSEO), example50websiteApify→Sheets. Clarified:
Clem should FIND best-reviewed personal injury firms in California and switch
brain to Opus. Actual live roles alreadyOpus5/Luna/Sol; no settings mutation
needed. Main/e5a75f5a, otherClaudePID47978, runningfingerprint2a9ef67f56122426c279ca47e104b14009f34fc059e4eb5d40dc3b11e42d8dd5.

ACTIVE Plan session sess-desktop-343022f2049f1e718ae9f3ed/source259439,
run desktop:343022f2049f1e718ae9f3ed58c7e3796c3eb9cb. Started through installed
app/live API with plan mode, no paid data calls or external writes authorized
in this discovery turn. Latest observer terminal=false,lastprompt_composition,
17calls1914145prompt371522cache1558070uncached. ActualOpus5+Sol. Do NOT restart
just because observation ends. Helpers start-composio-mcp-fifty-plan.mjs and
observe-composio-mcp-fifty-plan.py haiku (filename argument doesnotselectHaiku).
Artifacts composio-mcp-fifty-plan-haiku-{start,response,events,usage,summary}.

User clarification delivered as real active steer259528: find50firms, rankwith
publicratingsANDcounts/citations, dedupe, firm/city/site/rating/count/source/date/
scrapedtitle-description/status columns, new namedframeworktestSheet. Do not
claimobjectivelybestlawyers. Earlier initialprompt expectedURLlist—steerreplaced.
I incorrectly inferred MCPdocumentation-only from truncatedmcp_list_tools preview;
CORRECTED to user andactiveClemsteer259687: actual dataforseo__api_requestexists.
Earliersteer259628removedunrequestedpaidSEO enrichment requirement. Let actual
capabilities defineplan. Userdidnotrequire a separateSEO enrichmentproduct.

Critical efficiency evidence: DataForSEO GET /v3/business_data/business_listings/
categories viawork_call259616/ toolu_01AUKbPxLhu48PjQBiph82ym. Immediately after,
compositionhistory46812→178039estimatedtokens; total67722→198949. Repeated
subsequentcalls consumedhugecontext beforecompaction. Need audit exact retained
modelprojection/result tofindwhyfullcatalogentersprompt. Existing
brackets.ts spillClip around4834 formats strings withformatRecallableToolText
20kcap; work-call.ts around2038 preservesrealmediaonly, otherwiseJSONstringifies
successfuloutput. isToolMediaContent requiresinlineimage (NOT generictextarrays),
so donotblameitwithoutactualpayloadinspection. Need investigateprovider/host
projection exactbytes and duplication, preservesourcematerialthroughretained
handles/query whileboundmodelpreview, no gates or dataloss.

Clem used docs_search, categories read, tool_output_query injuryfilter,
file_query retaineddocs, Apify store search APIFY_STORE_GET (actualsuccess5items)
and schemahandle reads. Lastobserved stillplanning; no finishedplan, actor scrape,
Sheetwrite, workflowexecution or costwinclaim. Existing reviewer/tool route
verification required. Next: pollSAMEhandle, inspectpublishedplan andunresolved
actor/account/pricelimits. Userwantsactual50firms→Sheets execution; donotstopat
planonly deliverable. Keep controllednamedtest artifacts, no personalSpacefixes.
The Composio CLI skill read forschema-first workflow; acceptance viaClemtools.

## Fifty-site Plan terminal failure and exact oversized model evidence
User asks "What's the fix here". Same planrun reachedterminal, notrunning:
sess-desktop-343022f2049f1e718ae9f3ed/source259439, duration919.81s,31calls,
3397054prompt531542cache2927991uncached-work. ActualOpus5+Sol. Threecompletion
reviews allfalse: missingexactApify/Sheets/state/metrobindings; invalidranking
transform andmissingOpus/resume; finalstillmissingexecutableranking+injection
bindings. Finalrev3 erroneously saysReview/Execute withverificationfailurefooter.
Finalverdict259946 verifiedfalse, dispositionenabled_unavailable, deliveredTextIsJudgedTextfalse.
Do NOT execute rejectedplan. No50site scrape orsheetwrite performed.

Installed projectModelRequestProvenance read-only audit confirmed actualmodel
request, notmerelyestimate: ordinal8 tasklayer679555chars, input.7.output.text
513610chars containscategory_name andNOexact-output-receipt. Ordinal9 repeats
same513610chars input.6.output.text. Earlierord6/7 task173612/199811chars.
Thus actualMCPcategorycatalog leakedfullinto modelhistory repeatedly. Audit
helper audit-fifty-plan-large-result.mjs, outputfifty-plan-large-result-audit.json
contains sizes/paths only. Need identify exact host output.text projection and
bound modelview whilepreserving raw durablequery/evidence; ordinary formatter
20kcapexistsbutdidnotapplyhere. Do not claimimplementationfixedyet.
Nextwork: sharedoutputboundaryfix+controlledlargeMCPread liveacceptance, then
complete deterministicranking andverifiedplanbindings, durablepaidjob/dataset
reuse andsheetkeyedwrites, replanandexecute50firms withactualproviderreceipts.
Userinformedfailedrunand2.93Mcost; fixhasnotbeeninstalled. KeepOpusbrain already
active, smallworkersforreasoningonly, actualMCP+Composio coverage.

## Oversized host MCP output fixed, installed live acceptance PASS
User explicitly resumed optimization. Shared main/e5a75f5a; other Claude PID47978
still same checkout. Preserve all edits/token meter. Installed fingerprint
9574004d47b65eb80d0ee638af016c4719c4d8eeca69a346a4cc55d8c6e227c7.
New host-model-output-preview.ts + host-turn-runner integration bounds ordinary
text/JSON model projection after authoritative result settlement, retaining full
raw data for recall/query. Original output/evidence unchanged; explicit native
read_file preview budget respected. Genuine structured media blocks bypass this
helper; do not claim universal media bounds. Build passed, installed daemon and
both web assets with rollback, zero active leases at quit, reopened live app.
Installed replay proved original 513610 chars retained byte-exact, preview498.
Small outputs and explicit21000char file read unchanged.

Live actual Opus5/Sol session sess-desktop-c98c2e3578f24febe70b61e3 source260310,
first review260366 verifiedtrue, replyMatches/deliveredTextIsJudgedTexttrue.
One DataForSEO categories GET, one retained tool_output_query, correct two injury
categories. 39.23sec,5modelcalls206789prompt77736cached130348uncached-work.
Exact model provenance confirms work_call output serialized541chars (digest),
query272chars; task layer14441 then15312chars, no repeated513k payload.
Artifacts host-output-preview-{build,hotpatch,assets,check},
host-output-preview-live-haiku-{summary,events,usage},
host-output-preview-live-projection.json. Not a matched50firm speed benchmark.

Fresh full50firm PLAN ACTIVE sess-desktop-e03bc26f0ebf19474c088adc,
run desktop:e03bc26f0ebf19474c088adcd1224820646e275e. Helpers
start-optimized-fifty-plan.mjs / observe-optimized-fifty-plan.py haiku.
No model override from filename. Existing rejected plan not executed. Fresh
prompt carries known category/real MCP capability, correct transform grammar,
Opus modelID, batched small-worker intent, exact actor schema/output/resume
requirements. This turn plan-only discovery; full requested new test Sheet
execution still outstanding. Do not restart this handle on observer timeout.
No paid scrape/listing or sheet writes yet. Broader optimization goal active.

## False MCP access refusal found during full Plan; parser correction installed
Fresh50firm plan e03bc26f/source260416 ended blocked201.54sec21calls,
555689uncached-work. It repeatedly listed zero MCP tools despite connected
server. No paid API/scrape/Sheet write. Actual agent_context_packet.toolScope
was authority:none while initial mcp_tool_scope allowed dataforseo. Root cause:
compileMcpAccessConstraint treated "No changes to personal workflows or
integrations" as blanket access denial; context resolver without configured
catalog tightened to none. Steer260651 stopped repeat recovery and requested
honest blockers. Do not execute this incomplete published plan.

mcp-tool-scope.ts now distinguishes preserving connector configuration from
access refusals, and negated prohibitions ("does not forbid reading MCP tools")
from denied access. Explicit no-use and mixed modify-or-query refusals retained.
Three selected pure regression tests passed with live-home imports; no fixture
resets/DB writes in selected tests. Initial unqualified test command refused
live-home binding before tests ran; corrected to selected pure cases only.
First installedfbf079... exposed double-negation gap in new live test;
stopped exact test bdc3ae4a/source260719 promptly via cancellation endpoint.
Second build+hotpatch including both desktopweb/mobileassets now installed
ff01a316ebffabf090361c5e3e644d11eb29c5fe77cd342ef75cf2d730c22d48.
Previous versions retained with rollback; app reopened, idle before both quits.

Same controlled Plan prompt live sess-desktop-69bac399589a5a9b45cffae8/source260783
PASS42.475sec4calls39377uncached-work, actualOpus5/Sol260830,
verifiedtrue, planMatches/replyMatches/deliveredTextIsJudgedTexttrue. Real schema
for dataforseo__api_request discovered, executable one-step GET metadata plan.
Plan plan-91070e49-99e5-4a57-baf7-810ac9598a1a revision1 digest
3c003159a133845a8bc3ad0ef8b03bf3dc9df6966c3fbb242f212e38b5046d85.
Execute now ACTIVE same session, run desktop:798b87b78c083bd096533c05811a34a63269fa1b,
sinceSeq260838. Poll exact run, no restart. Requested retained targeted
verification, no repeat provider reads. Artifacts mcp-config-preservation-*
including v2-live-haiku start/response/events/summary; execute-request/response.

Parser limitation still observed in exact prior hugeprompt: "observations to
avoid rediscovery waste: DataForSEO" can mark namedserver denied when catalog
supplied. Current targeted change does not solve arbitrary negation attachment.
Exact-prompts.json records this; do not claim universal natural language access
parsing fixed. Full50firm workflow/paid data/Sheet remains outstanding. Next
return to full plan with concise task (rather than long diagnostic prompt),
verify ranking/actor/bindings/recovery and execute actual authorized result.

## Controlled Execute terminal — MCP reached, provider changed, strict review FAIL
Execute same sess69bac399/source260845 terminal63.203sec6calls137659uncached-work.
Actualroute initialOpus5 then model.rate_limited at260867 -> Terra, subsequent
preselected-rate-limited. Solreview260919 verifiedfalse. One actual MCP GET
succeeded status20000 and nonempty5318category data; raw stored and targeted
query worked. Plan had demanded cost0 in response, but default noAiMode:false
MCP projection omitted cost entirely. No secondproviderread permitted, so cost
could not be verified; failure is honest, not providerexecutionfailure. Do NOT
count this as Claude Execute or full acceptance. Full50firm still unexecuted.
Live model-status connectedClaude,5h10%/weekly85%/Fable-scoped99%; these snapshots
do not alone explain the transient actual rate_limited. No auth/settings changes.
Next: verify full provider envelope contract/cost via documented noAiMode when
needed, finish executable50firm plan/actor/ranking/bindings, actualrequestedOpus
route, then newtestSheet. Current scope/output fixes installed; no active test
remaining. Avoid duplicating paid work and don't rerun rejected plan.

## Continued full50 plan exposed missing Plan HTTP reads; native read tool installed
Previous goal turn was progress. Shared main/e5a75f5a, ClaudePID47978 alive.
Full50 plan v3 sess-desktop-fe9d3810d910137e8f847e4c/source260942 terminal534.173sec,
32modelcalls1274613uncached-work. ActualTerra/Sol initially; Opus resumed later.
Old rate-limit had600000ms cooldown, not proof wholeClaudeaccount exhausted.
MCP discovery now worked. Still no valid executable nativegraph/actorbindings.
Browser script Plan refusal, then every publicfetchalias not_reachable because
aliases depend on absent run_shell_command. Exact searches offered unrelated
Composio tools. Steers261189 and261326 supplied known dataset slug/readpath;
last stopsteer409RUN_NOT_ACTIVE, so no duplicate request. Final checkpoint
reopenfailure, no external-write attempt settled. Do not execute rejectedplan.
Artifacts fifty-plan-v3-haiku-{start,response,events,usage,summary}.

Added bounded-http-read.ts and http-read-tools.ts, local-runtime registration,
registry native http_read (read/discoverable/inner-dispatch), call_tool description.
Public HTTP(S) GET only, no suppliedheaders/cookies/auth/body;20sec,5redirects,
1MiB; response status/finalURL/contentType/bytes/sha256/body. Oversized bodies
fail explicitly rather than pretendcomplete. Existing http_fetch/web_fetch etc
shell aliases unchanged (initial same-name idea reverted before finalbuild).
3pure tests pass: exactUTF8digest/redirects, credential/protocolrefusal,404/loop/
oversize cancellation. No destructivefixture reset. Builds pass; installed
initial HTTPpatch a932ffe844d23714eca8bd3fe5cfedc37f18c9d80bcd2247922aaef9154df9f9.

Live Plan actualOpus5/Sol sess-desktop-57c2307d86c9313b06c2661a/source261522:
TWO actual http_read calls succeeded200 in Plan, no shell/browser/paidcalls.
DataForSEO pricing body498752bytes, Apifydefaultbuild body193325bytes.
After two irrelevant/overbroadplan reviews and steer261657 keepingpublicscope,
final261680 verifiedtrue, planMatches/replyMatches/deliveredTextIsJudgedTexttrue.
270.723sec17calls758806uncached-work. Too expensive, notefficiencywin.
Cancelattempt racedterminal409STALE_RUN_ATTEMPT; zeroactiveleases afterward.
Artifacts native-http-read-live-haiku-* andnative-http-read-live-projection.json.
Exactprovenance showsmodel HTTPpreviews20644/23410serializedchars, notfullraw.
Findingsfromactualbytes: DataForSEO$0.012/task+$0.00036/returneditem,1000itemmax.
Apifybuild u8gClHFAIyDHCQq0J, actor aYG0l9s7dbB7j3gbS, realinputschema includes
startUrls,maxCrawlDepth(default20),maxCrawlPages(default9999999),saveMarkdowntrue,
crawlerTypeenumcheerio/playwright variants, summarize paidfeature keepfalse.
Pin depth0/pages50, respectRobotsTxtFiletrue forfuturetest. Buildcomputeunits
are NOT runtimecrawlprice. Apifyactor metadata/runtimepricing stillneeded.
Full50 discovery docs alreadyread in v3, keepretainedschema toavoidredo.
Do not execute newmetadata memo plan as substitute for requested50firmworkflow.

## Trajectory review bulk-output inflation fixed and installed replay PASS
Live HTTPtest trajectoryreview261570 expanded754832chars sourceevidence;
Solcall333199prompttokens. Parentpreviewalreadybounded. Rootcause
host-completion-work.ts sourceSettledReadEvidence forced fullnewrawpayload
whenever afterSettlementIndex supplied (incremental trajectory). Now uses
existing answererView for bulk source results; targeted retained projections
remainwhole, prior/duplicate references unchanged, finalcompletion behavior
unchanged. Updated incremental contracttest expectedboundedbody+exacthandles.
Did NOT run destructive host-completion-contract fixture suite onlivehome.
Built then replayed candidate and installedfunction againstactual live receipts:
HTTPraw522957→19994shownbytes and222220→19998shownbytes; contentCompletefalse,
exactsourcehandles/digests preserved; ordinarycompletionviewidentical. Total
advisorysummary121606chars afteralllatecalls (earlier snapshot97639); this is
ledgerreplay, NOT freshmodeltokenmeasurement afterpatch.
Helpercheck-trajectory-bounded-preview.mjs, artifacttrajectory-bounded-preview-check.
Latestinstalled50340793afdd6f795921e856ddf56a5ade6ddf2c414bfc0b17b7ba10393c688c,
daemon+bothwebassetswithrollback; idlequit/reopenverified. Build passed.
Noactive tests. Goalactive: finishfull50 executableworkflow/actualnewSheet,
measureactuallatency/tokens, smallworkers asneeded. No paid data/scrape/Sheet
writes yet. Remaining unrelated-memory contamination and excessive plan repair
are observed issues; don't call broadgoalcomplete or claim allplanpathsqualified.

## Toolkit inference precision hotpatch and saved-workflow recovery — Sep20 16:56UTC
Shared main/e5a75f5a; ClaudePID47978 cwd still this checkout. Preserved other
edits/token meter. Latest installed daemon fingerprint
c9798f2424628e5f133450a19417cff6f1422b80dfd887cd41ef27d6583ab211.
Daemon and both webasset trees installed with rollback; app reopened visibly,
API confirms actual configured Opus5 brain/Luna worker/Sol judge.

Live author sess-desktop-7d535a1e79f0de16264dff7c/source261744 terminal667.014s,
actualOpus5/Sol,23calls2123306prompt1380992cached805529uncached-work.
FAILED final review (262047): discovery is retained but not consulted before
paid primary on rerun. Saved disabled manual fixture
harness-ca-pi-firms-20260920,11steps,required run_key/no default,no test_inputs,
max_attempts1. Candidatebudget repaired across allrequests <=1000/12tasks;
smallworkers gpt-5.6-luna; native retentiontransform/write; Sheetreconciliation.
No paid discovery/actor/Sheet write yet. Do NOT execute unrepairedgraph.
Artifactf938a85e3d7b2274a0137249c353096d8d59bbca1457f32b0d9c2537149c8a3f.
Other prerequisites: GOOGLESHEETS_SEARCH_SPREADSHEETS schema was guessed from
memory (not verified); primary California address_info.region wrongsemantic
(DMA notstate) would waste a call. NativeMCP unknowncatalog warning despite
actualsuccessful read earlier; don't convert to Composio DataForSEO.

Framework fix: orchestration-tools binder treated any global noun crawl/actor
plus providermention as toolintent. Injected DataForSEO Composio instruction
into pure build_rows and Apify into report_coverage. New pure
workflow-toolkit-intent.ts requestsToolkitUse requires explicit use/using/
prefer/call/invoke/run near provider; existing exactoperation/prohibition/
target/citation guards retained. Removed globaltoolnoun and barevia/with
inference. Two puretestspass, buildpass, candidate+installed binder replay
passes negative report/source-label/exactlocal cases and positiveApifycase.
No isolatedfixture suite or livereset. Artifactcheck-toolkit-intent.mjs,
toolkit-intent-{build,hotpatch,assets,live-build}. Installedreplay is NOT fresh
LLM authoring acceptance; fresh run below exercisesnative update next.

CURRENT IN-FLIGHT focusedrepair ONLY, noexternalexecution:
sess-desktop-b27dd22f387946df066bfd5d/source262074,
run desktop:b27dd22f387946df066bfd5def7c3c419626d405.
Helper start-fifty-workflow-repair.mjs already called ONCE;
observe-fifty-workflow-repair.py haiku polls samehandle; suffix notmodelchoice.
Response/cancelendpoint in fifty-workflow-repair-haiku-response.json.
Prompt requests retaineddiscovery reuse beforepaidcalls, percall checkpoint/
pendingintent for ambiguity, removeinvalidDMAfilter/startmetro directly,
verifyactualSheetsearchschema, removetemporaryignore-binder directives from
puresteps, keepdisabled/noinputs/noexecution. Last2calls actualOpus.
Continue this handle; don't startduplicateauthor or any paid execution.
Once graph passes actualreview, Plan then Execute exactapprovedartifact with
stable run_key, verifyactual50rows and receipts, recordfulltokens/timing.

NEW FRAMEWORK BUG TO FIX: workflow_update invalidtransform threw before any
write; SDKwrappederror tool_returned261929 okfalse, but logicalsettlement261928
kind succeeded. settledSourceArtifacts therefore owes missingfile receipt
for workflow_update#toolu_01GvHixvMvMNqF9uageHgc6d permanently, even aftervalid
same-source update. Do not relaxreceiptverification. Fix producer negative
outcomes BEFORE write: workflow_update normalizeWorkflowSteps is uncaught,
and its prewrite validation paths use textResult instead of nonWriteTextResult.
workflow_create normalization also uncaught. Existing negativeproducer tests
cover create invalidinputs but not this exception. Inspect narrowproducerpath,
no destructivefixtures live. Current latest patch does NOT fix this yet.
Goal remains active: broader efficiency/Plan/Execute/full50 live validation
unfinished. Authoring costs not efficiencywin; no benchmarkclaim.

## Negative workflow edits and nested optional fields installed — Sep20 17:08UTC
Previous goalturn progress, this turn progress. Sharedmain/e5a75f5a,otherClaude
PID47978stillalive. Latestinstalled daemon fingerprint
81598573598255514fdd6f5a072c3e8c96a579a24cbcedf744c4d745ad00a9b3.
Idlehotpatch daemon+bothwebassetswithrollback, appHome reopened, Opusselector
visible. APIbuild/roles asserted before currentPlan below. No personalsystems
changed; preservetokenmeter and otheragent edits.

Producerfix orchestration-tools.ts: pure normalizeWorkflowSteps errors now
nonWriteTextResult invalid_workflow in create/update BEFOREwrites. Update's
prewrite invalidinputs/resources/testinputs/graph/trigger/identity/notfound/
invalidworkflow returns now typednonwrite. No generic postwritecatch or
receiptverificationweakening. Addedupdate malformedtransform+validrepair case
inworkflow-create-negative-producer.test.ts; didNOTrun isolatedfixture suite.
Actualnativeadapter/dispatch/settlement/completioninventory check onnamed
disabledlivefixture passed candidate AND installed, noexternalcalls: malformed
update invalid_arguments, filebytesunchanged, repaired description yieldsone
currentartifact digestMatchestrue; no phantomreceipt. Installedfixture
harness-negative-update-1789924059166,source262393; candidatefixture
harness-negative-update-1789923590794/source262208. Helpers
check-negative-update-live.mjs, negative-update-live-check-*.json.

Live authorrepair exposednestednullable schemafailure262231 (properly
invalid_arguments262230, NOTphantomwrite). recoverOmittedNullableFields now
fills absentnullableleaf fields inexistingnestedobjects/records/arrays via
schemaissuepaths and fullstrictrevalidation, no missingparent fabrication,
no requiredvalueguess, no overwrite. Ordinarywrites eligible only fornominal
SDK inputvalidation beforehandlerstarts; readsretainexistingbehavior; sends/
adminunchanged. Prototype-safe ownproperty definition. Extended
local-runtime-tools.test.ts purecase, notisolatedsuiterun. Candidate+installed
check-nested-nullable.mjs confirmsnested3+top1nulls recovered, handler invoked
once fornominalvalidation, forgedordinaryerror doesn'treinvoke, wrongtypes/
requiredfieldsrejected, inputunchanged. Buildpassed. Artifacts
negative-update-{build,hotpatch,assets},nested-nullable-candidate-check.

Authorrepair sess-desktop-b27dd22f387946df066bfd5d/source262074 TERMINAL:
617.489sec22calls1609311prompt1137143cached528160uncached-work actualOpus5/Sol.
Final262381verifiedtrue allartifact/replymatchestrue. Workflow now12steps,
10Luna models, disabled/manual, requiredrun_key/no default, maxattempt1.
Receipt956825ead74a74463e45dd8682c51a02bf1fca1f11e93ad916f943c9c989344a.
Checks retainedcompleted beforepaiddiscovery; unresolvedpaidintent independently
forcesambiguity evenifretaineddataexists; percallintent/responsecheckpoint;
completion_status carriedintoretainedJSON(notliteralcompleted), ambiguities
stopApifylaunch; metros_used retained; firstmetroLA,noinvalidDMAfilter.
Sheetsearchactualschema verified query/search_type=name(prefix)/max_results/
include_trashed, exactmatchingreturnedtitle; previousSQLqueryguessremoved.
Remaininglimits: modelassertedstatusandnonatomicfile/providereffects; localMCP
catalogwarn despiteconnectedactualread, actualexternalrunstillneeded. Saved
emptyallowedTools arrays normalizeaway infrontmatter (doNOTclaimtoolisolation
proven merelyfromauthorreply); no spuriousbinderinstructions remainsobserved.
No paid discovery/scrape/Sheetwrites yet. Authoring istooexpensive,notwin.

CURRENT ACTIVE PLAN, doNOTrestart:
sess-desktop-13ade015e1c48c79aa636a94,
run desktop:13ade015e1c48c79aa636a94422ce7ae21b841d5.
start-fifty-saved-plan.mjs calledONCE; observer observe-fifty-saved-plan.py haiku.
Handle/cancelendpoint fifty-saved-plan-haiku-response.json. Fixedrun_key
framework-ca-pi-20260920-a. Promptplansactualsavedworkflow_run ONCE +monitor
sameworkflowrun+verifycoverage/Sheetresults/models/time/tokens. No paidwork in
Plan. Don'tregenerategraph, don'tduplicateverification/enableforschedule.
Use successful exactplanArtifactRef toExecute whenready, userauthorizedthis
namedcontrolledtestalready; no needarbitrarypermission. Pollsamehandle until
terminal; verifyactualOpus/Sol andartifactmatch. Goalstillactive/full50notdone.

## User correction: Claude is NOT account-exhausted; test Claude too
User explicitly corrected account-exhausted claim. Latestmodel-status cached
Claude snapshot capturedAt1789924089431: connectedtrue, fiveHour12%USED,
weekly86%USED, separate scopedWeekly Fable99%USED. DoNOTinterpret scopedwindow
or a429/cooldown as wholeaccount exhaustion. Actualcompletedrepair262074used
Opus5/Sol; currentPlan262413actualOpus5/Sol. SmallClaude-worker tests remain
required alongside Luna and actualOpusbrain; fallbackdoesnotqualifyClaude.
UseClem-ownedOAuth,notstandaloneCLIstatus. Evidenceclaude-capacity-correction.json.

Plan262413 uncovered NEXT FRAMEWORK GAP: exactworkflow_run tool_search returns
siblings (first262490 workflow_run_status/create/schedule/state/delete), not
workflow_run despite registrydeclaredlocalPlanning purpose dispatch_named_workflow.
Multipleequivalentqueries consumedcalls; steer262620 delivered tostoprepeat
catalogqueries andreportexactmissingplanningcapability, noalternateproduct or
paidexecution. Currenthandle remainsactive; observerlast18callsactualOpus/Sol,
noexecutableplanpublished. Keep samehandleuntilterminal. Don'trestart justfor
observationtimeout. Need fix nativeworkflow lifecycleplanning availability.
Inspect orchestrator.ts actionScopedDiscoveryTools/policyAllowed,
localPlanningCapabilityNames,workCallLocalSchemaNames andvisibleFirstClassNames
~1947,3507. captureLocalTools includes registerOrchestrationTools,sohandlerexists.
Registryworkflow_run haslocalPlanning andsdkbrain/orchestrator lanes but no
innerdispatch lane. NATIVE_PRODUCT_AUTHORING_TOOLS excludesrun. Determine exact
filter, don'tblindlyaddtoallowlist. Also existingnamed-workflow-host-dispatch
rejectsdisabledworkflow explicitly(test288); reconcilemanualtest execution
semantics withoutduplicatingpaidcreationverification or enabling schedules.
Allactualpaidworkstillzero; priorPlanprompt's keepdisabled mayneedclarifyas
keepunscheduled/manual; don'tletourtestinstructionimposeunneededproductgate.

## September 20: Claude capacity correction and native Plan routing candidate
Plan262413 ended FAILED:220.538sec20calls596605uncached-work, actualOpus5/Sol.
No external paid execution. Original 260867 fallback is Clem classification,
NOT verified account exhaustion; original provider error body unavailable.
Cached connectedClaude:12%five-hour USED,86%weekly USED, separateFable99%USED.
Source logs now retain redacted provider detail/status/class and call cooldown
local unavailability; transport429 labels scope unconfirmed. Behavior unchanged.
ExplicitPlan/Execute workflow_run now enters native planning discovery; normal
Act keeps first-class dispatch. Candidate build passes. Namedlivebroker fixture
262870 issues cap:local:workflow_run:reversible; assembly has no direct run.
Helper invokes genuine scoped broker + real planning authority separately from
SDK wrapper. Earlier helper shadow graph incorrectly froze fresh catalog;
its missing-ref result was fixture error, not another proven framework defect.
Actual installed Opus acceptance still needed. No isolated reset suites run.
Added explicitPlan assembly regression to tool-search-surface.test.ts (unrun).
Other Claude PID47978 remains shared main; preserve sidecar and unrelated edits.

## Installed native Plan routing and actual Claude worker acceptance
Installed fingerprint41b12893a999d8a8a700f557d6a4423d48f00199f43f61d81bc48069ce91eb5d
v3.18.17/schema81; daemon+bothwebtrees with rollback. Live helper262890 passes
exactworkflow_run ref and no directPlan dispatch. Build passed. Source changes:
orchestrator explicitPlan/Execute routing, fallback redacted detail/cooldown
wording, Claude transport diagnostic scope wording. No quota retry change.
Actual Opus Plan sess-desktop-10d23c1677692fe54f01a50d/source262907 TERMINAL:
exactlookup FIRSTsearch succeeds262935 cap:local:workflow_run:reversible;
workflow_set_enabled ref also discovered. Plan published but NOT fullpass:
asks permission to enable disabled fixture, final263049 fulfillsfalse,
planMatchestrue. 70.008sec6calls143477prompt52098cached96125uncachedwork.
Prompt differed from priorPlan, no controlledspeed/token improvement claim.
No paid work/activation/execution. Enable-time verification currently runs read
steps; must resolve one-manual-run lifecycle without duplicating paid discovery.
Our newPlan prompt included prerequisite but no explicitenable authorization;
do not treat its new permission question alone as proof of another framework bug.

Claude Haiku matrix sess-desktop-2031100d1731881a40b798bb/source262966 TERMINAL
PASS final263122: fulfills/verified/replyMatches/artifactsMatchtrue, realSoljudge.
Four actual Haiku4.5 workers, nofallover: native read_file4JSONrecords;
run_shell_command /usr/bin/true exit0; localdataforseo__docs_list_sections13;
Composio googledrive_find_file metadata1record. No writes/sends/configchange.
89.697sec16calls319206prompt132401cached191566uncachedwork. Opusbrainactual.
CLItrue provesdispatch notKeychainauthentication/Salesforce. Originalcapacity
cause remainsunknown; there is no evidence of exhaustedentireClaudeaccount.
CurrentappUI13%fivehour USED/86%weekly USED/separateFable99%USED.
Artifacts workflow-run-plan-{build,hotpatch,assets,installed-check},
fifty-saved-plan-patched-{start,response,events,usage,summary},
small-worker-matrix-capacity-haiku-{start,response,events,usage,summary}.

Next efficiency target measured: matrix firstprompt composition estimates
26488tokens toolSchemas, 35328total; actualOpus turns higher (4calls242929prompt,
130609cached,115708uncachedwork before finalreview). Haiku8calls51921prompt,
52751uncachedwork. Avoid merelyadding more prompts. Inspect schema surface
bulk and static cache stability, then rerun SAME matrix forcontrolledcomparison.
Full50firmworkflow stillnotexecuted, no paidrequests/Sheetwrites yet. Goalactive.
Otheragent PID47978 insharedmain; preserve allunrelated edits/sidecar.

## Schema description trim installed; live pair is NOT efficiency win
Previous goal turn progress: patchednativePlanrouting, provedactualOpus/Haiku.
Current turn source changed only descriptions in orchestration-tools.ts and
workflow-output-schema.ts: concise call/input/output/effect/trigger/goal text.
No tools removed, no nativefirstclass deferral, no fields/types/requiredness/
constraints changed. CandidatebuildPASS. Installed8a937c615e43458767c40a04675c5574db6bf6b7347ad06d4c3b472edc1bb256
v3.18.17/schema81, daemon+bothwebassets, rollback retained. InstalledHomeopened.
All26toolstructures deep-equal baseline/candidate/installed after removing only
stringdescription annotations, retaining nameddescriptionproperties. Surface
88569→85089chars (3480/3.93%less). Tools stilldirect. Installednegativeupdate
livefixture alsoPASS: malformedtransformchangesnothing, validupdateverified.
Artifacts schema-{surface,structure}-{baseline,candidate,installed},
schema-compact-{build,hotpatch,assets,independent-verification,native-acceptance}.

SAMEprompt/SAMEroles actual live matrix source263221,
sess-desktop-84751a16aae24af4820e1589 TERMINAL PASS final263394. All4Haiku4.5
workersactualno fallback: native4records, CLItrueexit0, localDataForSEO13sections,
ComposioDrive1metadatarecord. Solactualreviewverifiedfinal. BUT 118.849sec23calls
527676prompt270417cached263637uncachedwork vs baseline89.697sec16calls191566work
(37.6%MOREuncached). NOTefficiencywin, doNOTclaim4%bytesmeans4%runimprovement.
Singlepair notcausalproof regression: extraComposioworkersearch andtwofinalreply
rewrites afterreviews263387/263389-ish solelyfor extra batch/discoverycommentary.
Finalresultaccepted thirdreview. No secondworkerbatch/no externalwrites.
Workerpacket263304 carried parent-pinned GOOGLEDRIVE_FIND_FILE but legacy
name=composio_execute_tool + requirementcap:resolved:googledrive_find_file...;
worker did composio_search_tools thenactualgoogledrive_find_file. Inspect exact
handoff/discovery reuse before changingaccess. No privateintegrationrepair.

NEXT largecost target: response-only corrections currentlyrestartmainOpuswith
fullcontext/tool surface. Need typed reviewer repair scope and bounded small
worker reply revision using settled evidence; retainindependentfinalreview and
exactartifact/claimchecks, neverfailed-open. DoNOTregexreasonstofakepass.
Also stillfinish50firmmanualworkflow: disabledgate+enableverification wouldrun
paidreads beforeactualrun; reconcileone-manual-run semantics withoutduplicated
paidrequests/scheduledauthority. Full50notrun; no Sheetwrites/paiddiscovery yet.
No active matrix remains; don'trestart its handle. AllworksharedmainPID47978;
preserveotheragentedits/sidecar. Goalactive, notcomplete/notblocked.

## Formatting-only repair routed to small worker — installed/live PASS
Current installed df2c87ee2d6d9c69c17611273a751da366040c174a6622fdd588c1afa79f554d
v3.18.17/schema81, daemon+bothassets rollback retained. BuildPASS.
objective-judge adds typed REVISE_REPLY / repairScope reply_format (notdone).
Only allwork/claimsverified +format/extrawording qualifies; no factual/data/
action/Plan/awaiting/blocked/failedOpen shortcut. response-format-repair.ts
packet has objective/draft/reason <=24kchars, no truncation. hostturn routes
one nextstep to configuredworker (Luna), zero tool schemas, throws before
execution if worker returns toolcalls, no tools/work replay. Newowner/recovery/
watcher guidance or changedobjective keepsnormalpath. Interruptedoptimization
keeps normal durablecompletionfeedback. Revisedtext goes through sameframe,
effect/artifactchecks and actualindependentreview. No failed-open success.
PurepackettestPASS; initialparser testimport hit configtesthomeguard before
running, nooverride/reset used; removedconfigimportfrompuretest. Parser checked
in nondestructive actualmodelhelper. No isolatedhomeacceptance.

Focusedcandidate realSol→Luna→Sol formatcheck263466PASS (Luna132uncachedwork).
Installed realSol→Haiku→Sol check263473PASS: actualserved
claude-haiku-4-5-20251001 750prompt/1303uncachedwork, no tools. Reports
response-format-live-263466/263473.json and installed-haiku-check.txt.

Full SAME4lane matrix sess-desktop-1e5c28584ecfa213b73c8731/source263480 TERMINAL
PASS263634: Opusbrain, fourHaikuworkers actual/nofallback, allnative/CLI/MCP/
Composio reads success. ActualREVISE_REPLY263628→hostrouting263630→Luna
665input784uncachedwork with2526charpacket→Solaccepted. 98.422sec17calls
358887prompt149358cached214680uncachedwork. Priorcompactrun118.849sec23calls
263637work; originalprecompact89.697sec191566work. Singlepairs withdifferent
cache/search/repairdecisions, no broadbenchmarkwinclaim. Smallrepair itself
provenactualhost. Artifacts small-worker-matrix-repair-haiku-*,
response-format-{build,hotpatch,assets,tests,live-comparison}. Allmatrixterminal.

### 50firm enablement succeeded; correct earlier stale assumption
Actualsaveddiscover_primary/supplement nodes areWRITE because theycheckpoint.
Creationverification PREVIEWS these andallmutationdescendants (workflow-runner
runCreationTest previewTainted). NO paidreadsneedduplicate; don'taddmanualdraft
bypass feature basedonpriorincorrectassumption. Nativeenable authorizedapp
sess-desktop-e2bad912fe935c09b2aa06a9/source263643 queued creationtest
1789926455195-1c8703 once. Parent stoppedpending withnotdone review, but actual
childfinished2026-09-20T17:48:34.002Z succeeded/enabledfixture. ONLYcheck_retained
ran; all paid/write nodespreviewed, descendantsunverifiable (correctlynotproof
fullworkflow). NewfileSHA f6e20eab402d4031e08bb5acacb7c72af6c90beabfec1041059f5ad71a850bbf
isENABLEDmanual-only; descriptionstillhistoricaldisabledword, don'tmistakeitfor
actualflag. No paiddiscovery/Apify/Sheetwrites yet. Artifacts fifty-enable-*.

CURRENT ACTIVE readyPlan: sess-desktop-309dabb8401f267cb22a81ed,
run desktop:309dabb8401f267cb22a81edabf513c91a90e65e. start-fifty-ready-plan.mjs
calledONCE, responsefifty-saved-plan-ready-response.json. Observe using
observe-fifty-saved-plan.py ready. Plans nativeworkflow_run ONCE with run_key
framework-ca-pi-20260920-a; fulltestauthorized. Waitsamehandleuntilterminal,
then Execute exact successfulplanArtifactRef; don'trestartdueobservationtimeout.
No newactivation/schedule/verification. Afterdispatchmonitorsameworkflowrun,
verifySheetcoverage/models/time/tokens. OtherClaudePID47978main preserved.
Goalactive, full50notdone.

## First real Execute refused before queue; local-folder framework fix installed
ReadyPlan source263750 TERMINALPASS133.918sec9calls119588uncachedwork,
actualOpus/Sol. Artifact plan-7f2889f0-918a-46d3-aa27-97a4877e6d3d rev1 digest
5466e814be733edf2a08be653f7883cd6b17256eb68c9082888a6c397e7a687c,
fullartifactfifty-ready-plan-artifact.json. One input-object→JSONstring
preparationrepair, oneSolreviewrepair forstageoutputs/pre-dispatchrefresh.
ActualExecute263862 same session309dabb8401f267cb22a81ed TERMINALFAILED63.301sec
8calls153897work. Nativeworkflow_get/preflight passed, workflow_run263910
REFUSED beforequeue: resource state_dir kindfolder resourceIdabsolute was
misclassified as needingconnector. No actualpaidrun/Apify/Sheetwrites occurred.
Nativeworkflow_run refusal incorrectlysettled assuccessfulnone-artifact too.
Parentthenunnecessarilydidbroadworkflow_run_status, saw130oldneedsattention;
doNOTrepairthosepersonal/businessfixtures. Final263944notdone; no rerunning
oldExecute because plan_execution_claims keeps exactrevision idempotent.

Fixed workflow-resource-binding.ts: absolute resourceId forfolder withNOexplicit
remote/tool/CLI/MCP/url owner is native local_path. No existence/accessclaims;
actualtool stillownsfilesystempermission. Explicitcloudsurfacewins; relative
paths/cloudIDs/otherkinds don'tinferlocal. Reportsrecommendlocalpath directly,
notcloudcandidatehunt. orchestration-tools workflow_run certificationfailure
nowtypednonWriteTextResult, so refusals don't looklikesuccessfulworkflowactions.
BuildPASS; candidate+installed check-local-folder-binding.mjs proveslive50fixture
canRuntrue/resourceGaps[], relative/cloudnegative cases, cloudfixture
certificationfailuretypednonwrite andNOqueuedrun; namedfixturesdisabledafterward.
No isolation/reset. Artifacts local-folder-binding-{build,candidate-check,
hotpatch,assets,installed-check}. Installed fingerprint
83bfad025021fedcceb25f46bd38ad85575784c6faa3a9acc5b7fd8462d297cd
v3.18.17/schema81, bothwebassets/rollback. Saved50fixture unchanged/ENABLEDmanual,
SHAf6e20eab402d4031e08bb5acacb7c72af6c90beabfec1041059f5ad71a850bbf.
Readinessquestions areadvisory, notcanRunblockers; missingtestinputs aren't
missing actualruninputs. Do notrepairfixtureforunneededadvisories.

CURRENT ACTIVE reboundPlan in SAMEsession sess-desktop-309dabb8401f267cb22a81ed,
run desktop:e625cc0e4873916d93311f6782148810dd578092; sinceSeq263954.
start-fifty-rebound-plan.mjs calledONCE; handlefifty-saved-plan-rebound-response.json.
Observer observe-fifty-saved-plan.py rebound nowfilters events>response.sinceSeq
soitdoesNOTmistakepriorPlanorExecutecompletion forcurrentturn. Reusespriorplan
steps/reporting, refreshesrefs/publishesfreshrevision sinceoldrevisionclaimed.
Waitsamehandleuntilterminal; inspectnewartifact then Execute NEWexactref once.
No paidrunyet; fixedrun_keyframework-ca-pi-20260920-a remainsunusedexceptlocal
verification. Goalactive/progress, notblocked/complete. SharedmainClaude47978.


## 50-firm real run blocked; exact MCP discovery patched but dispatch still fails
User clarified a saved workflow must be optional. Validate ordinary conversational
Plan/Act execution separately; do not force research into workflow authoring.
Shared main/Claude PID47978 confirmed. Previous real run1789927152973-b4a63b
started17:59:43Z, TERMINALblocked18:02:25Z. discover_primary source264202
wrote local paid-intent JSONL (primary-la), then all three DataForSEO attempts
were refused BEFORE provider I/O: catalog_entry_or_manifest_missing:candidates=0:
proven=none. No DataForSEO business request/Apify/Sheet write occurred. Preserve
intent file and explicit refusal receipts; do not blindly replay or delete intent.
Evidence fifty-real-run-refusals.json. Current Execute parent264061 endedblocked.
Rebound Plan succeeded (plan-66540cc5-27e7-4ffd-8cb8-52ef5e48df71 rev1,
digest5982d5c6511b4d68fc7b5b2065cd69ebb264c1bfb977501aba62058b42455539).

Fixed src/agents/workflow-step-agent.ts: recognize canonical MCP names for
preserving discovery carriers even with a cold catalog; exact external block
preserves already-scoped tool_search instead of resetting to lockedTools. Added
search-first schema guidance. Updated exact-lock test expectation. BuildPASS;
non-destructive candidate+installed component helper check-mcp-lock-discovery.mjs
passes tool presence, unrelated-tool exclusion, zero raw SDK servers. No isolated
suite run. Installed daemon and both web trees with rollback; fingerprint
6afaaefe6d2f07406bdafe271d708718275fbe8dd2d80dfb68d21a5ee958f17a.

Actual live regression run1789927622234-d81444 TERMINALblocked18:08:09Z:
exact-lock free DataForSEO categories GET in Luna and Claude Haiku steps.
Both now discover current schema successfully at264379/264386; tool_search
misleadingly says dispatch_now, but exact dispatch still refuses missingcatalog.
No GET reached provider. Luna8calls43275uncachedwork; Haiku5calls45614work.
Fixture disabled after terminal via API. Artifacts mcp-lock-discovery-*,
mcp-lock-live-{start,response,result,disabled}.json. No new active test.
This is PARTIAL discovery fix, NOT successful MCP execution nor efficiency win.
Next investigate native MCP non-read/generic API materialization in workflow
accepted-source scope: stageDisclosedPlanningProviderCandidates only handles
Composio; prepareExternalMcpCandidates only issues live-read authority; generic
api_request candidate remains metadata with no planningAuthority. Foreground
native disclosure has a path that already passed categories GET (source260310).
Reuse correct authority handoff, do not bypass manifest/schema/account checks.
Original goal remains active and incomplete. Current failure is framework
pre-dispatch, NOT Claude subscription exhaustion. UI Claude14%5hUSED/86%weeklyUSED;
separate Fable99%USED does not prove all-Claude exhaustion. Retain full framework,
conversational50-firm, workflow, memory, UI/mobile, speed/token benchmark scope.


## Exact MCP materialization hotpatched; real provider calls pass, content check fails
Installed fingerprint5bf6903b045ddb939b445a5117242ceaaf25d333cf5a3a19ff527450b6f49f5e,
daemon+bothassets withrollback. tools/tool-search-provider-sources.ts nowuses
existing createProductionMcpReadCarrier.materializeExact forcall_tool candidates
thatcannotacquire read-onlyauthority, with exactMCPscope andlive schema. Generic
API retainsdeclaredexternal_write effect; no guessedreadgrant/approvalbypass.
BuildPASS; candidate+installed helpercheck-mcp-call-materialization.mjs proves
exactlivecurrententry/effectexternal_write/no businesscall. Artifacts
mcp-call-materialization-{build,candidate,hotpatch,assets,installed}.

Actual live workflow1789927944521-773adf finished18:13:19Z, statuscompleted BUT
terminalOutcomeblocked. Both Luna and Haiku executed ONE realfreecategoriesGET:
providerstatus20000,5318categories. Toolcalls264553/264589,returns264559/264596.
No catalog refusals. Luna incorrectlyreported categoryabsent afterreadingonly10
unfilteredrecords; Haiku targetquery foundpersonal_injury_lawyer. RealSoljudge
caughtthefalseabsence; fulltestFAIL, executionhandoffPASS. Luna5calls23546work,
Haiku5calls48504work,Sol2calls300500work. Hugejudge evidencecost is concrete
optimization target (workflow-objective-judge fullSourceEvidence; inspecttarget
evidence construction beforechanging; don'tweakencontentverification). Exact
fixtureharness-mcp-materialized-1789927944178 DISABLEDAPI200. Artifacts
mcp-materialized-live-{start,response,result,disabled}. No paidbusinesscalls.

CURRENT ACTIVE ordinary conversational PLAN, NOTsavedworkflow:
sess-desktop-a6bb470ead61f2b7b9973016,
run desktop:a6bb470ead61f2b7b997301648e74d8adb972263. StartcalledONCE; response
conversational-fifty-plan-response.json (nestedresponsefield). Opusrequested,
normalPlan→Execute research50CAfirms/localDataForSEO/ApifyComposio/newtestSheet.
Promptusesretainedcontracts, no repeatcategories, max12tasks/1000candidates,
Apifyoneasync50pagesmax$1, smallworkers/handles, preservedoldintent with explicit
pre-dispatchrefusalevidence, distinctconversationalcheckpoints. Onlyplan now,
then executeacceptedpublishedartifact whenrealreviewpasses. Fulltaskalready
authorized. Neverrunstarthelperagain dueobservationtimeout. No restart/hotpatch
whileactive. Pollsame sessionandinspectplanartifact/actualmodels/judge. Ordinary
conversation delivery isrequired; savingworkflow optional. Goalactive/progress;
full50-sheet/memory/UI/mobile/speedbenchmarketcremainincomplete.


## Query-based workflow review and historical-negation scope fix installed
Installed fingerprint6c0c8e66dc8874e933927de0f8eb3060a13daa29b2aa9709a0b53a4af2beb576
(daemon+bothwebassets,rollback). BuildPASS. workflow-target-evidence.ts keeps
large>12000char authenticated results/currentartifact bytes behind existing
JudgeEvidenceSource refs; prompt has allsettlement/digest/completeness labels,
smallresults inline, fullresults queryable/openable. summaryfreshness comparisons
retain source/raw/currentcontentdigests. workflow-objective-judge.ts passesrefs
to existingobjectivejudgeevidencetools. judge-evidence-tools.ts normalizes single
JSONtext MCP envelopes forqueries; error/mixedcontent retained, open keeps original.
No pass/failgate weakened; fullsourceprompt admission stillrequired.
Candidate+installed REALSol reviews of SAMEretained failedrun1789927944521-773adf
both rejectLunafalseabsence aftertwo targetedqueries. Candidate7.374s/10719work;
installed8.417s/10761work vsoriginalSol300500work (originalworkflowreview accounting,
notcontrolledwhole-harness benchmark). Summary6068chars vs1027222retainedchars.
Installedpositiveprobe rewrites ONLYcandidatepresentation false→true in memory;
actualrecordunchanged; Solaccepts23s/18173work. This is reviewerregressionacceptance,
NOT proofLunaoriginalsucceeded. Existingfailedfixture staysdisabled. Helpers
check-query-review{,-positive}.mjs; receipts workflow-review-query-{build,candidate,
hotpatch,assets,installed,positive}.txt/json. Noisolatedhome/reset/providerreplay.

ConversationalPlan sess-desktop-a6bb470ead61f2b7b9973016 originalrunfailed
18:19:53Z final264936; publishedplan notverified, doNOTExecuteoldartifact.
Actualinput scopecompiled BOTHallowdataforseo andDENYdataforseo. Historical
"never dispatched a paid request: all three DataForSEO attempts ..." treatedas
currentprohibition. Also no-list containing "changes to ... integrations" could
be blanketaccessban. mcp-tool-scope.ts nowexcludespast-tense executionreports
fromnegativeaccessmarkers, recognizesconfigurationpreservationwithinnegative
lists; lateraccessverbs stilldeny. Actualprompt+explicitNeverdispatch/Donotuse/
Donotchangeoruse negativechecks passed candidate+installed helper.

CURRENT ACTIVE repairedconversationalPlan SAMEsession, sourceafter264936,
run desktop:74a7c0365a9f5f3246d763b64d913c41e0502afb. Exactoriginalpromptagain
withnewclientrequestID; avoids replacingtaskorhidinggrammarregression. Response
conversational-fifty-plan-scope-fixed-response.json nestedresponse,sinceSeq264936.
StartcalledONCE. Pollsamehandle/observeonlyeventsafter264936, notpriorfinal.
No paidresearch/Apify/Sheetwrites yet. No restart/hotpatch whileactive. Verify
actualMCPdiscovery+reviewedplan beforeExecute; full50conversationaltaskstilldue.
Goalactive/progress; broaderUI/mobile/memory/efficiencybenchmarksremainrequired.


## Actual Opus extra-usage error captured; conversational MCP now binds
ACTIVE remains SAME sess-desktop-a6bb470ead61f2b7b9973016/source264970,
run desktop:74a7c0365a9f5f3246d763b64d913c41e0502afb. Do notrestartorresubmit.
Model initiallyreused stalezero-tools verdict withoutlookup andpublishedneedsinput.
Acceptedsteer265022 requestsfresh exactlookup afterscopepatch, same task/limits.
Now265075 tool_searchreturns actual localdataforseo__api_request withcitable
cap:live:mcp:v1:e7978acd7c8f14f68b83692e:a0dd45ef4b54f1422cc017b30acdbb5745d3143888448d70a731f60b127104d8.
Apify/Sheetscurrentrefsbound265083/265088/265097. Stillactiveat265101. Needwait
foractualreviewedplan, don'tExecuteoldunverifiedartifact. Freshlookup proves
installedscopefix; stalepriorfailurecarryforward remainsmemorybehaviorgap.

CRITICAL modelqualification: NOTanOpuspass. FirstOpusrequest wasrejected by
provider at1789928608075 withHTTP400, invalid_request_error, EXACTmessage
"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
Saved claude-opus-extra-usage-provider-error.json. Brainlabelclaude-opus-5,
localcooldown600000ms,sameProviderRetryablefalse. Event264987routesTerra then
265007/265021preselectedfallback. Thisproves extrausageunavailableforthisrequest;
NOTnormalClaude5h/weeklysubscriptionexhaustion, NOToriginalunrecordedfailure's
cause. Haikurequestsworked. No purchase/authreset/accountsettingchange.
Tolduserpreciseprovidererror andthatfallbackdoesnotcountasOpusvalidation.

PENDING SOURCEPATCH (NOTinstalled): shared/provider-capacity.ts exports
isProviderExtraUsageUnavailable, scopedprovidertextonly; fallback-model.ts retains
extraUsageUnavailableincooldownmemo andemitsmodel.extra_usage_unavailable /
preselected-extra-usage-unavailableinsteadgenericrate-limitreason. Routing/retry
policyunchanged. BuildPASS (beforetestfileedit; rebuildbeforehotpatch), pure
provider-capacity.test.ts2testsPASS, ordinary429/weekly/invalidschemaNOTextrausage.
Artifacts extra-usage-diagnostic-{build,tests}. Needhotpatchonlyafteractiverunends,
verifyinitial+preselectedroute reasons withcontrollednonbusinessfixture. Installed
still6c0c8e66dc8874e933927de0f8eb3060a13daa29b2aa9709a0b53a4af2beb576.
No paidresearch/Apify/Sheetwrites yet. Goalactive/progress. Fullconversational50firm
sheet,Opusqualification,speed/token/memory/UI/mobile/workflowcoverage stilldue.


## Recovery no-op loop bounded live; scoped Claude error now emitted live
Installedf8d8f4abf8bef5861c351bee320ae10000687a06786172ecf9b714e492a0a074,
daemon+bothassets/rollback. BuildPASS. Extrausagehelpercandidate+installed verifies
firstmodel.extra_usage_unavailable andpreselected-extra-usage-unavailable,
providerCalls0,fixturefailureonlyonce. Actualnewplan alsoemitscorrectreasons
265260/265287, fromOpus5toTerra. NOTOpuspass. HTTP400extrausage stillunavailable.

Found older exactrecovery session sess-desktop-3f470fbb78675aff366300c6/source246957
("Execute this reviewed plan exactly and verify the saved result") repeatedly
reentering despitecompleted physicalattempts. 2972completedatfirstaudit, 2995total
beforestop. No providerusagefor thissession after2026-09-20T04:44:04.590Z, so
scheduler/statechurn NOTevidenceofextraClaudeusagecause. Privatecheckpoint and
inFlightmarker unchanged. Recovery callback resolvedsuccess beforehostadmission,
so existingadmission-failurebudgetneverincremented. restart-recovery.ts now
observesafterdispatchresolution: sameexactserializedcheckpoint+sameinterrupted
marker withunchangedexistingcount =>noteUnchangedCheckpointResume. Leafhelper
exact-checkpoint-reentry.ts sharescounterandavoidsdoublecount; changedstate/cleared
markerdonotcount. Existingbudget5/noticepreserved; no provider replay/reset/terminal
manufactured. PurecheckPASS forprogress/no-doublecount/boundedunchanged. Actual
installedscannerreachedreentry_budget265291, lastattempt18:36:00.124Z, count2995
stable across20s observation. Statebytecomparisonunchanged. Evidence
recovery-noop-{build,check,hotpatch,assets,live-snapshot}. No personalworkflowrepair.
Thisboundsnooprecurrence, notrootrepair ofoldcheckpoint; nextapprestart resets
existingin-memorybudget andmayrecheck5times. Fullrecoverycorrectnessstillbroader.

PreviousconversationalPlan source264970 TERMINALFAILED18:32:35Z/final265212.
Review265202: graphlacksbounddatasetfetch andpasses1000rawrecords tohelperbefore
checkpoint. No paidresearch/Apify/Sheetwrites. DoNOTExecuteitsunverifiedartifact.
CURRENT ACTIVE finalrepairPlan SAMEsess-desktop-a6bb470ead61f2b7b9973016,
source265240, run desktop:e70b2409e346cbf9685c1e0ed74addf825cd60d2.
StartcalledONCE: conversational-fifty-plan-final-repair-{start,response}.json,
response.sinceSeq265212. Promptrepairsonlydatasetfetch+durablehandlecheckpoint
beforehelper; exactschemas/limitspreserved, ordinaryconversationnotworkflow.
Latest265285condenser_applied/265287Terrafallback. Waitsamehandle, no restart.
Full50firmSheet/Opusqual/memory/UI/mobile/benchmarks remainincomplete; goalactive.

## Conversational framing and retained-result worker gap — 2026-09-20
User questioned workflow framing. Confirmed ordinary conversational Plan -> Execute
for the 50-firm research; saved workflow remains optional. No new saved workflow.
Rechecked main, other Claude PID47978 alive, installed fingerprint f8d8f4ab unchanged.
Current source265240/run desktop:e70b2409e346cbf9685c1e0ed74addf825cd60d2 remains
active. Review265392 rejects unbound helper retained-result tools. Prompt265397
has grown to87394tokens (history65121), despite earlier compaction; no speedwin.
Code inspection finds a deeper real gap: recall-tools.ts uses current-session
resolveRetainedOutputRead; retained-output-read.ts queries only current session.
worker-host-runner.ts creates separate child sessions. Merely passing parent call
IDs in a worker packet DOES NOT provide readable parent results. Do not waive this
review or claim result-handle-only worker handoff already works.
Sent one steer, accepted lease_live at265400, to use parent-side compact field
projections after checkpoint, then pass bounded necessary records to smallworker.
Original50firms/max12tasks/1000candidates/Apify$1/newSheet/no duplicatepaidcalls
preserved. Artifacts conversational-parent-query-steer-{start,response}.json.
No source patch/hotpatch this turn. Future framework work: explicitly scoped,
host-validated retained-result sharing to child workers; never broad cross-session
fallback lookup. Current catalog also lists claude-opus-4-8 alongside opus5, but
catalog membership is NOT entitlement or successful runtime proof. No model
setting change or alternate Opus test made. Full goal remains open.

## Scoped worker result sharing installed; live acceptance started
Installed fingerprint de655a63ad0cf12662aa1e5d7bc1317ced118c38e6c5974e663587dc9e52d54d.
Build PASS, pure worker-retained-results.test.ts 2PASS. Daemon and both web trees
patched with rollback; app reopened to Home, build API confirms fingerprint.
New WorkerToolInput.retainedResultIds explicit parent call IDs/handles (max32),
packet key includes nonempty sharing list preserving old packet identities.
worker-host-runner validates each immediate-parent-owned retained result before
creating child, stores IDs/parent/content SHA256 in child metadata. No payloadcopy.
retained-output-read local lookup remains first; only delegated-worker child can
read exact shared parent results, verifies digest and completeness, no recursive
ancestor or arbitrary-session search. Query/recall use existing receipt mechanism.
New worker-retained-results.ts pure helper tests reject wrong parent, unlisted,
duplicate, changed, missing and truncated results. Pending actual model-path proof.

Previous 50firm source265240 terminalFAILED18:46:29Z. Review265425 negative;
publish_plan265430 nevertheless returns ready artifact plan-07b2693e-4e0d-4127-9fda-8739920be72e,
digest d43c40c5400ec110a29f11b8033d0cf9334fae09e0e04da869679253b4f34099.
Final265435 explicitlyBLOCKED/completion_review_negative. Do NOTExecute. Code
publish-plan.ts intentionallypublishes finalcandidate afterrepairbudget with its
review disposition, but publicationReceipt still invitesExecute: misleading
presentation, NOTevidence gateallowedexecution. No patch tothat yet.

CURRENT live controlled test: sess-desktop-7fcd8a06a784aa0f74daafbf,
run desktop:7fcd8a06a784aa0f74daafbf2305107e7e7bf2c0, startedONCE.
Artifacts worker-retained-results-live-{start,response}.json. Native read named
1000row synthetic worker-retained-results-fixture.json then exactlyoneLunaworker
with retainedResultIds, queries rows997..999; no file reopen/shell/externalwrite.
Expected values6979,6986,6993. Opusrequested; actualfallbackmustbehonest.
Waitsamehandle, nohotpatchwhileactive. Full50research/Sheet stillnotexecuted.

### Worker sharing live PASS
Source265442 finishedCOMPLETED18:49:23.263Z. Parent actualrouting Opus5 at
265443/265459/265484/265510, nofallback. Luna child
sess-worker-9a707c3c7e5f9fabddcd535bb42d6e7fe7cb0585 made shared
query settlement265496 succeeded/rh_09c47fb6e5375bd24f069904c44945f5.
Child modelcompleted265493/265498 confirmsLuna. Workerreturned265503 actual
rows997=6979,998=6986,999=6993. Parent packet265486 hasretainedResultIds and
instructions only, norowcontents. Read once native, parent alsoqueried compact
rows toverify. Independentreview265511 fulfillsTRUE. Final265515delivered.
Artifact worker-retained-results-live-evidence.json (boundedselectedevents).
This proves installed scopedchildquery path withactualOpus+Luna, not globaltoken
benchmark. Opus5 nowworks thisrequest; doesNOTexplainpreviousHTTP400extrausage.
Next repair conversationalPlan nativequerybinding/presentation inconsistency,
then resume full50firm research. No active test atthispoint. Goalunfinished.

## Exact-review publication receipt installed; fresh conversational plan active
Installed32b1305ca7c1d946b69e2cee7dcfadcd7b6c2abfc989126806f29fa6f72350ba,
daemon+bothwebtrees/rollback, Homeverified. BuildPASS, pure receipt testsPASS.
plan-publication-receipt.ts matches exactplanReviewDigest and distinguishes
passed/rejected/unverified; publish-plan.publicationReceipt includesreviewStatus
and no longer invitesExecute fornegative/unverified, includingrecoveredsource.
Artifactreadiness/executionpolicyunchanged. Testedactualsavednegativeartifact
at265427 throughcandidateandINSTALLEDcode/livehome; bothfresh/recoveredreceipts
rejected. Helpercheck-plan-publication-receipt.mjs, artifacts
plan-publication-receipt-{candidate,installed,tests,build,hotpatch,assets}.
CandidatehelperusesnormalNode (Electronagainstcandidatenode_modules ABI mismatch);
installedhelperusesElectron. Noenvironmentrepair/rebuildnode_modules.

New freshconversationalPlan toavoidpriorfailed-draftcontextbloat, SAMEfull50firm
objective/constraints. InstalledexplicitretainedResultIds nowavailable; contextual
queriesinsidecompute/workerstep, no fabricatedquerycapabilityRefs. Originalpaid
intentpreserved; newcheckpointnamespace framework-ca-pi-conversation-20260920-b.
One start: fifty-conversational-shared-plan-{start,response}.json.
CURRENT sess-desktop-e76f8fff0755484162d1c1c2,
run desktop:e76f8fff0755484162d1c1c2bea4749e791e8a48. Waitsamehandle. No research
orSheetwrites authorizedforthisplanningturn. Executeonlyactualreviewedrevision.
Goalactive; no overalltokenbenchmarkclaim.

## Verified wait and measured current Plan overhead
Same active source265526/run desktop:e76f8fff0755484162d1c1c2bea4749e791e8a48;
last inspected lease18:56:29Z. No restart/newrun thisturn. Lasttools265755Sheet
readback discovery,265749Apifypollschema; newcheckpointfilesverifiedabsent. Planning
only, no paid discovery/Apify/Sheetwrites. Opus5actualroute265527, nofallbackseen.
Initial composition23167tokens, rises29415/38731/45015; notfullspeedwin.
Usage snapshot18:55:24Z: Opus14calls,1073778prompttokens (858427cachedread),
222439uncachedwork; Sol7calls,79176prompt/79587uncachedwork. Scope exactsession;
notwholebenchmark, stillrunning. Sourceattribution classeschat include helper
reviews, so needinspect7Solpurpose beforeoptimization. Duration Sol0/unavailable,
doNOTderivewalllatency fromthat. Artifact
fifty-conversational-shared-plan-usage-progress.json. Fulltaskstillpending.

## Pending trajectory-review schema deduplication (not installed)
CurrentPlan source265526 remainsactive, lastlease18:58:29Z. DoNOThotpatch yet.
Inspected trajectoryreviews at265629/660/689/719: fourchecks every4settledcalls,
all on_track, completedcoverage ~58k-76kchars. These explain substantialSolusage;
notall7Solcalls conclusivelyattributed yet. hostWatcher usesincrementalreadcursor
but sourceSettledReadEvidence stillappended discoveryNavigation/inputcontracts
to old prior_review_window receipts. Exactduplicationbug.
Source change host-completion-work.ts: found/navigation onlycomputed when
!priorWindow. Oldreceipt/resultidentity retained; newdiscoveryschemasstillshown.
No cadence/model/reviewgatechange. BuildPASS. Realcurrentlivehome source replay
helper check-prior-discovery-window.mjs cursor16154: installedbefore47105chars,
candidate27183chars (19922/42.3%less), both26results/20priorreceipts/evidenceAvailable.
Prior-schema blocks3->0. Artifacts prior-discovery-window-{before,candidate,build}.
Notinstalledacceptance orfullmodelquality/whole-tokenbenchmark yet. Mustidlepatch,
verifyinstalledsamehelper; preserveactivePlan and executeonlyreviewedartifact.

### Plan source265526 verified wait, 19:00 UTC
Run remainsactive withfreshlease19:00:29.805Z. Firstpublish attempt265771 has22steps;
preparation265775 requests only missing /content binding on s22_final_report,
draft47b54321cea910dc317f46f305facdb4af594c9bde83f780ee21ab09f3135664.
No newpublishedreadyartifact orcompletionreview yet. No restart/steer/replay this
turn. Supervisorrecenttailshows no modeltimeout/error; Opus5contextlimit warns
unknown-model conservativefallback (not evidenceproviderfailed). Awaitsamehandle.
Pendingprior-windowdeduppatch unchanged/uninstalled; rebuild afterdocs edits
beforeeventualidlehotpatch. No businessresearch/Sheetwrites.

### Current Plan first substantive review, 19:01 UTC
Source265526 same run stillactive lease19:01:59.811Z. Revisedpublish265779
reachedactualSolreview265781: negative because proposedcategoryfallback could
change personal_injury_lawyer andexceedimmutable12-tasklimit. Feedback265784
retainsdraft65f4572caac35e2adaa9e833c10593293c89136f9778995b9074665db3e5468e
for targetedpatch. Notaccepted/notexecuted. No steering/restart thisturn.
Waitsamehandle for correction; pendingdeduppatchstilluninstalled.

### Same Plan generated category repair; collection preparation gap
Source265526 stillactive lease19:04:00.732Z. Prompt265786estimated90898tokens.
Publish265788rewritescompleteplan; preparation265792 rejects s8_discovery_wave
forEach.producerStepId=s6_category_gate becausecomputeoutput cannot supplyreviewed
memberset. Existingrepair offersstaticknownitems (preferredforknownmetros),
readtoolproducer, or unrolleddynamicbindings; exact/data->/databindingpreserved.
Draft8e809e3ebc97880539c0c3ee841157ec757dd2e13adb8fa3ef6d859e25c65435.
No manualsteer/restart thisturn. Noacceptedplan/researchwrites. Pendingdedupstill
notinstalled. Next waitsamehandle; inspectnewplanagainst12task/categoryinvariants.

## Plan passed; dedup installed; Execute refused on restored MCP capability
Plan source265526 completed19:05:04Z. Solreview265798fulfillsTRUE; artifact
plan-d4952d19-1c43-4ea8-9d2c-1b9fe7af6ea7 rev1 digest
e71794327f65767f5a023ad916d0f05da312583369dcbfa547bdb0d0a13135b5.
Savedfifty-conversational-shared-plan-artifact.json. Inspectedstaticpilot+11metro
wave (80each=960,exactcategory), oneApify$1,12columnnewSheet+readback. No savedworkflow.
FullPlanusage: Opus18calls/428207uncachedwork;Sol9calls/209566uncachedwork.
Artifactfifty-conversational-shared-plan-final-usage.json. Farfromefficiencygoal.

Installed8575bf1d38b2e92ae9d1bf928b7ef44d934278747b8e650adc638a804b1c19e3.
FinalbuildPASS,daemon+bothwebtreeswithrollback,Homeverified. Installeddeduphelper
PASS: priorSchemas0/priorReceipts20/evidenceAvailabletrue. Currentretainedsource
now30results duefinishedplan: installed98023chars vsrollbackold117945chars,
same19922chars removed. Original26result42.3%fixture comparisonremainscorrectbut
current30resultcomparison16.9%. Artifacts prior-discovery-window-{installed,before-current}.

Execute startedONCE afterinitialprePOSTbuild-info fetch ECONNREFUSED whilebooting;
firstfailedhelpernevercreatedstartartifact/nodispatch. Actualstart202/run
 desktop:93ac2b49985503985ec37ba6b8c8eb3914a62a99, SAMEsesse76f8...,source265819.
Artifacts fifty-conversational-shared-execute-{start,response}.json/helper.
TERMINALFAILED immediately,265825kindplan_execution_revalidation_refused,
reasonentry_missing. Final265826 saysreviewedMCP
cap:live:mcp:v1:e7978acd7c8f14f68b83692e:a0dd45ef4b54f1422cc017b30acdbb5745d3143888448d70a731f60b127104d8
changed/unavailable. No businesscallstarted, no research/intent/Sheetwrites.
Planexecutionclaimed265820 before refusal. DoNOTblindlyretry sameclaimedrevision
orregeneratewholeplan. NextfixframeworkreviewedMCP restoration acrossrestart/Plan
Execute. Priordiscoverymaterializationfixwasworkflowlane; thisisplanrevalidation.
Goalactive. Noactiverun atlatestinspection.

## Reviewed MCP cold-catalog restoration installed
Installedb17d7340d482661c2a552e112d425d539ee2fdb8f499b672cb02066c5873686d,
daemon+bothassets/backups. BuildPASS. reviewed-plan-runtime.checkReviewedPlanPreparation
now attempts exact nativeMCPmaterialization when reviewedentrymissing/noncallable:
parsecanonicaloperationnamespace, reobserveconfiguredserver tools/list against
reviewedinputschema, then rerunSTRICTfullreviewedidentitycomparison. No trust in
historicalschemaalone, no businessinvoke. Existingaccount/schema/effect/port
comparisonsremain unchanged. NoComposio/privateconfigchanges.
Helpercheck-plan-mcp-restore.mjs loadsactualsavedPlan, selectsits2MCPsteps for
boundedmetadata test. Coldprocesscatalog->bothrestored; mutatedaccountidentity
rejected; businessCalls0. Candidate(normalNode) andINSTALLED(Electron/livehome)
PASS. Artifacts plan-mcp-restore-{build,candidate,installed,hotpatch,assets}.
Appreopened (initialdashboardboot); needfinalHome/APIcheck next.

FullPlan execution NOT retried yet. Existing source265819 terminalrefusal and
claim265820 remainintact. admitPlanExecutionBridgeSource transaction mintsclaim
before loop revalidation; same-source terminalreturnsjoined, other-source also
joins. checkReviewedPlanPreparation comment sayspreclaimpossible but nocaller
invokesit beforeclaim. Nextframeworkissue: truthfulretryability forpre-dispatch
validationrefusal withoutclaimreset/manualDBmutation orregeneratingwholeplan.
Relevant plan-execution-bridge.ts, respond-bridge caller, plan-execution-ingress,
plan-artifacts claims. DoNOTblindlyretryclaimedrevision. Noactivebusinessrun.
Goalunfinished;50firms/Sheetstillnotproduced.

## User acceptance correction — September 20 wrap-up
The 50-firm conversational task MUST actually execute and deliver its new Sheet
before the requested clean tag point. Do not shelve this blocker as unfinished.
All further model testing must use Grok or GLM only, including workers/reviewers;
no Claude/Codex testing or fallback. Live settings changed through supported API:
Grok 4.6 brain (existing session repinned), GLM 4.5 Air worker, GLM 5.2 judge;
all_in routing, CLEMMY_BRAIN_FALLOVER off. No model run started yet on these roles.
Shared main remains e5a75f5a; other Claude agent PID47978 remains alive.
Pending retry/preflight changes retained following the user's explicit correction.
Correction to previous diagnosis: respond-bridge has preclaim checks for direct
sources, but desktop/mobile accepted sources bypass them. Add ingress preflight.
Cold full-plan helper also exposed missing Composio metadata after restart;
restore exact metadata and existing manifest before strict identity comparison.
Do not manually reset claims or repeat any paid business call.

## 50-firm execution continuation, 19:44 UTC
User insists successful 50-firm task before tag; Grok/GLM-only testing. Current
Grok4.6 brain, GLM4.5-air worker, Grok4.3 judge (GLM5.2 timed out reviewing full
plan). BRAIN_FALLOVER/JUDGE_CHAIN/JUDGE_HEDGE/JUDGE_CROSS_FAMILY all off via API
to prevent Codex/Claude substitutions. No prohibited model testing started.
Installed fingerprint eb6d6e0596ef6a1a2faff9bbbf13bdb174bec61b01d8cb5226236b6f8e3eb9d1, daemon plus bothwebtrees.

New framework fixes: ingress preflight before accepted-source/claim; scoped MCP
prewarm before exact materialization (cold listTools could return not-yet-ready
as missing and retire reference); Composio restoration via existing original
source registerProofProvisionedCapabilities with exact schema/recovery identity;
base_ref-only publish_plan reuses full plan, refreshes equivalent MCP references
then re-runs full preparation/review; freshly restored provider capability may
join source staging ledger even if initial display card predates its registration.

Latest blocker fixed: promoteSelectedSameSourceStagedPlanningDescriptors capped
selected execution to eight display cards. Nine actual distinct tools needed.
Selected same-source refs now survive promotion up to32/65536bytes; initialcard
remains8. Component candidate+installed PASS preserve9/rejectundisclosed/reject33.
Artifacts plan-card-* and check-selected-plan-tools.mjs. No isolated acceptance.

Full cold refresh helper candidate+installed PASS17toolsteps/27steps with unchanged
text and wrong-account rejection (plan-refresh-*). Retained original MCP ref
was retired by earlier cold missing-list observation; fresh equivalent ref ends
:reacquired:4395df1d-fb43-417f-9607-e5cbcc2bd072. Never manually revive oldref.

Plan refresh source265860 Grok4.6 failed new-source attachment, cancelled through
exact API before businessdispatch. V2source265964 in branch2087... published
plan-d4952d19-1c43-4ea8-9d2c-1b9fe7af6ea7 rev2 digest
aaa0954ac675bedc47d1437c563d4f86171f835167268119f74c59af28a99869.
Review266007 GLM timeout/failedOpen; NOT PASS. Fulltext/steps unchanged independently
compared, then authorized Execute once source266016 run4f649d5f...; admission
refused nine-tool card limit before ANY businesscall, cancelled exact API.

CURRENT ACTIVE Plan refresh v3: run desktop:869b023f79f169d477e05351017fd0eb0f5b8014,
session sess-branch-348ed3ac0437840f17ca833d5b15bd6bd749260a, sinceSeq266128.
Artifacts fifty-grok-refresh-v3-{start,response}.json. Await same handle, retrieve
new artifact, execute ONCE using new revision. No 50-firm research/Apify/Sheet
call has fired yet. No commit/tag/push. Shared main+meter edits preserved.

## Explicit limit-removal instruction
User: "any limits that are stopping the module like you described need to be
removed". Remove arbitrary admission limits on already disclosed/selected tools.
Initial discovery display stays compact; selected execution tools must not be
refused at8,32,or65536bytes. Removed the introduced32/byte ceiling and existing
staged-selection32 ceiling. Added component coverage for40selectedtools, while
undisclosed tools remain rejected. No user spending-limit change. Base revision
proof traversal uses cycle detection rather than arbitrary32revision cutoff.
V3source266140 cancelled prebusiness after cold V2 proof restoration failed.
New lineage fix candidate PASS against real V2 artifact,17toolsteps/27steps,
wrongaccountrejected. Current next helper start-fifty-grok-refresh-v4.mjs notrun.

## 2026-09-20 selected-tool limits and mixed-output projection
Latest user instruction: remove limits stopping the module. Removed selected-tool
promotion/staging count and byte limits, plus shownGroundingDescriptors truncation
of exact selected refs. Discovery remains compact; unknown refs still fail.
Derived reviewed-plan tracking previously copied the FIRST write's destination
onto every operation. Mixed create/append plans then failed destination mismatch.
Only emit a common destination when all target-bearing contracts agree; retain
exact reviewed argument/account/handle enforcement. No destination validator bypass.
Candidate AND installed live-home metadata checks pass full real 17-operation/
9-tool draft admission and 40-ref grounding, with zero model/business calls.
Artifacts: plan-destination-{build,candidate,hotpatch,installed}.log and
check-plan-destination.mjs. Installed fingerprint
9a2cc9cb1fb2b576330a74d1f94756d221f20ce5fd8874c682f7cc4b4e4bc1ea,
daemon plus desktop/mobile web assets. Main e5a75f5a, other Claude PID47978 alive.

Grok Execute source266509/run0cbc41... cancelled exact API before any paid
business dispatch after destination mismatch. No manual claim reset.
Current Plan refresh v5 source after266596, session
sess-branch-213ba7d2f960e3348366201a7c6bfe7622ad72e8,
run desktop:a2c48e91f3ee650f819ce3f3553d337cd8a79c95.
Base is plan-d4952d19-1c43-4ea8-9d2c-1b9fe7af6ea7 revision3 digest
601d8f0e353d7c60d8ca2f7f090c87732f8aac93738fb1011e2513f612b1d1c6.
Rev3 publication judge falsely said publication had not occurred while reviewing
its prepublication candidate; review is REJECTED, not a pass. Changed input to
clearly separate business plan review from later publication. Actual Grok4.6 brain,
GLM4.5-air worker,Grok4.3 judge; all fallback/hedging/cross-family off.
Still no 50-firm business calls/Sheet. No commit/tag/push. Finish actual task.

Follow-up: v5 refresh published revision4 digest
0d2979a85a48b48f3ae67872119df95ce1e7f8c1bdb86fc84da8e440df8efbdc,
Grok4.3 review PASSED, Plan completed in one tool call. Execute source266661
run3e9d7325... stopped prebusiness at host_destination_ambiguous_multiple_exact_targets.
Host destination derivation incorrectly forbade different EXACT selected targets.
Changed it to retain distinct kind/posture destinations after checking each
manifest/account/effect; removed 8-destination schema ceiling. This is not account
selection bypass. Complete saved draft passes combined derivation+validation in
candidate; installed check pending (first hotpatch correctly refused source drift
from the regression-test update). New pure regression tests18/18 pass with live
home config, audited no resets or business I/O. Initial test command was blocked
by test-process guard; explicit live-home opt-in only used for these pure tests.
Next refresh helper start-fifty-grok-refresh-v6.mjs is prepared, NOT started.

## Full compiler follow-through
V6 refresh passed Grok review and published revision5 digest
5f7cd5bc9ab03e714587d11544af824d23af8f87f9e66f4f6f3b1246738fce56.
Execute source266826 runfd57db504... refused downstream carryExactDestinationBinding
("one destination binding cannot authorize multiple admitted destinations").
Cancelled exact API prebusiness. Fixed carry to retain each target's own binding,
family/posture/evidence requirement; missing target binding remains refused.
Full compilePrimaryModelAcceptedTurnGraph now passes on actual source266826 in
candidate AND installed live-home process, route act, no graph persistence,
model/business calls0. Restoring checked capabilities BEFORE priming catalog
matches app ingress (first helper ordering was wrong, then corrected).
21 pure tests pass, no fixture resets. Current installed fingerprint
4fad677b69f269c2d63d049234016eea12d812ac234ba65ee902909eb258b796.
Artifacts full-plan-compile-{candidate,installed}.log, plan-exact-bindings-*,
check-full-plan-compile.mjs. App reopened. Next refresh v7 helper prepared;
not started at this checkpoint. No business calls/Sheet yet. No tag/commit.

## LIVE PAID PILOT SUCCEEDED; preserve it
V7 refresh source266923 published revision6 digest
639751fb0fdf0b18d13050f615eab4de5cdadd13f748ac539702f6f689fc299e;
Grok review passed. Execute source266976, session
sess-branch-ff816dd255e5be8c4b752cf7876404561831dc9e,
run desktop:849749ca6461d12ecf01fa7889a6e4cba6a65cfc, admitted267017.
Manifest and initial pilot intent written. Actual DataForSEO pilot succeeded:
call-cf8df255-dbf8-423a-99a1-c0db4dbce8b2-8, retained handle
rh_c855e5700d9ce2e939cf3ba64263351e, settlement267089, response267092,
task09202018-1049-0544-0000-f9529d7f7edb,80items,total_count368,cost0.0408.
DO NOT REPEAT THIS PAID PILOT. Source/intent run key
framework-ca-pi-conversation-20260920-b. No other discovery/Apify/Sheet call yet.
Full result redeemed from exact durable result handle into
output/weekend-harness-2026-09-19/fifty-live-pilot-result.json (80items). Eventlog
result is display-truncated at8000chars; do not parse it as full data.

New blocker: dischargedRequirementSettlements demanded nonexistent mutation
verification for generic MCP paid research POST. It had succeeded+retained result,
no frozen mutation recipe and no generated content contract, but remained2/17.
Fixed external_write discharge for exact redeemed success, no reconciliation,
no explicit verification/content contract. Explicit verifier/content contracts
remain enforced; no replay or final-artifact success is implied.
Current patch ed3f3d2df6439f4a847e1409b17ca2a66cd189b97905703002a9a572dbdd7543,
daemon+bothwebtrees, installed oracle confirms exact paid pilot discharged and
wrongsource rejected, model/business calls0 (paid-result-progress-*.log).
Actual old task authority now conflict after stopped execution; no manual reset.
Helper tests core discharge on the stored immutable contract, NOT claiming old
closed authority reopened. Original run cancelled via exactAPI; resume remaining
work through ordinary authorized conversation, preserving original receipts.
Prepared resume-fifty-after-pilot.mjs (notstarted at this checkpoint); app reopened.
No commit/tag/push. User still requires actual50 firms→Apify→newverifiedSheet.

## USER REQUESTED PAUSE — 2026-09-20 20:39 UTC
User: "You can pause that run and let me know how well it’s executing and see if
there are any final improvements we should make." DO NOT resume/restart paid
research automatically. Stop/review supersedes finishing50 immediately.
Stopped exact continuation run desktop:9423344640b694018153e26599294f285c2f7a29,
session sess-branch-f121c6ccd8d3d7d363f62941fea35c4a342d9b06,source267179.
API stop acknowledged and conversation_completed267547 confirms cancelled,
no further execution. There is no true pause endpoint; existing results preserved.

Actual progress: LA80 ($0.0408), SanDiego57 ($0.03252), SanJose13 ($0.01668):
150 candidate rows BEFORE deduplication,3of12requests,$0.09 DataForSEO total.
No Apify run, no Sheet, no completed50firm result. Native MCP and local CLI
worked. Composio tools discovered only; end-to-end acceptance unfinished.
Continuation 20:30:08–20:39:34 (~9m26s),45top-level tool calls,17tool_search,
10Grok4.6 calls,9Grok4.3 calls,0GLMworkers. All model testing Grok only here.
Usage ledger:759426inputtokens including401408cached;358018uncachedinput,
386506uncachedwork including output/reasoning. Not a comparative benchmark.
Prompt-composition estimates reached112637tokens; tool schemas25581 each.

Checkpoint journal is incomplete: pilot result recorded and SanDiego intent,
but SanDiego response/SanJose intent+response were not checkpointed beforestop.
Authoritative successes remain in retained result receipts. Preserve allthree:
- fifty-live-pilot-result.json (LA exact full response)
- paid-result-09202035-1049-0544-0000-ff08f81020b1.json (SD)
- paid-result-09202037-1049-0544-0000-bd81a8cab8d3.json (SJ)
No manual paid checkpoint rewrite, no reruns. Files redeemed from exact successful
result handles after pause, not reconstructed from truncated event previews.
Audit artifacts paused-run-{usage,metrics}.json,paused-paid-results-summary.json,
fifty-paused-for-review.json. Installed patch still ed3f3d2d... (above).

Recommended final framework work before wider testing/tag: carry exact selected
tools through continuation + smaller JIT schema/context; automatic host-owned
paid-call checkpoints and genuine pause/resume from settled steps; deterministic
GLM routing for bounded extraction/selection jobs; reduce redundant review cost
using actual progress milestones. Do not claim speed/token win or worker routing
acceptance. No commit/tag/push yet; preserve shared main and usage-sidecar edits.

### 2026-09-20 20:55 UTC — multi-exact fix and controlled Grok/GLM acceptance

Installed source 87ad2b44a63f5004b99a0a23da10b866f2dcfc3962df22a9b50cacab14092b43 includes exact multi-Composio operation lookup and ranking of all explicit names before fuzzy candidates. Candidate live metadata: 1198ms then 47ms; installed: 466ms then 44ms. Both Apify operation schemas returned; no model/business calls. Two pure regression tests pass without home changes or resets.

Controlled four-worker run source267557, session sess-desktop-0620aecf2a683cf9064f8e2c completed, 20:50:30.793–20:54:03.807 UTC (213.014s). One run_worker batch; native read_file=4records, local run_shell_command=/usr/bin/true exit0, DataForSEO docs_list_sections=13sections, Composio googledrive_find_file=1metadata record. Each child has a successful exact tool_attempt_settled and provider dispatch; worker_result.toolUses=[] is incomplete telemetry, NOT evidence of absent execution. Final Grok4.3 review verified. No paid research resumed, no external writes.

IMPORTANT MODEL ATTRIBUTION: host receipts incorrectly label workers glm-4.5-air (requested), but eight provider usage entries report glm-5.3-flash (served). Both are GLM; no Claude/Codex testing, but exact requested-model validation FAILS. Do not repeat the earlier provisional claim that exact GLM4.5Air was validated. Root cause: SDK streaming conversion drops model in response_done; traceless adapter didn't retain response_started provider metadata, and route metrics fell back to requested route. Framework fix in progress preserves provider-reported model in traceless responses and route outcome/worker receipts. Transport regression tests and candidate build/install follow.

Measured parent: 4Grok4.6 calls156481input/79360cached; 3Grok4.3 calls25009input/512cached. Workers:8GLM5.3Flash calls41202input/5056cached. Total222692input,84928cached. Six parent tool searches. Fresh parent composition estimates25581schema tokens. Correct four-tool execution, NOT efficiency qualification. Full workflow/Space/memory/mobile and retained plan end-to-end acceptance remain open. Controlled scope and evidence in output/weekend-harness-2026-09-19/rounded-glm-summary.json and hotpatch-acceptance-plan.md. No tag or commit; other Claude agent PID47978 still on shared main; preserve sidecar and others' work.

### 2026-09-20 21:00 UTC — installed reporting correction, safe test stopping point

Final running installed app 3.18.17/schema81 source98a9c5c3f756a7fbf6e462dc0ccc6b657547d55a86f39dc6ca2d0882b1e1fe49. Three transport/route regression tests pass (ordinary and streaming response), plus two exact discovery tests. Built and installed successfully; app reopened and build-info verified. Installed real GLM micro-check requested glm-4.5-air, provider returned glm-5.3-flash, and corrected route receipt now also says glm-5.3-flash. 78input/11output on confirmed probe, no tools. Previous micro-check had already passed model-attribution assertions but failed a too-strict literal-OK assertion because provider returned {"answer":"OK"}; semantic response accepted in second probe. Two small GLM calls total, no Claude/Codex. First helper startup failed native module ABI before network; corrected to installed dependency resolution.

Final report artifacts: provider-model-installed-confirmed.log, provider-model-regression.log, multi-exact-regression.log, rounded-glm-summary.json; acceptance matrix hotpatch-acceptance-plan.md. Four-read end-to-end acceptance ran immediately before reporting-only fix; no assertion that the full matrix or performance goal passed. Research stays stopped; no active run remained before final patch, no personal integrations/Spaces changed, no commit/tag. Next priorities: reduce parent schema/context load and unnecessary rediscovery/review, then controlled retained-plan/workflow/Space/memory/mobile coverage. Do not blindly repeat paid research or all acceptance runs.

### 2026-09-20 — exact recorded-request schema audit

Revalidated installed98a9c5c3 and configured Grok4.6/GLM4.5Air/Grok4.3; shared main, other Claude PID47978 remains active. Previous goal turn was progress (installed fixes and four-tool acceptance).

Authenticated and projected the original model_request_provenance for source267557; measured its actual catalog, not a default buildOrchestratorAgent surface. It contains24tools/72699serializedcharacters. workflow_update17520, workflow_create17289, space_save12685 together47494chars (65.3%). The earlier standalone measurement164tools/267222chars is NOT the actual foreground request and must not justify reductions. Fresh-turn25581tokens is an estimator, not byte-count divided by4 or a provider tokenizer count.

Within-schema repetition is limited: Space has no repeated subtree above120chars; each workflow schema repeats a1570char output-contract subtree twice, with nested overlap (do not sum overlapping savings). Generic repetition factoring alone cannot remove most schema cost. Keep native tools first-class and avoid replacing them with discovery gates. No new code or paid tests in this audit. Artifacts actual-schema-audit.json, schema-repetition-audit.json, measure-actual-schema.mjs. Next optimization requires testing a compact native authoring representation against real workflow/Space correctness, rather than claiming large savings from duplicated schemas that are not there. Paid research remains paused; full matrix and efficiency acceptance remain open.

### 2026-09-20 — native workflow acceptance found hidden creation-test diagnostics

Controlled source267743/session sess-desktop-5b3053af50ac52b5cfcc4d60 created framework-rounded-native-1789938302723 with native read + deterministic grouping of240rows. Creation run1789938378902-c461ff blocked: authored read output contract used verify.path_exists path, but actual output has data.path; downstream transform then had no settled upstream result. Full failure was already persisted in reportBack.detail, while workflow_run_status exposed only "creation test found issues". Clem consequently polled status, read old workflows and searched memory repeatedly without seeing the actionable error. Stopped exact parent through cancel endpoint (ack200); no new workflow batch/paid research. Do not claim workflow execution acceptance passed.

Framework fix: workflow_run_status now includes the existing detailed run report as well as summary/step ledger. This exposes creation-test failures and other persisted terminal explanations without changing tool authority or bypassing validation. Candidate/installed read-only check against the actual failed run pending, followed by one continuation of the same named controlled fixture. First-class authoring schema reduction not yet implemented; diagnostic repair is the immediate evidence-backed way to prevent wasted loops.

### Native workflow repair executed; goal-review evidence follow-up

Installed workflow_run_status diagnostic fix passed candidate and installed real-run read checks. Focused continuation source267926/session sess-desktop-0aae5c99e726dcb2df9edb7b repaired the controlled fixture, creation test1789938812148-1f75bc passed, and actual run1789938843494-055233 completed at21:14:41.482UTC. Its native read and deterministic aggregate processed240records: A count120/sum_amount14400, B count120/sum_amount14520. No model processing steps. Read step now omits max_chars (default), so this does NOT prove a1000-char preview binding preserves a240-row JSON payload in workflow transforms.

Final pinned goal judge incorrectly marked only2/3criteria evidenced: it saw step label read_json, not the read_file invocation. Verified workflowRunReadEvidence already exposes read_receipts/read_json/268082 with authenticated admitted read_file request and exact input path, but reviewer did not open it. Framework fix adds compact identities from verified successful settled reads directly to goal evidence; payloads/arguments remain accessible through existing exact refs. This is not a forced pass and failed/unavailable reads are excluded. Pure regression test covers verified-only/no-payload summary; candidate build/install and review-only re-evaluation pending. Do not rerun business workflow merely to test judge evidence. Existing delivered warning remains historical; do not edit it into a pass.

### 2026-09-20 21:20 UTC — workflow diagnostics and review evidence installed

Running installed 3.18.17/schema81 fingerprint cd15535219262c18df043bd53065038934d7ec707b24c8cd2af21832b9afb348. App reopened/build-info verified; zero active runs at check. Status-report fix passed candidate/installed against actual failed run. Verified-read summary unit test passes, candidate replay confirms correct240-row totals and authentic read_file identity, installed review-only re-evaluation passes all3criteria on Grok4.3 (2151input,55output,4614ms). No business workflow rerun for that check and original historical67%warning was not rewritten. Artifacts workflow-evidence-installed-review.log, native-review-corrected.json, rounded-native-summary.json. Earlier helper first attempt expected parsed array but persisted stepOutputs are JSON strings; corrected decode before verification; no model call occurred on that helper assertion failure.

Native workflow execution now accepted for this controlled two-step native read/deterministic aggregate after model-authored contract repair. Full original run did not pass its initial review; corrected review validates exact retained results on final installed code. No claimed schema token reduction or matched speed win. New framework changes this continuation: workflow_run_status exposes persisted reportBack.detail; run-level goal evidence includes compact verified succeeded read identities with lazy exact refs. Preserve other agents' edits and sidecar. Paid50-firm research remains paused. Next useful live coverage: controlled Plan→Execute for Space with desktop/mobile output and scoped memory recall; avoid repeating paid or four-worker tests absent new risk. No commit/tag/push yet.

### 2026-09-20 — rounded Space/retained-plan and memory acceptance completed

Installed cd15535219262c18df043bd53065038934d7ec707b24c8cd2af21832b9afb348 unchanged. Controlled Space framework-rounded-space-1789939295021, session sess-desktop-0cb0bb8f881617fbc37cf135: Plan source268107 completed191.045s; Execute source268320 completed65.852s. No Space existed after planning; exact retained plan-c7bb0e41-82e7-4934-a3d7-29912c9379c9 revision1 digestf79b56e40c977b628bcc7f808272f98507007f55042eabf5a0956dbc37c208e1 activated via plan_task{}; one each space_save/get/get_view/preview. Both final reviews verified+fulfills on Grok4.3. Planning first publish malformed structured_plan string, corrected second attempt. Stored static snapshot has exactly Native tools and Memory scope, both Pending, no sources/actions/reengage. Native dark390x844 desktop HTML preview visually inspected: readable/no clipping. Installed mobile projector independently checked persisted data:2records with matching statuses. This is mobile DATA acceptance, not paired physical-phone UI acceptance. Authored optional breakdown was omitted by projector; essential headline/records correct.

Memory source268245/session sess-desktop-b491f8605f16c5474a35f481 completed91.229s: recovered retained synthetic cobalt pattern with exact support3814,3815, correctly distinguished inference from explicit user preference; verified Grok4.3 review. All top-level effective tools were reads: recall_all, search_facts twice, search, tool_search; no memory write tool invoked. This is scoped lineage recall, not a cold/repeated comparison or broad memory benchmark.

Performance NOT qualified. Space plan5Grok4.6+4Grok4.3 calls249416input/69760cached; execute4Grok4.6+2Grok4.3 calls301751input/103680cached. Memory3Grok4.6+4Grok4.3 calls113854input/35072cached. All test usage Grok; prior workers actually GLM5.3Flash. No Claude/Codex tests. Planning3tool searches and repeated existing-Space reads; memory irrelevant model tool_search; redundant context/review is next optimization target. Keep native tools first-class. No token/speed superiority claim. Zero active runs at audit; paid50-firm research remains stopped, no Apify/Sheet completion. No code edits this final audit, no commit/tag/push. Shared main/other-agent edits preserved. Artifacts rounded-space-summary.json, rounded-space-projection.json, rounded-space-dark-preview.png, rounded-space-events.json/usage.json, rounded-memory-summary.json in output/weekend-harness-2026-09-19. Broader paired-mobile, failure/recovery, matched efficiency and final shared-work tag review remain open.

### 2026-09-20 — execution context cost isolated, read-only replay

User confirms separate agent owns UI and final merge; remain framework-only. Shared main still e5a75f5a, other Claude PID47978 alive. Last goal turn completed acceptance evidence (progress). No runtime change/hotpatch/model tests in this audit.

Authenticated actual request-layer audit sources268107/268245/268320: Execute initial task163021chars, catalog34426, memory12402, stable policy6260, turn context6639. Initial Execute task contains full prior planning transcript, including skill19357chars, search schemas, memory reads, both publish attempts, plus current exact reviewed-plan input37247chars. Thus native schemas alone do not explain this run's overhead. Data in rounded-request-layers.json.

Installed compactInFlightToolContext read-only replay on exact Execute input (session identity supplied, durable recall checks enforced) default32000result-token trigger did nothing. Tested16000trigger/8000retained budget/min3/max8:8old exchanges collapsed,8retained; task input163011→106625serializedchars (34.6%reduction), estimate43487→26041tokens.8000trigger same result, no further gain. Original input byte-identical and every user item preserved. No history persistence, no model call, no business action. Artifact execute-compaction-replay.json, helper replay-execute-compaction.mjs.

This is a candidate measurement NOT an installed optimization or measured provider-token/speed win. Existing compaction removes some older skill/memory/search bodies from immediate view but retains call IDs/exact raw outputs, so a live acceptance must check recall churn and skill use as well as bytes. Next: apply a scoped between-turn Execute projection using existing durable recall, preserve exact selected plan and all current-source frames, and verify against controlled retained-plan fixture with Grok/GLM. Do not globally lower every model's context window or drop tool availability. No resumed50-firm research; no tag/merge. Current running hotpatch remains cd155352...; final matrix/performance still incomplete.

### 2026-09-20 21:49 UTC — Execute history projection installed; acceptance stopped on model wait

Installed app3.18.17/schema81 fingerprint201cc4e337f720cb35e898835f3545b80d4e38e9313c4d86700216b9ef2f433a, build/hotpatch succeeded, UI unchanged. Framework edits: loop.ts creates a one-time prior-history projection only for a fresh exact accepted Execute claim, no prior model request for that source, no checkpoint/host-owned continuation; uses existing durable-recall compactor at16000result trigger/8000retained budget/min3/max8. Model input filter replays that chosen prefix without moving the boundary as new frames arrive; persisted history and current request/frames remain unchanged. Missing evidence/changed prefix preserves ordinary input. New retained-history-prefix.ts plus two pure regression tests: exact current/steering frames, paired calls, input immutability, cloned history, changed/missing/already-projected prefix fail-safe. Pure tests passed, candidate and installed read-only replay of real prior Execute request passed163011→106625chars with exact current input/pairs preserved. No isolated-home acceptance or fixture resets.

Live new controlled fixture framework-context-space-1789940417902 in same session sess-desktop-0cb0bb8f881617fbc37cf135. Plan source268426 passed Grok4.3 review in68.510s, two Grok4.6 calls plus one judge, space_list once/publish_plan once, no tool_search/no publish repair. Plan-d9c38212-9127-4fa3-bbc3-17508b77cd79 revision1 digest54d1ec56d366878f1415e6c85e1f556e2d8069e53a09d31d3308160114e184b9. No Space before Execute. This retained-template Plan success is NOT attributed to the Execute-only patch.

Execute source268473 emitted condenser_applied268493 kindreviewed_execute_preparation:15older pairs collapsed, estimated historical context50337→23454tokens (~53%); actual authenticated model request records carry the projected input. Executed plan_task{} once and space_save once. New Space HTML and data are byte-identical to prior visually verified fixture; independent installed mobile projector confirms2Pendingitems/static/no sources/actions. Third Grok request stayed pending after save for several minutes, no readback/preview/final response. Stopped exact run through its returned cancelEndpoint, ack200 then authoritative statuscancelled at21:47:31.522UTC,322.271s total. Zero active runs. Do not restart because cancelled; reviewed Execute claim is consumed. No automatic research continuation.

END-TO-END ACCEPTANCE OF THIS PATCH IS INCOMPLETE; speed/total provider-token efficiency NOT qualified. The unreturned request has no completed usage record, so do not infer zero cost or diagnose quota/auth exhaustion. Completed Execute usage2Grok4.6calls100208input1536cached604output; all new completed test usage Grok. No Claude/Codex tests. Plan142485input50368cached. This is not a matched speed benchmark. No evidence yet establishes why third response stalled or whether context change influenced it. Need investigate model wait/recovery and complete controlled end-to-end acceptance without repeating already-saved work, then broader efficiency/mobile checks.

Evidence: execute-context-build.log, execute-context-hotpatch.log, execute-projection-candidate.log, execute-projection-installed.log, context-space-summary.json/events.json/usage.json, context-request-layers.json, context-space-stop.json. Goal active. User's other agent owns UI and final merge; no commit/tag/push here, preserve shared main/sidecar/other changes. Paid50-firm task still stopped and incomplete.

### Recovery acceptance in progress — temporary GLM test brain

Follow-up diagnostic: stalled source268473 contains heartbeat model-wait notices and user/test cancellation only, no provider error/rate-limit reply. Existing sized first-byte default300s/stream600s/responsewall900s explains permitted wait; no global timeout reduced or false auth/quota cause asserted. Switched active brain through supported API to glm-4.5-air, re-pinned ONLY controlled session sess-desktop-0cb0bb8f881617fbc37cf135; workerGLM/judgeGrok4.3 unchanged. Restore original brain via `node output/weekend-harness-2026-09-19/switch-context-test-brain.mjs restore` after test; exact prior API brain/model selection saved in context-brain-before.json (no credentials). New read-only recovery Plan run desktop:67a32f68d9c2da6d43d4c067b9e1979d8da1cd4b accepted since268524. It plans only remaining manifest/data/HTML/preview checks for existing framework-context-space-1789940417902, explicitly no recreate/edit/delete. Follow exact live run, do not duplicate if observation delayed. This tests continuation from completed write without replay; original cancelled Execute remains cancelled.

### 2026-09-20 21:56 UTC — GLM recovery Plan→Execute passed; brain restored

Recovery POST automatically branched cancelled parent into sess-branch-e0c767bed0bf01b9cf2fc0ea541e0b7d7d0eccc4 (do not confuse parent session with returned session). Plan source268527 completed54.282s, served GLM5.3Flash3calls58737input16896cached and Grok4.3review2calls15551input832cached. First publish refused because exact local space_get_view/space_preview definitions were not in this source's planning context. GLM searched those two operations and republished successfully. Final ready plan-fb616ff2-128c-4023-bda4-32a291c8b052 revision1 digesta413d15094f15648a0d43ac81fd44633a493eeec98f4d09e0063e506d3776366 had4readsteps (duplicated same space_get for manifest and data). Helper initially expected3steps, failed BEFORE execution; inspected all4, confirmed read-only and same slug, accepted actual plan. No weakening of tool/effect policy.

Execute source268586 completed39.406s. GLM5.3Flash4calls97975input45440cached397output; Grok4.3review1call13777input192cached21output, verified+fulfills. Actual top-level effective calls exactly space_get1,space_get_view1,space_preview1; no plan_task, no writes, no searches, no duplicate data read. It used the single space_get for both checks and correctly described dynamic labels from dataset despite plan's mistaken literal-HTML assumption. Saved fixture remains activev1, createdAt==updatedAt, unchanged HTML/data, exactly two Pending items; independent native dark390x844 preview visually checked. Mobile data correct, physical paired-phone UI not tested. Completion reply says no discrepancies; do not elevate that phrase into proof the literal-HTML planning assertion was correct. The actual explanation/rendering was correct.

Active brain restored through supported API to original Grok4.6 globally, original controlled session AND new recovery branch pin. WorkerGLM4.5Air (provider servesGLM5.3Flash), judgeGrok4.3 unchanged. Zero active runs. Installed201cc4e... unchanged; no new hotpatch/code edits this continuation. No Claude/Codex tests. Paid50-firm work remains stopped. No commit/tag/push; UI and final merge belong to other agent.

Evidence context-recovery-summary.json/events.json/usage.json, context-recovery-dark-preview.png, recovery plan/execute request artifacts. This proves read-only recovery after a completed write without recreating it, and successful reviewed Plan→Execute on current installed runtime. Smaller auto-branched recovery history did NOT trigger new Execute history projection. Original full write-plan execution on this patch remains cancelled; projection has pure replay + live activation/save evidence, not full projected-turn completion. Speed/token superiority remains unproven; recovery execution still111752input including45632cached. No cause for stalled Grok response was established.

Potential next concrete efficiency target from this evidence: native exact-operation preparation forced2catalog searches and a failed publish after recovery despite tools being configured. Investigate current-source local-definition revalidation/materialization (publish-plan.ts and local-planning-capability.ts) while preserving exact tool schema/account/effect checks; do not simply trust a fabricated capabilityRef or remove authorization. Avoid repeating already-passed business fixtures absent a relevant change.

### 2026-09-20 22:03 UTC — native plan lookup hotpatched and live-accepted; handoff

User emphasized discovery/use of tools absent from memory and asked for handoff status. Preserve this requirement: memory is navigation/context, never a tool allowlist. Native exact-contract lookup is additive; MCP/CLI/Composio discovery remains available and unchanged. Prior live four-lane reads passed, not an exhaustive every-tool guarantee.

New framework change: observeSelectedLocalPlanningDisclosureCandidate in local-planning-capability.ts treats a canonical cap:local reference as a nomination only, checks exact declared/configured registry tool, derives its current work_call schema/semantics and matches the exact variant/ref in a host-issued candidate. publish-plan.ts resolves a missing native disclosure through this path and the existing source-bound disclosure boundary, then performs existing argument/schema preparation. Requires exact current planning identity; does not overwrite changed/ambiguous/corrupt prior disclosures. Existing dispatch/consent/effect checks unchanged. This removes the redundant search-to-copy-schema step that caused the initial GLM recovery Plan refusal.

Build passed; candidate AND installed configured-contract checks verified space_get_view/read,space_preview/read,space_save/reversible. Unknown name, fake read/write variant, noncanonical ref and forged candidate rejected. Installed3.18.17/schema81 fingerprint9cba6ed5f0e3c78d1efef8c3bef57369ba435f4bebd575d8c970f31ffd0ecec6, UI unchanged.

Fresh live Plan source268659/session sess-desktop-c9288c8df389925bb63df74b directly nominated get_view/preview references in the controlled user prompt, no prior source discovery. Completed24.648s with exactly publish_plan1, tool_search0, no business execution; ready/reviewpassed, verified Grok4.3 final. ServedGLM5.3Flash1call17982input0cached609output; judgeGrok4.3 1call8759input192cached24output. Plan-c03d0882-d49c-4aee-b361-19f5ec8a4844 revision1 digest4278a79d5db731ccf86d5d61eacd26eb1ab91596fb8ed65473132786c0a0bfff. This validates direct native nomination/preparation, not all unfamiliar-provider discovery or general speed superiority. No need to execute another preview: unchanged native execution path already accepted in prior recovery test.

Grok4.6 restored globally and fresh test session pin; workerGLM4.5Air/judgeGrok4.3 unchanged. Zero active runs. No Claude/Codex tests, no research restart, no final commit/tag/push. Handoff: docs/checkpoints/2026-09-20-framework-handoff.md. New evidence native-plan-lookup-summary.json/events.json/usage.json, candidate/installed/build/hotpatch logs under output/weekend-harness-2026-09-19. User's other agent owns UI and merge. Goal remains active; broader matched efficiency, projected write-plan completion, proactive memory and paired-mobile acceptance remain unproven as detailed in handoff.

### Post-handoff read-only discovery audit

Previous goal turn made progress: native plan lookup installed/live-accepted and handoff produced. Rechecked shared main and required checkpoints. Source review: tool-search-tool.ts preferred-source lookup falls through to broad providers unless exact live/retained evidence already answers; Composio unresolved search uses index as ranking hints and always starts bounded live search; external MCP resolves exact current definition or refreshes connected server list, with no memory-match prerequisite. Added these specific findings/limits to framework-handoff.md. No new model tests, config changes or hotpatch. Do not elevate architectural findings to an every-tool guarantee. Latest installed9cba6ed5..., Grok restored at preceding final audit; other agent owns UI/merge. Goal remains incomplete on broader efficiency and acceptance.

### Ownership question pending; next context candidate measured offline

After user requested handoff, asked whether further framework changes should stay here or move to the other agent. While awaiting preference, measured existing native plan structure only: verbose binding identity plus host execution draft yields hypothetical6798char reduction per30.7k native Space structure; recovery native plan4902chars. Steps/schemas/descriptions retained in the comparison; no actual projection/code changed. Full artifact remains host authority; arbitrary provider-plan identity cannot be removed on this evidence. Handoff updated with candidate and caveats, plan-bookkeeping-audit.json saved. No model test, hotpatch, configuration change or paid research restart. Current installed9cba6ed5..., goal still incomplete; do not claim implementation or token savings beyond hypothetical serialized characters.

### Handoff regression coverage persisted

Added selected-native-plan-lookup.test.ts, four pure tests covering exact host issuance, forged/noncanonical/unknown references, unconfigured tools/fake effects, and current-schema drift rejection. All4pass. Test observer is process-local; no DB/home resets or live settings changes, no tool bodies/models invoked. No runtime source edit or new hotpatch. Handoff updated. Ownership clarification remains pending; this bounded regression coverage preserves completed framework work for the merging agent. Goal still incomplete; no claim broad acceptance or provider-token efficiency won.

### Completed-run cost attribution consolidated

Read-only analysis of existing accepted summaries, no new model calls or app changes. Four-worker case brain156481input vsworker41202input=3.8×, six parent searches. Judge input share across seven completed cases11.2–32.8%. Prioritize parent context/discovery and duplicated review evidence, not just smaller workers. Saved performance-evidence-summary.md/json and reproducible local summary helper under output; handoff updated. Cases differ in workload/history/models; not an A/B benchmark or monetary cost calculation. Cancelled unreturned request excluded with explicit unknown-cost caveat. Ownership question remains unanswered; no runtime changes while preparing these measurements. Full goal remains unproven.

### Local validation hashes omitted from model context; installed acceptance passed

Implemented a deliberately narrower refinement than the hypothetical bookkeeping removal: `reviewed-plan-model-view.ts` omits only five recognized64-character local-registry validation hashes from the model-facing prepared bindings. `accepted-plan-execution.ts` uses that view. Full immutable artifacts, account/effect/destructive semantics, descriptors, tool names, schemas, exact arguments, source identities, steps and executionDraft remain intact. Provider identities and unrecognized versions/values remain unchanged. Inspection found executionDraft presence controls Execute instructions in orchestrator, and its topology/evidence carry semantics; do not remove it wholesale. Two pure regression tests pass, including artifact immutability and preserving digest-shaped business data.

Three retained four-binding plans each lose1780serialized characters; this is a context-size measurement, not a provider-token or latency A/B claim. Build and installed hotpatch passed. Current fingerprint f920aea33e5669a316ac608aa0b21e85f08b0719ce1b31794f874b0647b606cb, version3.18.17/schema81.

Live Execute source268699/session sess-desktop-c9288c8df389925bb63df74b consumed the previously ready read-only plan-c03d0882-d49c-4aee-b361-19f5ec8a4844 revision1 digest4278a79d5db731ccf86d5d61eacd26eb1ab91596fb8ed65473132786c0a0bfff. Completed38.294seconds: space_get_view and space_preview once each, no writes/searches. All three actual archived model requests contain the projected two-binding structure, preserving steps, schemas and null read-only draft. Grok4.3 verified/fulfills review; independent captured-image inspection confirms Native tools and Memory scope both Pending, legible at dark390x844. This does not close the earlier full write-plan acceptance gap or physical-phone UI acceptance.

Actual usage: GLM5.3Flash3calls55949input17216cached519output; Grok4.3judge1call10569input192cached23output. Total66518input including17408cached. No Claude/Codex test calls. Grok4.6 restored globally and test-session pin; no active foreground runs at terminal audit. Paid research still stopped. No commit/tag/push, UI/sidecar untouched by this change. Evidence: model-view-execute-summary/events/usage.json, model-view-request-audit.json, model-view-execute-preview.png, reviewed-plan-model-view-test/build/hotpatch logs and replay.json under the output directory.

### Model-context refinement: local write-plan acceptance

Installed f920aea3... also passed a fresh GLM Plan→Execute with one controlled local Space creation. Session sess-desktop-2ad32ad617c9f0ab6eca3cfa, Plan source268753 completed62.600s; Execute268803 completed59.033s. Plan75af84a3-354f-4b65-b9a1-c4f1d714143a revision1 digest4e56a48807ae82a88bb28d5fa00f02f9db2761cbf3aa64745b10f9e603bead36. Grok4.3 verified/fulfills both. Exactly one actual space_save and one actual space_get; plan_task{} activated the intact saved draft, and plan_step_result recorded compute completion. All six archived Execute requests preserve the exact three steps/write draft and schemas while omitting local validation hashes. Independent live files confirm framework-model-view-write-1789943386115 at version1, createdAt==updatedAt, records exactly[{marker:verified}], empty sources/actions. Grok restored globally and fixture pin, zero active runs at terminal audit.

Efficiency still incomplete: Plan searched once then repaired an invented id key using publication patching. Execute initially added limit:null and offset:null absent from approved arguments; exact-call validation refused before dispatch, and Clem repaired its call. Optional-null equivalence is a concrete next candidate to investigate against the actual native handler/contract; never blanket-allow argument drift or drop meaningful provider nulls. Plan usage GLM3calls61645input16320cached2088output plusGrok judge2calls17974input832cached49output; Execute GLM6calls170322input66432cached875output plusjudge1call16684input192cached21output. Cached counts included in input.

Evidence model-view-write-summary.json, per-phase status/events/usage, retained plan-artifact.json and model-view-write-request-audit.json under output/weekend-harness-2026-09-19. This closes write-path acceptance for the hash-only model projection, not the earlier cancelled long-history execution or a matched token/speed benchmark. No runtime changes this turn; no paid research restart, no Claude/Codex tests, no commit/tag/push.

### Optional-null correction, installed30a87ba1

Root cause confirmed: ordinary reviewed-step comparison required byte-identical object keys, while reviewed collection-member comparison already accounted for the native args_json adapter filling omitted nullable properties. Unified that existing local-only normalization through reviewed-local-null-arguments.ts and used it in both reviewed-plan-runtime.ts comparison paths. Only actual nulls for named schema-nullable properties absent from the approved expected object are added to the comparison view. No stored plan mutation, provider normalization, non-null default guessing, unknown-field allowance, or overwrite of approved values. Actual call authority/schema/account and host dispatch checks remain.

Two pure tests pass. Exact retained rejected call268847 reproduced the failure on the prior installed code, then passed candidate and newly installed gate replay against the actual live-home reviewed plan/source268803. A changed slug, limit21 and unknown:null still refuse. Installed materializeLocalRuntimeToolArguments independently returns identical prepared args for the observed omitted-versus-null forms; no handler/business dispatch was invoked. This is precise production-gate and adapter validation, not a new end-to-end model run. No model tokens or repeated writes spent.

Build/hotpatch passed; installed version3.18.17/schema81 fingerprint30a87ba1c633a4787d389aa4990c425684a5965fe096bdc3795139ac94d231ad. Grok4.6 brain, configuredGLM4.5Air worker, Grok4.3 judge verified after restart. Prior live read/write acceptance remains evidence for preceding hash-only patch, not a claim that this exact build has completed a new model run. Logs/checker under output/weekend-harness-2026-09-19/reviewed-local-null-*. No commit/tag/push, paid research remains stopped.
