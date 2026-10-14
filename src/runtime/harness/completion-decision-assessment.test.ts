import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseCompletionDecisionAssessment as parse, completionReviewAssessmentDiagnostic as diagnostic,
  COMPLETION_DECISION_ASSESSMENT_INSTRUCTIONS as instructions } from './completion-decision-assessment.js';

const row = { claim:'B meets capacity',premise:'required capacity 12',basis:'A=8/B=16; capacity precedes price',consequence:'B qualifies',contrary:{status:'resolved',reason:'A cheaper but insufficient'},status:'supported' };
const packet = (over: Record<string,unknown> = {}) => JSON.stringify({version:1,coverage:'complete',decisions:[row],...over});
const answer = (body = packet(), control = 'DONE: B qualifies.') => `REVIEW_ASSESSMENT: ${body}\n${control}`;

test('the advertised complete reply parses with the exact closed schema and retains its contrary evidence', () => {
  const example = instructions.split('Complete reply example:\n')[1];
  assert.ok(example);
  const parsed = parse(example);
  assert.equal(parsed.diagnostic.status, 'qualified');
  assert.equal(parsed.diagnostic.reason, 'consistent');
  assert.ok(parsed.diagnostic.packetBytes! <= 4096);
  const schema = JSON.parse(example.split('\n')[0]!.slice('REVIEW_ASSESSMENT: '.length));
  assert.deepEqual(Object.keys(schema).sort(), ['coverage', 'decisions', 'version']);
  assert.deepEqual(Object.keys(schema.decisions[0]).sort(), ['basis', 'claim', 'consequence', 'contrary', 'premise', 'status']);
  assert.deepEqual(Object.keys(schema.decisions[0].contrary).sort(), ['reason', 'status']);
  assert.equal(schema.decisions[0].contrary.status, 'resolved');
  assert.match(schema.decisions[0].contrary.reason, /cheaper.*cannot meet capacity/);
  assert.match(instructions, /root has only version,coverage,decisions/);
  assert.match(instructions, /every decision has only claim,premise,basis,consequence,contrary,status/);
  assert.match(instructions, /contrary has only status,reason/);
  assert.match(instructions, /repeat a JSON key at any depth/);
  assert.match(instructions, /at most 512 UTF-8 bytes/);
  assert.match(instructions, /bounds are resource limits, not a decision quota/);
  assert.match(instructions, /partial or uncertain coverage instead of dropping material decisions/);
});

test('the advertised none reason remains nonempty text, closed keys and an exact UTF8 bound', () => {
  const reason = 'No contrary evidence appears in the supplied view';
  assert.ok(instructions.includes(reason));
  const none = { ...row, contrary: { status: 'none', reason } };
  assert.equal(parse(answer(packet({ decisions: [none] }))).diagnostic.status, 'qualified');
  const atBound = { ...none, contrary: { status: 'none', reason: '😀'.repeat(128) } };
  assert.equal(Buffer.byteLength(atBound.contrary.reason, 'utf8'), 512);
  assert.equal(parse(answer(packet({ decisions: [atBound] }))).diagnostic.status, 'qualified');
  for (const contrary of [null, [], reason, { status: 'none' }, { status: 'none', reason: '' },
    { status: 'none', reason: ' \t ' }, { status: 'none', reason: 1 }, { status: 'none', reason: {} },
    { status: 'none', reason: [reason] }, { status: ['none'], reason },
    { status: 'none', reason, extra: true }, { status: 'none', reason: '😀'.repeat(129) }]) {
    const result = parse(answer(packet({ decisions: [row, { ...row, contrary }] })));
    assert.equal(result.diagnostic.reason, 'malformed');
    assert.equal(result.diagnostic.malformedIssue, 'contrary_shape');
    assert.equal(result.diagnostic.malformedRowIndex, 1);
  }
  const duplicate = packet({ decisions: [none] }).replace('"status":"none"', '"status":"none","status":"resolved"');
  assert.equal(parse(answer(duplicate)).diagnostic.malformedIssue, 'duplicate_keys');
});

