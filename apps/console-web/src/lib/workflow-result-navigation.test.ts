import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowResultArchiveHref } from './workflow-result-navigation';

test('internal tool results lead to a readable workflow search without inventing a file identity', () => {
  for (const path of ['artifacts/email-fetch-1.json', 'steps/read-customer.json', 'step-results/report.txt', undefined]) {
    const href = workflowResultArchiveHref('weekly-customer-brief', path);
    const parsed = new URL(href, 'https://fixture.invalid');
    assert.equal(parsed.pathname, '/made');
    assert.equal(parsed.searchParams.get('q'), 'Weekly Customer Brief');
    assert.doesNotMatch(href, /fileId|session|\/files\/open|download|https:/);
  }
});

test('meaningful filenames narrow the archive search while untrusted paths stay inert query text', () => {
  const href = workflowResultArchiveHref('weekly-customer-brief', 'reports/Revenue & customers.pdf');
  const parsed = new URL(href, 'https://fixture.invalid');
  assert.equal(parsed.pathname, '/made');
  assert.equal(parsed.searchParams.get('q'), 'Revenue & customers.pdf');
  assert.equal(new URL(workflowResultArchiveHref('controlled', 'javascript:untrusted.pdf'), 'https://fixture.invalid').pathname, '/made');
});
