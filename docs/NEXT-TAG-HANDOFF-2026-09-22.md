# Handoff: 3.18.20 readiness and the road to the next major tag

Written 2026-09-22, end of day, by the session that ran the day's pre-tag pass.
**For the harness agent** who refines the framework on top of this work. A
separate UI agent owns the console/mobile design changes and will cut the
3.18.20 tag; this document is not for them. Read this with
`docs/checkpoints/2026-09-22-author-fix-suggest.md` (the measurements) and
`docs/JEV-FRAMEWORK-HANDOFF-2026-09-21.md` (the mandate). Nothing here is
pushed or tagged.

## 1. Paste-ready prompt for the harness agent

```text
You are the harness agent for Clementine. You refine the framework on top of the 2026-09-22 work and finish what
it left open. A separate UI agent owns the console/mobile design changes and will cut the v3.18.20 tag; you do not
tag, you do not touch their files, and you do not put unreviewed runtime changes under their tag.

Repo: ~/clementine-next (shared `main` worktree). Read, in this order:
docs/NEXT-TAG-HANDOFF-2026-09-22.md (this), docs/checkpoints/2026-09-22-author-fix-suggest.md (measurements),
docs/JEV-FRAMEWORK-HANDOFF-2026-09-21.md (the mandate), docs/NEXT-TAG-RELEASE-GATE.md ("Candidate and tag procedure").

Coordination, until the v3.18.20 tag is pushed:
- Work in your own worktree on a branch from main: `git worktree add ../clementine-next-harness-3-19 -b harness/3.19 main`.
  The release runtime was gated at dce76b81; a runtime commit on main before the tag would ship ungated. After the
  tag lands, rebase onto main and land your commits one reviewed series at a time.
- The UI agent owns apps/console-web, apps/mobile-web, apps/desktop and .impeccable/. You own src/execution,
  src/runtime, src/agents, src/tools, src/spaces, src/memory, scripts/ and docs/checkpoints/. Ask before crossing.
- Never `git add -A`. Commit only the paths you changed. The owner's own docs/JEV-FRAMEWORK-HANDOFF-2026-09-21.md
  is uncommitted on purpose; leave it.

Binding rules (owner's, not negotiable):
- Implement, do not audit. Every failure you see live is a framework defect to fix at the class level, pinned by a
  test that fails without the fix. No band-aids, no rollout flags, no model or provider names in kernel decisions,
  no new chat verbs; behaviour lives in code, not prompts.
- Test with Grok/GLM for generative work and Jev for decisions. Do not spend Claude or Codex quota on tests.
  Never aim a destructive reset at the live home (~/.clementine-next); isolated tests use their own CLEMENTINE_HOME.
- Measure on the installed app against the live home before calling anything done: one accepted source, one
  terminal, exact settlements, before/after wall, calls and tokens on matched work.
- Launch the app BY PATH (`open ~/Applications/Clementine.app`; `open -a Clementine` starts a stale 3.18.6 copy) and
  confirm gitSha from GET /api/console/build-info before driving anything. Hotpatch only through the Terminal
  .command recipe (memory: hotpatch-terminal-and-held-updater-0922), and only when the UI agent is not mid-cycle;
  a build is required after ANY commit (the fingerprint covers src/, docs/, scripts/ and HEAD).
- Run the full suite and journeys only on an otherwise idle machine; two hung files retire a loaded run early.
  Attribute every failure by name at HEAD alone and at the last tag before calling it pre-existing.

Your work is section 6, in order. One accepted candidate per item: the pin, the live trace on the installed app,
the numbers in a checkpoint doc under docs/checkpoints/, and a memory note of every trap. Report what you
verified, what you skipped, and what is still owed, in that order, in your own words.
```

## 2. Where things stand

| Item | State |
|---|---|
| `main` HEAD | above `032e415e`; 74 commits past `v3.18.19`, none pushed |
| Version | 3.18.20 in `package.json`, `apps/desktop/package.json`, both lockfiles (`ee799093`) |
| Release runtime gated | `dce76b81` (later commits: docs, the readiness-hold retirement `fe0d5b52`, the dead-occurrence sweep `bf684668`) |
| Installed app | sealed 3.18.19 bundle, daemon hotpatched by the other agent (`7eb11623` at 16:06 PT); my last install was `a7099a68` |
| Updater | `pending.held-20260921-215159` still held (see prompt) |
| Worker role | claude-haiku-4-5 (restored); brain grok-4.6; judge grok-4.3 |
| Owner's uncommitted file | `docs/JEV-FRAMEWORK-HANDOFF-2026-09-21.md` — theirs, leave it; it makes the packaged-upgrade gate refuse in the working tree by design |
| Other agent's WIP | `apps/console-web/src/components/{AppShell,ModelStatusChips,automate/WorkflowDrawer}.tsx`, `.impeccable/critique/…` |

## 3. Tested and fixed since v3.18.19 (what a user notices)