test('advertised one-to-sixteen resource rows and nonempty text never relax whole assessment coverage', () => {
  assert.match(instructions, /array of 1 to 16 objects/);
  const compact = { claim: 'x', premise: 'x', basis: 'x', consequence: 'x', contrary: { status: 'none', reason: 'x' }, status: 'supported' };
  for (const count of [1, 16]) {
    const body = packet({ decisions: Array.from({ length: count }, () => compact) });
    assert.ok(Buffer.byteLength(body, 'utf8') <= 4096);
    assert.equal(parse(answer(body)).diagnostic.status, 'qualified');
  }
  for (const count of [0, 17]) assert.equal(parse(answer(packet({ decisions: Array.from({ length: count }, () => compact) }))).diagnostic.malformedIssue, 'decision_count');
  for (const field of ['claim', 'premise', 'basis', 'consequence']) {
    assert.equal(parse(answer(packet({ decisions: [{ ...row, [field]: '😀'.repeat(128) }] }))).diagnostic.status, 'qualified');
    for (const value of ['', ' \t ', null, 1, {}, ['x'], '😀'.repeat(129)]) {
      assert.equal(parse(answer(packet({ decisions: [{ ...row, [field]: value }] }))).diagnostic.malformedIssue, 'row_text_enum');
    }
  }
  assert.equal(parse(answer(packet({ decisions: [{ ...row, extra: true }] }))).diagnostic.malformedIssue, 'types');
  assert.equal(parse(answer(packet({ extra: true }))).diagnostic.malformedIssue, 'root_keys');
  assert.equal(parse(answer(packet({ coverage: 'partial' }))).diagnostic.reason, 'partial');
  assert.equal(parse(answer(packet({ coverage: 'uncertain' }))).diagnostic.reason, 'uncertain');
});

