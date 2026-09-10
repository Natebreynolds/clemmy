/**
 * Run: npx tsx --test src/runtime/harness/plan-first-contract.test.ts
 *
 * The owner's contract for Plan mode, 2026-09-10, in his words: take the task
 * and what you already know, and BEFORE you start doing work give me the plan
 * you'll attack it with; if you need more to firm it up, come back and ask;
 * don't start until I say execute. Plus the distinction that kills the naive
 * version of this: the Google Doc he handed her she MUST read — and a plan that
 * comes back saying "first I'll read your doc, then I'll plan" is not a plan.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-first-test-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  readsAnOwnerNamedInput, planFirstWorkRefusal, PLAN_SCOPING_READ_ALLOWANCE,
} = await import('./plan-first-contract.js');

const REQUEST = 'I need to run some extensive research. using firecrawl, data for seo, apify. any scraping tool '
  + 'nessasary to accomplish this. https://docs.google.com/document/d/1oREggTuvL-oXTpOhi6g2QsMpXsaHFyhORy-rBfIHZWw/edit?tab=t.0';

test('the document the owner handed her is an input, not the work', () => {
  // The exact call from the live run, which read the brief 95 seconds in.
  const readingTheBrief = JSON.stringify({
    tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
    arguments: { id: '1oREggTuvL-oXTpOhi6g2QsMpXsaHFyhORy-rBfIHZWw' },
  });
  assert.equal(readsAnOwnerNamedInput(readingTheBrief, REQUEST), true, 'the doc id he pasted is his own input');

  // Same doc reached by URL, without the ?tab= and /edit he happened to paste.
  const byUrl = JSON.stringify({
    url: 'https://docs.google.com/document/d/1oREggTuvL-oXTpOhi6g2QsMpXsaHFyhORy-rBfIHZWw',
  });
  assert.equal(readsAnOwnerNamedInput(byUrl, REQUEST), true, 'the identifying middle still matches');
});

test('open-web research is the work, however it is spelled', () => {
  const firecrawl = JSON.stringify({ tool_slug: 'FIRECRAWL_SEARCH', arguments: { query: 'competitor pricing 2026' } });
  assert.equal(readsAnOwnerNamedInput(firecrawl, REQUEST), false, 'a query names nothing the owner gave her');
  // Naming a tool in the request does not make its every call an input: he said
  // "using firecrawl", which authorizes the tool, not the fieldwork.
  const namedTool = JSON.stringify({ tool_slug: 'FIRECRAWL_SEARCH', arguments: { query: 'firecrawl' } });
  assert.equal(readsAnOwnerNamedInput(namedTool, REQUEST), false);
});

test('reading the owner\'s input is never refused, no matter how many reads came before', () => {
  const refusal = planFirstWorkRefusal({
    sessionId: 'sess-plan-1',
    sourceUserSeq: 10,
    toolName: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
    argumentsJson: JSON.stringify({ id: '1oREggTuvL-oXTpOhi6g2QsMpXsaHFyhORy-rBfIHZWw' }),
    requestText: REQUEST,
    externalRead: true,
  });
  assert.equal(refusal, undefined, 'she must be able to read what he gave her, always');
});

test('a host-local call is never the work', () => {
  assert.equal(planFirstWorkRefusal({
    sessionId: 'sess-plan-1',
    sourceUserSeq: 10,
    toolName: 'memory_search',
    argumentsJson: JSON.stringify({ query: 'what do I know about this account' }),
    requestText: REQUEST,
    externalRead: false,
  }), undefined, 'her own memory and context are exactly what she should be planning from');
});

test('scoping is allowed; carrying out the research is not', async () => {
  const { appendEvent, createSession } = await import('./eventlog.js');
  const sessionId = 'sess-plan-scoping';
  createSession({ id: sessionId, kind: 'chat', title: 'plan first' });
  const work = {
    sessionId,
    sourceUserSeq: 10,
    toolName: 'FIRECRAWL_SEARCH',
    argumentsJson: JSON.stringify({ query: 'market leaders 2026' }),
    requestText: REQUEST,
    externalRead: true,
  };

  assert.equal(planFirstWorkRefusal(work), undefined, 'the first scoping read is free');

  for (let i = 0; i < PLAN_SCOPING_READ_ALLOWANCE; i += 1) {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'read_receipt',
      data: { record: { effectClass: 'read', source: { sessionId, sourceUserSeq: 10 } } },
    });
  }

  const refusal = planFirstWorkRefusal(work);
  assert.ok(refusal, 'past the allowance with no plan, the work is refused');
  assert.match(refusal!, /^PLAN_FIRST:/);
  assert.match(refusal!, /publish_plan/, 'the refusal names its repair');
  assert.match(refusal!, /fan out/, 'and asks for the thing the owner actually wanted');
  assert.match(refusal!, /never a plan step/, 'so "first I will read your doc" can never be the plan');
  assert.match(refusal!, /ask the user that exact question/, 'the alternative to gathering is asking');
});

test('once the plan is published the constraint is gone', async () => {
  const { appendEvent, createSession } = await import('./eventlog.js');
  const sessionId = 'sess-plan-published';
  createSession({ id: sessionId, kind: 'chat', title: 'plan first' });
  for (let i = 0; i < PLAN_SCOPING_READ_ALLOWANCE + 2; i += 1) {
    appendEvent({
      sessionId,
      turn: 1,
      role: 'system',
      type: 'read_receipt',
      data: { record: { effectClass: 'read', source: { sessionId, sourceUserSeq: 10 } } },
    });
  }
  const work = {
    sessionId,
    sourceUserSeq: 10,
    toolName: 'FIRECRAWL_SEARCH',
    argumentsJson: JSON.stringify({ query: 'market leaders 2026' }),
    requestText: REQUEST,
    externalRead: true,
  };
  assert.ok(planFirstWorkRefusal(work), 'refused while nothing is published');

  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'plan_revision_published',
    data: { sourceUserSeq: 10 },
  });
  assert.equal(planFirstWorkRefusal(work), undefined, 'a turn that offered its plan is no longer withholding it');
});
