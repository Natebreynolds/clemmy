# Failed-call accounting and fixture alignment

Candidate follow-up to a848175b1; installed acceptance still owed when written.

The installed Sol workflow-list run (source 286089) recorded a Jev strategy timeout with no usage receipt. Its zero placeholder was certified as zero cost. Failed calls with all-zero usage now remain visible and uncertified in canonical accounting and rollups. Failed calls with positive usage still contribute their known tokens. This also corrects projections of existing failed rows without rewriting history.

The regression fails at a848175b1 (expected certified=false, actual=true), then passes with the fix. Usage and estimator suites: 27 passed. Typecheck passed. No generative calls were used for these checks.

Three named fixture failures are resolved: native space_save remains first-class, specialized schemas remain discoverable; structured-envelope documentation uses the expected readable formatting; local-project persistence provisions real projects in its disposable configured inventory and restores that configuration. The two affected suites pass all 223 tests. This aligns the stale dock assertion with the existing native authoring contract, rather than removing authoring capability to satisfy it. It is not a claim that the full suite passes.

Traps to retain: failed zero usage is unknown cost, not free work; SDK and native client versions are distinct; new model discovery does not prove transport compatibility; standalone CLI login is not Clem OAuth authority. The isolated runner could not certify its live-home sentinel while the daemon owned that home; no isolated acceptance claim is made.

Broader installed-app workflow, cold-tool, restart, mobile, packaging and full-suite gates remain owed. No tag is authorized by these focused checks alone.
