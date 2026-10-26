# Question repair and unresolved memory review

Base: `5587fc3a4537198e8c2b6527eea3a3e67884c543`.

The installed q7 run rejected two question drafts that omitted an independent
answer. The second draft was treated as an honest failure account, entering
disclosure before the existing second repair was used. Question candidates now
remain in the existing repair path. Ordinary honest failure reports still stop
after one repair, and exhausted question repair remains bounded. No new prompt,
reviewer, retry allowance or automatic publication of rejected choices is added.

A separate regression used four real Remember clauses and the existing intake
selector: three facts were promoted while the fourth was absent. Verified storage
of that subset could override an explicit negative completion review when the
next reviewer was unavailable. The existing source/objective-bound review history
now holds both retention fallback paths until a fresh qualified whole-request
review clears the finding. Claims-only scope is not acceptance of a revised
answer. Correction provenance and current canonical storage checks remain
independent. A valid current owner question still pauses without claiming success.
The unfinished-memory message now covers both new memories and corrections.

Validation: genuine question routing RED, followed by GREEN; genuine memory RED
with 12 intended failures and one preserved fresh-positive case. Final stable
controlled suites passed 55 host, 58 memory, and 44 adjacent correction/intake
tests. The focused subsets overlap these suites and are not additional tests.
Assertions about reviewer callbacks are outside caught/fail-open boundaries.
Independent source review found no concrete blocker.

Evidence is retained under the primary checkout's
`output/end-to-end-review-2026-10-26/question-partial-progress/question-honest-stop/`
and `memory-assessment-coverage/`, including exact source, test and log hashes.
These tests establish routing and evidence handling, not live model semantics.
Build, guarded installed hotpatch and new q8/q9 live acceptance are pending at
this commit. q6/q7 remain failed question acceptance cases. The communicated peer
merge boundary remains `cc30bc481` until new evidence justifies changing it.

Scope: framework only; no personal/business data repair, fixture cleanup, new
store, provider change, push, tag, publication or native release. No device,
Windows, full-provider identity, usage/cost or savings qualification is inferred.