**Judges and Jev.** Reviewer hedged behind Jev, never raced (`610411f8`). Every judge call carries a lane so spend
ranks (`6dfa3583`). Goal reviewer reads the person's gate decision (`2517ec44`, `b382e4b4`). Proven-strategy Jev
call capped at 2 s on the critical path (`67ae7ea3`). Reviewer's change note verified by Jev before the gate
re-asks, judge-model backstop when Jev is slow (`6be305a7`, `930c755f`); live: `applied` 0.86 in 3.5 s. Trajectory
read beside the watcher, recorded not trusted (`a1f1f986`).

**Human-in-the-loop workflows.** Approved step performs what was approved (gate coverage); change request revises
the producing step instead of cancelling; drafts and approvals read as a person would on desktop and mobile; Space
re-projects on a dataset write; external sends mirror in-app (`9e77e697`, `d0235ba1`, `6be305a7`, `178e896d`,
`5220d8d1`). Ten paused occurrences are one decision (`99fd2b43`). Live: prospecting and content-calendar journeys
green end to end, including the revision loop.

**Authoring, fixing, suggesting.** Enable/update/edit settle inside the call; a failed creation test hands a
one-call patch; exact call steps with `{{now}}`/`{{now+24h}}`; strategies scoped chat vs step; suggestion watch
raises one plan card; drawer follows the creation test (`b7f93fc6`, `6305b3d9`, `f32c573b`, `cbfff5c8`,
`4857b064`). Live: fix journey 173 s → 120 s; authoring ends in an exact calendar call step.

**Proven turns.** A strategy thins the surface only when its keywords and the request's mostly coincide
(`1a49645e`, `1776a5b1`); no more placeholder-question dead ends; calendar turn 49.6k prompt tokens on the target
shape.

**Capability chain.** A saved provider step proves its operation in-process on a cold daemon, both step paths
(`c839caad`, `3c3bf2e9`) — the class behind 12 runs parked "not connected" after launches; cold proof 4 s. Park
messages carry their cause (`516a0d17`). Several accounts park as a choice, never "connect" (`a11d7ca7`); console
and scheduled runs route through the authoring conversation (`40546b7d`, `f548acbb`).

**Calendar watch** on a heartbeat contract with live per-account observation, Graph zones, one item per event,
in-app only (`f8b5ddf8` … `e1011bc8`).

**Models.** Codex-subscription models discovered live, sign-in refreshes the picker, six-hour heartbeat
(`dce76b81`). Live: OpenAI catalog 8 → 12 on one boot, gpt-6 family visible.

**Ops truthfulness.** Parked runs stay parked at boot; reaper resumes onto the current record (`668c09a4`); stale
readiness holds retired once the workflow ran again (`fe0d5b52`); occurrences that never worked are cancelled once
a newer one exists, on boot and on demand (`bf684668`); surfaces never advertise a door they lack (`8a432718`).

## 4. Gate evidence on the release runtime (`dce76b81`)

- Typecheck; release-asset 56/56; release closure 137/137; public hygiene 4/4; fresh-install smoke; packaged upgrade
  21/21 in a clean worktree.
- Full isolated suite: 16,654 tests, 16,517 pass, 127 fail, 47 min, first full completion in days. Every failing
  name attributed alone at HEAD and at baseline `eebd4239`: zero regressions; 54 files carry pre-existing failures
  (`host-turn-runner` 37, `loop` 8, `rubric-characterization` 6, planning-card recovery 5, …); load-only flakes pass
  alone.
- Journeys: 174 / 131 pass / 43 fail, against 166 / 130 / 36 at the tag; the only HEAD-only names are one
  local-LLM + Firecrawl file that fails whole at the tag and per test now. One journey fixed. No regression.
- Live on the installed release daemon: calendar read, Space update from the dock, workflow listing; one accepted
  source and one terminal each.
- Re-run recipe: `npm run build && npx tsc --noEmit`; `npm run test:release-assets`, `test:release-closure`,
  `test:public-hygiene`, `test:smoke:gate`; `test:packaged-upgrade` in a clean worktree (`git worktree add … <sha>`,
  symlink node_modules); `npm test` then `npm run journeys`, each alone.

## 5. Open, stated plainly

- Judge availability has no Claude-quota awareness (`claudeAvailable()`); Jev fallback covers it.
- Jev trajectory verdicts recorded, not enforced — owner decision once there is data.
- Mobile half of the review journey not driven (pairing token must stay out of transcripts); desktop was.
- Restart / repeated-tap continuation, the mixed unfamiliar-tool task, the retained-memory correction: pinned or
  earlier-proven, not re-driven on this candidate.
- Revision judge's model backstop pinned only; Jev answered inside its cap every time.
- Latency: the 600 s silence wall before a retry (four stalls in one evening were the Mac's network path, Slack
  pongs failed 52×); the one-off first-call recovery after a launch (a transient account refresh); size both to the
  request.
- Codex dispatch still identifies as the shipped client version; if the backend refuses a newly listed model for
  it, the client-version constant in `codex-model.ts` is the fix.
