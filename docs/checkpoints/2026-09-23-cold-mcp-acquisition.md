# Cold MCP acquisition candidate

## Evidence and fix

Prior installed b7012d67a continuation source292652→292692 resumed the original pilot but acquisition returned capability_acquisition_missing. It did not reach no-argument contract validation, so no live acceptance of that repair yet. No Jev read-nomination usage was recorded. Full trace/build/metrics/rollback are in output/harness-acceptance/2026-09-23-pilot-b701/; STATUS.md includes the exact run and remaining findings. Canonical done terminal is NOT pilot success: no pilot/card/run exists.

Reproduced a concrete cold-start defect using the REAL namespace shim inside the read carrier with generated provider metadata and a pending handshake. With advertisement budget20ms and handshake350ms, prior code returned generatedServer__unavailable as its inventory, not generatedServer__sections. That placeholder has unknown effect, so the acquisition registry excludes it and can report missing without reaching Jev. No model calls or provider-specific branches involved. This proves the class defect; the original live run did not retain its raw list and remains inferential as to this precise cause.

Namespace shim now exposes listToolsAuthoritative for exact metadata acquisition. It waits through existing connect/list timeouts and throws unless every scoped server connected; it never turns a connecting/failure placeholder into authoritative tool evidence. Ordinary model advertisement keeps its existing short budget. Scoped wrapper forwards the authoritative listing through the SAME scope filtering and namespaced routing. Production MCP carrier selects this method when available, falling back to ordinary listTools for non-shim adapters. Live attestation, schema/effect checking, admission, and acquisition deadline/publication guard remain unchanged. No settings/feature flags/provider names added.

Negative cold test failed with unavailable versus sections before fix. Green test gets the actual read operation; separate failed-connect test rejects unavailable rather than returning empty metadata. Four related files ran serially:126checks pass (carrier, acquisition registry, namespace shim, scoped MCP servers). Final TypeScript check passes with both new tests. Whitespace check clean. Disposable homes only, no full-suite idle sentinel claim.

## Owed

Build/install/live original pilot from a COLD restarted app without manually calling the console tool-list endpoint first. That inspection warms the connection and can mask this class. Do not change the approved dataset, proposal, output Space or source metadata. Verify review card and separately approved execution to five records/provenance before claiming pilot success. Candidate is not installed yet. Further scope filter/warm-path behavior should be judged through the original live flow, not standalone metadata probes.

Preflight token attribution is still missing: respond-bridge.ts calls prepareCheckedHostClarificationAnswer before loop.ts enters withModelUsageAttribution. Pin exact accepted-source/attempt accounting; never relabel unscoped usage by timestamps. Prior b701 live totals197715input/116736cached/80979uncached/2608output across9exact rows,1unscopedpreflight,60278ms,2topcalls; certificationFALSE. Together AI comparisons remain queued after stabilization. Section6 full release gates remain outstanding, no tag authority or readiness claim.
