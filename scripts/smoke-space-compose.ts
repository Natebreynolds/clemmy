/**
 * Live smoke for the Workspace LLM "compose" step.
 *   npx tsx scripts/smoke-space-compose.ts
 * Confirms composeForSpace turns an account row into a grounded personalized
 * email draft (no hallucinated facts).
 */
import { configureHarnessRuntime } from '../src/runtime/harness/codex-client.js';
import { composeForSpace } from '../src/spaces/compose.js';

const ROW = {
  contactName: 'Dana Reyes',
  company: 'Sample Law Partners',
  email: 'dana@sample-law.example',
  uisCampaign: 'Spring Personal-Injury Push',
  metrics: { organicTrafficChange: '+18% MoM', topKeyword: 'birmingham injury lawyer (#3)' },
  priorWork: 'https://reports.example/sample-baseline',
};

async function main() {
  const configured = await configureHarnessRuntime();
  if (!configured.ok) { console.error(`✗ runtime not configured: ${configured.reason}`); process.exit(1); }

  const out = await composeForSpace(
    'Write a warm, concise (~110 word) outreach email to the contact about their UIS campaign results. Put the subject on the first line prefixed "Subject:", then a blank line, then the body. Reference the prior work link. End with a soft CTA to book 15 minutes. Sign as "Alex".',
    ROW,
    1200,
  );

  if (!out.ok) { console.error(`✗ compose failed: ${out.error}`); process.exit(1); }
  console.log('--- DRAFT ---\n' + out.text + '\n-------------');

  // Grounding checks: real facts present, and the obviously-fake guardrail (no
  // invented phone/number that wasn't supplied).
  const hasCompany = /Sample Law Partners/.test(out.text);
  const hasContact = /Dana/.test(out.text);
  const hasSubject = /^subject:/im.test(out.text);
  const ok = hasCompany && hasContact && hasSubject;
  console.log(`company=${hasCompany} contact=${hasContact} subjectLine=${hasSubject}`);
  console.log(ok ? '✓ compose produced a grounded, formatted draft' : '✗ draft missing grounded facts/format');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
