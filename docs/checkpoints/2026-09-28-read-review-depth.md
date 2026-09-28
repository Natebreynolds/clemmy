# Incomplete read evidence must retain reviewer depth

Installed candidate `10e7256e7` passed its source/fingerprint and both web-tree
checks (`output/live-acceptance-review7-0928/installed-runtime-only.json`).
Jev1.13.0 remains on, DeepSeek V4.1 Flash remains the brain, completion review
is on, the selected judge remains GLM5.2 and the actual response is GLM5.3.
The native executable is unchanged; full resource signing is still owed.

## Fresh live findings

- Controlled source318420: exact18 rows, net386144, correct IDs, one canonical
  write, valid full GLM review, no unfinished attempt.35.463s versus45.002s in
  the earlier reviewed run. Input118544 versus118454; uncached47184 versus39670.
  This is a faster sample, not a token-cost improvement. Jev answered in409ms
  and530ms. The verdict now truthfully records served GLM5.3.
- Salesforce source318497 completed instead of stopping prematurely:128.420s,
  14 brain frames,563407 input,137359 uncached,19059 output. It selected17 open
  opportunities and included Task reply records in addition to7 EmailMessages;
  scope differs from the previous19-opportunity run. No clean latency/cost
  comparison is justified. Jev had6 successes and2 timed-out decisions.
- **Accuracy failed despite a positive reviewer verdict.** The answer said
  the other13 deals had zero related activity of any kind. Retained provider
  results show activity on5 non-reply deals. The seven incoming EmailMessages
  and the two additional cited Task records exist; this does not validate the
  unsupported absence claim. Do not report this as a correct Salesforce pass.

## Bounded policy correction

The read review previously used medium effort for every read-only answer and
accepted a positive fast verdict, even when the structured evidence assessment
reported incomplete coverage. Effect safety does not establish factual review
simplicity. On a declared binary-thinking wire, explicit effort may disable
thinking; the selected provider's default should remain available for a review
that must inspect retained evidence.

The production completion path now passes its existing evidence-coverage
assessment into review-depth selection. Incomplete read evidence gets one
review at the selected provider's default depth. Complete evidence retains the
fast path; plan and write behavior, deadlines, fallback settings, Jev, and
claim-correction ownership are unchanged. No extra judge call is introduced.

This is a concrete policy fix, not proof that depth caused this particular
model error or a guarantee that a reviewer cannot miss a claim. Re-run live
acceptance and independently verify the result before claiming the defect is
closed. The installed10e7256e7 does not yet contain this follow-up.

The new pin fails before the fix (`read-depth-red.log`).140 focused checks pass
afterward (`read-depth-green.log`), covering judge depth, fallback, evidence
tools, verdict repair and liveness. Typecheck/build/live acceptance still owed.

## Test-runtime trap and remaining gates

The shell resolves Node22.17.1; the app's Terminal recipe uses Node22.22.0.
Three liveness worker tests fail under the former with unknown `.ts` extension
and pass under22.22.0. The full unit attempt was stopped after discovering this
and the new live accuracy defect. It is incomplete, not green or waived. Use
the explicit22.22.0 executable for the next full run.

The earlier23 ordinary-chat/provider-neutral plan journey failures reproduced
on unchanged main312e95e2d. They and the natural-task byte ledger remain release
gates; the source fixes do not waive those tests. Full candidate qualification,
workflow author/enable/execute, approval correction, long-task continuation,
signed packaging and upgrade acceptance remain owed. No tag has been cut.
