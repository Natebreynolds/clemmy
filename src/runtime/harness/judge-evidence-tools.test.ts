import assert from 'node:assert/strict';
import { test } from 'node:test';

const { judgeEvidenceTools, judgeEvidenceGuidance, judgeEvidenceReferences, JUDGE_EVIDENCE_LOOKUP_BUDGET } = await import('./judge-evidence-tools.js');

const triage = {
  mailbox: 'owner',
  emails: [
    { subject: 'Renewal terms', bucket: 'respond', draft: 'Thanks, attaching the terms.' },
    { subject: 'Weekly newsletter', bucket: 'noise', draft: '' },
    { subject: 'Contract question', bucket: 'respond', draft: 'Happy to walk through it Thursday.' },
    { subject: 'Invoice overdue', bucket: 'respond', draft: '' },
  ],
};
const report = 'Line one of the report.\n'.repeat(2_000) + 'REPORT_TAIL';
const source = {
  refKind: 'step ids of this run',
  refs: () => ['triage', 'report', 'raw_json_text'],
  resolve(ref: string) {
    if (ref === 'triage') return { text: JSON.stringify(triage), value: triage };
    if (ref === 'report') return { text: report };
    if (ref === 'raw_json_text') return { text: JSON.stringify({ data: { items: [{ id: 1 }, { id: 2 }] } }) };
    return undefined;
  },
};

type Invokable = { name: string; invoke: (context: unknown, input: string) => Promise<unknown> };
function tools(budget?: number): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const built = judgeEvidenceTools(source, budget) as unknown as Invokable[];
  return Object.fromEntries(built.map((entry) => [entry.name,
    async (args: Record<string, unknown>) => String(await entry.invoke({ context: {} }, JSON.stringify(args)))]));
}

test('query_evidence checks a criterion about every record, with the true count', async () => {
  const { query_evidence } = tools();
  const respond = await query_evidence({ ref: 'triage', where_field: 'bucket', equals: 'respond', fields: ['subject', 'draft'] });
  assert.match(respond, /3 of 4 records at emails match/);
  assert.match(respond, /Invoice overdue/);
  assert.match(respond, /"draft": ""/, 'the empty draft a sample would have hidden is visible');
  const contains = await query_evidence({ ref: 'triage', path: 'emails', where_field: 'subject', contains: 'CONTRACT' });
  assert.match(contains, /1 of 4 records/);
  const nested = await query_evidence({ ref: 'raw_json_text' });
  assert.match(nested, /2 of 2 records at data\.items match/, 'a JSON document held as text is queried as that document');
});

test('open_evidence reads past a bounded view and says where the rest continues', async () => {
  const { open_evidence } = tools();
  const first = await open_evidence({ ref: 'report', max_chars: 1_000 });
  assert.match(first, /characters 0–1000 of \d+ \(continue with offset 1000\)/);
  const tail = await open_evidence({ ref: 'report', offset: report.length - 200 });
  assert.match(tail, /REPORT_TAIL/);
  assert.match(tail, /\(end\)/);
});

test('a reviewer can only open the refs scoped to the work under review', async () => {
  const { open_evidence, query_evidence } = tools();
  const unknown = await open_evidence({ ref: 'someone_elses_session' });
  assert.match(unknown, /No retained result for ref/);
  assert.match(unknown, /Valid refs: triage, report, raw_json_text/);
  const notAList = await query_evidence({ ref: 'triage', path: 'mailbox' });
  assert.match(notAList, /Nothing list-shaped at path "mailbox"/);
});

test('lookups stop at the budget so a review stays short', async () => {
  const { open_evidence } = tools(2);
  await open_evidence({ ref: 'triage' });
  await open_evidence({ ref: 'report' });
  assert.match(await open_evidence({ ref: 'triage' }), /Lookup budget spent \(2\)/);
  assert.match(judgeEvidenceGuidance(source), new RegExp(`at most ${JUDGE_EVIDENCE_LOOKUP_BUDGET} lookups`));
  assert.match(judgeEvidenceGuidance(source), /step ids of this run/);
});


