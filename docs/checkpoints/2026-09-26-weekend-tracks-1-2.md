# 2026-09-26 weekend wave: approvals that show and iterate, a checker that fixes, Jev that settles

Branch `claude/checker-evidence` (worktree `~/clem-worktrees/checker-evidence`), based on the
v3.18.21 tag (07fb6f850), head 722959296 when this was written. Nothing pushed. Installed app: daemon hotpatched at 2ef56dc9d on
2026-09-25 16:32 PT; everything after that commit is **not installed**.

This checkpoint holds the provenance that framework comments no longer carry: source comments
state the rule only; the dated incidents, counts and measurements behind each rule live here.

## What landed, and why (provenance)

| Commit (branch) | Rule | What we saw live |
|---|---|---|
| bce0bad61 | An approval card shows the exact arguments it will send; the host's filler prose does not repeat the card | 09-25: two Slack approvals read only "Slack open dm" and "Send Slack message"; the message text never reached the card and the owner approved without knowing what. The host's "Approval required…" filler read as a second card and invited a typed answer. |
| 82b71712e | Headless Claude calls get the reasoning tier they ask for; none/minimal switches thinking off | 09-25, one account-routing verdict, same model and prompt: 297–492 output tokens in 5.3–6.4 s with thinking, 68 tokens in 2.5 s without, same verdict. The CLI had inherited the user's settings effort level. |
| 82b71712e | Account selection runs without extended thinking | 09-25: that call held a Slack write turn's tool search for 7.9 s, almost all hidden reasoning. |
| b9849f976 | A question shows the question, not the retained-work checkpoint | 09-25: a clarifying question arrived followed by "Source/tool …calendar_view: 83 records (complete) retained as rh_…". |
| 37c735a8e | Memory extraction runs at low reasoning | 09-25: 72 extraction runs in a day, about 1,500 output tokens and 21 s each at default depth; on one batch, low used 343 tokens in 4.7 s against 2,195 in 20.8 s (4 facts kept instead of 7). |
| 5c1f214e0 | An approval card names the ids it shows | 09-25: a card read "users U…" (a bare Slack user id); the owner could not tell who the message was for. |
| 2ef56dc9d | Change a waiting approval by writing back | Owner request 09-25: natural-language iteration on the pending action. |
| 8f234eaba | Pre-send check against standing rules; the card shows conflicts, the owner decides | 09-25: an email went out naming a tool the owner had asked never to name in emails; the rule was already in context and the card showed only subject and recipients. |
| 528eb207b | The mid-task watcher runs on Jev only | Owner decision 09-25. The flagship watcher cost about $15 on 09-24 (62 Opus calls) and delivered no steer on 09-25 (24 reviews, all on track). The old "214 of 217 agreed" comment is not supported by harness.db (jevShadow rows start 09-22). |
| 78aeb8e60 | One review pass lists every finding; the fix touches only those; the owner's note is cut only between items | 09-25: the review note stopped mid-sentence at a fixed 240 characters; multi-round rejections (302318: 6 checker calls, 377k tokens). |
| ec096be52 | A claims-only finding never ships inside the answer | 09-24 and 09-25: "SEO snapshot" delivered blocked while still containing the flagged figures. |
| fb4bf993a | Reasoning effort follows the work within a turn | 09-25: "quick" asks that gathered many results drafted at tier none; first drafts carried wrong figures, each rejection adding 15–55 s. |
| 8f4a3bf3f | The completion reviewer sees what earlier turns checked | 09-25: "I checked beforehand: the folder did not exist" was ruled unverified and a finished save ended blocked. |
| 69c4e0edd, f654074ad (wk-one-card) | A call that delivers nothing stops asking separately; sends keep their card | 09-25: messaging a teammate took two calls; opening the DM (returns an id, delivers nothing) was carded as an irreversible send by a name token; the owner approved it and never opened the second card, which held the message. |
| eaf83e493, 74546ebee (wk-checker-quota) | A used-up checker plan moves the review to the next family instead of passing unreviewed | 09-21: every review failed open while the Claude plan window was used up. |
| 255c69f68…2e479d55a (wk-approval-resurface) | One reminder 30 minutes after an unanswered formal approval; expired cards say so | 09-25: an approval's channel copies were held 56 minutes by open chat views and never answered. Across the live registry 154 of 173 approvals were answered within 30 minutes. |
| 3670a2d43 | Jev settles a plain read-back (calibration below) | 09-25/26: Jev abstained on 23 of 23 completion checks. |
| 00bc1d417 | An expired approval reads "expired — not run" on Discord too | The approval-expiry card change covered desktop and phone; Discord's live status still called it "rejected". |
| 6959542cc | A confirmed change in another app shows its card as soon as the provider confirms it | Receipt cards rendered only after the answer was written and checked; the plan item "receipt first after a send". |
| a09da60c6…67789e5f0 (wk-honest-effects) | file_query opens any settled result; only a change the consent affirmed reads as a write; the ledger carries the consent's reversibility; merged recipient strings split into addresses | 09-25: file_query refused write results (60 of 60 recent host writes had no nonce row); a "write completed" line for calls that only returned data; a send recorded irreversible=false; a merged recipient string recorded as a third target. |
| 722959296 | tool_output_query computes exact figures (where / sort_by / aggregate); lean rules: stated figures come from it | 09-25: 7 of 13 checker rejections were factual, mostly miscounted or misread figures (a top-3 keyword count, a rank 42+ vs actual 76, review counts, a word count, a weekly MRR sum). |

