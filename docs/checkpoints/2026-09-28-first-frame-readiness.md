# First-frame readiness — 2026-09-28

Branch `claude/first-frame-readiness`, worktree `~/clem-worktrees/first-frame-readiness`, based on installed
`2a5422d3012390bc02ec9b50b7e7365b12293b64` (`claude/evidence-sufficiency`). Framework only. Private evidence is
under `output/first-frame-0928/` (ignored).

## What the recorded runs show

Two-event request, session `sess-desktop-c421c898a43e7ebc71185661`, source 325491, 48.4 s to the approval.

- The router was asked both turn-start questions once. It leaned to the right remembered run (choice 0.56, fit
  0.67) and to the right operation (choice 0.49, fit 0.63). Each answer fell under its own bar, the planning card
  was published empty, and the brain found the operation by search: 9.5 s of provider discovery.
- Four memory lookups through three tools did not return an address that nine confirmed writes had used two hours
  earlier. A history search found it. Rounds 2 and 3 exist only for that: 7.4 s.
- The nine-event run (source 325147) had finished `done` and reviewed. It left no learned strategy and no work
  episode.

## Cause of the missing learning

A run finished after an approval publishes under the approval decision's source. Its objective, settled calls,
results and verdict belong to the request that was approved. Strategy learning and the work episode were keyed to
the decision's source, found no objective and no settled work, and recorded nothing.

Live record since 2026-09-28T00:00Z: 4 approval-resumed `done` terminals, 0 learned; 13 direct `done` terminals,
11 learned.

## Change

1. **Approved work is learned under the request that asked for it.** The work's source is read from the host's
   durable resume marker (`completionEvidenceSource`), the one publication already uses for the verdict. A marker
   the host did not write names no work and nothing is borrowed. One accepted source is still one observation.
2. **Two unsure router answers that name the same operation are an offer.** When neither turn-start answer is a
   pick, both lean (choice at least 0.35, fit at least 0.5), and the remembered run used the operation the router
   would run first, the run is offered on the first frame. It goes through the existing path: re-attested against
   the live source, published with its schema and bound account, recorded as `proven_operation_selected` with
   `pickedBy: 'jev_corroborated'`. It is worded as an offer, the surface is never narrowed, and discovery stays
   available. An operation the live source no longer offers is not published.
3. **A request's own history no longer crowds what is known out of the memory primer.** A record of earlier work
   repeats the request's words, outranks everything, and is several times the length of a fact. It no longer sets
   the relevance floor for other stores, and facts, notes and policies take their place in the block first.
   Found because change 1 made approved work remembered and four existing tests then lost a standing fact from
   the first frame.

No threshold for a sure pick changed. No new model call, no new tool, no provider or model name in a branch.

## Evidence for the offer rule

166 recorded turn-start decisions, 2026-09-25 to 2026-09-29, first decision per accepted source:

| Outcome | Count | Turn went on to use or prepare the operation |
| --- | ---: | ---: |
| Sure pick under existing thresholds | 18 | 13 (by settled calls only; prepared writes not counted) |
| Would meet the offer rule, no pick | 7 | 6 |
| Unsure, answers did not agree | 59 | not offered |
| Nothing chosen | 77 | not offered |

Seven is a small sample. The one miss queued a pending action instead of calling the operation.

## Verification before installation

- `tsc --noEmit` clean.
- New pins: router corroboration (1 test, 9 cases), host offer and re-attestation (2), learning under the request
  through a real publication with an untrusted-marker variant (2), primer floor and order (5).
- Baseline falsification on `2a5422d30`: the learning pin and the corroboration pin both fail there.
  Log: `output/first-frame-0928/baseline-red.log`.
- Focused regression around the changed seams: logs `focused-1.log` to `focused-5.log`. One existing assertion
  was changed with the behaviour: the memory pointer is sent only when memory holds more than the view shows, and
  with facts placed first every fact may now fit.
- Not the full suite and not installed-app acceptance at the time of this commit.

## Limits

- Verified-write capability learning (`learnVerifiedWriteCapabilitiesForAcceptedTask`) still reads the decision's
  source and the published terminal of that task. It is unchanged and still learns nothing from approved work.
- A remembered address reaches a later request only if the work episode that holds it is recalled and fits. No
  typed person-to-address record is written. Whether the lookups in the two-event run disappear is a live question.
- The offer rule rests on 7 historical cases.
- Work already finished before this change is not learned retroactively.

## Owed

Full suite on a frozen tree, installation, and live acceptance: an approved controlled write that is then
learned, a similar request that receives the operation on its first frame, and the first-frame timings against
the recorded 48.4 s.
