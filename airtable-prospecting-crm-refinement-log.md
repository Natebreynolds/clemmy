# Airtable Prospecting CRM Refinement Log

Date: 2026-06-01
Base: `appsqmMqkPCk6L1Eq`
Base URL: https://airtable.com/appsqmMqkPCk6L1Eq

## Goal
Refine the prospecting CRM so it can safely store leads, research data, and email history without duplicating outbound emails.

## Tables already in place
- Prospecting Accounts
- Prospecting Contacts
- Prospecting Research Hooks
- Prospecting Outreach
- Prospecting Tasks
- Prospecting Campaigns

## Refinements completed

### New table: Prospecting Dedupe Registry
Created table: `Prospecting Dedupe Registry`
Purpose: one row per contact/campaign outreach key to prevent duplicate emails across Market Leader, non-Market-Leader, and USI prospecting lanes.

Fields created:
- Dedupe Key
- Contact Email
- Campaign
- Account Name
- Last Drafted At
- Last Sent At
- Email Status
- Outlook Draft ID
- Outlook Thread ID
- Do Not Email
- Dedupe Checked At
- Notes

### Prospecting Outreach fields added
- Dedupe Key — normalized Contact Email + Campaign key used to prevent duplicate outreach.
- Email Status — lifecycle state: not drafted, draft pending, approved, sent, replied, bounced, paused, do not email.
- Sent At — timestamp when outreach was sent.
- Last Reply At — timestamp of most recent reply.
- Outlook Thread ID — Outlook conversation/thread ID.
- Do Not Email — blocks drafting/sending for this contact/campaign row.

### Prospecting Contacts fields added
- Do Not Contact — blocks outreach to this contact.
- Last Emailed At — most recent email timestamp for this contact.
- Last Campaign — most recent campaign used for this contact.
- Email Validity — valid, unknown, bounced, risky.

### Prospecting Accounts fields added
- Active Opportunity — marks accounts with an active Salesforce opportunity.
- Last Outreach Campaign — most recent campaign used for this account.
- Last Outreach At — most recent outreach timestamp for this account.
- Do Not Prospect Reason — reason an account should be excluded.

### Prospecting Research Hooks fields added
- DataForSEO Endpoint — source used for the hook, e.g. Local Finder, Maps, Organic SERP, AI visibility.
- Confidence — high, medium, low.
- Use In Email — marks hooks approved for outbound personalization.

## Operating rule going forward
Before creating an Outlook draft, check `Prospecting Dedupe Registry` for the dedupe key:

`lower(contact_email) + "|" + campaign`

If found and not explicitly safe to re-use, update the existing row instead of creating another email. If not found, create the registry row first, create the Outlook draft, then write back Outlook Draft ID / Thread ID and status.

## Import readiness
The base is now ready for a small pilot import of leads + research data. Recommended first pilot: import the 10 Salesforce prospect accounts from the Google Sheet, create matching contacts, add 1–2 research hooks per account, then generate a few approval-gated Outlook drafts.
