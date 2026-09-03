/**
 * Run: node scripts/run-tests-isolated.mjs src/no-hardcoded-provider-pins.test.ts
 *
 * The harness must not hold provider-specific operation pins.
 *
 * Owner rule (2026-09-02): "the harness should never hold something like
 * 'google sheets'". Clem learns her own pins into procedural memory
 * (memory/tool-choice-store.ts) at runtime, where a renamed schema or a new
 * tool is learned rather than compiled in. Production source still carries
 * pins from earlier waves, so this is a RATCHET, not a ban: every file's count
 * of provider-slug literals may only fall. A new file with any, or an existing
 * file with more, fails the build and names the file. Test files and fixtures
 * are allowed to name real slugs.
 *
 * When one of these counts goes down, lower the baseline in the same commit.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));

const PROVIDER_SLUG_RE = /\b(?:GOOGLESHEETS|SLACK|GMAIL|AIRTABLE|SALESFORCE|OUTLOOK|HUBSPOT|NOTION|GOOGLECALENDAR|GOOGLEDRIVE|GOOGLEDOCS|LINKEDIN|APIFY|MONDAY|DISCORD|TWITTER|TRELLO|ASANA|JIRA|ZOOM|CALENDLY|STRIPE|SHOPIFY|GOOGLEADS|METAADS|SUPABASE)_[A-Z0-9_]{3,}\b/g;

/** Per-file ceilings as of 2026-09-02. Only ever lower these. */
const BASELINE: Record<string, number> = {
  'channels/discord.ts': 95,
  'config.ts': 50,
  'channels/slack.ts': 44,
  'setup/setup.ts': 24,
  'runtime/notifications.ts': 23,
  'runtime/harness/sheet-from-json-content-contract.ts': 20,
  'integrations/composio/async-job.ts': 18,
  'setup/doctor.ts': 17,
  'channels/webhook.ts': 15,
  'execution/background-tasks.ts': 14,
  'integrations/composio/slug-effect.ts': 12,
  'dashboard/console-routes.ts': 12,
  'tools/composio-tools.ts': 11,
  'runtime/notification-delivery.ts': 11,
  'integrations/composio/operation-semantics.ts': 11,
  'index.ts': 11,
  'runtime/harness/execution-gate.ts': 10,
  'runtime/harness/tool-guardrail.ts': 9,
  'runtime/exact-origin-delivery.ts': 7,
  'daemon/runner.ts': 7,
  'runtime/harness/production-capability-adapters.ts': 6,
  'integrations/composio/mcp-scope-adapter.ts': 6,
  'channels/discord-install.ts': 6,
  'tools/tool-search-tool.ts': 5,
  'memory/tool-choice-store.ts': 5,
  'channels/discord-store.ts': 5,
  'tools/tool-search-provider-sources.ts': 4,
  'runtime/harness/connected-goal-catalog.ts': 4,
  'execution/workflow-validator.ts': 4,
  'channels/discord-harness.ts': 4,
  'agents/proactive-briefs.ts': 4,
  'agents/calendar-monitor.ts': 4,
  'tools/composio-carrier.ts': 3,
  'runtime/semantic-boundary/production-bootstrap-fixtures.ts': 3,
  'runtime/semantic-boundary/isolated-vertical.ts': 3,
  'runtime/secrets/registry.ts': 3,
  'runtime/harness/discovery-advisory.ts': 3,
  'runtime/harness/composio-carrier-completion.ts': 3,
  'runtime/harness/capability-resolution.ts': 3,
  'runtime/harness/brackets.ts': 3,
  'memory/capability-semantic-index.ts': 3,
  'integrations/composio/outlook-sender-verifier.ts': 3,
  'agents/planner.ts': 3,
  'tools/tool-choice-tools.ts': 2,
  'spaces/space-smoke.ts': 2,
  'runtime/harness/work-report.ts': 2,
  'runtime/harness/tool-effect.ts': 2,
  'runtime/harness/staged-transfer-production-fixture.ts': 2,
  'runtime/harness/host-capability-catalog-factory.ts': 2,
  'runtime/harness/expected-work-admission.ts': 2,
  'runtime/harness/accepted-source-settlement-audit.ts': 2,
  'runtime/activity-format.ts': 2,
  'integrations/composio/client.ts': 2,
  'execution/workflow-step-effect.ts': 2,
  'execution/workflow-runner.ts': 2,
  'execution/workflow-runner-migration.ts': 2,
  'execution/workflow-live-call-compiler.ts': 2,
  'execution/workflow-describe.ts': 2,
  'channels/slack-harness.ts': 2,
  'agents/tool-taxonomy.ts': 2,
  'agents/inbox-monitor.ts': 2,
  'tools/tool-contract-store.ts': 1,
  'tools/space-tools.ts': 1,
  'tools/registry.ts': 1,
  'tools/composio-schema-cache.ts': 1,
  'tools/composio-batch-validator.ts': 1,
  'spaces/store.ts': 1,
  'runtime/harness/tool-narration-shapes.ts': 1,
  'runtime/harness/tool-error-corrective.ts': 1,
  'runtime/harness/source-strategy-admission.ts': 1,
  'runtime/harness/runtime-tool-identity.ts': 1,
  'runtime/harness/public-presentation.ts': 1,
  'runtime/harness/loop.ts': 1,
  'runtime/harness/host-turn-runner.ts': 1,
  'runtime/harness/callable-surface.ts': 1,
  'runtime/harness/attempt-settlement.ts': 1,
  'runtime/harness/accepted-model-batch-checkpoint-process-fixture.ts': 1,
  'runtime/dev-flags.ts': 1,
  'runtime/approval-summary.ts': 1,
  'memory/tool-choice-audit.ts': 1,
  'memory/skill-distiller.ts': 1,
  'integrations/composio/standing-policy-compiler.ts': 1,
  'integrations/composio/identity-cache.ts': 1,
  'execution/trace-to-workflow.ts': 1,
  'channels/slack-manifest.ts': 1,
  'assistant/instructions.ts': 1,
  'agents/workflow-step-agent.ts': 1,
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      out.push(...walk(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry) || /\.fixture\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

test('provider-slug literals in production source only ever decrease (no new hardcoded tool pins)', () => {
  const grew: string[] = [];
  const fresh: string[] = [];
  const counts = new Map<string, number>();
  for (const file of walk(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    const count = [...text.matchAll(PROVIDER_SLUG_RE)].length;
    if (count === 0) continue;
    counts.set(rel, count);
    const ceiling = BASELINE[rel];
    if (ceiling === undefined) fresh.push(`${rel} (${count})`);
    else if (count > ceiling) grew.push(`${rel} (${count} > ${ceiling})`);
  }
  assert.deepEqual(
    fresh,
    [],
    'a NEW production file names provider operations directly. The harness must not hold a service pin: '
    + 'resolve the operation from the connected catalog or the proven entries this turn, or let Clem learn it '
    + 'into procedural memory (memory/tool-choice-store.ts).',
  );
  assert.deepEqual(
    grew,
    [],
    'an existing file gained provider-operation literals. Lower, never raise, the pin count.',
  );
  // Informational: files whose count fell below the ceiling — lower the
  // baseline in the same commit so the ratchet keeps its teeth.
  const slack = Object.entries(BASELINE)
    .filter(([rel, ceiling]) => (counts.get(rel) ?? 0) < ceiling)
    .map(([rel, ceiling]) => `${rel}: ${counts.get(rel) ?? 0} < ${ceiling}`);
  if (slack.length > 0) {
    // Not a failure: shrinking is the goal. Surface it so the baseline follows.
    console.warn(`[no-hardcoded-provider-pins] baseline can be lowered for: ${slack.join('; ')}`);
  }
});
