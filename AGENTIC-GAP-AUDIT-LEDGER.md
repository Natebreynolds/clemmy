# Agentic Gap Audit — Ledger (2026-06-15)

Source: an 8-lane grounded audit (memory injection/retrieval/round-trip ×3, chat, workflows, workspaces, background, agentic-loop) — each gap adversarially re-verified against the code. **11 confirmed-real, all additive/forward-only (extend an existing primitive, no duplicate code).** Plus one found independently before the audit (constraint enforcement cap).

Stress harnesses guarding the fixes: `npm run bench:gates` (safety gates), `npm run stress:memory` (memory round-trip), and new per-fix tests.

| # | Sev | Area | Gap | Status |
|---|-----|------|-----|--------|
| 0 | HIGH | memory/enforce | `listConstraints()`/`listPinnedFacts()` capped by recency → an old critical constraint silently un-ENFORCED (>20) / un-injected (>12 pins) | ✅ FIXED (uncap enforcement, importance-rank display, elision note) |
| 1 | HIGH | memory/dedup | Nightly stored-embedding dedup (`consolidateActiveFacts`, cos≥0.95) has NO entity guard → can erase a distinct client/account/table fact | ✅ FIXED |
| 2 | HIGH | memory/merge | `mergeParaphrases` entity guard is seed/canonical-relative, not pairwise → a no-anchor fact bridges two entity-distinct facts into one cluster | ✅ FIXED |
| 3 | HIGH | memory/write | Standing rules captured as user/feedback facts never become `kind:'constraint'` → dispatch gate never enforces them | ✅ FIXED |
| 4 | HIGH | chat/context | Native MCP tool outputs bypass the per-write recall-clip → land RAW in chat history (context blowup in long chats) | ✅ FIXED |
| 5 | HIGH | workflows/choke | Single-slot run drain (concurrency 1) + unbounded `forEach` items = head-of-line blocking that wedges the workflow queue | ✅ FIXED |
| 6 | HIGH | agentic/deliver | Decision-level `awaiting_approval` strands the run silently — no card/reply delivered (the symmetric `awaiting_user_input` hole was patched; this one wasn't) | ✅ FIXED |
| 7 | HIGH | background | A background task paused on `awaiting_approval` has no terminal-state recovery and is invisible to the watchdog | ⬜ |
| 8 | MED | workflows/resume | `forEach` crash-resume can double-fire a send/write (forEach exemption skips the crash-resume HALT) | ⬜ |
| 9 | MED | workspaces | Concurrent `refreshSpaceData` for the same slug clobber each other's `data.json` (lost update) | ⬜ |
| 10 | LOW | memory/pin | A standing rule lands non-pinned without a literal email/list token → objective-scoped recall can evict it at action time | ⬜ |
| 11 | LOW | memory/observ | Auto-capture fact write is fire-and-forget with a swallowed catch → eventlog reports 'learned' even when the fact never persisted | ⬜ |

Order of attack: memory data-loss (1,2) → memory constraint round-trip (3,10,11) → workflow choke/double-send (5,8) → chat context (4) → delivery/background (6,7) → workspaces (9). Each fix: extend the named primitive, add a regression test, keep the suite green.
