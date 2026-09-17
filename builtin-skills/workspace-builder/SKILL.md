---
name: workspace-builder
description: Build, redesign, fix, or extend a Workspace (a Space) — a live, clickable surface you and the user work in. Covers attaching data sources that refresh without the model, wiring action buttons such as draft replies, designing the view with the built-in design layer and helper kit, and verifying the result before calling it done. Use for any request to create, change, improve, or debug a Space, Workspace, dashboard, board, cockpit, or command center.
applicability:
  toolFamilies: [space, spaces, workspace, workspaces, dashboard, board, cockpit]
  entitySlots: [view, data source, action, button, layout, design]
---

# Workspace builder

A Workspace is a durable, interactive artifact. You author its structure once; after that its data refreshes on the server and its buttons run operations, with no model in the loop. Build it so it keeps working when you are not there.

A Workspace has five parts. Decide all five before writing anything:

1. **Data sources**: read operations the server runs on a schedule and on demand.
2. **View**: sandboxed HTML that renders the stored data, served inside the desktop app.
3. **Actions**: declared operations the view's buttons call.
4. **Contract**: the user's objective, concrete success criteria, and invariants later edits must keep.
5. **Phone content and re-engagement**: what the phone shows, and which in-Workspace events wake you.

## 1. Start from what exists

- When the Workspace already exists, read it first: `space_get` returns the manifest, recent notes, and a summary of each source (where its records are, how many, their fields, and trimmed samples); `space_get_view` returns the current HTML with line numbers (use `grep` to find a region).
- Look at the real records before writing any rule. `space_get` with `source_id` pages through one source's records (`limit`, `offset`). Never guess a field path or what a record looks like.
- Resolve identities with tools, never by guessing: the user's own handle in a chat tool, their mailbox, their team's record owners. For example, look up the user's chat account by their own email address before filtering messages "to me".

## 2. Attach data (no model after this)

Declare sources on `space_save` as `data_sources`:

- **Connected-app read**: `{ id, composio_slug, composio_args_json, schedule, timezone }`. Use a read operation (list, get, search, fetch, query). Find the exact operation name with `tool_search` first. The save prepares each operation against its current definition before judging it, and refuses anything that is not a read.
- **Local command-line read**: `{ id, cli_argv, schedule, timezone }` where `cli_argv` is a reviewed read from the CLI catalog, frozen as an argument array with no shell. For Salesforce: `["sf","data","query","--query","SELECT Id, Name FROM Opportunity WHERE IsClosed = false","--json"]`. Only the options the reviewed read declares are carried (`--query`, `--target-org`); any other option is refused by name.
- **Schedules**: five-field cron plus an IANA timezone, for example `"0 7,13 * * 1-5"` with `"America/Los_Angeles"`.
- **Editing sources**: a partial `data_sources` list merges by id and leaves other sources untouched. `remove_data_sources: ["id"]` removes one. An explicit empty list clears all of them.
- **Workflow-fed data**: a workflow publishes into a source with a `space_set_data` call step whose `data_json` comes from a transform step. Never have a model step re-type a dataset.
- Never paste data into the HTML and never fetch from the view. The view has no network.

Every save runs each changed source once and reports what came back. A source that returns zero rows raises a question; set `allow_empty: true` only when empty is a real, expected state.

## 3. Read data in the view