test('review-specific references do not change tool schemas or stable guidance', () => {
  const other = { ...source, refs: () => ['other-current-result'] };
  assert.deepEqual(JSON.parse(JSON.stringify(judgeEvidenceTools(source))), JSON.parse(JSON.stringify(judgeEvidenceTools(other))));
  assert.equal(judgeEvidenceGuidance(source), judgeEvidenceGuidance(other));
  assert.match(judgeEvidenceReferences(source), /triage, report, raw_json_text/);
  assert.equal(judgeEvidenceReferences(other), 'Valid refs: other-current-result.');
  assert.doesNotMatch(JSON.stringify(judgeEvidenceTools(source)), /raw_json_text/);
});

test('column projection over tuple records checks every row without dragging unrelated cells into the verdict', async () => {
  const value = { batches: [{ cells: Array.from({ length: 200 }, (_, i) => [
    i === 199 ? 'target-date' : 'other-date', 'large unrelated cell '.repeat(1000), i,
  ]) }] };
  const source = { refKind: 'recording matrix', refs: () => ['matrix'],
    resolve: (ref: string) => ref === 'matrix' ? { text: JSON.stringify(value), value } : undefined };
  const query = (judgeEvidenceTools(source) as unknown as Invokable[]).find(t => t.name === 'query_evidence')!;
  const found = String(await query.invoke({ context: {} }, JSON.stringify({ ref: 'matrix',
    path: 'batches.0.cells', where_field: '0', equals: 'target-date', fields: ['0', '2'] })));
  assert.match(found, /1 of 200 records/);
  assert.match(found, /target-date/);
  assert.match(found, /"sourceIndex": 199/);
  assert.doesNotMatch(found, /large unrelated cell|clipped/);
  const absent = String(await query.invoke({ context: {} }, JSON.stringify({ ref: 'matrix',
    path: 'batches.0.cells', where_field: '0', equals: 'absent-date', fields: ['0'] })));
  assert.match(absent, /0 of 200 records/);
});


test('review queries reach records inside nested CLI JSON text without changing raw evidence', async () => {
  const value = { result: { status: 0, argv: ['query'], stdout: JSON.stringify({ result: {
    records: [{ id: 'a', incoming: false }, { id: 'b', incoming: true }], done: true,
  } }) } };
  const text = JSON.stringify(value);
  const source = { refKind: 'settled calls', refs: () => ['cli'],
    resolve: (ref: string) => ref === 'cli' ? { text, value } : undefined };
  const built = judgeEvidenceTools(source) as unknown as Invokable[];
  const query = built.find(t => t.name === 'query_evidence')!;
  for (const path of [undefined, 'result.stdout.result.records']) {
    const found = String(await query.invoke({ context: {} }, JSON.stringify({ ref: 'cli', path,
      where_field: 'incoming', equals: 'true', fields: ['id'] })));
    assert.match(found, /1 of 2 records at result\.stdout\.result\.records match/);
    assert.match(found, /"sourceIndex": 1/);
    assert.match(found, /"id": "b"/);
  }
  const open = built.find(t => t.name === 'open_evidence')!;
  assert.ok(String(await open.invoke({ context: {} }, JSON.stringify({ ref: 'cli' }))).endsWith(text));
  assert.equal(JSON.stringify(value), text);
});


test('an authenticated empty record path wins over a larger carrier metadata array', async () => {
  const value = { result: { argv: ['query', '--all'], stdout: JSON.stringify({ result: { records: [] } }) } };
  const source = { refKind: 'settled calls', refs: () => ['empty'], resolve: () => ({
    text: JSON.stringify(value), value, recordPath: 'result.stdout.result.records',
  }) };
  const query = (judgeEvidenceTools(source) as unknown as Invokable[]).find(t => t.name === 'query_evidence')!;
  const found = String(await query.invoke({ context: {} }, JSON.stringify({ ref: 'empty' })));
  assert.match(found, /0 of 0 records at result\.stdout\.result\.records match/);
  assert.doesNotMatch(found, /result\.argv match/);
});

