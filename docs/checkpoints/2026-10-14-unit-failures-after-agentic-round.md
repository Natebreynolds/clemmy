# 2026-10-14 — main unit failures that arrived with the agentic forward-motion round

For the agent working on `codex/agentic-forward-motion`. Your round through
678f52d14 was merged to main (8f50d12b7) and shipped in v3.18.38 (ca46db422).
CI's unit job on main has failed on every push since the merge. Eight of
22,519 tests fail on the release commit (run 38578411103):

| Test | Since | Cause |
|---|---|---|
| held parent and migration child have exact minimal runtime import closures | before the merge | pre-existing |
| measured catalog is exactly equal and diagnostics cannot mutate authority or leak fixture data | before the merge | pre-existing |
| explicit stop cancels a scheduled automatic restart (desktop supervisor) | release commit only | hook failure, likely runner timing |
| the exact reservation terminal clears logical uncertainty after readback reconciliation | e8d034cdc | this round |
| exact conditional lookup gets no setup card on its first call and reuses proof with models unavailable | d2a2c5885 | this round |
| changed arguments, recipient and definition cannot inherit an exact lookup proof | d2a2c5885 | this round |
| an exact lookup proof cannot cross accounts or override outbound/destructive evidence | d2a2c5885 | this round |
| a matching Tool Memory row receives the live fingerprint without a provider fetch | 9e94f693e | this round |

The five round failures reproduce on your current tip 152d8f101, so they are
not a merge interaction. Bisected on the three files
(`host-interactive-consent-learned-delivery.integration.test.ts`,
`settlement-audit-platform-plane.test.ts`, `tool-search-index-nomination.test.ts`):
19242ca9b 0 fail → e8d034cdc 1 → d2a2c5885 4 → 9e94f693e 5.

## Reading of each

- **Learned delivery and tool memory (four tests).** `learningHold(scope)`
  now suppresses learning unless `readTurnLearningPolicyForScope` returns
  `allowed`. These fixtures call with a session id but record no accepted
  source in `source_session_contexts_v1`, so the scope is `unavailable` and
  learning is held: the conditional lookup falls back to its card
  (`needs_user`, "destructive, irreversible, administrative, or a sealed
  bulk mutation") and the Tool Memory row keeps no fingerprint. In a real
  turn with a readable accepted source the policy is `allowed`, so this
  looks like fixtures written before the rule. Please confirm the exact-call
  conditional lookup path passes `sessionId` and `sourceUserSeq` (or runs
  inside the source context) in production; if it does not, every first
  conditional lookup shows a card.
- **Readback reconciliation (one test).** An orphaned reservation followed
  by `external_write_succeeded` with `reason: reconciled_present` and an
  `evidenceCallId` now audits `uncertain_write` with
  `blockingUncertainWrites: 1` and `confirmedWrites: 1`. The fixture's
  evidence id names no settled read in the ledger, so the stricter
  "verified effect evidence" rule from e8d034cdc may be correct and the
  fixture stale. Please confirm that a real readback reconciliation (the
  write-freeze path from dc5dd5855, where the model reads the target after a
  dark write) still audits clean. If it does not, a write Clem read back and
  confirmed would still end the turn as needing reconciliation.

Nothing in these files was changed on main; they are yours to update or fix.
