# Weekend refinement checkpoint — 2026-09-19

## Ownership and delivery state

Started from the active Claude agent's checkout, `main` at `b43d8f3c`, in
`~/clementine-next`. The other agent subsequently committed `e5a75f5a` and
hotpatched a separately built worktree with its judge evidence tools and BLOCKED
verdict. Its commit also picked up our shared-file reply-digest and exit-usage
changes. **Its installed worktree build does not contain those two changes**;
the installed JavaScript was inspected directly. A commit SHA alone is not
proof of the installed bytes.

The usage-sidecar edits predate this task and were not changed here.

Our combined candidate was installed after the user unlocked the Mac. The
restarted packaged daemon reports source fingerprint
`2161959b3957643b0df2ab328d9b29dcd674c08ec9b1984b7d6d3b74897b2321`
at `e5a75f5a` with local changes, schema 81/81. Both web asset trees exactly
match their built candidates. The installed JavaScript contains the reply-digest
guard and `runner_exit` snapshot. Daemon, skills, and web asset backups were
retained by the patch helpers. This checkpoint update follows that build.

Live desktop Home now shows “8 updates while you were away” and neutral Update
rows, including the signed-out CLI notices. The initial model-based acceptance
pause was based on a faulty Codex quota reading, diagnosed and fixed below.
Broad scenario acceptance remains pending; do not claim release readiness or
measured efficiency wins.

## Follow-up: false Codex exhaustion fixed in the live app

The user challenged the 100% reading. The current Codex account report showed
1% used and usage allowed. `rate-limit-store.ts` incorrectly multiplied header
values <=1 by 100 even though `x-codex-*-used-percent` is already a percentage.
That converted 1% to 100% in both the UI and judge availability gate.

Removed fraction inference and premature rounding (99.9% is not exhausted).
Versioned new captures with `percentUnit: 'percent'`; legacy windows are
discarded on load because their original values cannot be recovered reliably.
Explicit 429 backoff and unrelated provider data are preserved.

14 focused in-memory tests passed; backend build passed. Hotpatched the real
installed daemon and relaunched, with source fingerprint
`6e15d3ac247a394e247f990399a7de7e854d22b20ba166c54f2146ca47e4dcab`.
The actual provider response persisted 1%, and the native Home badge was
observed showing “Codex wk 1%”. No global model settings were changed.

Live source 237615 (`probe-quota-percent-1789833713691`) answered 17×19 with
323. Its completion judge returned done=true, failedOpen=false, selfJudge=true.
Both review and runner_exit usage snapshots included two calls and 13,706 input
tokens. This validates quota recovery and the exit snapshot, not broad harness
quality or efficiency.

The user also authorized Claude validation. Source 237636 requested
claude-sonnet-4-6, but its response receipt explicitly reported effective model
gpt-5.6-terra. It is not a Claude pass. Direct `claude auth status` reported
loggedIn=false; daemon keychain readiness also reported unavailable. **Correction:
those CLI observations do not establish Clem authentication health.** The user
clarified that Clem owns Claude authentication. The active configuration audit
in `2026-09-19-active-configuration.md` traces the vault-backed SDK credential
path and records contradictory auth/availability signals. Claude validation
remains unproven, not established as blocked by CLI login. Local response receipts are
under `output/weekend-harness-2026-09-19/quota-live-{codex,claude}.json`.

## Findings, ranked

1. **Changed answers inherited stale rejections.** All four carried completion
   verdicts in the initial September 12–19 audit had different reply digests
   from their preceding verdict. Source sequences: 236362, 236629, 237208,
   237460. A corrected answer can use retained evidence without making another
   tool call or saying “done.” The runner now requires an identical reply
   digest before reusing the rejection. Added a corrected-read regression and
   retained the unchanged-failure case.
2. **The cost summary missed repairs.** Source 237460 logged 66,133 input
   tokens over four calls before its correction. Its ledger contains five
   calls, 90,970 prompt tokens, 10,240 cache reads, and 1,827 output tokens
   (82,557 uncached-work tokens, including output). The runner now emits an
   accepted-source cumulative snapshot on every physical runner exit. Review
   snapshots are labeled separately. Consumers must use the latest snapshot,
   not sum snapshots. A runner exit may also mean pause/error, not completion.
3. **A broad memory fallback still treats task briefs as standing rules.**
   Replay of source-backed facts 2851, 3335, and 3467 against today's extractor
   reproduced the issue. A marker and a destination anywhere in a long brief
   were sufficient. Added an asynchronous semantic review only for this
   fallback, using the existing durable queue and configured memory judge.
   Standing output must quote an exact source span; mixed tasks retain only
   that span. Task-only candidates are rejected with a recorded reason while
   the source episode remains. Unavailable or malformed review retries through
   the existing queue. Explicit remember/correction paths are unchanged.
