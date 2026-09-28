# Packaged candidate qualification — 2026-09-27

Candidate 1a6ce8133 built in a clean detached qualification checkout. Runtime, console, mobile and desktop builds passed. Runtime build identity is clean, schema 82, fingerprint 4f8713cfef05c3642b690a353ff936e7596795250f573b11fb0d628e0a7b5024. Package versions remain 3.18.21 pending final release qualification; this is not a new tag.

Fresh-install setup checks and the staged daemon/dashboard end-to-end check passed. The npm-packed candidate installed its own runtime dependencies in a fresh consumer project; its production local workflow action executed once, and a second process added no logical call, physical crossing, settlement or local execution. These are packaging fixtures, not installed/live-home acceptance or release signing.

The first console build borrowed a stale local dependency tree missing @xyflow/react. A clean lockfile install within the qualification checkout resolved it; no runtime or dependency manifest was changed. The owner’s main dependency directory was left untouched.

## Packaged upgrade gate regression and correction

The actual v3.14 packaged upgrade rehearsal failed 2 of 21 checks. Both identify one mismatch: the candidate ships people-lookup, but the gate's closed first-boot builtin seed list names only technical-content-marketing and workspace-builder. The runtime added the expected people-lookup files and the checker correctly refused to silently admit unexplained additions. The same seed-roster classifier passes on the last tag, which does not ship people-lookup. This is a candidate gate regression, not an inherited waiver or demonstrated user-data migration loss.

Add the intended shipped skill to the explicit closed list. Preserve rejection of unknown skill names and extra files. Strengthen new builtin seed validation to require exact candidate-shipped SKILL.md bytes as well as the existing bounded front matter/body and digest-sidecar validation. An altered body with a freshly recomputed sidecar digest must not be mistaken for an exact deterministic seed. Existing user-owned skill files are not classified as newly added seeds and retain the unchanged-file protections.

Both focused pins fail before the correction and pass afterward. The last-tag roster check passes. Full packaged-upgrade rerun is required after committing and rebuilding this script/document change. Receipts will be retained under output/release-3.18.22-2026-09-27/ with exact candidate identities; the initial build and smoke receipts are in build-1a6ce8133/.

Full suite and canonical journeys still await an otherwise idle machine or the owner's pending scheduling decision. The 100-worker journey assertion edit is separate and unexecuted. No app hotpatch, live benchmark, main merge, signing operation, push or tag occurred in this qualification wave. Those gates remain outstanding.