- The current dataset is planted as `window.__SPACE_DATA__` before your script runs, and `await clem.data()` returns the same object. The desktop reloads the view whenever the data changes, so render straight from it.
- Each source lives under its id: `data["emails"]`. Provenance lives under `data._meta`.
- `clem.rows(data.emails)` returns the record list inside any stored shape. Connected-app sources are stored as `{ complete, result: { data: … } }`; command-line reads store the command's parsed JSON, such as `{ status, result: { records } }`.
- `clem.pick(value, "result.data.value.0.subject")` reads a path safely and returns `undefined` when any step is missing.
- `clem.sources()` returns each source's `ok`, `error`, `refreshedAt`, and `stale`. Render a stale or failed source visibly while keeping its last good data on screen.
- `clem.refresh(sourceId?)` re-runs sources on demand and returns `{ results, data }`.
- Provider text arrives encoded. Render email and document text through `clem.fmt.text` (decodes `&amp;` and friends), chat messages through `clem.fmt.slack(text, namesById)` (emoji codes, mentions, links), and handles through `clem.fmt.person("dana.lee")` → "Dana Lee".
- `clem.mail.isAutomated(message)` recognizes machine mail (no-reply and notification senders, no-reply return addresses, the mailbox's own "Other" classification); `clem.mail.sender(message)` gives a display name; `clem.mail.preview(message)` gives the ask itself, without the signature, contact lines, quoted thread, or security banner.
- Ask the source for the provider's own judgments when it can return them, such as a mailbox's focused/other classification or a message's importance. They separate people from bulk mail far better than any sender rule.

## 4. Wire actions

- Declare `actions: [{ id, label, composio_slug, args_template_json }]`. The template holds fixed arguments; the view passes the per-click ones.
- Call from the view: `const result = await clem.action("draft_reply", { message_id: row.id, mail_folder_id: row.parentFolderId, comment: text })`. Per-click arguments merge over the template.
- **Required inputs are checked at save.** The save reads each action operation's input schema without calling it. When a required input is set by neither the template nor the literal `clem.action` call, the save is refused and names the input. Fix it in the template or pass it from the view.
- Handle all three outcomes. `{ pending: true, approvalId }` means the action waits for one approval: show `clem.ui.pending()` and never say it happened. `{ ok: true, result }` means it ran. A thrown error means it failed: show `clem.ui.error(message)`.
- Sends take one approval. Drafts and ordinary reversible writes run directly.
- Disable a button while its action is in flight, and put the row id in a data attribute rather than rebuilding it from text.
- Never prove a button works by performing a write on the user's real data. The save's input check and the operation's own validation cover wiring. When a live check truly matters, tell the user exactly what one click will do and let them click it.

## 5. Make it useful before making it pretty

A surface earns a daily visit by answering "what needs me, and what do I do about it" faster than the apps it summarizes.

- **Rank with reasons from the data.** Every priority says why in words the user cares about: "Dana asked for two client references, waiting 2 days", "Northwind renewal is 19 days past its close date, no activity in 3 weeks". A generic reason like "unread email" is not a reason.
- **Cover every source the user named.** A cross-source priority list that asked for email, chat, and pipeline shows the most urgent of each kind, not just whichever source has the most items.
- **Keep noise out of the attention list.** Machine mail, notifications, digests, newsletters, vendor announcements, and marketing never rank as things to reply to. Collapse them into one count the user can expand.
- **One item per person or thread.** Several messages from the same person, or on the same thread, are one item with the latest message and a count.
- **Put the next step on the item.** Draft a reply, open the thread, open the record. One primary action per item; secondary actions stay quiet.
- **Show the ask, not the envelope.** Previews are the request itself, one or two lines. Never signatures, phone numbers, addresses, or quoted history.
- **Calm beats busy.** A clean list with light dividers reads faster than cards nested inside boxes. Leave space between sections, keep one accent color for the primary action, and let the headline numbers carry the page.
- **Say timing in plain words.** "19 days overdue", "closes Friday", "quiet for 3 weeks". Never a signed day count.
- **Check every rule against the real records before saving.** Count what the rule keeps and what it drops, and look at the top items it produces. If a notification would still rank first, the rule is wrong.

## 5b. Build from a goal

When the request is an outcome ("help me make an extra $40K this year", "cut churn", "hit my number"), the Workspace is a plan that keeps running, not a report.

- **Inventory what is connected first.** Find every connected tool that could hold signal for the goal (CRM, mail, chat, calendar, documents, analytics) and read a sample from each. When the user says "look at all my tools", a build that reads one of them is incomplete. In the reply, name the sources you used and the ones that had nothing useful.
- **Scope to the person.** "Me" means records the user owns. When they also manage a team, lead with their own book and keep the team view separate and labelled.
- **Baseline, then the gap.** From real records, establish where the user stands today: won so far this period, open pipeline, their own win rate by stage, typical deal size, and cycle length. The gap is the goal minus what the current trajectory already delivers. Never call a goal "covered" because a pool of dollars is larger than it.
- **Levers with honest math.** Size each lever (recover slipping deals, win back lost accounts, expand current customers, speed up late-stage deals, price unpriced deals) from named records. Use rates from the user's own history when the records allow it, and say where each rate came from.
- **Today's moves at the top.** A short list of specific actions for today, each tied to a record, a reason in plain words, the dollars it moves, and the action itself on the item.
- **Progress toward the goal.** Show won-to-date against the goal so the page tells the user whether the plan is working as deals close.
- **Signals across sources.** Enrich each record with what the other tools say: the last email with the account's contacts, open questions in chat, the next meeting. That is the intelligence a single-system view lacks. Wire it in the same build: add one source per tool that returns recent activity in bulk (for example the mailbox's recent sent and received messages with sender, recipients, subject, and time), then join in the view on a shared key such as a contact's email address or the account's website domain. One bulk source joined in the view beats a lookup per record, and needs no model after it is saved. Do not defer this to a follow-up offer.
- **Keep it working.** Sources refresh on a schedule that fits the goal, actions run from the page, and re-engagement triggers wake you when a milestone is hit or a risk appears.
- **Numbers must add up.** Every headline number is reproducible from the records on the page. Check the sums before saving.

## 6. Design with the built-in layer

Every served view already carries a stylesheet and a helper kit. Spend your byte budget (24 KB of inline HTML) on the reading order and the logic, not on CSS.

**The reading order**
1. `.clem-header` with the title, a one-line subtitle, and `clem.ui.sourceStrip()`.
2. `clem.ui.kpis([...])`: the three to six numbers the user would ask for first.
3. **What needs the user today**, most urgent first. Each item says why it matters and when: a deadline, an age, a question waiting.
4. Context sections in a `.clem-grid`, side by side on a wide screen and stacked on a narrow one.

