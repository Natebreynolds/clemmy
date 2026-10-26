# Ordinary host turns in diagnostic trace

The trace selected only legacy graph authority rows. Ordinary `host_v1` chat is deliberately rooted in `accepted_turn_call_authorities`, and need not compile a graph. Such turns were missing from the diagnostic output; this was not missing runtime registration.

`scripts/turn-trace.ts` now unions the existing graph and host source roots before applying its recent-source limit. Exact session/source joins retain only nonsynthetic human input. Sources with both roots appear once; read-only host turns appear, workflow authority kinds do not. The output distinguishes observed host authority from a planned graph. Older graph-only databases remain readable. Reads use a read-only, query-only transaction; no runtime authority, terminal, accounting or database record is changed.

Genuine baseline RED: three failures and one passing control. Final five tests pass through the actual diagnostic CLI against disposable SQLite fixtures, covering host inclusion, deduplication/order, limits, source boundaries, graph-only compatibility and host authority kinds. Database bytes remain unchanged. Node 24; network and live-home reads denied. Final log SHA256: `8ebe9ecf7b13df50f030ecbef3cf8e788971a8cee6afd15b641e01927b771d3f`.

Evidence: `output/end-to-end-review-2026-10-26/host-turn-trace` in the primary checkout. Source and test reviewed independently. This is diagnostic coverage, not new live acceptance or a cost/savings claim. The communicated peer merge boundary remains exact `cc30bc481022decada95027ca31d7131a215560e`.
