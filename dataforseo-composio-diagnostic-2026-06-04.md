# DataForSEO via Composio diagnostic — 2026-06-04

## Connection status
- Composio enabled: true
- API key present: true
- DataForSEO connection: ACTIVE (`ca_l2E9qngGijNQ`)
- Composio CLI authenticated: true

## Catalog evidence
Composio DataForSEO toolkit lists 227 actions. Relevant visible slugs include:

### Works for traffic history
- `DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE`
- Purpose: historical monthly organic/paid traffic estimates for domains/pages.
- Verified on `revilllawfirm.com`: returned 12 months of organic keyword count + estimated traffic.

### Works for local SERP rank checks
- `DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST`
- `DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID`
- Purpose: check exact market/practice keywords and competitors.
- Verified: Birmingham legal SERP tasks were created and payloads were retrieved for Revill.

### Works for AI visibility checks
- `DATAFORSEO_GET_AI_OPTIMIZATION_LLM_MENTIONS_TOP_DOMAINS_LIVE`
- Purpose: ChatGPT / AI Overview mention/citation domains by query.

### Works for keyword discovery, but not domain rank positions
- `DATAFORSEO_GET_DATAFORSEO_LABS_GOOGLE_TOP_SEARCHES_LIVE`
- `DATAFORSEO_CREATE_KW_GOOGLE_KW_FOR_KW_TASK`
- `DATAFORSEO_GET_KW_BING_KW_SUGGESTIONS_FOR_URL_LIVE`
- Purpose: keyword ideas/search volume, not clean ranked organic keywords by domain.

## Missing / not exposed in Composio catalog
I do not see the exact DataForSEO Labs endpoint needed for: “ranked organic keywords for this domain with current positions and ranking URLs.”

The expected native DataForSEO capability would be similar to a Labs ranked-keywords/domain endpoint. In this environment, the native DataForSEO MCP is still connecting, so that endpoint is not directly available here.

## Confirmed Revill raw metric output from Composio
Traffic history endpoint returned:

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

## Recommended baseline until native ranked-keywords is available
1. Domain traffic history: `DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE`.
2. Exact local keyword SERPs: create + poll organic SERP tasks for 5–10 city/practice terms.
3. Local pack/Maps checks: Google Maps or Local Finder task slugs from Composio catalog.
4. AI visibility: `DATAFORSEO_GET_AI_OPTIMIZATION_LLM_MENTIONS_TOP_DOMAINS_LIVE`.
5. Keyword discovery/search volume: keyword suggestions/top-searches endpoints.
6. If ranked organic keywords by domain are required, use native DataForSEO MCP/API once connected; Composio catalog currently does not expose that exact endpoint.

## Decision rule for CRM
Do not write an SEO record as “complete” unless it includes either:
- the native ranked-keywords-by-domain table, or
- an explicit fallback table from local SERP checks showing rank/absence for the selected prospecting keywords.
