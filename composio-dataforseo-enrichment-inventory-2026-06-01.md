# Composio DataForSEO enrichment inventory — 2026-06-01

## Verified discovery evidence
Composio toolkit searched: `dataforseo`.

### Keyword / SERP / ranking-related slugs discovered
- `DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST` — create Google organic SERP tasks for target keyword + location. Best for identifying whether a prospect/domain appears for practice-area market searches and who ranks above them.
- `DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID` — retrieve advanced organic SERP task results by task id.
- `DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_REGULAR_BY_ID` — retrieve regular organic SERP task results by task id.
- `DATAFORSEO_CREATE_SERP_GOOGLE_LOCAL_FINDER_TASK` — create local finder tasks for map/local-pack style visibility checks.
- `DATAFORSEO_CREATE_SERP_GOOGLE_MAPS_TASK` — create Google Maps tasks for local competitor/local visibility checks.
- `DATAFORSEO_GET_KW_GOOGLE_ADS_KW_FOR_KW_LIVE` — keyword suggestions and metrics from seed keywords, useful after scraping site practice areas.
- `DATAFORSEO_CREATE_KW_GOOGLE_KW_FOR_KW_TASK` / `DATAFORSEO_GET_KW_GOOGLE_KW_FOR_KW_TASK_BY_ID` — standard keyword data task/result path for keyword ideas.
- `DATAFORSEO_GET_KEYWORDS_DATA_GOOGLE_SEARCH_VOLUME_TASK_BY_ID` — search volume results by task id.
- `DATAFORSEO_GET_KW_GOOGLE_ADS_KW_FOR_SITE_TASK` — Google Ads keywords-for-site result retrieval by task id; create endpoint was not surfaced in the latest search results.
- `DATAFORSEO_LIST_KW_GOOGLE_ADS_KW_FOR_SITE_TASKS_READY` and `DATAFORSEO_LIST_KW_GOOGLE_KW_FOR_SITE_TASKS_READY` — ready task lists for prior standard tasks.

### Other useful Composio DataForSEO slugs discovered
- `DATAFORSEO_GET_BACKLINKS_SUMMARY_LIVE` — backlink summary by domain.
- `DATAFORSEO_GET_BACKLINKS_BULK_PAGES_SUMMARY_LIVE` — bulk backlink summaries for multiple targets.
- `DATAFORSEO_CREATE_ON_PAGE_LIGHTHOUSE_TASK_POST` / `DATAFORSEO_GET_ON_PAGE_LIGHTHOUSE_TASK_GET_JSON` — Lighthouse/on-page quality by URL.
- `DATAFORSEO_CREATE_ON_PAGE_TASK_POST` / `DATAFORSEO_GET_ON_PAGE_SUMMARY_BY_ID` — on-page crawl and summary.
- `DATAFORSEO_GET_AI_OPTIMIZATION_LLM_MENTIONS_TOP_DOMAINS_LIVE` — AI/LLM top-domain visibility for target prompts/keywords.

### Firecrawl slugs discovered for scrape-first step
- `FIRECRAWL_SCRAPE` — scrape one URL to markdown/content.
- `FIRECRAWL_EXTRACT` / `FIRECRAWL_EXTRACT_GET` — extract structured practice areas, city, positioning, attorney names, proof points.
- `FIRECRAWL_MAP_MULTIPLE_URLS_BASED_ON_OPTIONS` — discover relevant practice-area pages before scraping.
- `FIRECRAWL_BATCH_SCRAPE` — scrape multiple URLs.

## Near-term enrichment method
1. Pull Airtable prospect row: firm, website, city/market, contact.
2. Firecrawl scrape/extract the website to identify actual practice areas and market language.
3. Build 3–5 local search terms, e.g. `dui attorney near me`, `criminal defense lawyer Chattanooga`, `personal injury attorney [city]`.
4. Use Composio DataForSEO organic SERP/local finder/maps tasks for those terms and market.
5. Capture prospect rank if present, competitors above them, directories dominating the SERP, and near-page-1/page-1/top-3 gaps.
6. Use backlink/on-page/AI visibility as secondary proof points.
7. Write Airtable Notes with only sourced/observed claims and a prospecting email angle.

## Important limitation
The current Composio discovery did not surface the same native DataForSEO Labs ranked-keywords endpoint that directly returns all organic keyword positions for a domain. For exact domain keyword-position inventory such as “firm ranks #12 for ‘dui attorney near me’,” prefer native DataForSEO Labs when available; otherwise use Composio SERP tasks around scraped practice-area/city keywords to produce equivalent market-specific ranking evidence.
