/**
 * Guardrail for docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md.
 *
 * The framework decided "is this an operation?" by testing a name against
 * Composio's spelling convention in 21 places. A reviewed CLI read is
 * lower_snake, so all 21 answered "not an operation" for it — one defect that
 * produced twelve different failures in a single workflow.
 *
 * The reason it kept coming back is that each repair ADDED a spelling instead
 * of removing the test: the 2026-09-11 fix added an UPPER_SNAKE branch, the
 * 2026-08-27 fix added a carrier-keeps rule, and both were re-broken by the
 * next carrier. This script is what makes that regression visible at review
 * time rather than in a live run six weeks later.
 *
 * A site is allowed to ask "is this spelled like a composio slug?" ONLY inside
 * a composio-specific path. Ask `operationIdentity(name)` anywhere else.
 *
 * Run: node scripts/check-operation-identity.mjs
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** The shape test this wave exists to contain. */
const SHAPE = /\[A-Z\]\[A-Z0-9\]\*\(\?:_\[A-Z0-9\]/;

/**
 * Sites that legitimately ask a composio-specific question, each verified by
 * reading its call path. Adding to this list is a deliberate act: it asserts
 * the answer is consumed only inside a composio path, never as "is this an
 * operation at all".
 */
const COMPOSIO_SCOPED = new Set([
  'src/tools/composio-carrier.ts',
  'src/tools/pending-action-admission.ts',
  'src/tools/tool-search-provider-sources.ts',
  'src/integrations/composio/client.ts',
  'src/runtime/harness/auto-remember.ts',
  'src/runtime/harness/capability-resolution.ts',
  'src/runtime/harness/composio-carrier-completion.ts',
  'src/runtime/harness/discovery-boundary.ts',
  'src/runtime/harness/execution-gate.ts',
  // Privacy conservatism about what may ship as a public identity, not a
  // capability decision. Category C in the plan.
  'src/runtime/harness/public-presentation.ts',
  // The one owner. Keeps a composio-slug shape for a provider operation
  // discovery has not seen yet, which no registry can answer.
  'src/tools/operation-name-identity.ts',
  // Reachability falls back to shape below identity, for that same case.
  'src/runtime/harness/callable-surface.ts',
  // Admission guard with an incident behind it (2026-09-01 phantom operation);
  // its red-before proof would not go red, so it stays as it is.
  'src/execution/workflow-step-external-catalog.ts',
  // Composio-only scope whose throw is unreachable from its sole producer.
  'src/runtime/harness/accepted-source-catalog-scope.ts',
  // Warning advice + a conservative autonomous-send floor. Widening the floor
  // is a safety decision, not a naming one.
  'src/execution/workflow-validator.ts',
  // Keeps the composio gateway for a slug no registry carries yet.
  'src/agents/workflow-step-agent.ts',
  // Identity decides first; the 2026-09-11 UPPER_SNAKE branch survives beneath
  // it for the same undiscovered-slug case. (Its neighbouring carrier-prefix
  // literal belongs to the 108-file literal census, Step 6 — not this check.)
  'src/execution/workflow-enforce.ts',
]);

const tracked = execFileSync('git', ['ls-files', 'src/**/*.ts'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file.endsWith('.ts') && !file.includes('.test.'));

const offenders = [];
for (const file of tracked) {
  let body;
  try { body = readFileSync(file, 'utf8'); } catch { continue; }
  if (!SHAPE.test(body)) continue;
  if (COMPOSIO_SCOPED.has(file)) continue;
  offenders.push(file);
}

if (offenders.length > 0) {
  console.error('Operation identity check FAILED.\n');
  console.error('These files test an operation name against composio\'s spelling convention');
  console.error('without being on the composio-scoped allowlist:\n');
  for (const file of offenders) console.error(`  ${file}`);
  console.error('\nAsk operationIdentity(name) instead — it answers from what an operation');
  console.error('DECLARES (providerKind, effect), so every carrier is covered rather than the');
  console.error('one whose spelling was anticipated. If the site is genuinely composio-only,');
  console.error('add it to COMPOSIO_SCOPED in this script and say why in the commit.');
  console.error('\nSee docs/SPELLING-IS-NOT-IDENTITY-PLAN-2026-09-18.md');
  process.exit(1);
}

console.log(`Operation identity check passed (${COMPOSIO_SCOPED.size} composio-scoped sites allowlisted).`);
