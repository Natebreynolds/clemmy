# Airtable Prospecting CRM Schema Audit

Date: 2026-06-01
Base audited: `appsqmMqkPCk6L1Eq`
Base URL: https://airtable.com/appsqmMqkPCk6L1Eq
Verification source: `AIRTABLE_GET_BASE_SCHEMA` succeeded after table creation.

## Audit question
Is the base organized well enough to add prospect research, SEO/data hooks, and email history without doubling up on outreach?

## Evidence from schema
The base contains the six core CRM tables needed for the prospecting workflow:

1. `Prospecting Accounts`
   - Stores account-level identity and segmentation.
   - Key fields observed/created: Account Name, Prospecting Lane, Salesforce Account ID, Salesforce Opportunity ID, Website, Market, Vertical, Research Hook, SEO Opportunity Summary, Priority, Outreach Status, Last Touch Date, Next Follow-up Date, Disqualification Reason.

2. `Prospecting Contacts`
   - Stores decision-maker/contact data.
   - Key fields observed/created: Contact Name, Account Name, Salesforce Contact ID, Title, Email, Phone, LinkedIn URL, Contact Quality, Notes.

3. `Prospecting Research Hooks`
   - Stores research and personalization hooks.
   - Key fields observed/created: Hook Name, Account Name, Source, Keyword, Position, Competitor, Evidence URL, Hook Summary, Verified At.

4. `Prospecting Outreach`
   - Stores email drafting and outreach history.
   - Key fields observed/created: Outreach Name, Account Name, Contact Email, Campaign, Email Subject, Email Body, Draft Status, Outlook Draft ID, Last Drafted At, Chili Piper Link Included.

5. `Prospecting Tasks`
   - Stores follow-up reminders and next actions.
   - Key fields observed/created: Task Name, Account Name, Task Type, Owner, Due Date, Status, Notes.

6. `Prospecting Campaigns`
   - Stores campaign definitions.
   - Key fields observed/created: Campaign Name, Lane, Target Segment, Messaging Angle, Active, Default Follow-up Cadence.

## Assessment
The structure is directionally sound. It separates the core objects correctly:

- Accounts = the firm/business being prospected.
- Contacts = the person we may email.
- Research Hooks = evidence and personalization inputs.
- Outreach = actual email draft/send history.
- Tasks = follow-up work.
- Campaigns = reusable messaging lanes.

That is the right foundation for storing research and email data without mixing everything into one flat sheet.

## Dedupe risk
The current schema supports dedupe, but it does not yet enforce it strongly enough.

The biggest duplicate-email risk is that `Prospecting Outreach` currently tracks `Account Name`, `Contact Email`, and `Campaign`, but does not yet have a dedicated unique dedupe key field. Airtable can still be used safely if we consistently check those three values before creating a draft, but a generated key would make the process much more reliable.

## Recommended additions before importing/sending at scale
Add these fields:

### Prospecting Outreach
- `Dedupe Key` — formula or single-line text: normalized `Contact Email + Campaign`.
- `Email Status` — draft pending, approved, sent, replied, bounced, paused, do not contact.
- `Sent At` — date/time.
- `Last Reply At` — date/time.
- `Thread ID` — Outlook conversation/thread identifier.
- `Do Not Email` — checkbox.
- `Dedupe Checked At` — date/time.

### Prospecting Contacts
- `Do Not Contact` — checkbox.
- `Last Emailed At` — date/time.
- `Last Campaign` — single-line text.
- `Email Validity` — valid, unknown, bounced, risky.

### Prospecting Accounts
- `Last Outreach Campaign` — single-line text.
- `Last Outreach At` — date/time.
- `Active Opportunity` — checkbox.
- `Do Not Prospect Reason` — text.

## Operating rule to prevent duplicate emails
Before creating any Outlook draft, check Airtable for an existing Outreach row where:

`Contact Email` matches the target email AND `Campaign` matches the campaign AND `Email Status` is not bounced/paused/do-not-contact.

If a row exists, update that row instead of creating a new draft. If no row exists, create the Outreach row first, then create the Outlook draft, then write the Outlook Draft ID back to Airtable.

## Verdict
Yes — this base is well organized for research + outreach history, but it needs a small dedupe layer before we rely on it for high-volume prospecting. The backbone is good; the next best step is adding the dedupe/status fields above, then importing the 10 prospects and using the Outreach table as the source of truth before any Outlook drafts are created.
