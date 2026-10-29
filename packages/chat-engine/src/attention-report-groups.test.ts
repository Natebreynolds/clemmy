import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionReportCount, attentionReportSummary, groupAttentionReports } from './attention-report-groups.js';

const generation = 'a'.repeat(64);
const report = (id: string, key = 'flow:controlled', extra = {}) => ({ id, attentionKey: key, generation, ...extra });

test('one work parent retains every report object, exact destination and choice scope', () => {
  const first = { ...report('new'), body: 'Needs credit', choices: ['Review account'], runId: 'run-new' };
  const second = { ...report('old'), body: 'Permission refused', choices: ['Choose source'], runId: 'run-old' };
  const other = report('other', 'flow:another');
  const grouped = groupAttentionReports([first, other, second], row => row);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].reports, [first, second]);
  assert.equal(grouped[0].reports[1], second);
  assert.equal((grouped[0].reports[1] as typeof second).runId, 'run-old');
  assert.deepEqual((grouped[0].reports[1] as typeof second).choices, ['Choose source']);
});

test('mixed generations, unknown generations and typed decisions never borrow a parent or controls', () => {
  const rows = [report('now'), report('before', 'flow:controlled', { generation: 'b'.repeat(64) }),
    report('unknown', 'flow:controlled', { generation: undefined }), report('approval', 'approval:controlled'),
    report('protected', 'flow:controlled', { protected: true })];
  const grouped = groupAttentionReports(rows, row => row);
  assert.equal(grouped.length, rows.length);
  assert.equal(grouped[2].generation, undefined);
  assert.equal(grouped[3].attentionKey, undefined);
  assert.equal(grouped[4].attentionKey, undefined);
});

test('equivalent repeats retain their source IDs and contribute to visible report count', () => {
  const rows = [{ ...report('credit'), sourceIds: ['credit-new', 'credit-old'] },
    { ...report('permission'), sourceIds: ['permission'] }];
  const [group] = groupAttentionReports(rows, row => row);
  assert.equal(attentionReportCount(group.reports, row => row.sourceIds), 3);
  assert.equal(group.reports.find(row => row.sourceIds.includes('credit-old'))?.id, 'credit');
});

test('overview summaries omit only exact title and body repeats while every source report stays retained', () => {
  const reports = [{ id:'credit-new',title:'Review account',body:'Credit refused',runId:'new' },
    { id:'credit-old',title:'Review account',body:'Credit refused',runId:'old' },
    { id:'permission',title:'Review account',body:'Permission refused',runId:'permission' }];
  const summary = attentionReportSummary(reports, row => row);
  assert.deepEqual(summary.map(row => row.id), ['credit-new','permission']);
  assert.equal(summary[0],reports[0]);
  assert.deepEqual(reports.map(row => row.id),['credit-new','credit-old','permission']);
  assert.equal(reports[1].runId,'old');
  assert.equal(attentionReportSummary([...reports,{...reports[0],id:'different-case',title:'review account'}],row=>row).length,3);
});
