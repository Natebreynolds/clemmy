# DataForSEO Verification — 2026-06-01

## Status
DataForSEO is working when called through the native MCP tools directly. Do not route DataForSEO work through Composio.

## Verified native tools
1. `dataforseo__dataforseo_labs_google_ranked_keywords`
   - Target: `chattanoogatnlawfirm.com`
   - Result status: `20000 Ok`
   - Evidence returned:
     - `motorcycle red light laws` — search volume 4,400; chattanoogatnlawfirm.com ranking position 67
     - `red light motorcycle law` — search volume 4,400; ranking position 82
     - `family law attorney in tennessee` — search volume 3,600; ranking position 30

2. `dataforseo__serp_organic_live_advanced`
   - Keyword: `dui lawyer Chattanooga`
   - Location: `Chattanooga,Tennessee,United States`
   - Result status: `20000 Ok`
   - Evidence returned:
     - Local pack: Best and Brock, Davis & Hoss, Houston & Underwood
     - Organic competitors: Justia, Best and Brock, Speek Turner & Newkirk, Davis & Hoss, Mochel Law, Sam Byrd, Houston & Underwood, Stevie Phillips

3. `dataforseo__dataforseo_labs_google_competitors_domain`
   - Target: `chattanoogatnlawfirm.com`
   - Result status: `20000 Ok`
   - Evidence returned:
     - chattanoogatnlawfirm.com: 256 organic keywords, estimated organic traffic 623.553, estimated paid traffic value $8,100.201
     - Ranking distribution: 4 keywords at #1, 5 in positions 2–3, 52 in positions 4–10
     - Competitor/domain intersections: justia.com 198, findlaw.com 188, avvo.com 179

## Correct usage pattern saved to memory
- Use native DataForSEO MCP tools directly.
- Use country-level Labs calls for domain/ranked keyword/competitor metrics.
- Use city-level live SERP calls for local practice-area gap analysis.
- For prospect enrichment: scrape/inspect the site first to identify real practice areas and market, then run searches like `<practice area> lawyer <city>` / `<practice area> attorney <city>` and summarize competitors, rankings, gaps, and safe email angle.

## Memory record evidence
- Saved reference memory #652: native DataForSEO tools verified and correct usage pattern.
- Saved reference memory #653: concrete verification evidence with status codes and returned metrics.
