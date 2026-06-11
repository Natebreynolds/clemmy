# Prospecting Contacts migration evidence — 2026-06-04

Correct Airtable destination:
- Base: Scorpion Prospecting (`appsqmMqkPCk6L1Eq`)
- Table: Prospecting Contacts (`tblJ3l4l9B5iLUsJq`)
- Airtable table URL: https://airtable.com/appsqmMqkPCk6L1Eq/tblJ3l4l9B5iLUsJq

## Created records in Prospecting Contacts

| Airtable Record ID | Account Name | Contact | Email | Campaign | Notes include website + Salesforce Account ID |
|---|---|---|---|---|---|
| recISSPfbNKJelF3a | Greco Neyland Attorneys at Law | Jeffery L. Greco | jeff@gnlaw.nyc | Market Leader - Non R&R | yes |
| recjwtVkfH45JBLNI | Sherrod & Bernard | Kenneth R. Bernard | kbernard@sherrodandbernard.com | Market Leader - Non R&R | yes |
| recgARwlgFgKesDlM | Joshi & Schisani Law Firm | Rajan Joshi | rajan@joshi-law.com | Market Leader - Non R&R | yes |
| recmOOQHSPh37Ic3f | Doran, Beam & Farrell | Anna Farrell | afarrell@pascolawteam.com | Market Leader - Non R&R | yes |
| recBN85mKc2wOv75Q | Hogan Eickoff | Danielle M. Gorsuch | danielle.gorsuch@hoganeickhoff.com | Market Leader - Non R&R | yes |
| recDLekJryfRMiBF8 | Cook, Bradford & Levy, Llc | Brian M. Bradford | brian@colegalteam.com | Market Leader - Non R&R | yes |
| recAhHRFTVfyC85B1 | Fox Willis Burnette, Attorneys At Law | Beth Office Manager | beth@foxlawtn.com | Market Leader - Non R&R | yes |
| recbsEKr4h6o8yLdx | Krum, Gergely, & Oates | David M. Krum | david@kgofirm.com | Market Leader - Non R&R | yes |
| recIB6E9QbqbTdNKY | Collins Law | April H. Collins | acollins@acollinslaw.com | Market Leader - Non R&R | yes |
| rec9I1gorNOntXJ0b | Becker Law Office | Christopher Goode | cgoode@bubalolaw.com | Market Leader - Non R&R | yes |
| rec0fbo7GmlMXRVA4 | The Gertz Law Firm | Ryan Gertz | rgertz@gertzadair.com | Market Leader - Non R&R | yes |
| recquCfXnJWq22xnt | Beaver Courie | David T. Courie | dtc@beavercourie.com | Market Leader - Non R&R | yes |
| recxLJGwpe5OYg2NN | Yates & Wheland-Chattanooga | Allen Yates | ay@ywlawyers.com | Market Leader - Non R&R | yes |
| recthADZL1EBmlieo | The Law Offices of Smith and White | James J. White | james@smithandwhite.com | Market Leader - Non R&R | yes |
| reck1MvllnFNSSiRO | Nicolet Law Accident & Injury Lawyers-Minneapolis | Russell Nicolet | russell@nicoletlaw.com | Market Leader - Non R&R | yes |

## Schema correction
Prospecting Contacts does not have `Salesforce Account ID` or `Website` fields, so those values were preserved in `Notes`. A cleaner CRM restructure should add first-class fields for website, Salesforce account ID, SEO metric snapshot, AI visibility result, and data source timestamp before the next daily prospecting batch.

## SEO correction
The earlier qualitative SEO notes should not be treated as raw SEO data. Future SEO enrichment should use measured metric fields from DataForSEO or equivalent: ranked keywords, positions, search volume, estimated traffic, ranking URLs, SERP competitors, local-pack status, and AI mention/citation results.