- Test debt: 54 files with pre-existing failures; the two hang-prone files (`constraint-guard`, checkpoint-process;
  `balanced-user-stops-ordinary-channel` in journeys).
- UI owed: a "Clean up old occurrences" control on Workflows calling
  `POST /api/console/workflows/dead-occurrences/sweep`.
- Fixtures in the owner's home to delete: workflows Invite digest B, Invite digest, Digest check, Digest check 2,
  Whats on my calendar today, Prospect outreach review, Content calendar review; Spaces Prospect campaign, Content
  calendar; plan proposal `plan-a1f3b23e`; the pending "Send Slack message" approval (send-mirror live proof waits
  on it). Two kept occurrences await a decision: today's daily-standup-email, the platform-49 review from 09-15.

## 5b. The Jev handoff's definition of done, row by row

| Row | Status on this candidate | Evidence or gap |
|---|---|---|
| Simple task with a known tool | Done | calendar read on the installed release daemon, 2 calls, 49.6k tokens on the target shape |
| Mixed task discovering an unfamiliar tool | Not re-driven | earlier waves proved discovery; not repeated on this candidate |
| Native workflow creation with a human review step | Done | prospecting and content-calendar journeys, gate → note → re-draft → approve |
| Find and respond to the review item on desktop | Done | approval card with a person-readable draft, approve and request-changes |
| … on mobile | Not driven | pairing token must stay out of transcripts; mobile renders through the same presentation code |
| Request for changes preserves draft identity, invalidates stale approval | Done | `step_invalidated` under the run slug, consumed approval ids ignored, Jev `applied` 0.86 |
| Account choice during creation testing, preview preserved | Done earlier (`1f045ec6`, `a11d7ca7`) | not re-driven today |
| Approval/response continuation after restart, repeated taps, no duplicates | Pinned, not live | the v3.16 "approval/resume write" canary is still deferred; item 1 of section 6 |
| Correct cancellation and truthful partial failure | Done | refused writes named as refusals; dead occurrences cancelled with reasons |
| Retained-memory correction affecting a later task | Not re-driven | |
| Before/after correctness, time, tokens, interventions on matched work | Done | tables in the checkpoint doc |

## 6. Direction for the next major tag (candidate name: 3.19 "trust to walk away")

The gate doc has carried three canaries since v3.16 as "deferred to v3.17": approval/resume write, the durable
pilot, and the P1/P3 end-to-end mutation canary. They are still deferred. The next major tag should be the one
that stops deferring them. In order, each with its exit evidence, measured on the installed app against the live
home:

1. **Approval/resume write canary.** A gated external write approved on the phone after a daemon restart, tapped
   twice, executes exactly once; the mirror shows one send. Exit: run record, one physical dispatch, one mirror
   item, pin for the double tap. (Closes two Jev definition-of-done rows: restart continuation, mobile response.)
2. **Durable pilot.** The "reviewable opportunity → questions → disabled pilot → review → approved workflow + bound
   Space" lifecycle from the gate doc, driven once from a cold request for a non-calendar dataset. Exit: the
   Space renders records with provenance, the next occurrence is scheduled, the pilot never sent.
3. **P1/P3 mutation canary.** One workflow that reads, drafts, gates, sends, and reconciles an uncertain write
   after a killed process. Exit: zero duplicate effects across the crash matrix, the report-back names the
   uncertainty honestly.
4. **Judge under quota.** `claudeAvailable()` learns quota; the judge lane meter shows the switch. Exit: a
   forced-quota test where the review completes on Jev or Grok, never fails open silently.
5. **Latency walls sized to the request.** Silence wall and first-content wall derived from prompt size and the
   provider's observed p95; a small prompt retries in tens of seconds, not ten minutes. Exit: the stall pin plus
   one live silent-frame trace.
6. **Trajectory trust decision.** Present the recorded Jev trajectory verdicts against the watcher's on a week of
   traffic; the owner decides enforce or drop.
7. **Unfamiliar-tool task, cold.** One request discovering a provider the home has never used, through the same
   loop. Exit: one search, one exact call, one terminal, tokens within the calendar turn's envelope.
8. **Test debt paydown.** Retire or fix the 54 failing files by contract, never by weakening; make the two hang
   files bounded so a full run completes under load.

Do not add chat verbs for any of this. Every item is a contract on the runner, the kernel or a judge, with a pin
that fails without the fix and a live trace on the installed app before it counts.

## 7. Traps that cost time today

- A docs-only commit after a build makes the hotpatch refuse; rebuild after the last commit.
- `open -a Clementine` launches the stale /Applications copy; the old daemon took the live home for a minute.
- The full suite dies at ~11,000 under load (hung file); on an idle machine it completes at 16,654.
- A weeks-old `blocked_readiness` or parked record reads like today's failure in the UI; check run records by
  `finishedAt`/`createdAt` before believing a card. Both classes are now retired automatically, but only on a
  build that carries `fe0d5b52` and `bf684668`.
- Slack websocket pong timeouts in the daemon log are the tell for a degraded local network; model stalls in the
  same window are not the harness.