4. **Notifications were presented as completed work.** Live desktop Home
   showed signed-out CLI warnings as green “Done” rows and included them in
   “done while you were away.” Desktop and mobile now use neutral Update
   presentation unless existing typed warning fields indicate attention.
   Notification delivery no longer implies task completion.
5. **Background accounting is not universally attributable.** The initial
   audit found 1,333 rows without an accepted-source identity, mostly source
   `unknown`. Certified token arithmetic does not establish complete task
   attribution. Keep these rows visible and separate; do not assign them to a
   benchmark by timestamp guessing.

Most older pinned one-off memories no longer pass today's extractor. The
existing 48 active pinned facts include useful constraints as well as stale
task text. No blanket cleanup was performed: many older rows lack the original
source, and rejecting their current wording is not authority to delete them.

## Evidence and checks

- `scripts/audit-live-harness.mts` reads SQLite in readonly mode and existing
  usage files, with no runtime imports, model calls, or credential reads. It
  reports source-level totals, changed carried verdicts, uncertified or
  unattributed rows, failed-open verdicts, and pinned-memory sizes. Dates are
  UTC with an exclusive upper bound; current partial tasks remain partial.
- Local audit/build/check output is under
  `output/weekend-harness-2026-09-19/`. No private prompts or memory contents
  are included in the audit report.
- Backend typecheck/build, console build, and mobile build passed.
- Pure standing-review checks: 3 passed. Home model checks: 16 passed.
- Operation-identity check and provider-pin check passed.
- The host regression was added but its isolated-home fixture was **not run**
  for this task. No isolated-home acceptance claim is made.
- The other agent's live inbox source 237566 has `failedOpen: true` because
  its configured judge was unavailable. Its terminal success is **not** a
  passing review or qualification of either agent's changes.
- Desktop notification labels and neutral icons were verified in the restarted
  real app through accessibility state and a screenshot. Mobile assets were
  installed and compared byte-for-byte; physical mobile verification is pending.

## Required live continuation

1. Installation and desktop visual verification are complete for the fingerprint
   above. Before subsequent patches, refresh shared source changes and build
   identity; the other agent remains active. Finish in-flight live tasks first.
2. Future patches must include both web asset trees, retain rollback, and compare
   the running fingerprint and installed bytes; version or HEAD alone is insufficient.
3. Verify the mobile Home on the connected physical device.
4. With a working configured judge, repeat calendar/inbox reads three times;
   include all repair/judge calls and independently verify returned records.
   Exercise the corrected-answer path and repeated-unchanged failure path.
5. Exercise a task-only brief containing standing-looking words, a real
   recurring preference, a mixed task/preference, and explicit correction.
   Verify candidate dispositions, canonical facts, exact source evidence, and
   recall in another session. Soft-forget only the clearly named test facts.
6. Verify Plan→Execute, Act, local Space/workflow creation, restart/resume,
   long-chat compaction, and desktop/mobile state agreement. Do not trigger
   externally sending workflows without task-specific authorization.
7. Run matched-model Claude Code comparisons in fresh, warm, and
   memory-assisted sessions after restoring auth/model availability. No
   comparative win is claimed from unlike models or failed-open results.
8. Validate the installed release candidate against the real home before
   claiming that another user's installation will receive the same behavior.

The broader memory-quality, long-horizon, workflow recovery, attribution, and
release-installation work remains open; these targeted changes are a first
measured increment, not a declaration that the harness is perfected.


## Claude reconnection verified — 2026-09-19 16:19 UTC

Supersedes the earlier expired-grant finding: after the user signed in again,
the running daemon reports Claude configured=true, source=vault, expiry
2026-09-20T00:18:42.243Z. A real no-tools model call through the installed
Claude adapter and live-home vault returned 323 for 17×19. The actual usage
ledger records claude-opus-5, 504 input and 3 output tokens. Global defaults
were unchanged. Receipt: output/weekend-harness-2026-09-19/claude-vault-live-validation.json.
This proves the credential/adapter path works. Full chat/SDK routing and the
broader acceptance matrix still need validation; this was not a full chat turn.

### 2026-09-20 — exact multi-operation discovery follow-up

User requested buttoning up the framework for a rounded hotpatch test, emphasizing intelligence, speed, accuracy and token efficiency. Paid 50-firm research remains stopped. Found multi-name Composio queries fell through to fuzzy search because only one explicit identity was recognized. Updated source to look up each named operation with existing connection/schema validation; updated ranking to keep all exact matches ahead of noisy candidates before truncating the window. Candidate and installed metadata checks pending. No model or business execution is needed for this regression check. Full Grok/GLM acceptance still needs measured completion, worker usage, memory, plan/act and native/MCP/CLI/Composio coverage; no broad performance win claimed.
