# Ordinary-conversation journey: what the red test hides — 2026-09-29

Looked into as part of release preparation. Code candidate `47f192e2d`. No source changed here.

## The failure

`src/journeys/ordinary-conversation-competitive-acceptance.test.ts`, third case ("Hey there"): the context packet
is expected to carry `plain_conversation_surface` and carries nothing. The test stops at its first failure.

It is not new. It fails the same way on main `5df6c757e` and is listed as a known limit in
`docs/releases/v3.18.22.md`. Journeys are outside the full suite, so it never blocked a suite run.

## Cause

Two owner decisions disagree, and the later one is the safer.

| Date | Decision | Effect |
| --- | --- | --- |
| v3.16.0 | 130 ordinary chats take a surface with no tools and no preparation | the journey's contract |
| 2026-09-20 (`61c23d22b`, `b4b339a9a`) | A turn keeps its tools unless it is provably self-contained | after a live request was stripped of every tool and failed for 124 s |

The 2026-09-20 rule decides "provably" with a fixed list of openers and arithmetic. Whatever remains after the
opener must be empty. "Hey there" leaves "there".

## Measured on `47f192e2d`

One run of the journey's own 130 requests through the ordinary channel, recording instead of stopping. Scripted
model, isolated temporary home, nice 19. Records: `output/release-gates-0928/ordinary-journey/` (ignored).

| | Requests | Tools offered | Tool schema bytes | Catalog snapshots per turn | Embedding calls per turn | Host time, median |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No-tool surface | 36 | 0 | 0 | 1 | 0 | 41.7 ms |
| Full surface | 92 | 10 | 14,689 | 154 | 1 | 134.5 ms |
| Answered with a question, no model | 2 | — | — | 0 | 0 | 29.2 ms |

By kind, requests on the full surface: greetings 17 of 30, thanks 7 of 30, questions 28 of 30, explanations 30 of
30, text-only writing 10 of 10.

What still holds for all 128 that reached the model: one model request, one terminal, no stop, no graph, no
hidden semantic model, no provider crossing, no skill or workflow ranking.

## Found behind the first failure

1. **Two acknowledgements opening a new conversation are answered with a question.** "Appreciate it" and "Got
   it" reach no model. The host replies "What should I work on? This conversation has no prior message or
   attachment to use as the …" and waits for input. The word "it" is read as a reference to work. The turn had
   already been judged a closed conversational turn one step earlier; that judgement is not consulted. It can
   only happen on the first message of a conversation.
2. **A full-surface turn takes 154 catalog snapshots.** With an empty catalog, as here, each is cheap. The count
   is the finding; its cost with a real catalog is unmeasured.

Neither is fixed here. The release candidate stays the code that was installed and accepted.

## What this does not show

- Live token cost. The scripted model reports no real usage. 14,689 bytes of schema is a size, not a bill.
- Any timing under a real catalog or a real model.
- Variability. One run.

## Direction — not built

Adding openers to the list moves the cliff to the next phrasing, and deciding from the user's words by pattern
is what the 2026-09-20 incident was. The question "does this request need anything outside this conversation"
is a judgement. The router is already asked two typed questions at the start of a turn; this would be a third
answer in the same call, acted on only when sure, with the 2026-09-20 recovery kept: a review that reports
missing evidence returns the turn to the full surface.

It changes which turns get tools. It needs the owner's decision and a matched live measurement before it is
built. The journey is left as written; no assertion was weakened.
