# Prospecting Contacts SEO metrics evidence — 2026-06-04

Airtable destination:
- Base: Scorpion Prospecting (`appsqmMqkPCk6L1Eq`)
- Table: Prospecting Contacts (`tblJ3l4l9B5iLUsJq`)
- Airtable table URL: https://airtable.com/appsqmMqkPCk6L1Eq/tblJ3l4l9B5iLUsJq

## Tool calls / verified source status

- Airtable records loaded successfully from Prospecting Contacts filtered to `Market Leader - Non R&R`.
- DataForSEO connection is ACTIVE in Composio.
- DataForSEO Backlinks bulk pages summary task IDs returned but subscription blocked results:
  - `06042058-1049-0576-0000-d2a4f53efe90` — status `40204 Access denied` for backlinks subscription.
  - `06042058-1049-0482-0000-7ba2ca3c3af0` — status `40204 Access denied` for backlinks spam score subscription.
- DataForSEO AI Optimization LLM mentions task returned successfully for first 10 keyword targets:
  - `06042059-1049-0637-0000-86b448495a70`
  - Result: `items=null`; no source/citation domains returned for those prompts.
- A 14-target AI mentions attempt returned a useful API constraint: `target` items must be between 1 and 10.

## Current raw website scrape metrics

| Airtable Record ID | Firm | Domain | Scrape status | Page title | H1 | Word count | Practice signals |
|---|---|---:|---|---|---|---:|---|
| rec0fbo7GmlMXRVA4 | The Gertz Law Firm | gertzlawyers.com | fetch_failed |  |  |  | HTTP 403 |
| rec9I1gorNOntXJ0b | Becker Law Office | beckerlaw.com | scraped | Kentucky's Personal Injury Lawyers \| Becker Law Office Injury Lawyers | Kentucky Personal Injury Lawyer | 30626 | personal injury; car accident; truck accident |
| recAhHRFTVfyC85B1 | Fox Willis Burnette, Attorneys At Law | foxandfarleylaw.com | scraped | Tennessee Personal Injury Lawyer | Tennessee Personal Injury Lawyers | 10186 | personal injury; criminal defense; DUI; car accident; truck accident; workers compensation |
| recBN85mKc2wOv75Q | Hogan Eickoff | hoganeickhoff.com | fetch_failed |  |  |  | HTTP 403 |
| recDLekJryfRMiBF8 | Cook, Bradford & Levy, Llc | cookinjurylaw.com | scraped | Boulder Personal Injury Lawyer \| Lafayette Accident Attorney \| Cook, Bradford & Levy | Boulder Personal Injury Lawyers | 10227 | personal injury; car accident; truck accident |
| recIB6E9QbqbTdNKY | Collins Law | acollinslaw.com | scraped | Birmingham Personal Injury Lawyer - Collins Law, LLC | Birmingham Personal Injury Lawyer | 25273 | personal injury; car accident; truck accident |
| recISSPfbNKJelF3a | Greco Neyland Attorneys at Law | newyorkcriminallawyer.com | scraped | NYC Criminal Lawyer \| Best New York Criminal Defense Attorney \| Greco Neyland, PC | New York Criminal Defense Lawyer | 8719 | criminal defense |
| recbsEKr4h6o8yLdx | Krum, Gergely, & Oates | kgofirm.com | scraped | KGO Law Firm - Law Offices of Krum, Gergely, & Oates | No Matter the Legal Challenge, Our Lawyers Can Help You | 15048 | personal injury; criminal defense; DUI; family law |
| recgARwlgFgKesDlM | Joshi & Schisani Law Firm | joshi-law.com | scraped | Orlando Criminal Defense Lawyer | Orlando Criminal Defense Lawyers | 8188 | criminal defense; DUI |
| recjwtVkfH45JBLNI | Sherrod & Bernard | sherrodandbernard.com | scraped | Douglasville Personal Injury Attorneys - Sherrod & Bernard, P.C. | REPUTATION. RESPECT. RESULTS. | 18247 | personal injury; car accident; truck accident |
| reck1MvllnFNSSiRO | Nicolet Law Accident & Injury Lawyers-Minneapolis | nicoletlaw.com | fetch_failed |  |  |  | HTTP 403 |
| recmOOQHSPh37Ic3f | Doran, Beam & Farrell | pascoinjurylaw.com | fetch_failed |  |  |  | HTTP 403 |
| recquCfXnJWq22xnt | Beaver Courie | beavercourie.com | scraped | Criminal, Traffic, Family and Injury Lawyers \| Cumberland, Hoke & Moore County Criminal Lawyers | Criminal, Traffic, Family and Injury Lawyers | 9054 | personal injury; criminal defense; DUI; car accident; family law; divorce |
| recthADZL1EBmlieo | The Law Offices of Smith and White | smithandwhite.com | fetch_failed |  |  |  | HTTP 403 |
| recxLJGwpe5OYg2NN | Yates & Wheland-Chattanooga | chattanoogatnlawfirm.com | fetch_failed |  |  |  | HTTP 403 |

## What counts as the refined SEO metric standard going forward

When Nate asks for SEO scrape/enrichment, capture measured data in this order:
1. Domain ranking keywords: keyword, current position, search volume, ranking URL, traffic/cost if available.
2. Local SERP checks for 2–3 practice+city terms: organic rank, local-pack presence, visible competitors, map pack competitors.
3. AI visibility: prompt/query, platform, whether prospect domain is cited/mentioned, top cited domains, source URLs if returned.
4. Authority/backlink metrics only if the DataForSEO Backlinks subscription is available; otherwise mark `blocked: backlinks subscription` rather than inventing DA/DR.
5. Website scrape facts: title/H1, word count, practice signals, fetch status.

## Airtable update note

Prospecting Contacts currently lacks first-class fields for website, Salesforce Account ID, ranked keywords, local SERP results, AI visibility, SEO captured at, and data-source task IDs. Until the CRM schema is cleaned up, only compact evidence can safely be written to `Notes`; the full raw metrics should live in an artifact or a dedicated SEO metric table.