## Jev completion calibration (3670a2d43)

Decision log `state/jev-decisions/2026-09-25.ndjson` and `2026-09-26.ndjson` (UTC days), joined to
`goal_alignment_judged` in harness.db (read-only). 23 completion checks, all answered (no HTTP
errors, no timeouts), all abstained under the old rule (support question ≤ 0.15).

- `unsupported` never fell below 0.20. Checker-passed answers read 0.20–0.61; the answers add
  inference and offers no result states word for word (e.g. a workspace-roots read-back added
  "all seven are local directories under your home folder"; Jev read 0.61, the checker passed it).
- Within delivered ≥ 0.85 and unaddressed ≤ 0.15, the closest checker-rejected answer read 0.66
  (a miscounted word count). Clipped evidence: 11 of 23.
- New rule: delivered ≥ 0.85, unaddressed ≤ 0.15, unsupported ≤ 0.4, evidence not clipped, and
  not sure (≥ 0.85) that a figure is computed. On Friday's data this settles 4 of 23 (17%): a
  Spaces list, an overwrite check, a backlink count and a page count, all checker-passed.
- The plan's "Jev settles a third" needs a better signal than the support question. The new
  `computed` question is recorded on every call; recalibrate once a day of rows exists.

## Where checker time went (09-25, 1,927 reviewer model-seconds vs brain 849)

Post-turn reflection 779 s (now at low effort, 37c735a8e) · workflow mutation-constraints judge
369 s · chat completion judge 206 s (but the largest uncached input: 790k, 45k per verdict) ·
workflow goal-fidelity 178 s · fact upsert 97 s · memory signal 94 s · consolidation 72 s ·
watcher 64 s (now Jev only). Jev settling completion checks buys turn latency (checker p50 6.0 s,
p90 11.1 s); the model-time target runs through reflection and the workflow judges.

## Decisions owed by the owner

- Live `.env` has `CLEMMY_JUDGE_CHAIN=off` (set 09-20 for single-provider testing): as installed,
  a used-up checker plan records the quota reason but nothing stands in.
- The only stand-in for the owner's setup (BYO brain, Claude checker) is the cheap Codex checker.
- Migration v82 (`pending_approvals.reminded_at`) belongs to the reminder; any other branch's
  migration must be v83+.
- On first boot after install, the still-pending apr-gzo6 gets one reminder about an interview
  that has already passed.
- Presence deferral still delays an approval's first channel copy while any chat view is open;
  worth capping.

## Still to build on the plan (as of this checkpoint)

- Track 2: a better Jev completion signal to reach "a third" (the `computed` question is logged on every call now; recalibrate from a day of rows).
- Track 3: proven operations bind directly (agent branch `claude/wk-familiar-direct`); people lookup as a skill; learned hints keep shape, not values.
- Track 4: landed writes stay landed + posts confirm from the provider reply (agent branch `claude/wk-landed-writes`); failing sources back off; one notification per outcome.
- Track 5: merge to main + one release (with `claude/wk-model-handoff`), CI green, journey triage, stale interrupted chats, stale memory notes; fixture removal after the owner sees the list.

## Owed before this is "done"

Live acceptance in the installed app with named fixtures for: approval preview + labels + change
by reply; pre-send check conflict; one card for a DM open + send; reminder after 30 minutes;
expired card; claims removal; Jev settling a read-back; checker stand-in under a used-up plan.
