# Read-turn completion review: cost data (2026-10-09)

For the agent that owns the read-turn review path. This is data only; no
change to the review path was made on this branch.

## The turn

A phone chat, read-only question: what is on slide 7 of a deck, and does a
photo on slide 4 sit neatly over its placeholder. No write, no creation
(`settledEffectCount: 0`). Session `sess-mob-9fbb3b30cb3173efbe02eabac913037c`,
source `438506`, judged at event `438872`.

## The review it got

| Field | Value |
|---|---|
| `reviewDepth` | `fast` |
| Judge | the owner-selected judge, a different family from the brain |
| Input tokens | 57,334, none cached |
| Output tokens | 123 |
| Duration | 3.3 s |
| Judged read results | 29 |
| Open evidence entries | 8 (6 unopened, 2 shown) |

Prompt components, from `state/token-usage/2026-10-10.ndjson` (`channel:
judge:completion`, `role: reviewer`):

| Component | Tokens |
|---|---|
| instructions | 2,849 |
| history | 36,687 |
| toolSchemas | 617 |
| providerAndToolOverhead | 17,179 |

The overhead figure is large for a 617-token tool schema. The turn showed a
slide thumbnail (`googleslides_get_page_thumbnail2`, inspection `shown`), so
an image block in the judge request is the likely cause. Worth confirming.

## Why it matters

The owner's rule (2026-10-08): read and answer turns get a light check only,
and a full other-model review runs when something is written or created.
This one was light in depth (`fast`) but not in size: it sent the whole
slide data and probably a picture, uncached, to a second model for a
read-only answer. Uncached input for the whole turn, by role: brain 84,963
over 17 requests, reviewer 60,396 over 2 calls, router 7,811, memory 716.
The review was 39% of the turn's uncached input.

Possible directions, for the owner of that path to weigh:
- cap the evidence a read-turn check receives (headline records and the
  reply, not every judged read in full);
- leave images out of a read-turn check unless the question is about the
  picture (here it partly was: the photo placement on slide 4);
- or route read turns to the in-process verdict only, as the 10-08 rule
  says, and keep the second model for turns with a settled effect.

## More read-turn data (2026-10-10, desktop fixture chats)

The same read-only question ("which drafts mention slide 7 of that deck")
across nine runs on builds 119-122. The completion review on that read turn,
from state/token-usage (channel judge:completion):

| Run | Turn time | Reviewer input, uncached | Reviewer time |
|---|---|---|---|
| C119f1 | 35 s | 31,405 | 3.6 s |
| C119f2 | 64 s | 44,878 | 3.2 s |
| D120f1 | 52 s | 24,570 | 2.9 s |
| D120f2 | 46 s | 42,868 | 4.5 s |
| E121f1 | 25 s | 16,090 | 6.6 s |
| E121f2 | 50 s | 47,582 | 4.5 s |
| E121f3 | 57 s | 48,573 | 3.0 s |
| F122f1 | 58 s | 28,856 | 3.8 s |
| F122f2 | 105 s | 54,108 | 11.9 s |

Every run sent 16-54K uncached tokens to a second model for a read-only
answer; none of these turns wrote or created anything.