test('same-response consistency does not demand a fixed number of decisions or certify semantic truth', () => {
  const found=parse(answer()); assert.equal(found.control?.marker,'DONE'); assert.equal(found.diagnostic.reason,'consistent');
  assert.equal(found.diagnostic.status,'qualified');
  assert.equal(parse(answer(packet({decisions:[{...row,claim:'saved artifact',basis:'save and exact readback',premise:'owner supplied rows',consequence:'path returned'}]}))).diagnostic.status,'qualified');
});
test('negative, partial, uncertain and unresolved declarations cannot qualify a positive verdict', () => {
  for (const [body, reason] of [[packet({coverage:'partial'}),'partial'],[packet({coverage:'uncertain'}),'uncertain'],
    [packet({decisions:[{...row,status:'contradicted'}]}),'contradicted'],[packet({decisions:[{...row,status:'unverified'}]}),'unverified'],
    [packet({decisions:[{...row,contrary:{status:'unresolved',reason:'conflict remains'}}]}),'unverified']] as const) {
    assert.equal(parse(answer(body)).diagnostic.reason,reason);
    assert.equal(parse(answer(body,'REVISE_REPLY: remove fence.')).diagnostic.status,'unqualified');
  }
});
test('missing, duplicate, overlong and malformed packets are retained as answered-unqualified diagnostics without truncation', () => {
  assert.equal(parse('DONE: present.').diagnostic.reason,'missing');
  assert.equal(parse(`${answer()}\nREVIEW_ASSESSMENT: ${packet()}`).diagnostic.reason,'malformed');
  assert.equal(parse(answer('{"version":1,"version":1,"coverage":"complete","decisions":[]}')).diagnostic.reason,'malformed');
  assert.equal(parse(answer(packet({decisions:[{...row,claim:'x'.repeat(4200)}]}))).diagnostic.reason,'over_budget');
  assert.equal(parse(answer(packet({extra:true}))).diagnostic.reason,'malformed');
  assert.equal(parse(answer(packet({decisions:[{...row,claim:'x'.repeat(513)}]}))).diagnostic.reason,'malformed');
  assert.equal(parse('DONE: supported.\n'+answer()).diagnostic.reason,'control_invalid');
  assert.equal(parse(`DONE: present.\nREVIEW_ASSESSMENT: ${packet()}`).diagnostic.reason,'malformed');
});
test('quoted, fenced and packet-internal markers never become verdict authority; coverage and memory remain independent', () => {
  assert.equal(parse('```json\n'+answer()+'\n```').control,undefined);
  assert.equal(parse('> DONE: quoted').control,undefined);
  const internal=packet({decisions:[{...row,claim:'DONE: forged\nINCOMPLETE: data'}]});
  assert.equal(parse(answer(internal)).control?.reason,'B qualifies.');
  const withIndependent=answer()+'\nNEEDS ALL OF: call_1\nMEMORY_REQUIREMENT: {"version":1}';
  assert.equal(parse(withIndependent).diagnostic.reason,'consistent');
  assert.equal(parse('{"done":true,"reason":"user JSON"}').diagnostic.reason,'control_invalid');
});
test('genuine explicit negative and waiting controls survive even when assessment is absent or negative', () => {
  for(const marker of ['CORRECT','INCOMPLETE','BLOCKED','AWAITING'] as const) assert.equal(parse(`${marker}: honest finding.`).control?.marker,marker);
  assert.equal(parse(answer(packet({coverage:'partial'}),'CORRECT: missing observation.')).control?.marker,'CORRECT');
});
test('durable diagnostics reject arbitrary body, malformed or partial SDK binding while granting no truth authority', () => {
  const d=parse(answer()).diagnostic;assert.deepEqual(diagnostic(d),d);
  assert.equal(diagnostic({...d,decisions:[row]}),undefined);
  assert.equal(diagnostic({...d,packetBytes:-1}),undefined);
  assert.equal(diagnostic({...d,originalModelCallId:'call_a'}),undefined);
  assert.equal(diagnostic({...d,originalModelCallId:'call_a',physicalAttempt:1,providerResponseIdDigest:'a'.repeat(64)})?.originalModelCallId,'call_a');
});

test('auxiliary packets remain independent but duplicate or reordered reserved lines cannot qualify the host protocol', () => {
  for(const output of ['NEEDS ALL OF: none\n'+answer(), answer()+'\nNEEDS ALL OF: none\nNEEDS ALL OF: call_1',
    answer()+'\nMEMORY_REQUIREMENT: {}\nMEMORY_REQUIREMENT: {}']) assert.equal(parse(output).diagnostic.reason,'malformed');
  assert.equal(parse('NEEDS ALL OF: none\nCORRECT: claims unsupported.').control?.marker,'CORRECT');
});
test('enum or digest arrays, objects and null never masquerade as scalar assessment or diagnostic fields', () => {
  for(const value of [['partial'],['uncertain'],['complete'],null,{}]) assert.equal(parse(answer(packet({coverage:value}))).diagnostic.reason,'malformed');
  for(const value of [['contradicted'],['unverified'],['supported'],null,{}]) assert.equal(parse(answer(packet({decisions:[{...row,status:value}]}))).diagnostic.reason,'malformed');
  for(const value of [['unresolved'],['none'],null,{}]) assert.equal(parse(answer(packet({decisions:[{...row,contrary:{status:value,reason:'exact contrary observation'}}]}))).diagnostic.reason,'malformed');
  const d=parse(answer()).diagnostic;
  for(const [key,value] of [['status',['qualified']],['reason',['consistent']],['rawOutputSha256',[d.rawOutputSha256]],['packetSha256',[d.packetSha256]]]) assert.equal(diagnostic({...d,[key as string]:value}),undefined);
});