**Rules**
- Fill the frame with `.clem-app`. Never center a narrow column or set a page max-width.
- Use tokens only, never literal colors, so light and dark both work: `--clem-ink`, `--clem-ink-muted`, `--clem-ink-subtle`, `--clem-primary` for fills and `--clem-primary-ink` for text, `--clem-success`, `--clem-warning`, `--clem-danger`, `--clem-info` and their `-tint` variants, surfaces `--clem-bg-canvas`, `--clem-bg-surface`, `--clem-bg-subtle`, `--clem-bg-hover`, `--clem-bg-raised`, and `--clem-border`.
- Components: `.clem-kpis > .clem-kpi` (`-ok`, `-warn`, `-danger`, `-info`), `.clem-card`, `.clem-section` with `.clem-section-head` and `.clem-section-body`, `.clem-list > .clem-item` (`-urgent`, `-warn`), `.clem-table` (`.clem-right` for numbers), `.clem-tag` (`-ok`, `-warn`, `-danger`, `-info`, `-primary`), `.clem-btn` (`-primary`, `-ghost`, `-danger`, `-sm`), `.clem-empty`, `.clem-pending`, `.clem-error`, `.clem-skeleton`, `.clem-progress`, and utilities `.clem-row`, `.clem-stack`, `.clem-muted`, `.clem-num`, `.clem-small`, `.clem-mono`.
- Builders escape every field:
  - `clem.ui.kpis([{ label, value, hint, tone }])`
  - `clem.ui.section(title, bodyHtml, { count, meta, actions })`
  - `clem.ui.list([{ title, meta, body, html, href, tags: [{ text, tone }], urgent, warn, attrs }], { empty })`
  - `clem.ui.table(rows, [{ key or render, label, align, html }], { empty, rowAttrs })`
  - `clem.ui.card(bodyHtml, { title })`, `clem.ui.tag(text, tone)`, `clem.ui.empty(text, hint)`, `clem.ui.pending(text)`, `clem.ui.error(text)`, `clem.ui.sourceStrip()`
  - `clem.sources()` → `[{ id, ok, error, refreshedAt, ageHours, stale }]`; `clem.theme()` → `{ name, isDark }`
  - Other classes: `.clem-header` with `.clem-sub`, `.clem-item-title`, `.clem-item-meta`, `.clem-item-body`, `.clem-item-tags`, `.clem-src`, and the `--clem-radius` token.
- Format with `clem.fmt`: `money(n, currency)`, `number(n, decimals)`, `percent`, `date(v, "long")`, `time`, `relative(v)`, `daysUntil(v)`, `plural(n, one, many)`, `truncate(s, n)`, `initials`. Pass any external text you interpolate yourself through `clem.fmt.esc`.
- Compute the signals the data does not carry: quiet for 14 days, closes this week, waiting on the user, amount at risk. That is what makes the surface worth opening.
- Every list has an empty state, every source has a stale or failed state, and every action has a pending state.
- Links to `http`, `https`, `mailto`, `tel`, and meeting apps open outside the frame when clicked.

## 7. Edit without breaking

- Targeted change: `space_get_view` with `grep`, then `space_edit_view` with find strings copied verbatim, whitespace included.
- Redesign: one `space_save` with the complete new `view_html`.
- Keep everything outside the requested change. Omit contract fields on later saves to keep them.
- After changing a source, run `space_refresh` so the open Workspace shows the new data. Use `space_history` and `space_diff` to see what changed between refreshes.

## 8. Verify before saying it is done

- **Look at it.** `space_preview` renders the Workspace exactly as the desktop shows it, with its real data, and returns an image. Preview after every create or redesign, and after any visual change. Check the image against sections 5 and 6: is the attention list short and real, is text decoded, does the page fill the frame, is anything cluttered, empty, or broken? Fix what you see and preview again. Check dark theme and a 390-pixel width once before you finish.
- Read the whole save result. Fix every gap-test item it names; the save refuses until they are fixed.
- Preview a long page in parts with `offset_y` (for example 0, then 1000, then 2000) instead of one very tall screenshot, whose text is shrunk before you see it. Check tables for cramped columns and words broken mid-word.
- Confirm each source refreshed with real rows, and that the view renders them under the right ids.
- Finish the build in the same turn. For a small product choice, such as reply-all or sender-only drafts, pick the sensible default, say which you chose, and offer to change it. Do not end a build on a question.
- Tell the user what is live, what changed, and anything they need to click or approve. Name any real object you created and where it is.

## 9. Phone and re-engagement

- The HTML view never reaches the phone. For static content, include `_mobile` in `initial_data_json` or `replacement_data_json`: `{ headline: [{ label, value }], breakdowns: [...], records: { label, total, items: [...] } }` with display-ready strings. Source-backed Workspaces are summarized from their data.
- `reengage_triggers` (`note`, `ask`, `threshold`) plus `reengage_guidance` say which in-Workspace events wake you and what to do then.
