# CLI recovery, managed interactive sign-in, and steering

Parent candidate: f9024b5d410905282287fee8375a9fa5cf8f339a.
Worktree: clem-worktrees/combined-retry, codex/release-integration-0927.
The commit containing this checkpoint is the next source candidate. This is
framework work; no personal org, credential, workflow, or account was changed.
Owner previously asked to prepare changes and choose hotpatch timing later.
No installation, main merge, tag, or paid model test is claimed here.

## Evidence from the owner's actual run

Session sess-desktop-e516b5be896a76d63ee9c8a1, accepted sources 315207 and
315417, installed 03ff91db6cd43de86c80f51d1274b65ce6bb40c2.
Read the live database in read-only mode; do not copy its business records into
fixtures. The source used DeepSeek V4.1 Flash and a Grok 4.7 completion review.

- 315292: the Salesforce query actually executed and returned NoDefaultEnvError.
- 315303 and 315321: remembered username/org targets returned NamedOrgNotFoundError.
- 315351: org-list exited zero, but its empty account list carried saved-auth-file
  warnings from SecKeychainItemCreateFromContent. This is NOT evidence there are
  no configured accounts. The cause of the OS credential-store failure remains
  undetermined; do not claim an expired subscription or promise login alone fixes it.
- Discovery exposed cli_setup and run_shell_command as unsupported_unmaterialized /
  not_declared. Subsequent repair/login attempts were refused before execution;
  the final login attempt also hit coverage_missing. No login process started.
- 315297: owner correction "not outlook from salesfroce" at 05:17:17.189 UTC.
  Another Outlook provider dispatch started at 05:17:26.738, after the correction.
  315312: the correction was adopted at 05:17:30.205 (13.016 seconds later).
  Thus steering ultimately worked but allowed stale work to start meanwhile.

## Candidate changes

1. Fresh model responses yield to owner instructions that arrived during model
   generation, before response admission, dispatch, or final delivery. No stale
   call/result pair or provider response ID is added to canonical history.
   Instructions arriving during asynchronous call preparation also retire the
   unstarted prepared batch through the existing release/settlement path.
   A final check after host-owned provider preparation uses the existing
   zero-crossing refusal/recovery path before the physical reservation. Its
   receipt explicitly records refused_pre_dispatch and zero crossings.
   Already-started calls and completed writes retain their settlements.
   This does not claim cancellation of arbitrary in-flight provider operations
   or a new last-edge guard inside every nested adapter.
2. cli_setup publishes separate, argument-bound auth/install/repair capability
   variants. These configuration operations are truthfully irreversible; read
   inspection never acquires their authority. cli_inspect exposes health,
   declared repairs, and job status as a separate discoverable read-only tool.
   Existing setup spellings remain for compatibility. Consent, exact-source
   coverage, Plan restrictions, and worker restrictions are not bypassed.
3. CLI catalog probe metadata distinguishes configuration_required and
   credential_store_unavailable from signed_out. Explicit known failures override
   exit-zero text and do not keep an old healthy verdict. A fresh verified repair
   of either condition produces the existing recovery transition exactly once.
   Existing workflow/background-task recovery still owns which work may resume;
   this is not a new unrestricted auto-resume mechanism for every chat.
4. Catalog interactive authentication on macOS can use a managed pseudo-terminal
   inside the conversation. A fixed system Expect adapter owns the macOS PTY;
   no native Node/Electron addon is introduced. The original script-based
   approach failed the real round-trip test and was removed.
   Interactive jobs require an exact accepted conversation identity.
   Recipes resolve to one configured executable plus
   literal argv, not a login-shell string. Placeholder recipes are refused before
   execution and need a dedicated secure setup flow. Browser/system prompts still
   belong to the user. No arbitrary command-start API is exposed by the UI.