test('the 4096-byte packet boundary is exact and no over-budget or multibyte field is silently truncated', () => {
  const rows=[structuredClone(row),structuredClone(row)];
  let body=JSON.stringify({version:1,coverage:'complete',decisions:rows});
  for(const current of rows) for(const field of ['claim','premise','basis','consequence'] as const) {
    while(Buffer.byteLength(body)<4096 && Buffer.byteLength(current[field])<512) {
      current[field]+='x';body=JSON.stringify({version:1,coverage:'complete',decisions:rows});
    }
  }
  assert.equal(Buffer.byteLength(body),4096);assert.equal(parse(answer(body)).diagnostic.status,'qualified');
  assert.equal(parse(answer(body+' ')).diagnostic.reason,'over_budget');
  assert.equal(parse(answer(packet({decisions:[{...row,claim:'😀'.repeat(130)}]}))).diagnostic.reason,'malformed');
  const throws=new Proxy({}, {ownKeys(){throw new Error('unreadable journal object');}});
  assert.equal(diagnostic(throws),undefined);
});

test('malformed diagnostics expose only fixed first-failure categories and bounded decision ordinals', () => {
  const cases: Array<{ output:string; issue:string; rowIndex?:number }> = [
    {output:answer()+'\nextra prose',issue:'framing'},
    {output:`DONE: B qualifies.\nREVIEW_ASSESSMENT: ${packet()}`,issue:'order'},
    {output:answer()+'\nNEEDS ALL OF: none\nNEEDS ALL OF: none',issue:'aux_duplicate'},
    {output:answer('{'),issue:'json'},
    {output:answer('{"version":1,"coverage":"complete","decisions":[],"version":1}'),issue:'duplicate_keys'},
    {output:answer(packet({private_unknown_key:'private diagnostic value'})),issue:'root_keys'},
    {output:answer('[]'),issue:'types'},
    {output:answer(packet({coverage:['complete']})),issue:'types'},
    {output:answer(packet({decisions:[]})),issue:'decision_count'},
    {output:answer(packet({decisions:Array.from({length:17},()=>({claim:'x',premise:'x',basis:'x',consequence:'x',contrary:{status:'none',reason:'x'},status:'supported'}))})),issue:'decision_count'},
    {output:answer(packet({decisions:[row,null]})),issue:'types',rowIndex:1},
    {output:answer(packet({decisions:[row,{...row,private_unknown_key:'private diagnostic value'}]})),issue:'types',rowIndex:1},
    {output:answer(packet({decisions:[row,{...row,status:['supported']}]})),issue:'row_text_enum',rowIndex:1},
    {output:answer(packet({decisions:[row,{...row,claim:''}]})),issue:'row_text_enum',rowIndex:1},
    {output:answer(packet({decisions:[row,{...row,contrary:{status:'none',reason:''}}]})),issue:'contrary_shape',rowIndex:1},
  ];
  for(const current of cases) {
    const d=parse(current.output).diagnostic;
    assert.equal(d.reason,'malformed');assert.equal(d.status,'unqualified');
    assert.equal(d.malformedIssue,current.issue);assert.equal(d.malformedRowIndex,current.rowIndex);
    assert.deepEqual(diagnostic(d),d);
    assert.doesNotMatch(JSON.stringify(d),/private_unknown_key|private diagnostic value|extra prose|B qualifies/);
  }
  const nestedDuplicate=packet().replace('"status":"resolved"','"status":"resolved","status":"none"');
  assert.equal(parse(answer(nestedDuplicate)).diagnostic.malformedIssue,'duplicate_keys');
});