test('a page is cut between records and reports only what it returned', async () => {
  const wide = { rows: Array.from({ length: 40 }, (_, index) => ({ index, text: `record ${index} ` + 'x'.repeat(900) })) };
  const seen: unknown[] = [];
  const built = judgeEvidenceTools({ refKind: 'refs', refs: () => ['wide'],
    resolve: (ref: string) => (ref === 'wide' ? { text: JSON.stringify(wide), value: wide } : undefined) },
  undefined, (lookup) => seen.push(lookup)) as unknown as Invokable[];
  const query = built.find((entry) => entry.name === 'query_evidence')!;
  const first = String(await query.invoke({ context: {} }, JSON.stringify({ ref: 'wide' })));
  const shown = Number(/showing (\d+) from offset 0/.exec(first)![1]);
  assert.ok(shown > 0 && shown < 40, 'forty wide records do not fit one lookup');
  assert.match(first, new RegExp(`\\(continue with offset ${shown}\\)`));
  assert.doesNotMatch(first, /clipped/);
  const page = JSON.parse(first.slice(first.indexOf('\n\n') + 2)) as Array<{ sourceIndex: number }>;
  assert.equal(page.length, shown, 'every record reported as shown is whole');
  assert.equal(page.at(-1)!.sourceIndex, shown - 1);
  assert.deepEqual(seen, [{ tool: 'query_evidence', ref: 'wide', recordPath: 'rows', recordsTotal: 40,
    recordsMatched: 40, recordsReturned: shown, offset: 0 }]);
});

test('a single record over the limit is returned clipped and recorded as no whole record', async () => {
  const huge = { rows: [{ id: 1, text: 'y'.repeat(30_000) }] };
  const seen: Array<Record<string, unknown>> = [];
  const built = judgeEvidenceTools({ refKind: 'refs', refs: () => ['huge'],
    resolve: (ref: string) => (ref === 'huge' ? { text: JSON.stringify(huge), value: huge } : undefined) },
  undefined, (lookup) => seen.push(lookup as never)) as unknown as Invokable[];
  const query = built.find((entry) => entry.name === 'query_evidence')!;
  const result = String(await query.invoke({ context: {} }, JSON.stringify({ ref: 'huge' })));
  assert.match(result, /clipped inside the record/);
  assert.equal(seen[0]!.recordsReturned, 0);
});

test('every lookup is recorded with what it returned, including the ones refused', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const built = judgeEvidenceTools(source, 2, (lookup) => seen.push(lookup as never)) as unknown as Invokable[];
  const call = (name: string, args: Record<string, unknown>) =>
    built.find((entry) => entry.name === name)!.invoke({ context: {} }, JSON.stringify(args));
  await call('open_evidence', { ref: 'report', offset: 100, max_chars: 1_000 });
  await call('query_evidence', { ref: 'someone_elses_session' });
  await call('query_evidence', { ref: 'triage', where_field: 'bucket', equals: 'respond' });
  assert.deepEqual(seen, [
    { tool: 'open_evidence', ref: 'report', charStart: 100, charEnd: 1_100, charTotal: report.length },
    { tool: 'query_evidence', ref: 'someone_elses_session', refused: 'unknown_ref' },
    { tool: 'query_evidence', ref: 'triage', refused: 'budget' },
  ]);
});

test('an observer that throws never changes what the reviewer receives', async () => {
  const built = judgeEvidenceTools(source, undefined, () => { throw new Error('observer failure'); }) as unknown as Invokable[];
  const query = built.find((entry) => entry.name === 'query_evidence')!;
  assert.match(String(await query.invoke({ context: {} }, JSON.stringify({ ref: 'triage' }))), /4 of 4 records at emails match/);
});
