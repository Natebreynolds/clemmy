# Meeting analysis persistence defect — September 28, 2026

## Live evidence

Installed daemon API: c9cc6a1982003f26a8364f60c94dfcc5f90b6226, fingerprint 9261952a1255fc31f1160fef29992c25100f86d4bbf578e466d25c8acac865ee. Source main/tag is 5df6c757ed93c696b2deac6abc09e968654c0a43. These are distinct identities.

Latest completed Recall meeting recall-mulk0uhl-fa5e30 finished at 18:43:23Z. The running API reports Transcribed, canonical ready, 308 segments, and analysis absent. The transcript artifact exists (47,282 bytes). Recall capture/backfill succeeded for this meeting; this is not evidence of a provider transcription outage.

Analysis task bg-mulliyvu-bc1be4 (source 320794) was told by buildAnalyzerPrompt to write directly to the protected internal state/meeting-capture/analysis directory. write_file refused that mutation. The model retried, wrote alternate artifacts, and created a meeting-analysis-save workaround workflow. Its final response requested user input; run_attempts says interrupted while background task JSON still says running. The watchdog reported it silent. Those status/recovery issues remain separate follow-up work.

Last cumulative runner snapshot: 44 brain frames, 16 side frames, 2,937,969 input tokens including 2,683,392 cached input tokens, 254,577 uncached input tokens, 34,705 output tokens. Do not add earlier cumulative snapshots or call all input uncached spend.

An additional record recall-mulligw6-998540 began immediately afterward and still says recording with one segment. Active versus stale is unconfirmed. No recording was stopped, app restarted, or personal records/workflows manually modified.

## Bounded framework correction

Branch codex/meeting-analysis-save, worktree /Users/nathan.reynolds/clem-worktrees/meeting-analysis-save. New meeting_analysis_save tool validates structured analysis and requires an existing completed meeting with a transcript artifact. Destination is derived by the host, never supplied by the model. It uses the existing canonical analysis persistence and note-filing path, retaining the transcript and user-locked title. Exact retries preserve generatedAt for unchanged normalized content. Tool registered on local and MCP surfaces and shared registry; analyzer prompt for Recall and local recordings requests this operation instead of write_file.

Protected-state write_file restrictions remain intact. No credential changes, model launches, release/tag modifications, or hotpatch performed.

## Verification and owed acceptance

57 focused checks passed: meeting-analysis-tools, meeting-capture, meeting-notes, tool-registry, local-file-revision. TypeScript noEmit passed. Isolated tests are prerequisites, not installed-app acceptance. Isolation-runner global sentinel was not performed because the live daemon was writing; fixture files use their own temporary CLEMENTINE_HOME.

Still owed: real installed dispatch/discovery and save receipt, desktop/mobile presentation, canonical analysis recovery for the affected meeting, disposition of the model-created workaround workflow/alternate artifacts, and reconciliation of the background task status. Confirm whether the post-meeting recording record is live before any app restart. The owner was asked which meeting and symptom they see; response pending at checkpoint time. Do not silently retry the old analysis prompt against protected paths or relax the state directory guard.

## Owner clarification: ship a writable Meetings home

The owner requires meetings to be first-class and a writable meeting folder to ship with Clem. The existing vault/04-Meetings location was only created lazily by capture. Added shared MEETINGS_DIR to normal vault scaffolding and reused it in Recall/local artifact filing; no path migration or existing-note rewrite. The save tool now returns meetingNotePath and meetingsDirectory rather than the internal state JSON path, and describes supporting-note/draft writes through the ordinary file tool. Structured analysis still uses typed persistence so the Meetings UI and canonical record stay synchronized.

Verification: vault/capture/notes/file-boundary suite 36/36, then expanded meeting-tool suite 4/4 (three overlap); TypeScript passes. New checks prove repeat scaffold preserves notes, the actual file tool writes a draft in Meetings, and the same tool still refuses internal analysis-state writes. Installed-app acceptance/hotpatch remains owed; no live recording or user artifact modified.

## Transcript retrieval, automatic analysis, and late background settlement

Owner requirement: analyze every captured call automatically without an approval prompt; Clem must retrieve its own saved transcripts when asked. Live settings confirmed Recall enabled and analyzeOnComplete=true. The original chat source321379 searched calendar, mail, Teams, Drive and Greenhouse and incorrectly declared no transcript reachable. Source321629, after the owner's Recall clarification, found and summarized the local transcript. This was missing native discovery, not missing transcript data.

Added discoverable meeting_search and meeting_read on both tool surfaces and the shared registry. Reads use local saved records, support time/text search and paginated complete transcripts, and bind page continuation to a transcript revision. Analysis absence does not block reading. Typed analysis save has no approval requirement. Added exact failed discovery-query regression, no-approval declarations, local/Recall parity, pagination and immediate analysis visibility checks. Canonical saves now invalidate the analysis-file cache.

Added exact-source terminal reconciliation before background-capacity counting. A finished worker's late awaiting-user-input terminal now parks its background task and tracked run instead of leaving Thinking forever. Active attempts, newer source requests, and newer task incarnations are excluded. Cancellation of an already-finished attempt settles cancelled, not completed or resumable. This does not infer successful completion or change external-write authority.

Live recovery performed at owner's request: stopped bg-mulliyvu-bc1be4 through the API, independently verified no active run attempt, then used canonical background/run APIs to finish its cancellation (the old daemon otherwise leaves cancellation pending). Recovered the pre-existing generated analysis from its alternate artifact via persistMeetingAnalysis. Before/after segment SHA matched; all308 segments retained. Running installed API confirmed hasAnalysis=true and task status aborted. No new model call. This validates recovery/readback, not installed acceptance of newly registered tools.

Disabled only the analysis-created workaround workflow meeting-analysis-save---recall-mulk0uhl-fa5e30 and cancelled its parked trigger-277cf2e40797a6bb75345163bca83f06 via authenticated API, both200. Other workflows untouched. Subsequent readback briefly failed because the desktop updater closed the daemon; supervisor identifies the v3.18.22 Squirrel update. No restart/update was initiated by this fix.

Validation: background suite157/157; final focused suite42/42 including four exact-source reconciliation cases and actual failed discovery query. Recall SDK upload and local-meeting capture tests passed in the earlier combined run; its sole registry expectation failure was corrected to include the two new pure-local readers, then registry suite passed. Fixture homes are isolated; live global sentinel remains unavailable while the daemon writes. Source is still separate from main/tag; native tools and status reconciliation need installed-app acceptance after integration. Existing generated analysis was restored, not independently re-analyzed for factual accuracy.
