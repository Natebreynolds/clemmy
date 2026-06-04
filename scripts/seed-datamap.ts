/**
 * One-time honest seed for the Data Map (source-map) viewer — a few
 * genuinely-real sources for this user so the panel demonstrates value on first
 * view. The layer ALSO grows reactively as Clementine navigates connectors;
 * these are just accurate starters, not fabricated data. Writes to the real
 * ~/.clementine-next memory.db (do NOT set CLEMENTINE_HOME).
 *
 * Run: npx tsx scripts/seed-datamap.ts
 */
import { upsertResourcePointer, countResourcePointers } from '../src/memory/source-map.js';

const seeds = [
  {
    app: 'Salesforce', kind: 'object', name: 'Accounts',
    whatsHere: 'Client + prospect accounts; Market_Leader__c flag; owner-scoped to Nathan',
    whenToUse: 'Prospect selection, account lookups, outreach targeting',
    trust: 0.9, source: 'reactive' as const,
  },
  {
    app: 'Outlook', kind: 'label', name: 'Sent & Drafts',
    whatsHere: 'Outbound prospecting + client email; drafts awaiting approval',
    whenToUse: 'Sending outreach, checking replies before discovery',
    trust: 0.9, source: 'reactive' as const,
  },
  {
    app: 'Airtable', kind: 'base', name: 'Prospecting CRM',
    whatsHere: 'Prospect accounts, contacts, outreach, research runs, campaigns',
    whenToUse: 'Tracking the prospecting pipeline + enrichment',
    trust: 0.9, source: 'reactive' as const,
  },
  {
    app: 'DataForSEO', kind: 'site', name: 'SEO / SERP data',
    whatsHere: 'Ranked keywords, domain rank, backlinks, Lighthouse for prospect domains',
    whenToUse: 'Building SEO opportunity briefs + audits for law-firm prospects',
    trust: 0.85, source: 'reactive' as const,
  },
];

for (const s of seeds) {
  const p = upsertResourcePointer(s);
  console.log('seeded:', p.app, '·', p.kind, '·', p.name);
}
console.log('total pointers now:', countResourcePointers());
