# Prospecting Email Toolkit Inventory

Verified: 2026-06-01 08:50 PT

## Ready

| Need | Status | Evidence |
|---|---:|---|
| Scorpion outbound email skill | Ready | Loaded `/Users/nathan.reynolds/.clementine-next/skills/scorpion-outbound/SKILL.md` plus references: `brand-voice.md`, `vertical-terminology.md`, `outbound-cold.md`, `proven-patterns.md`, `proof-points.md`, and `examples.md`. |
| Salesforce account/contact research | Ready | Remembered working tool: local `sf` CLI for SOQL queries. Composio Salesforce is expired, so use CLI. |
| Outlook draft creation | Ready | Remembered working tool: `OUTLOOK_CREATE_DRAFT` with active Outlook connection `ca_T9pDCuTalAI3`. Drafts should be approval-gated. |
| Google Sheets read/write | Ready | Remembered working tools: `GOOGLESHEETS_VALUES_GET` and `GOOGLESHEETS_VALUES_UPDATE` with active connection `ca_GJ_hJWV2Hw7P`. |
| Firecrawl site scrape | Ready | Composio status shows Firecrawl active connection `ca_hIANGqi0SGL8`. Useful for page copy, positioning, and website observations. |
| DataForSEO general access | Partially ready | Composio status shows DataForSEO active connection `ca_l2E9qngGijNQ`, but the ranked-keywords endpoint previously was not exposed in this tool surface. Do not depend on page-2 keyword enrichment unless endpoint is confirmed first. |
| Browser/domain access | Partially ready | Chrome can be driven through AppleScript and Salesforce/CSX pages were navigated successfully, but JavaScript from Apple Events is disabled. Use UI navigation where possible, or CLI/API for Salesforce-backed fields. |

## Email rules verified from skill

- Cold emails under 120 words.
- Must include one true researched detail: competitor, ranking gap, market trend, search-volume number, or AI-search observation.
- Legal language: clients, cases, consultations, signed retainers. Never customers/jobs.
- No em dashes.
- Avoid banned terms including optimize, leverage, empower, innovative, boost, robust, cutting-edge, synergy, circle back, touch base, and generic openers.
- One CTA, usually a 15-minute conversation.
- No body sign-off because the mail tool appends the signature.

## Recommended workflow

1. Pull prospects and best contacts from Salesforce.
2. Enrich each prospect with one verified hook from Firecrawl, DataForSEO if available, or manual SERP/AI-search check.
3. Write drafts using the Scorpion outbound skill.
4. Create Outlook drafts only after review/approval, with Chili Piper link available if Nate wants it embedded.

## Starter cold email pattern

Subject: `[Firm]: one search gap worth checking`

Hi `[First Name]`,

`[Specific researched observation about their market, competitor, ranking, AI-search result, or website positioning.]`

That kind of gap can send high-intent cases to another firm before a client ever compares attorneys.

Scorpion works with law firms to turn search demand into signed cases, and our legal clients average a 5x return on their marketing.

Worth 15 minutes to see what we would change for `[Firm]`?