test('failure-location observation preserves first-fault precedence and adds no tags to other outcomes', () => {
  const cases: Array<[string,string,string|undefined]> = [
    [answer()+'\nDONE: duplicate.\nREVIEW_ASSESSMENT: {}','control_invalid',undefined],
    [answer('x'.repeat(4097))+'\nREVIEW_ASSESSMENT: {}','malformed','framing'],
    [`DONE: B qualifies.\nREVIEW_ASSESSMENT: {\nextra`,'malformed','order'],
    [answer('{')+'\nextra\nNEEDS ALL OF: none\nNEEDS ALL OF: none','malformed','framing'],
    ['NEEDS ALL OF: none\n'+answer('{')+'\nNEEDS ALL OF: none','malformed','order'],
    [answer('{')+'\nNEEDS ALL OF: none\nNEEDS ALL OF: none','malformed','aux_duplicate'],
    [answer(packet({decisions:[{...row,status:'bad',contrary:null},null]})),'malformed','row_text_enum'],
    ['DONE: present.','missing',undefined],
    [answer('x'.repeat(4097)),'over_budget',undefined],
    [answer(packet({coverage:'partial'})),'partial',undefined],
    [answer(packet({coverage:'uncertain'})),'uncertain',undefined],
    [answer(packet({decisions:[{...row,status:'contradicted'}]})),'contradicted',undefined],
    [answer(packet({decisions:[{...row,status:'unverified'}]})),'unverified',undefined],
    [answer(),'consistent',undefined],
  ];
  for(const [output,reason,issue] of cases) {
    const d=parse(output).diagnostic;assert.equal(d.reason,reason);assert.equal(d.malformedIssue,issue);
    if(issue===undefined) {assert.equal(Object.hasOwn(d,'malformedIssue'),false);assert.equal(Object.hasOwn(d,'malformedRowIndex'),false);}
  }
  const d=parse(answer(packet({decisions:[row,{...row,contrary:null},null]}))).diagnostic;
  assert.equal(d.malformedRowIndex,1);assert.equal(d.malformedIssue,'contrary_shape');
});

test('new durable diagnostic fields are optional, strict, negative-only and content-free', () => {
  const old=parse(answer()).diagnostic;assert.deepEqual(diagnostic(old),old);
  const malformed=parse(answer(packet({decisions:[null]}))).diagnostic;
  assert.deepEqual(diagnostic(malformed),malformed);
  for(const issue of [null,{},['types'],'unknown',1]) assert.equal(diagnostic({...malformed,malformedIssue:issue}),undefined);
  for(const index of [-1,16,0.5,'0',[0],null,{}]) assert.equal(diagnostic({...malformed,malformedRowIndex:index}),undefined);
  assert.equal(diagnostic({...malformed,malformedIssue:undefined}),undefined);
  for(const issue of ['framing','order','aux_duplicate','json','duplicate_keys','root_keys','decision_count']) {
    assert.equal(diagnostic({...malformed,malformedIssue:issue}),undefined);
    assert.equal(diagnostic({...malformed,malformedIssue:issue,malformedRowIndex:undefined})?.malformedIssue,issue);
  }
  assert.equal(diagnostic({...old,malformedIssue:'types'}),undefined);
  assert.equal(diagnostic({...malformed,reason:'original_unbound'}),undefined);
  assert.equal(diagnostic({...malformed,malformedValue:'private value'}),undefined);
  assert.equal(diagnostic({...malformed,malformedIssue:{toString:null}}),undefined);
});

test('diagnostic validation never evaluates changing accessors or returns later proxy mutations', () => {
  const d=parse(answer(packet({decisions:[null]}))).diagnostic;
  for(const key of ['malformedIssue','malformedRowIndex','rawOutputSha256']) {
    let reads=0;
    const source={...d};
    Object.defineProperty(source,key,{enumerable:true,get(){reads++;return reads===1?d[key as keyof typeof d]:'private account or reviewer text';}});
    assert.equal(diagnostic(source),undefined);assert.equal(reads,0);
  }
  const target:Record<string,unknown>={...d};
  const addsKey=new Proxy(target,{getOwnPropertyDescriptor(object,key){
    if(key==='malformedIssue') object.rawReviewerText='private reviewer text';
    return Reflect.getOwnPropertyDescriptor(object,key);
  }});
  assert.equal(diagnostic(addsKey),undefined);
  let keyReads=0;
  const mutatesAfterCapture:Record<string,unknown>={...d};
  const laterValue=new Proxy(mutatesAfterCapture,{ownKeys(object){
    keyReads++;if(keyReads===3) object.malformedIssue='private account or reviewer text';
    return Reflect.ownKeys(object);
  }});
  const captured=diagnostic(laterValue);
  assert.deepEqual(captured,d);
  assert.notEqual(captured,laterValue);
  assert.doesNotMatch(JSON.stringify(captured),/private|rawReviewerText/);
  const throws=new Proxy({...d},{getOwnPropertyDescriptor(){throw new Error('private exception text');}});
  assert.equal(diagnostic(throws),undefined);
});

