# Focused harness refinement checkpoint — September 9, 2026

Work is on `codex/post-3161-refinements` in `clementine-next-post-3161-review`, based on `2606a51f`. UI integration, version bump, tag and push are not part of this pass.

## What changed and why

- Active MCP discovery ranks the authorized catalog instead of being confined to the initial prompt shortlist. Explicit denials and server restrictions still apply; an ambient denied context constructs no servers.
- Native discovery, Plan publication and reopened Execute share their configured argument schema, including core file writes. Preparation failures carry the argument-repair code expected by the consumer.
- Workflow readiness questions remain advisory and preserve the requested enabled state. Existing structural validation and explicit send policy remain. Workflow output formatting preserves numeric and other scalar answer fields.
- Space editing guidance preserves unrequested content and puts change explanations in chat. Exact-diff live tests passed after the first attempt added an unsolicited note.
- `run_worker` declares its coordination acknowledgement contract so completion review does not demand a nonexistent host file. It retains the same dispatch authority and child-effect constraints.
- Single live host workers share the existing batch cancellation/drain owner. A cooperative child can park before the hard tool deadline and return an honest pending remainder. This is not permission to replay unresolved external effects.
- The trajectory watcher reads only the current accepted request's tool and worker evidence. Prior work stays in session history but cannot count as a new action. Its cadence uses current-source settlements; late verdicts for superseded objectives are discarded. Older worker producers now stamp source provenance. Source-filtered summaries are also passed to legacy completion/watcher callers.
- Worker/parent guidance distinguishes observed facts, inferences, and unmeasured claims. This is guidance, not a proof that generation quality is solved.

## Live results and evidence limits

The ignored directory `output/focused-live-20260909/` contains the private raw responses, fingerprints, event captures, failed attempts, audits, and `QUALIFICATION.md`. Do not commit customer records or email bodies to release documentation.

- Google Drive: one real document creation and readback, 52.7 seconds, three calls. Exact title/content verified.
- Salesforce: ten distinct accounts cross-referenced against contacts, opportunities, tasks and events. Eleven complete SOQL responses verified, twelve calls, 146.4 seconds, no CRM writes.
- Local site: complete HTML/CSS mockup, visually checked at desktop and mobile sizes with no overflow or JavaScript errors. It completed in 364.6 seconds against a 360-second bound; retain the timing failure and resource-contention caveat.
- Spaces: Opus and Terra creation/edit paths passed, including one-write exact content preservation and no Plan. Terra edit took 11.3 seconds.
- Manual workflows: Grok and Terra create/explicit-run journeys passed. Grok delivered the previously lost scalar answer. Terra reported an unavailable workflow quality judge; that is not judge qualification.
- Explicit Plan → revised Plan → Execute passed without business writes during Plan and applied only the revised objective.
- Five Outlook drafts were created but initial copy failed independent review, and the original completion falsely demanded a file from worker coordination. A subsequent worker-assisted repair failed at the outer deadline/checkpoint boundary. Both failures are retained.
- Direct repair used one batch PATCH for five records, then five full-body readbacks. A coarse fixture expecting five mutating calls failed because a batch is one call. Independent record auditing confirms all five edits; the fixture failure is not rewritten as green.
- Final reviewer-supplied copy was applied through Clem in 89.8 seconds, three model requests, six calls, zero searches and zero Plan. All five full bodies, subjects, recipients, IDs and draft flags exactly matched. The owner-selected same-provider Opus completion verdict was accepted and publication verified. Drafts remain unsent. This proves application of reviewed copy, not autonomous first-attempt copy quality.

## Specific defects still requiring follow-through

1. **One-time scheduled work:** fresh scheduled preparation ran after restart, but retirement failed. The model selected a self-edit operation intentionally unavailable within workflow steps, leaving a recurring schedule. Add a host-owned one-time occurrence through existing trigger/queue ownership; do not widen all workflow-step authoring authority. Inspect `workflow-schedule-tools.ts`, `workflow-scheduler.ts`, `workflow-trigger-registry.ts`, `workflow-trigger-engine.ts`, and `workflow-store.ts`.
2. **Hard cancellation beyond cooperative drain:** the original parent classified an unresolved local worker as no-effect repair while the immutable settlement required reconciliation. Finalization rejected it repeatedly. The singleton supervisor addresses the observed cooperative drain omission, but an abort-ignoring body/hard-deadline checkpoint edge is not qualified by that change. Preserve this distinction.
3. **Evidence cost and claim quality:** original outreach recorded 854,617 Opus prompt tokens, 690,987 uncached, excluding child Grok usage. The completion call used 63,433 uncached input tokens. Its read evidence included 77,640 bytes of tool-discovery metadata out of 130,978 bytes. Main-request context growth is another cost. Isolate cache invalidation before claiming a cache fix. Do not silently truncate source records or discard procedural memory. A fresh, unprompted outbound generation should demonstrate supported claims and skill compliance; supplied-copy repair cannot substitute for that.
4. **Combined release:** this branch has not been combined with the UI agent's work. Prior provider-specific matrix limits and a complete calendar/preparation/reminder journey remain as documented in `output/brain-stretch-20260908/PRETAG-FINDINGS.md`.

## Validation at checkpoint creation

The full suite on fingerprint `46ce3fe7…` completed with 15,488 passed, one failed, two skipped. The failure was an outdated workflow-schedule readiness expectation; it is corrected. The subsequent watcher/worker/schedule regression group passed 135/135. Typecheck passed. The remaining affected host suites passed 560 tests with one skipped and zero failures. Typecheck and build passed. On frozen fingerprint `5eebe26f…`, a live single Grok worker plus Opus completion review passed in 31.7 seconds (two parent requests, one tool call, no business mutation). A read-only turn in the original long draft session passed in 73.4 seconds (two requests, five reads, zero Plan/writes/watcher steers), and all five saved bodies remained exact after restart. Both completion verdicts were accepted and publication verified. The full suite was not rerun end to end after the final watcher/single-worker refinements; the 695 subsequent passing checks are the affected suites. The live-home isolation sentinel could not certify isolation while the owner daemon was running. Full evidence is recorded in `output/focused-live-20260909/QUALIFICATION.md`.

The live tests demonstrate both working paths and failures. No tag-readiness claim is made for the larger partnership/scheduling scenario until the remaining cases are closed.
