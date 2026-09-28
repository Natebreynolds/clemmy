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