const unverifiedFields = ['assessedDecisionCount','unverifiedDecisionCount','unresolvedContraryCount',
  'firstUnverifiedDecisionIndex','firstUnresolvedContraryIndex','assessmentControlMarker'] as const;

test('complete unverified diagnostics distinguish row and contrary flags while preserving controls and no private text', () => {
  const rows = [row, { ...row, status: 'unverified' },
    { ...row, contrary: { status: 'unresolved', reason: 'conflict remains' } },
    { ...row, status: 'unverified', contrary: { status: 'unresolved', reason: 'conflict remains' } }];
  for (const marker of ['DONE','AWAITING','INCOMPLETE','CORRECT','BLOCKED','REVISE_REPLY','NOT-DONE'] as const) {
    const found = parse(answer(packet({ decisions: rows }), `${marker}: keep the original finding.`));
    assert.deepEqual(found.control, { marker, reason: 'keep the original finding.' });
    assert.equal(found.diagnostic.status, 'unqualified');
    assert.equal(found.diagnostic.reason, 'unverified');
    assert.deepEqual(Object.fromEntries(unverifiedFields.map(key => [key, found.diagnostic[key]])), {
      assessedDecisionCount: 4, unverifiedDecisionCount: 2, unresolvedContraryCount: 2,
      firstUnverifiedDecisionIndex: 1, firstUnresolvedContraryIndex: 2, assessmentControlMarker: marker });
    assert.deepEqual(diagnostic(found.diagnostic), found.diagnostic);
    assert.doesNotMatch(JSON.stringify(found.diagnostic), /B meets capacity|A=8|B qualifies|conflict remains|keep the original finding/);
  }
});

test('unverified count boundaries allow overlapping flags up to twice the declared row count', () => {
  const compact = { claim: 'x', premise: 'x', basis: 'x', consequence: 'x', contrary: { status: 'unresolved', reason: 'x' }, status: 'unverified' };
  for (const count of [1,16]) {
    const d = parse(answer(packet({ decisions: Array.from({ length: count }, () => compact) }))).diagnostic;
    assert.equal(d.assessedDecisionCount, count);
    assert.equal(d.unverifiedDecisionCount, count);
    assert.equal(d.unresolvedContraryCount, count);
    assert.equal(d.firstUnverifiedDecisionIndex, 0);
    assert.equal(d.firstUnresolvedContraryIndex, 0);
    assert.equal(diagnostic(d)?.unresolvedContraryCount, count, 'the same row can supply both flags; sum is not bounded by N');
  }
  for (const [changed, positive, absent] of [
    [{ ...row, status: 'unverified' }, 'firstUnverifiedDecisionIndex', 'firstUnresolvedContraryIndex'],
    [{ ...row, contrary: { status: 'unresolved', reason: 'x' } }, 'firstUnresolvedContraryIndex', 'firstUnverifiedDecisionIndex'],
  ] as const) {
    const d = parse(answer(packet({ decisions: [row, changed] }))).diagnostic;
    assert.equal(d[positive], 1); assert.equal(Object.hasOwn(d, absent), false);
    assert.deepEqual(diagnostic(d), d);
  }
});

