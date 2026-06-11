# Revill Law Firm raw SEO metrics — Birmingham baseline — 2026-06-04

Domain: revilllawfirm.com
Market: Birmingham, Alabama
Practice: criminal defense
Backlinks: excluded per Nate.

## Traffic history — DataForSEO historical bulk traffic estimation
Endpoint: DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE
Status: returned successfully
Location: United States
Language: English

| Month | Organic ranking keyword count | Estimated organic traffic |
|---|---:|---:|
| 2026-05 | 888 | 2,107.78 |
| 2026-04 | 871 | 2,036.52 |
| 2026-03 | 1,024 | 2,329.74 |
| 2026-02 | 1,113 | 3,172.62 |
| 2026-01 | 1,159 | 3,112.59 |
| 2025-12 | 1,120 | 2,574.70 |
| 2025-11 | 1,079 | 2,888.23 |
| 2025-10 | 998 | 2,762.72 |
| 2025-09 | 881 | 2,808.42 |
| 2025-08 | 772 | 2,936.39 |
| 2025-07 | 789 | 3,231.74 |
| 2025-06 | 805 | 4,530.39 |

Quick read: estimated organic traffic dropped from 4,530 in Jun 2025 to 2,108 in May 2026, down about 53%. Ranking keyword count is up slightly from 805 to 888, so the issue appears more like weaker high-value positions/traffic capture than complete keyword loss.

## Website scrape metrics
- Title: Birmingham Criminal Defense Attorney | Top-Rated Defense | Revill Law Firm
- H1: Birmingham Criminal Defense Attorney
- Homepage word count: 13,812
- Internal links: 387
- Total links: 410
- Practice signals found: criminal defense, DUI, drug crimes, probation violation, theft, juvenile

## Keyword/ranking data pulled so far
Endpoint: DATAFORSEO_GET_KW_BING_KW_SUGGESTIONS_FOR_URL_LIVE
Status: returned successfully; payload available in tool result handle call_1iue7eKDn1TmuowHiwKj81om.

Endpoint attempted for Google Ads keywords-for-site result by ID:
DATAFORSEO_GET_KW_GOOGLE_ADS_KW_FOR_SITE_TASK_BY_ID
Status: task not found for id 06042129-1049-0595-0000-1ba7c1c83f71, so no Google keyword rows were returned from that task.

## Correct Birmingham local SERP payloads retrieved
Endpoint: DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID
- Birmingham criminal defense lawyer: call_ceDo9E8LhDN45UalV6sVTUkc
- Birmingham DUI lawyer: call_5rC8NJQwpbY47IpVZ5OuSaZD
- Birmingham drug crimes lawyer: call_yKr5Gqylp7KppYRlphVJ9wAM
- Birmingham theft attorney: call_W1REV8WXrQXLAYDD1SlRot9s
- Birmingham probation violation lawyer: call_qgMUj0hotLbROHvEu3tUSUGJ

These need final row extraction from the stored payloads into: Revill rank, ranking URL, top competitors, local pack presence, and SERP features.

## Baseline fields to keep for future prospecting emails
1. Traffic trend: monthly estimated organic traffic + ranking keyword count.
2. Keyword winners: terms where prospect ranks top 1-10.
3. Keyword losses: relevant practice/market terms where prospect is absent or below page 1.
4. Competitors: recurring top domains across the local SERPs.
5. Local pack: whether prospect appears, and who does if they do not.
6. AI visibility: whether ChatGPT/AI Overview cites the prospect or competitors for the same local queries.
7. Outreach angle: one short line derived from the raw data, not replacing the raw data.


## Raw data returned in-chat — current verified extract

### Traffic history
| Month | Organic ranking keyword count | Estimated organic traffic |
|---|---:|---:|
| 2026-05 | 888 | 2,107.78 |
| 2026-04 | 871 | 2,036.52 |
| 2026-03 | 1,024 | 2,329.74 |
| 2026-02 | 1,113 | 3,172.62 |
| 2026-01 | 1,159 | 3,112.59 |
| 2025-12 | 1,120 | 2,574.70 |
| 2025-11 | 1,079 | 2,888.23 |
| 2025-10 | 998 | 2,762.72 |
| 2025-09 | 881 | 2,808.42 |
| 2025-08 | 772 | 2,936.39 |
| 2025-07 | 789 | 3,231.74 |
| 2025-06 | 805 | 4,530.39 |

### Ranking / keyword endpoints executed
- Historical organic traffic and ranking-keyword count: successful.
- Birmingham Google Top Searches: successful but broad; returned only generic keyword `birmingham` from the filter, not legal-intent ranking rows.
- Bing URL keyword suggestions: successful; large payload stored under tool handle `call_GKPjbq9B57DGPCgAc4AdN6J2`.
- Google Ads keyword-for-site by ID: task not found; no rows returned.
- Birmingham local SERP advanced payloads: all five retrieved; extraction still requires result-reader access.

### Current limitation
This file contains the verified raw traffic history and endpoint evidence. It does not yet contain a clean keyword-by-position table because the rank payloads are stored in compressed tool results that are not readable by the currently exposed tools.
