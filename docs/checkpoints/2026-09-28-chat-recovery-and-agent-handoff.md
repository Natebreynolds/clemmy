# Chat recovery, tool argument parity, and agent handoff — September 28

## Installed evidence and changes

The owner reported three issues while release qualification was running. The
served installed app was `292ce2ab35d98117033d9b2848fef0affbadaffc`, fingerprint
`ee61c33464647658fd6b4c8bf9786fe2834505176d29a0a1acfeb2e9d8b95ee0`, PID 2025.
The fixes below are source work, not installed acceptance yet.

1. **Retained query hiccup.** Session `sess-desktop-5d2a1c3a616cc7046275a644`,
   accepted source 319695. Salesforce returned 51 records successfully. Deferred
   `tool_output_query`, call `call_01a0e8e66ac571269efc2336`, attempted offset 50
   with a free-text `query`. Seqs 319758–319759 show `invalid_arguments`, zero
   physical crossings, and `Unrecognized key: "query"`. The next query used
   `fields`, `offset:50`, `limit:5`; seq 319770 returned the last record. No
   Salesforce reauthentication or repeated Salesforce query was needed.
   Direct local tools used a stripping object parser; deferred tools used a
   closed object parser. The direct parser now honors the same closed contract,
   so an unsupported filter/query cannot silently turn into a different read.
   This does not promise models will never propose invalid arguments or attempt
   to interpret arbitrary prose as a deterministic filter.

2. **Missing and duplicated chat display.** The same session had all three
   accepted questions (319695, 319782, 319897) and terminals (319779, 319895,
   319981) in the database and all six transcript messages in the installed
   session-detail endpoint. Desktop accessibility showed an older question
   paired with the second answer and the original exchange missing. A reload
   restored the full saved transcript, then added a duplicate older answer.
   Two defects were reproduced: the stateful chat could seed once from a partial
   query-cache entry and ignore the subsequent fresh history; its reconnect
   check consumed only the first page of events. The live `limit=200` endpoint
   returned seqs 319695–319894 with latestSeq 319983 and a continuation: the
   second terminal was on the next page. The reconnect logic consequently
   treated that completed turn as unfinished. Chat now waits for this opening's
   fresh history before mounting, and checks a frozen paginated event snapshot
   before reattaching. The scan retains only the latest source/terminal, honors
   private pages and exact source identity, and abandons superseded reads.
   Later background refetches do not remount the composer. Saved data was not
   edited, and no Salesforce work was rerun to restore the display.

3. **First switch from Clem into a saved agent.** Session
   `sess-desktop-7ac3c8dcac46f491640503fb`, source 320009, was correctly routed
   as Instagram Manager. The authenticated retained model-request payload
   contains both `Working as Instagram Manager` and its saved specialist
   instructions in stablePolicy. This was not a label-only switch. The owner
   nevertheless received a general sales-operations answer. The handoff helper
   explicitly skipped the first transition from Clem to a saved agent; its old
   test expected an empty note. The helper now consults the preceding accepted
   source's route receipt, excluding the current source's already-recorded
   route. It carries facts/decisions while explicitly retiring the prior role.
   The original agent definition and personal memory were not edited. A live
   rerun must still establish whether this correction resolves the observed
   answer; deterministic context coverage is not proof of model adherence.

## Checks

Output: `output/release-gates-0928/` in the release-gates worktree.

- Failing regressions captured for cache seeding, partial-page reconnect,
  unsupported query stripping (query-parity-red2.log), and first-agent handoff.
- Boundary suites: 34 passed (saved-agent switching, local runtime tools,
  advertised tool contracts).
- Combined fixtures: 113 passed, zero failed/skipped, including 56 provider-
  neutral journey checks and 57 desktop chat/history checks.
- Root typecheck passed. Console typecheck and builds tracked in output.
- No generative test provider was launched in these checks. The owner's live
  runs supplied the production evidence. The live-home isolation sentinel
  correctly reports NOT PERFORMED while the installed daemon owns that home;
  that is not an isolation-proof claim.

## Release continuity

Candidate worktree: `/Users/nathan.reynolds/clem-worktrees/release-gates-0928`,
branch `codex/release-gates-0928`, based on 292ce2ab3. Main and other owners'
files remain untouched. Monitor remains paused.

The provider-neutral journey fixture now exercises current foreground discovery,
account review, exact transport identity, and deferred plan control. Native
Space/workflow authoring uses real handlers and checks admitted logical call,
matching work binding, current lease BEFORE atomic commit, actual durable
content afterward, one dispatch, and successful settlement. The old inner
stub no longer intercepted refreshed native handlers. External refusal/approval/
restart cases still pass. This is fixture repair, not new runtime authority.

The old full-suite orchestrator was deliberately interrupted after 8 of 16
batches: 9,570 passed, three skipped; batch 9 is incomplete, not a pass. That
partial result does not qualify this newer candidate. The unchanged ordinary-
conversation 130-case journey contract also fails at v3.18.21, as do the old
provider-neutral fixtures; last-tag-attribution.log records exact failures.
The ordinary-conversation contract still needs resolution without reopening
provider-discovery regressions or weakening the release gate.

No tag or release-readiness claim: exact-commit full suite/canonical journeys,
builds, installed acceptance of these changes, matched task measurements, and
signed package/fresh-install/upgrade/release-asset qualification remain owed.