5. Managed job receipts persist source/session identity, status and timestamps.
   Exact logical-call replays observe the original job instead of spawning again.
   A prior-boot running receipt is interrupted/unconfirmed, not success or an
   automatic retry. Cancellation/timeouts stop the owned process group and retain
   uncertainty about effects already performed. Exit zero alone does not prove
   authentication: the current health probe must verify the connection.
6. Desktop and mobile conversations expose process details, private input and
   Stop process. The endpoints require the existing surface authentication; mobile
   retains device-proof middleware and its /m API. Input/cancel bind the existing
   job to its conversation. Input does not become a chat message or model call.
   Auth output is excluded from model job-status results and all job output is
   excluded from durable receipts. Typed input is masked from displayed output;
   partial and split UTF-8 echoes are held/redacted before display, and
   secret-like environment variables are removed from the child environment.
   Interactive output is process-local, not a saved terminal transcript.
   Process status is not cacheable; mobile refuses an offline snapshot as live.

## Verification and traps

Receipts: output/cli-steering-2026-09-27 in this worktree.
- Final focused recovery/capability/registry/steering-boundary suite: 84 pass.
- Host steering and transport-continuity subset: 11 pass. This includes stale
  calls/answers during model generation, a write retired after real provider
  preparation, and preservation/no replay of prior completed writes across
  model transport interruption. See steer-final.log.
- The managed-job pins exercise real macOS private input, nonzero child exit,
  and cancellation of the actual PTY child, plus source replay, foreign-session
  rejection, restart ambiguity and exit-zero/unverified authentication. The final
  extra Unicode echo pin is recorded in final-native.log.
- API parity pin: authenticated desktop and mobile reads, no-store headers,
  foreign-session mutation rejection, and interrupted restart state pass.
- Desktop and mobile UI builds passed during implementation. Both actual card
  components were exercised in a controlled browser preview: private input,
  expandable output, cancellation and removal of input controls. Phone width 390
  was inspected. No account or process was connected to these preview endpoints.
- Impeccable detector returned no findings. Preview servers/files/tabs were removed.
- Use scripts/run-tests-isolated.mjs for deterministic pins: importing the large
  host test directly initializes configuration before its per-file fixture setup
  and fails authority-payload storage. This is not installed-app qualification.
- The isolation sentinel explicitly could not prove isolation while the live daemon
  was writing the live home. Fixtures used isolated homes; no live-home resets ran.
- Two pre-existing experimental journey edits remain unstaged and unmodified by
  this wave. Never stash, reset, or include them to clean the candidate.

## Installation and acceptance still owed

Build the exact committed source in the clean qualification checkout, then use
the coordinated Terminal hotpatch recipe when the owner chooses to install.
Confirm the served fingerprint and installed bytes, not just the disk stamp.

On the installed app/live home, verify cli_inspect discovery/call and exact
cli_setup action disclosure, then the bounded interactive login path with the
owner completing any required secure browser/OS prompt. Do not reset Keychain,
erase org files, or select a business account from remembered guesses. Confirm
actual account/default selection separately before repeating the original query.
Verify that a correction during thinking and preparation prevents another call
to the abandoned source, and that already-settled writes are not replayed.
Check desktop/mobile input, cancel, offline state and restart receipts; reconcile
whether the original conversation is truly resumed rather than merely reporting
that authentication succeeded. Capture all brain/Jev/reviewer/worker tokens and
wall time on matched work before claiming an efficiency gain.

Scope boundary: this adds managed catalog CLI interaction and fixes its callable
contracts. It does not make arbitrary shell scripts proven read-only, add an
unrestricted terminal tool, or remove the existing raw-shell authority boundary.
The deny-list-based legacy shell approval classifier is not a sufficient sandbox;
any broader arbitrary-script surface still needs explicit execution authority and
separate regression qualification. Do not broaden that surface under this tag as
an incidental way to bypass a missing CLI contract.

The earlier long-conversation, fan-out, workflow, plan-correction, no-replay and
combined release qualifications remain owed. This checkpoint is not tag readiness.
