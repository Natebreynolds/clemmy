# 2026-10-15 — conversation lifecycle with memory

Owner, after the boot-scan finding: a long-term storage solution, with memory.
Chosen: compact after 7 idle days, memory-only after 30; fold the 4 GB of
per-step model history in afterwards. Transcripts are kept: measured, the text
the owner can open is about 50 MB per three months of a 21 GB home. The bytes
are Clem's internal records (sealed request snapshots 6.6 GB, per-step model
history 4.4 GB, tool outputs and result handles 1.1 GB, internal events 0.5 GB,
conversation state 0.2 GB). The disk was 96 % full.

## Phase 1 — conversation state in its own table (`bfb548116`, live)

Schema v94 `session_conversation_state` (`fidelity` full | compacted | memory,
`memory_episode_id`, `compacted_at`). The migration moved `__conversation` out
of `sessions.metadata_json` byte for byte: live, 3,102 states and 196,817,526
bytes before and after; session metadata 200 MB → 5.3 MB. Every writer moves
the session row and the state in one transaction; recovery adoption and
protocol repair keep their compare-and-swap on both; `createSession` /
`updateSession` route a legacy `__conversation`.

Boot (live v8, first boot carried the one-time move of about 5.5 s): lanes and
timers 4.6 → 1.5 s, historical reconcile 3.8 → 0.6 s. On the home copy:
parked-approval recovery 1,839 → 337 ms, first rail build 3,869 → 1,495 ms.
Live R28 resumed a migrated chat and answered from its history with no tool
call.

Downgrade: an older daemon on a v94 database ignores the table, so old chats
lose their stored context (no crash). The next tag must come from this line.

## Phase 2 — idle conversations fold into memory (`113d00ed5`, `5fbd3fa77`)

`src/memory/conversation-memory.ts`, `src/runtime/harness/conversation-state-lifecycle.ts`.

- Chat idle ≥ 7 days: the owner's memory model writes its memory from the
  visible transcript only (`learn` job): what was asked, what Clem did and
  found, what was decided, what was left open, references. Stored as a memory
  episode (kind reflection, subtype `conversation`), found by ordinary recall.
- Same age: stored state compacted (`tidy` job): messages verbatim, each tool
  result a 400-character excerpt with its `rh_` handle, reasoning and
  oversized arguments dropped, provider chain cut.
- Idle ≥ 30 days: retired to its memory plus the last four messages. A chat
  retires only once its memory exists; workflow and execution steps and chats
  with nothing visible retire without one.
- A year after the conversation ended, its memory keeps its first line.
- Never lowered: pinned, pending approval, unfinished run, interrupt /
  recovery / held-stop / approval-checkpoint state, a history the protocol
  inspector does not read as valid. Compare-and-swap; the update time never
  moves; a new turn makes the state full again and clears the memory note.
- First pass about 5 minutes after start, then hourly; 15 memories, 150
  compactions and 150 retirements per pass.

Live first pass (v9, 05:04Z): 15 remembered, 150 compacted, 10 retired, none
held. The memories were specific (exact paths, counts, calendar entries).
Copy measurement: 993 compacted + 285 retired in 3.3 s; 708 compacted states
= 11.7 MB.

Request provenance (`82c62ef53`). A past result with a logical projection or
host receipt is checked against it and fails closed on any form it cannot
reverse; only the in-chat canonical clip reverses. The first live pass took
the oldest chats (none of 1,156 compacted results had a receipt), but the next
600 in line held 2,882 receipt-bound results. Compaction now keeps every
receipt-bound call and result whole, and each pass first restores, byte for
byte from the retained tool output, any such result an earlier pass shortened.

Fixture proof on the installed app (R29, a named fixture chat with one
receipt-bound `http_read`): compacted 2,969 → 1,728 bytes with the bound pair
whole, resumed with no tool call and no provenance hold (7.7 s); retired to a
memory note plus its last messages, resumed and answered the code word and
site from memory (4.8 s).

Structured summaries (`4903bbddc`). On the live memory model, effort none did
not switch reasoning off; it spent the 1,200-token cap before the answer and
two summaries came back cut. A structured answer runs with thinking off where
the wire switches it (probe: 565 output tokens, 2.2 s); the cap is a 4,000
runaway stop; an unusable summary is asked again the next day.

Found on the way: since `d2a2c5885` (10-14 ~06:14Z) every background BYO
memory call outside a turn was booked `byo:unowned` (the attempt has no owner,
so its own entry capture never matched). `0266a68ac` lets an ownerless attempt
keep the usage it captured at entry when that usage names only a background
job of the same role.

## Next

- Phase 3: tool outputs and result handles decay on completion. Readers of
  `durable_result_handles` include request provenance and terminal proofs;
  map each reader's behaviour on a missing handle before deleting any.
- Phase 4: the 10-02 lossless model-history plan (non-final checkpoints of
  closed turns; sealed request snapshots).
- Then the 10-12 memory tiers (M0–M4) replace the one-year fade.
