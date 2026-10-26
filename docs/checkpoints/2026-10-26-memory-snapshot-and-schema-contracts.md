# Memory snapshot and provider discovery contracts — 2026-10-26

Base: `a20e3e018524b21db37db87b1dfd5132d19ec7f2` on `codex/memory-completion-refinement`, already serving in the installed Mac app. Peer branch `claude/daemon-loop-holds` was last independently clean at `d8ad0862984c6af1df92f431becfcf211c200ede`; recheck ownership before another installation. Settings model-switch explanation `9cd6b80b0` is ancestral. Protected Needs you files, native shell, token meter and personal/business data are unchanged.

## Changes

- Automatic memory consolidation now compares successful host `memory_remember` settlements for its exact accepted source, together with current active fact content/kind/scope, before applying its first mutation. If explicit saves changed that snapshot while the resolver awaited, the stale decision is discarded into the existing bounded retry/backoff. The next attempt uses the existing resolver with current facts and reuses the already checked destination. Missing evidence refuses before a model call. Scope and candidate ownership remain authoritative, and this new retry cannot restart a partially applied decision. No new semantic deduplication rule, schema or completion authority is introduced.
- Tool discovery preserves sourced providers' authoritative JSON schemas. A required field that allows null remains required; optional fields remain optional. Generic guidance says only optional fields may be omitted. Existing local deferred transport compatibility and original-Zod decoding are unchanged.

## Evidence

- The memory regression reproduced twice before the fix: an awaited ADD committed after paraphrased same-source explicit saves, and after a previously saved fact changed. The final focused matrix passes 12 cases, covering fresh retry context, scope isolation, inactive/moved facts, malformed and forged receipts, lost ownership, and later saves after the first automatic write. Another 78 adjacent memory cases pass, for 90 distinct memory cases. One fixed-path test ran from an output-only copy with only its fixture path and import anchors relocated; the original assertions and preexisting fixture directory were preserved, with a reversible diff and hashes retained.
- The provider discovery regression reproduced for both external MCP and Composio: required-nullable keys disappeared at the root, in array items and in union branches. The six focused cases now pass, including local workflow optional-field conversion and original-Zod null controls.
- Independent bounded review found no remaining actionable issue in these changes. Tests used isolated homes with network and live-home reads denied. Build and installed acceptance are separate subsequent qualifications.
- Retained controlled source 667863 has three canonical succeeded `memory_remember` calls, supporting the actual settlement path used by the memory guard. No private memory text was emitted or modified.

## Limits

The memory fix prevents a stale decision from committing after completed, source-bound explicit saves change its evidence. It does not certify semantic coverage of every aggregate or make separate memory/event stores one atomic transaction. A fresh resolver may still choose ADD; that is a separate semantic outcome. Cross-kind retrieval authority is unchanged. Correction and unresolved-objective requirements still require their existing exact proofs.

The schema fix concerns authoritative sourced provider contracts. First-party nullable omission compatibility is preserved; no provider dispatch bypass or new live provider failure is claimed.

The installed a20 live fixture has passed fresh reads and chained reuse while retaining original timestamps. Real expiry acceptance, this candidate's installation, and its scoped memory acceptance are recorded separately in primary repository `output/end-to-end-review-2026-10-26/`. No push, tag, publication, native iOS build or TestFlight upload is authorized by this checkpoint. Device/Windows acceptance and complete all-leg usage attribution remain separate qualifications; no savings claim.
