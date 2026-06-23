---
name: salesforce-deal-risk-workspace
description: "Build (or edit) an interactive Salesforce DEAL-RISK Workspace for a rep or a team: pull their open opportunities and flag which deals are at risk / likely to slip / on track, with the WHY grounded in concrete engagement data — email & call communications, NextStep, notes, opportunity age — not just the close date. Actions: build, author, create, edit, refresh, improve a workspace/dashboard/surface. Subjects: Salesforce deal risk, pipeline risk, opportunity risk, will this deal close, forecast risk, deal review, team pipeline, at-risk deals, slipping deals, close date, stalled deals, sales manager review. READ-ONLY analysis. Use when asked to build/edit a deal-risk or pipeline workspace, or to make a deal-risk 'why' more concrete. A proven, ready-to-adapt runner ships in src/refresh.reference.mjs."
---
# Salesforce Deal-Risk Workspace

Build a live, interactive **Workspace** (a Clementine space) that shows a rep's or
a team's open Salesforce pipeline with each deal flagged **On Track / At Risk /
Likely to Slip** — and, critically, a **"Why" built on concrete evidence**: email
& call communications, whether a **Next Step** is set, notes on file, and the
**age** of the opportunity. Proven against Darrin Sennott's team (294 deals);
`src/refresh.reference.mjs` is the working runner to adapt.

## Defining requirements (what makes this trustworthy — do not skip)

1. **READ-ONLY.** SELECT queries only. Never update, create, or delete a Salesforce
   record. The workspace analyzes and recommends; it does not act on the CRM. Put
   "read-only, no Salesforce records modified" in the view footer.
2. **The "Why" must cite CONCRETE engagement evidence**, not just the close date.
   Each deal's reason leads with the sharpest real signal: *"No email in 34d"*,
   *"Last email 15d ago; No next step set"*, *"No emails or calls ever logged"*,
   *"140d old, still Discovery"*. Close date is one signal, not the whole story.
3. **Every figure traces to the pulled data.** No estimates from memory. If a
   field is blank in Salesforce (e.g. Amount, NextStep), show it as blank/"not
   set" — never invent a value to fill a cell.
4. **Resolve people at runtime — never hardcode IDs.** Look up the rep/team lead
   by name; resolve the team as the lead + their active direct reports (ManagerId).
5. **Scale:** for a single rep/team a direct pull is fine; for a very large book
   (N≫300 opps) author it as a `forEach`/worker fan-out so it survives restarts.

## The concrete signals to pull (read-only SOQL)

- **Team:** `User` where the name matches the lead + `User WHERE ManagerId = <lead>` (active).
- **Open opportunities:** `Opportunity WHERE OwnerId IN (team) AND IsClosed = false`
  — select `Amount, StageName, CloseDate, Probability, CreatedDate, LastActivityDate, NextStep`.
- **Email & call communications (the key "why" data):** `Task WHERE WhatId IN (oppIds)`
  — `TaskSubtype`/`Type` distinguishes Email vs Call; bucket per opp to get
  **last email date, days-since-email, email count, last touch, touch count**.
- **Notes:** `ContentDocumentLink WHERE LinkedEntityId IN (oppIds)` (count per opp).
  Often sparse — wrap in try/catch and fail-open to "no notes".
- **Age:** `today − CreatedDate` (days).

## The risk model (compute per deal)

- **Tier 1 — close-date drivers → "Likely to Slip":** close date already passed
  and still open; or closes within ~7d but still early-stage / low probability.
- **Engagement signals (lead the reason):** no email logged · no email in >30d ·
  last email >14d ago · NextStep blank · no next step *and* no notes on file ·
  age >120d still in an early/mid stage.
- **Pipeline-shape signals (corroborate):** low probability in an early stage; a
  large Amount stuck in an early/mid stage; closing this/next month.
- **Tier:** slip-driver → *Likely to Slip*; else ≥2 signals (or one strong stale-
  engagement / big-stuck signal) → *At Risk*; else *On Track*.
- **reason** = the slip driver (if any) + the sharpest engagement signal; for
  At Risk, the top two signals (engagement first); for On Track, a short positive
  ("Proposal, 70%, closes in 12d, emailed 3d ago, next step set").

## Build the workspace

1. Create the space (`space_save` / `POST /api/console/spaces`) titled e.g.
   "<Lead> — Deal Risk".
2. Write the data runner `data/refresh.mjs` — **start from `src/refresh.reference.mjs`
   in this skill**, change only the team-lead name match. It runs read-only `sf data
   query` calls and prints one JSON object (team, deals, summary). Register it as a
   data source in `space.json` with a daily schedule (e.g. `0 7 * * *`).
3. Author the view `view/index.html`: a summary card row (total open value, value
   at risk, closing this/next month, likely-to-slip), risk-tier + stage bars,
   filter controls (owner / stage / tier / search / group-by-tier), and a sortable
   table whose columns include **Last Email**, **Next Step**, **Age**, **Δ Close**,
   **Risk** and the evidence-based **Why**. Footer states the read-only refresh time.
4. `POST /api/console/spaces/<slug>/refresh` to pull live data, then confirm the
   reasons cite concrete evidence and that **zero** external writes occurred.

## Editing an existing deal-risk workspace

To make the "why" more concrete (or add columns): edit `data/refresh.mjs` to pull
the extra signals + rebuild the `reason`, then `POST …/refresh`; and edit the
view's column list + row renderer to surface them (e.g. add **Last Email** /
**Next Step** columns). Re-verify read-only.

## Done when

Every open deal shows a risk tier and an evidence-based reason that a sales manager
can act on, every number traces to the Salesforce pull, blanks are shown honestly,
and nothing in Salesforce was modified.
