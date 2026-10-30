# Quick voice access — October 29, 2026

The owner stopped the Claude validation watch and requested implementation of
fast, robust voice access from iPhone widgets, Shortcuts/Action button, and Apple
Watch, with a practical end-to-end test. Automation
`review-clem-jev-integration` was deleted. Work is isolated on
`codex/voice-quick-access`, based on clean peer source
`1eb9d213dedac439cf312a3073c4e1f8b8c270c1`. The peer checkout, running Mac,
settings, authentication and personal integrations were not changed.

## Implemented

- Phone: Check in, Ask Clem, Read latest, Retry original and Talk live actions.
  Siri actions return both dialog and a String so a Shortcut can add Speak Text.
  The quick widget offers Check in and Talk live. Native quick actions require
  iOS 18 and existing native voice enrollment; iOS 17 keeps existing Talk.
- A foreground live action stores a pairing-bound one-use receipt. The paired
  page consumes it before navigation acknowledgment, waits briefly for the same
  foreground conversation's history, and starts existing GPT-Live directly.
  URLs alone do not record. Drafts, files, busy work, backgrounding, expiry and
  conversation changes prevent automatic recording.
- Phone live transport stops a microphone granted after cancellation, aborts
  connection setup, ignores late connection answers and exposes voice errors.
- Native requests retain immutable text/body/key before dispatch. Read latest
  never submits work. Explicit Retry original can reuse the original request
  only after its exact missing-receipt response; accepted tasks never re-POST.
  Typed terminal status distinguishes completed answers from owner questions
  and approvals. Recoverable owner holds are re-read. Completed answers remain
  monotone. Pairing/generation checks fence actual result publication.
- A real Watch companion adds Siri/system-dictation Ask, Check in, and Read
  latest. The phone relays proof-bound requests; no credentials go to Watch.
  Foreground Watch result polling is bounded, cancellable and read-only. Exact
  pending keys survive uncertainty. A presentation owner prevents UI speech
  from repeating Siri's readback. Watch intents require device authentication.
- Authenticated no-store `GET /m/api/voice/check-in` reads a bounded retained
  briefing without models, connected-tool searches, watcher execution or
  mark-read/reconciliation writes. It reuses canonical approval/question/plan
  gates and watch/run projections. Two saved watch findings include recorded
  timestamps and status. Omitted sources and unavailable data stay explicit;
  the primary-decision subset never claims to be the full Inbox or all-clear.

## Verification and evidence

Evidence is in `output/voice-quick-access-2026-10-29/` in this checkout.

- Frozen combined whole-file web/backend checks: **80 passed**, no failures.
- New iPhone tests on a fresh, unpaired simulator: **19 passed**.
- Exact copied Watch protocol/state/ownership source and tests on the Mac host:
  **17 passed**. This does not execute the Watch transport/UI on watchOS.
- Full phone+embedded Watch native build and Watch unit-test build succeed.
  No watchOS simulator runtime is installed; the 11 native Watch access tests
  compiled but were not executed on watchOS.
- Backend configured typecheck/build and mobile production build succeed.
- A controlled Chromium fixture exercises the real mobile voice control and
  protocol with synthetic audio/service boundaries: two ordinary chat turns,
  one live session, delayed history readiness, committed readback only, and no
  microphone for an unauthorized URL. No real microphone or provider call.
- Native metadata contains/trains all five iPhone and three Watch shortcuts.
  The unsigned simulator test host logs metadata-provider registration error
  9004 before tests start. Actual signed-device Shortcut discovery remains
  unqualified; extraction alone is not runtime success. The existing startup
  registration follows Apple's sample and was retained without a retry patch.
- Failed fixture/build attempts are retained, including corrected initial test
  fixture syntax, missing browser binary/resolution, and native class-protocol
  conformance. They are not counted as passing acceptance.

No installed-app/live-home, real microphone, real connected-app, signed phone,
physical Watch, off-LAN, or all-leg latency/cost acceptance is claimed. No
install, restart, upload, push, tag or external agent message occurred.

## Next step

Installation/restart remains reserved to Claude by the owner's earlier
instruction. The reviewable voice candidate needs explicit transfer of that
ownership before a matching Mac/native installation. Then follow the controlled
device test recipe in `apps/ios/README.md`: actual Shortcut discovery, widget
launch, two conversational turns, a scoped read/discuss/draft, slow-task result
recovery, locked/offline behavior and separate Watch execution. Record useful
spoken response time and voice/backend usage; synthetic timings are not
performance or savings evidence.
