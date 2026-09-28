# One notification per approval — September 28

Owner requested removal of duplicate approvals after Slack approval reminders reached Discord during the hotpatch qualification.

Cause: the host used approval-<id>, while the 30-minute reminder used approval-reminder-<id>. Each had independent per-destination delivery receipts. Content-based deduplication compared title/body, so reminder wording bypassed it. This is separate from the still-open semantic misclassification of DM setup as a send.

Changes:
- Refresh the original approval carrier instead of creating a second reminder ID. Preserve creation time, read/settled status, inline suppression, admitted routes and per-destination delivery evidence. Do not emit a second notification.created event.
- Deduplicate producers by exact approval ID and owning session, irrespective of wording. Distinct approval IDs remain distinct; no consent is granted by deduplication.
- Keep unread approval carriers through ordinary count pruning. Render legacy original/reminder copies as one Activity entry without rewriting historical records.
- When a legacy separate reminder is queued, reuse only matching same-approval, same-session receipts whose destination authority digest matches. Never inherit success across a changed recipient/route.
- A destination that never received the original ask can still receive its first notice after the existing presence deferral. This preserves useful away-user delivery.

Validation: 58 focused checks passed across approval reminders, the daemon delivery worker, notification storage and durability. The new behavioral pin fails on pre-fix runtime: four sends rather than the two destination deliveries expected. Both completed delivery and legacy reminder replay are pinned; separate approvals still deliver. The test runner used fixture homes and made no external sends; these checks are prerequisites, not installed acceptance. Installed checks and exact identity are recorded under output/approval-dedup-hotpatch-0928 after installation.

Existing Discord message history is not deleted. Business approvals apr-n080 and apr-qjjo represent two distinct messages and must remain pending until the owner resolves them. Review-resume attribution, argument-bound DM semantics and the history-search stall from output/slack-hotpatch-0928/LIVE-RESULTS.md remain separate open findings.