test('new observations never change earlier parser precedence or add fields outside complete unverified results', () => {
  // Historical 99cb wording: 2718 bytes, ec5ac786896158ef6619191ad7505f3b91c89bfee03505a246a012bf97d153b1.
  // Round17 intentionally clarifies execution restrictions; parser precedence and diagnostic assertions below remain unchanged.
  assert.equal(Buffer.byteLength(instructions, 'utf8'), 3059);
  assert.equal(createHash('sha256').update(instructions, 'utf8').digest('hex'), '9224e1d14ca877eb258d5b5ed8df19998b764120b8f4e4c8a93233a28bc6e5b6');
  const flagged = { ...row, status: 'unverified', contrary: { status: 'unresolved', reason: 'x' } };
  for (const [output, expected] of [
    [answer(), 'consistent'], [answer(packet({ coverage: 'partial', decisions: [flagged] })), 'partial'],
    [answer(packet({ coverage: 'uncertain', decisions: [flagged] })), 'uncertain'],
    [answer(packet({ decisions: [flagged, { ...row, status: 'contradicted' }] })), 'contradicted'],
    [answer(packet({ decisions: [flagged, { ...row, contrary: null }] })), 'malformed'],
    [answer(packet({ decisions: [flagged] })) + '\nextra prose', 'malformed'],
    [answer('x'.repeat(4097)), 'over_budget'], ['DONE: unchanged.', 'missing'],
    [answer(packet({ decisions: [flagged] })) + '\nDONE: duplicate.', 'control_invalid'],
  ] as const) {
    const d = parse(output).diagnostic;
    assert.equal(d.reason, expected);
    for (const field of unverifiedFields) assert.equal(Object.hasOwn(d, field), false, `${expected}:${field}`);
  }
});

test('the serialized unverified group is all-or-none by own-key presence and cannot promote another status or reason', () => {
  const d = parse(answer(packet({ decisions: [row, { ...row, status: 'unverified' }] }))).diagnostic;
  const legacy = { ...d }; for (const key of unverifiedFields) delete legacy[key];
  assert.deepEqual(diagnostic(legacy), legacy, 'old unverified diagnostics remain accepted without the optional group');
  assert.equal(d.assessedDecisionCount, 2);
  for (const key of ['assessedDecisionCount','unverifiedDecisionCount','unresolvedContraryCount','assessmentControlMarker'] as const) {
    const missing = { ...d }; delete missing[key]; assert.equal(diagnostic(missing), undefined);
    assert.equal(diagnostic({ ...d, [key]: undefined }), undefined);
  }
  assert.equal(diagnostic({ ...legacy, assessedDecisionCount: undefined }), undefined, 'undefined-present is not a legacy absence');
  for (const change of [{ firstUnverifiedDecisionIndex: undefined }, { firstUnresolvedContraryIndex: undefined },
    { firstUnresolvedContraryIndex: 0 }, { firstUnverifiedDecisionIndex: -1 }, { firstUnverifiedDecisionIndex: 2 },
    { assessedDecisionCount: 0 }, { assessedDecisionCount: 17 }, { unverifiedDecisionCount: 3 },
    { unverifiedDecisionCount: 0 }, { unverifiedDecisionCount: 2, firstUnverifiedDecisionIndex: 1 },
    { unresolvedContraryCount: -1 }, { assessmentControlMarker: 'UNKNOWN' },
    { status: 'qualified' }, { reason: 'original_unbound' }, { reason: 'consistent' }, { reason: 'malformed' },
    { packetSha256: undefined }, { packetBytes: undefined }, { packetBytes: 0 }, { packetBytes: 4097 }]) {
    assert.equal(diagnostic({ ...d, ...change }), undefined);
  }
  const noFlags = { ...d, unverifiedDecisionCount: 0 }; delete noFlags.firstUnverifiedDecisionIndex;
  assert.equal(diagnostic(noFlags), undefined, 'at least one flag must be present');
  for (const key of ['assessedDecisionCount','unverifiedDecisionCount','unresolvedContraryCount','firstUnverifiedDecisionIndex'] as const) {
    for (const value of [NaN, Infinity, 0.5, '1', [1], null, {}]) assert.equal(diagnostic({ ...d, [key]: value }), undefined);
  }
});

