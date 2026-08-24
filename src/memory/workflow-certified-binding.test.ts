/**
 * Run: npx tsx --test src/memory/workflow-certified-binding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-certified-binding-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
mkdirSync(path.join(TMP_HOME, 'workflows', 'runs'), { recursive: true });

const {
  CERTIFIED_STEP_OUTPUT_MIN_RUNS,
  coerceStepOutputRecord,
  formatSettledStepPinBlock,
  loadPriorSuccessfulStepOutputs,
  normalizeCertifiedIdentityValue,
  pinDispatchFromChoice,
  resolveCertifiedStepOutput,
  workflowStepPinIntent,
} = await import('./workflow-certified-binding.js');

const PAGE_A = 'https://www.facebook.com/Scorpion.co/';
const PAGE_A_NORM = 'https://www.facebook.com/scorpion.co';
const PAGE_B = 'https://www.facebook.com/other.page';

const identityContract = {
  required_keys: ['facebook_page_url', 'verification_evidence'],
  verify: { url_present: ['facebook_page_url'] },
};

const collectionContract = {
  required_keys: ['source_page_url', 'posts_reviewed_count', 'key_findings'],
  verify: { url_present: ['source_page_url'] },
  non_empty: ['key_findings'],
};

function pageOutput(url: string, evidence = 'prior site metadata') {
  return {
    facebook_page_url: url,
    verification_evidence: evidence,
  };
}

test('normalizeCertifiedIdentityValue folds URL host case and a trailing slash', () => {
  assert.equal(normalizeCertifiedIdentityValue(PAGE_A), PAGE_A_NORM);
  assert.equal(normalizeCertifiedIdentityValue(PAGE_A_NORM), PAGE_A_NORM);
});

test('coerceStepOutputRecord parses JSON strings and refuses blocked or artifact refs', () => {
  assert.deepEqual(coerceStepOutputRecord(JSON.stringify(pageOutput(PAGE_A))), pageOutput(PAGE_A));
  assert.equal(coerceStepOutputRecord({ blocked: true, reason: 'nope' }), null);
  assert.equal(coerceStepOutputRecord({
    __clementine_context_ref: true,
    path: '/tmp/artifact.json',
  }), null);
});

test('resolveCertifiedStepOutput binds after N identical identity URLs on a read step', () => {
  const bound = resolveCertifiedStepOutput({
    sideEffectClass: 'read',
    outputContract: identityContract,
    priorSuccessfulOutputs: [
      JSON.stringify(pageOutput(PAGE_A, 'run-new')),
      pageOutput(PAGE_A_NORM, 'run-mid'),
      pageOutput(PAGE_A, 'run-old'),
    ],
  });
  assert.ok(bound);
  assert.equal(bound.sourceCount, CERTIFIED_STEP_OUTPUT_MIN_RUNS);
  assert.equal(bound.identity.facebook_page_url, PAGE_A_NORM);
  assert.equal(bound.output.verification_evidence, 'run-new');
});

test('resolveCertifiedStepOutput refuses fewer than N runs or a disagreeing URL', () => {
  assert.equal(resolveCertifiedStepOutput({
    sideEffectClass: 'read',
    outputContract: identityContract,
    priorSuccessfulOutputs: [pageOutput(PAGE_A), pageOutput(PAGE_A)],
  }), null);
  assert.equal(resolveCertifiedStepOutput({
    sideEffectClass: 'read',
    outputContract: identityContract,
    priorSuccessfulOutputs: [pageOutput(PAGE_A), pageOutput(PAGE_A), pageOutput(PAGE_B)],
  }), null);
});

test('resolveCertifiedStepOutput never binds sends, call nodes, or fresh collections', () => {
  const priors = [pageOutput(PAGE_A), pageOutput(PAGE_A), pageOutput(PAGE_A)];
  assert.equal(resolveCertifiedStepOutput({
    sideEffectClass: 'send',
    outputContract: identityContract,
    priorSuccessfulOutputs: priors,
  }), null);
  assert.equal(resolveCertifiedStepOutput({
    sideEffectClass: 'read',
    hasCallNode: true,
    outputContract: identityContract,
    priorSuccessfulOutputs: priors,
  }), null);
  assert.equal(resolveCertifiedStepOutput({
    sideEffectClass: 'read',
    outputContract: collectionContract,
    priorSuccessfulOutputs: [
      { source_page_url: PAGE_A, posts_reviewed_count: 3, key_findings: ['a'] },
      { source_page_url: PAGE_A, posts_reviewed_count: 4, key_findings: ['b'] },
      { source_page_url: PAGE_A, posts_reviewed_count: 5, key_findings: ['c'] },
    ],
  }), null);
});

test('pinDispatchFromChoice host-dispatches a healthy read pin and refuses sends or losing pins', () => {
  const healthy = pinDispatchFromChoice({
    kind: 'composio',
    identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    invocationTemplate: JSON.stringify({
      actorId: 'apify/facebook-posts-scraper',
      input: { startUrls: [{ url: PAGE_A }] },
      resultsLimit: 25,
    }),
    successCount: 8,
    failureCount: 1,
  }, 'read');
  assert.ok(healthy);
  assert.equal(healthy.slug, 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS');
  assert.equal(healthy.args.actorId, 'apify/facebook-posts-scraper');

  assert.equal(pinDispatchFromChoice(healthy && {
    kind: 'composio',
    identifier: 'SLACK_SEND_MESSAGE',
    invocationTemplate: '{"channel":"C1"}',
    successCount: 4,
  }, 'read'), null);

  assert.equal(pinDispatchFromChoice({
    kind: 'composio',
    identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    invocationTemplate: '{"actorId":"x"}',
    successCount: 1,
    failureCount: 4,
  }, 'read'), null);

  assert.equal(pinDispatchFromChoice({
    kind: 'composio',
    identifier: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    invocationTemplate: '{"actorId":"x"}',
    successCount: 8,
  }, 'send'), null);
});

test('formatSettledStepPinBlock presents the host result as authority', () => {
  const block = formatSettledStepPinBlock({
    slug: 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS',
    args: { actorId: 'apify/facebook-posts-scraper' },
    result: [{ url: PAGE_A, text: 'ChatGPT ads' }],
  });
  assert.match(block, /HOST SETTLED READ/);
  assert.match(block, /APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS/);
  assert.match(block, /ChatGPT ads/);
});

test('loadPriorSuccessfulStepOutputs returns newest successful step outputs for one workflow', () => {
  const dir = path.join(TMP_HOME, 'workflows', 'runs');
  const writeRun = (id: string, rec: Record<string, unknown>) => {
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec));
  };
  writeRun('old-ok', {
    id: 'old-ok',
    workflow: 'scorpion-facebook-trends',
    workflowSlug: 'scorpion-facebook-trends',
    status: 'completed',
    terminalOutcome: 'succeeded',
    finishedAt: '2026-08-01T00:00:00.000Z',
    stepOutputs: { find_official_page: pageOutput(PAGE_A, 'old') },
  });
  writeRun('mid-ok', {
    id: 'mid-ok',
    workflowSlug: 'scorpion-facebook-trends',
    status: 'completed',
    goalOutcome: 'satisfied',
    finishedAt: '2026-08-10T00:00:00.000Z',
    stepOutputs: { find_official_page: JSON.stringify(pageOutput(PAGE_A, 'mid')) },
  });
  writeRun('new-ok', {
    id: 'new-ok',
    workflowSlug: 'scorpion-facebook-trends',
    status: 'completed',
    terminalOutcome: 'succeeded',
    finishedAt: '2026-08-14T00:00:00.000Z',
    stepOutputs: { find_official_page: pageOutput(PAGE_A, 'new') },
  });
  writeRun('blocked', {
    id: 'blocked',
    workflowSlug: 'scorpion-facebook-trends',
    status: 'completed',
    terminalOutcome: 'blocked',
    finishedAt: '2026-08-15T00:00:00.000Z',
    stepOutputs: { find_official_page: pageOutput(PAGE_B, 'blocked') },
  });
  writeRun('other', {
    id: 'other',
    workflowSlug: 'other-workflow',
    status: 'completed',
    terminalOutcome: 'succeeded',
    finishedAt: '2026-08-16T00:00:00.000Z',
    stepOutputs: { find_official_page: pageOutput(PAGE_B, 'other') },
  });
  writeRun('current', {
    id: 'current',
    workflowSlug: 'scorpion-facebook-trends',
    status: 'running',
    finishedAt: '2026-08-17T00:00:00.000Z',
    stepOutputs: {},
  });

  const loaded = loadPriorSuccessfulStepOutputs({
    workflowSlug: 'scorpion-facebook-trends',
    stepId: 'find_official_page',
    currentRunId: 'current',
  });
  assert.equal(loaded.length, 3);
  assert.deepEqual(coerceStepOutputRecord(loaded[0])?.verification_evidence, 'new');

  const bound = resolveCertifiedStepOutput({
    sideEffectClass: 'read',
    outputContract: identityContract,
    priorSuccessfulOutputs: loaded,
  });
  assert.ok(bound);
  assert.equal(bound.output.verification_evidence, 'new');
});

test('workflowStepPinIntent is the existing tool-choice key', () => {
  assert.equal(
    workflowStepPinIntent('scorpion-facebook-trends', 'scrape_and_analyze'),
    'workflow:scorpion-facebook-trends:scrape_and_analyze',
  );
});

test('cleanup tmp home', () => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
