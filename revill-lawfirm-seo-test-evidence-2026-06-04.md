# Revill Law Firm SEO baseline test evidence — 2026-06-04

Domain: `revilllawfirm.com`  
Market: Birmingham, Alabama  
Practice focus: criminal defense  
Backlinks: excluded per Nate.

## Test status
This Revill test was run through Composio DataForSEO and local page scrape. The test produced usable traffic-history + site-scrape data, and it created/retrieved Birmingham SERP payloads. The final keyword-position table is not yet complete because the SERP payload rows still need extraction from stored tool results.

## Verified endpoint/test evidence

### 1. Traffic history — returned successfully
Endpoint: `DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE`  
Tool call evidence: `call_EC16JKpLw3hJMeZWQE2U1Gmb` / prior verified extract in `/Users/nathan.reynolds/clementine-next/revill-lawfirm-raw-seo-metrics-2026-06-04.md`

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

### 2. Website scrape — returned successfully
Source: direct local scrape of `https://revilllawfirm.com`

| Metric | Value |
|---|---|
| Title | Birmingham Criminal Defense Attorney \| Top-Rated Defense \| Revill Law Firm |
| H1 | Birmingham Criminal Defense Attorney |
| Homepage word count | 13,812 |
| Internal links | 387 |
| Total links | 410 |
| Practice signals | criminal defense, DUI, drug crimes, probation violation, theft, juvenile |

### 3. AI visibility — returned successfully
Endpoint: `DATAFORSEO_GET_AI_OPTIMIZATION_LLM_MENTIONS_TOP_DOMAINS_LIVE`  
Tool call evidence: `call_p0BVJrf0uPtl3u32KmNGmZLJ`

Tested Birmingham legal queries:
- Birmingham criminal defense lawyer
- Birmingham DUI lawyer
- Birmingham drug crimes lawyer
- Birmingham theft attorney
- Birmingham probation violation lawyer

Observed result: no ChatGPT citation/source domains were returned in the verified summary for those tested queries.

### 4. Keyword discovery — returned payload
Endpoint: `DATAFORSEO_GET_KW_BING_KW_SUGGESTIONS_FOR_URL_LIVE`  
Tool call evidence: `call_CdgURRRSBnEqHFU6lXPIimFo`

Status: returned a payload, but this endpoint is keyword discovery/suggestions, not a ranked-keywords-by-position table.

### 5. Birmingham local SERP checks — tasks created and payloads retrieved
Create endpoint: `DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST`  
Create call evidence: `call_00T7jgpeRaZpS95VWp6StS7f`

SERP task IDs:
- Birmingham criminal defense lawyer — `06042215-1049-0066-0000-e74b81c49fde`
- Birmingham DUI lawyer — `06042215-1049-0066-0000-0461f157735f`
- Birmingham drug crimes lawyer — `06042215-1049-0066-0000-4f38ebf936aa`
- Birmingham theft attorney — `06042215-1049-0066-0000-cc838f67d49f`
- Birmingham probation violation lawyer — `06042215-1049-0066-0000-8d1c79049589`

Retrieved payload evidence handles from the latest polling pass:
- `call_HcRyGbnJQ1yUrq7DeGjPxsB6`
- `call_tdP1gfGR9I0alGFT4UkK8Ni0`
- `call_2rDth2IMVxUj2I6vXLwCCORY`
- `call_sp5QX7n4QY38iMZOEtJ6ng6k`
- `call_Rawwbp93zj5phjndvL7Y3AZQ`

Status: DataForSEO returned large SERP payloads for these checks. The needed final extraction is: prospect rank, ranking URL, top competing domains, local-pack presence, and SERP features.

## Current usable outreach read
Traffic dropped from 4,530 estimated organic visits in Jun 2025 to 2,108 in May 2026, while ranking keyword count rose from 805 to 888. That suggests Revill may be covering more keyword variants but losing traffic from the highest-value positions. This is a strong raw-data-backed outreach angle, but it should be paired with the final SERP rank/competitor table before being used in production.

## Remaining gap
The deliverable is not final until the five SERP payloads are parsed into a clean ranking table. Do not treat this as a completed SEO baseline yet.