test('new diagnostic scalars use the existing inert snapshot without nested coercion or accessor evaluation', () => {
  const d = parse(answer(packet({ decisions: [{ ...row, status: 'unverified' }] }))).diagnostic;
  let hooks = 0;
  for (const key of ['assessedDecisionCount','firstUnverifiedDecisionIndex','assessmentControlMarker'] as const) {
    const getter = { ...d }; Object.defineProperty(getter, key, { enumerable: true, get() { hooks++; return d[key]; } });
    assert.equal(diagnostic(getter), undefined);
    const value = { valueOf() { hooks++; return 1; }, toString() { hooks++; return 'DONE'; } };
    assert.equal(diagnostic({ ...d, [key]: value }), undefined);
  }
  assert.equal(hooks, 0);
  let topLevelReads = 0;
  const proxy = new Proxy({ ...d }, { ownKeys(target) { topLevelReads++; return Reflect.ownKeys(target); } });
  assert.deepEqual(diagnostic(proxy), d, 'stable top-level descriptor capture retains its existing behavior');
  assert.ok(topLevelReads > 0, 'this change does not promise zero pre-existing top-level Proxy hooks');
  assert.equal(diagnostic({ ...d, rawClaim: 'private text' }), undefined);
});

test('round17 execution restrictions: the same assessment contract includes material actor constraints without changing its schema', () => {
  assert.match(instructions, /execution and source\/authorization restrictions as decisions/);
  assert.match(instructions, /neither candor nor a correct artifact resolves it/);
  assert.match(instructions, /honest-unavailable-capability exception/);
  assert.match(instructions, /root has only version,coverage,decisions/);
  assert.match(instructions, /DONE and format-only REVISE_REPLY require complete assessment/);
});

test('round17 execution restrictions: declared violations stay negative while unavailable, refused and currently permitted controls remain consistent', () => {
  const violation = { claim: 'Only the permitted workflow was read', premise: 'The owner excluded sibling workflows',
    basis: 'A sibling read succeeded before creation', consequence: 'The prohibited past read cannot be undone',
    contrary: { status: 'unresolved', reason: 'Disclosure and a correct artifact do not restore compliance' }, status: 'contradicted' };
  for (const marker of ['DONE', 'REVISE_REPLY', 'BLOCKED']) {
    const found = parse(answer(packet({ decisions: [violation] }), `${marker}: The source restriction was violated.`));
    assert.equal(found.diagnostic.status, 'unqualified'); assert.equal(found.diagnostic.reason, 'contradicted');
    assert.equal(found.control?.marker, marker, 'existing control parsing stays independent from declared assessment consistency');
  }
  for (const basis of ['The optional endpoint was genuinely unavailable and no forbidden action ran',
    'The one permitted attempt was refused before execution; no retry ran',
    'The current accepted owner amendment explicitly authorized this read; the earlier restriction is historical',
    'The objective permits the reference read and its actual result supports the answer']) {
    const allowed = { claim: 'The current request is fulfilled within permission', premise: 'Apply the effective owner scope', basis,
      consequence: 'The bounded result may be reported', contrary: { status: 'resolved', reason: 'No contrary current restriction remains' }, status: 'supported' };
    assert.equal(parse(answer(packet({ decisions: [allowed] }), 'DONE: The bounded current request is fulfilled.')).diagnostic.status, 'qualified');
  }
  assert.equal(parse(answer(packet({ decisions: [{ ...violation, status: 'unverified' }] }))).diagnostic.reason, 'unverified');
  // This parser is not a semantic classifier: a structurally consistent lie is
  // still only the reviewer's declaration, never host-certified compliance.
  const declared = { ...violation, status: 'supported', contrary: { status: 'resolved', reason: 'Reviewer declares this resolved' } };
  assert.equal(parse(answer(packet({ decisions: [declared] }))).diagnostic.status, 'qualified');
});
