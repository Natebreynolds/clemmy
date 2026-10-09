import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UnifiedHit } from './unified-recall.js';
import { retainAutomaticPrimerOrigin, transferAutomaticPrimerOrigin, canCompactAutomaticPrimerSource } from './automatic-primer-origin.js';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-primer-origin-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.CLEMMY_EMBEDDINGS = 'off';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
delete process.env.OPENAI_API_KEY;
const { resetMemoryDb } = await import('./db.js');
const { rememberFact, getFact } = await import('./facts.js');
const { recordMemoryEpisode, getFactEvidence } = await import('./temporal-memory.js');
const { recallMemory } = await import('./recall-memory.js');
const { recallEverything, formatUnifiedRecall, unifiedPrimerLines, visibleUnifiedPrimerHits } = await import('./unified-recall.js');
const { createRecallRunId, recordRecallRun, recordRecallUse } = await import('./recall-usage.js');
const { buildUnifiedTurnPrimer } = await import('./turn-primer.js');
const { readFactObservation } = await import('./fact-correction.js');
const { upsertEntity } = await import('./reflection.js');
const { setFactEntityLinks } = await import('./relations.js');
const { withMemoryReadScope } = await import('./memory-scope.js');

beforeEach(() => resetMemoryDb());
after(() => rmSync(testHome, { recursive: true, force: true }));

const SOURCE = 'conversation://sess-desktop-0123456789abcdef01234567/auto-capture%3Auser-source%3A427000';
function hit(ref = '1', type: UnifiedHit['type'] = 'fact', sources = [SOURCE]): UnifiedHit {
  return { type, ref, title: 'user fact', snippet: 'Use the complete recurring convention, only in its stated scope.',
    score: .7, confidence: .9, validFrom: '2026-09-01T12:00:00.000Z', validTo: '2026-12-01T12:00:00.000Z',
    truncated: false, evidence: sources.map((sourceUri, i) => ({episodeId:`source:${i}`,excerpt:'Original full evidence.',sourceUri})) };
}
function bind(value: UnifiedHit, sourcePath: unknown = SOURCE): UnifiedHit {
  return retainAutomaticPrimerOrigin(value, {type:value.type,id:value.ref}, sourcePath);
}

test('eligible automatic lines compact only the locator and preserve enumerable symbols, JSON, full tools and dates', () => {
  const original = hit();
  const jsonBefore = JSON.stringify(original);
  const fullBefore = formatUnifiedRecall({objective:'convention',hits:[original],perStore:{}}, 4000);
  const before = unifiedPrimerLines([original])[0];
  bind(original);
  assert.equal(JSON.stringify(original),jsonBefore,'host metadata adds no serialized fields');
  assert.deepEqual(Object.keys(original),Object.keys(JSON.parse(jsonBefore)));
  assert.equal(Object.getOwnPropertySymbols(original).length,1);
  assert.equal(Object.getOwnPropertyDescriptor(original,Object.getOwnPropertySymbols(original)[0])?.enumerable,true);
  const spread = {...original,score:.8};
  assert.equal(unifiedPrimerLines([spread])[0],before.replace(` [source: ${SOURCE}]`,' [source via ref]'));
  assert.equal(formatUnifiedRecall({objective:'convention',hits:[original],perStore:{}},4000),fullBefore,'full tool formatter retains raw evidence');
  assert.ok(unifiedPrimerLines([spread])[0].includes(original.snippet));
  assert.ok(unifiedPrimerLines([spread])[0].includes('[valid_from: 2026-09-01T12:00:00.000Z]'));
  assert.ok(unifiedPrimerLines([spread])[0].includes('[valid_to: 2026-12-01T12:00:00.000Z]'));
  assert.deepEqual(original.evidence,JSON.parse(jsonBefore).evidence);
});

test('strict generated source and safe numeric identity reject lookalikes, external/account locators and forged JSON', () => {
  const sources = [
    'https://crm.example/account/acct_9', '/Users/test/report.md', 'tool://sess-desktop-test/read',
    SOURCE+'?account=acct_9', SOURCE+'#fragment', SOURCE.replace('%3A','%3a'),
    SOURCE.replace('0123456789abcdef01234567','0123456789abcdef012345678'),
    SOURCE.replace('427000','0'), SOURCE.replace('427000','0427000'), SOURCE.replace('427000','9007199254740992'),
    ' '+SOURCE, SOURCE+' ', SOURCE.replace('auto-capture%3Auser-source','other-source%3Auser-source'),
  ];
  for (const source of sources) {
    const value=hit('1','fact',[source]);bind(value,source);
    assert.equal(unifiedPrimerLines([value])[0].includes('[source via ref]'),false,source);
  }
  for (const id of ['0','-1','01','1.5','1e3','unsafe-id','9007199254740992']) {
    assert.equal(unifiedPrimerLines([bind(hit(id))])[0].includes('[source via ref]'),false,id);
  }
  for (const type of ['entity','resource','episode','vault'] as const) {
    assert.equal(unifiedPrimerLines([bind(hit('1',type))])[0].includes('[source via ref]'),false,type);
  }
  const branded=bind(hit());
  const forged=JSON.parse(JSON.stringify(branded));
  forged.automaticPrimerOrigin={factId:'1',sourceUri:SOURCE};
  forged.source={path:SOURCE};
  forged[Symbol('host-bound automatic primer origin')]={factId:'1',sourceUri:SOURCE};
  assert.ok(unifiedPrimerLines([forged])[0].includes(` [source: ${SOURCE}]`),'API fields and lookalike symbol do not establish a host binding');
});

test('missing/mismatched origins and mixed evidence preserve the original selected-source order and exact fact binding', () => {
  for (const origin of [null,undefined,SOURCE.replace('427000','427001')]) {
    const value=hit();retainAutomaticPrimerOrigin(value,{type:value.type,id:value.ref},origin);
    assert.ok(unifiedPrimerLines([value])[0].includes(` [source: ${SOURCE}]`));
  }
  const external='https://crm.example/account/acct_9';
  const externalFirst=bind(hit('1','fact',[external,SOURCE]));
  assert.ok(unifiedPrimerLines([externalFirst])[0].includes(` [source: ${external}]`),'account cue chosen before internal evidence remains');
  const internalFirst=bind(hit('1','fact',[SOURCE,external]));
  assert.ok(unifiedPrimerLines([internalFirst])[0].includes(' [source via ref]'));
  assert.deepEqual(internalFirst.evidence?.map(e=>e.sourceUri),[SOURCE,external]);
  const changed={...internalFirst,ref:'2'};
  assert.ok(unifiedPrimerLines([changed])[0].includes(` [source: ${SOURCE}]`),'spread cannot apply origin to another fact');
  const alias=transferAutomaticPrimerOrigin(internalFirst,hit('1','policy'),{type:'policy',id:'1'});
  assert.ok(unifiedPrimerLines([alias])[0].includes(' [source via ref]'));
  const wrong=transferAutomaticPrimerOrigin(internalFirst,hit('2'),{type:'fact',id:'2'});
  assert.ok(unifiedPrimerLines([wrong])[0].includes(` [source: ${SOURCE}]`));
});

test('frozen, nonextensible, repeated and conflicting attachments never break recall or revive stale origin', () => {
  for (const value of [Object.freeze(hit()),Object.preventExtensions(hit())]) {
    assert.doesNotThrow(()=>bind(value));
    assert.ok(unifiedPrimerLines([value])[0].includes(` [source: ${SOURCE}]`));
  }
  const repeated=bind(hit());Object.freeze(repeated);
  assert.doesNotThrow(()=>bind(repeated));
  assert.ok(unifiedPrimerLines([repeated])[0].includes(' [source via ref]'));
  assert.doesNotThrow(()=>bind(repeated,SOURCE.replace('427000','427001')));
  assert.ok(unifiedPrimerLines([repeated])[0].includes(` [source: ${SOURCE}]`));
  assert.ok(unifiedPrimerLines([{...repeated}])[0].includes(` [source: ${SOURCE}]`),'spread cannot restore a rejected binding');
  const projected=transferAutomaticPrimerOrigin(repeated,hit(),{type:'fact',id:'1'});
  assert.ok(unifiedPrimerLines([projected])[0].includes(` [source: ${SOURCE}]`));
  const from=bind(hit()),to=Object.freeze(hit());
  assert.doesNotThrow(()=>transferAutomaticPrimerOrigin(from,to,{type:'fact',id:'1'}));
  assert.ok(unifiedPrimerLines([to])[0].includes(` [source: ${SOURCE}]`));
});

test('real admitted fact/policy origins survive utility and complete-set spreads and facade transfer with reopenable evidence', async () => {
  const content='Our Orchard cohort roster is Mira Vale, Noel Chen, and Iona Park.';
  const fact=rememberFact({kind:'constraint',content,path:SOURCE});
  const run=recordRecallRun({id:createRecallRunId(),objective:'Orchard cohort',surface:'memory_recall_all',answerability:'partial',
    candidateRefs:[{type:'fact',id:String(fact.id)},{type:'policy',id:String(fact.id)}]});
  recordRecallUse({recallId:run.id,refs:[`fact:${fact.id}`,`policy:${fact.id}`],outcome:'used',detail:'fixture verified use'});
  const query='List all members of the Orchard cohort roster';
  const recalled=await recallMemory(query,{stores:['fact','policy'],graphDepth:0,limit:10});
  for (const type of ['fact','policy'] as const) {
    const selected=recalled.hits.find(value=>value.ref.type===type&&String(value.ref.id)===String(fact.id));
    assert.ok(selected,type);
    assert.ok(selected.whyRecalled.some(why=>why.includes('proven useful')),'actual utility spread');
    assert.ok(selected.whyRecalled.includes('complete-set durable fact preferred'),'actual complete-set spread');
    assert.equal(canCompactAutomaticPrimerSource(selected,selected.ref,SOURCE),true);
  }
  const unified=await recallEverything(query,{stores:['fact','policy'],graphDepth:0,limit:10});
  for (const selected of unified.hits.filter(value=>value.ref===String(fact.id))) {
    assert.equal(canCompactAutomaticPrimerSource(selected,{type:selected.type,id:selected.ref},SOURCE),true);
    assert.ok(unifiedPrimerLines([selected])[0].includes(' [source via ref]'));
    assert.equal(selected.snippet,content,'complete-set full value retained');
    const unbranded=JSON.parse(JSON.stringify(selected));
    assert.equal(JSON.stringify(selected),JSON.stringify(unbranded));
    assert.equal(formatUnifiedRecall({objective:query,hits:[selected],perStore:{}},4000),
      formatUnifiedRecall({objective:query,hits:[unbranded],perStore:{}},4000));
  }
  const primer=await buildUnifiedTurnPrimer({query,surface:'automatic_primer',sessionId:'origin-fixture-session',format:'tail',
    maxChars:1200,limit:10,selection:{relativeFloor:.5,reservedPolicySlots:2}});
  assert.ok(primer.recallId);
  assert.ok(primer.visibleRefs?.some(ref=>ref.id===String(fact.id)));
  assert.equal(getFact(fact.id)?.content,content,'numeric ref still reopens full fact');
  assert.equal(getFact(fact.id)?.source.path,SOURCE);
  assert.ok(getFactEvidence(fact.id).some(e=>e.sourceUri===SOURCE&&e.excerpt===content),'full source remains durable');
});

test('actual named-entity and distinctive ranking spreads retain the exact admitted host origin', async () => {
  const content='For the Orchard Cohort, Bayberry explanations preserve the full schedule conditions.';
  const fact=rememberFact({kind:'user',content,path:SOURCE});
  for (let i=0;i<4;i++) rememberFact({kind:'user',content:`Orchard Cohort routine schedule record ${i} covers a different ordinary condition ${i}.`});
  const entity=upsertEntity({type:'project',name:'Orchard Cohort'});
  setFactEntityLinks(fact.id,[entity],{linkType:'stored'});
  const recalled=await recallEverything('Explain the Bayberry convention for Orchard Cohort',{stores:['fact'],graphDepth:1,limit:10});
  const selected=recalled.hits.find(value=>value.ref===String(fact.id));
  assert.ok(selected);
  assert.ok(selected.whyRecalled?.some(why=>why.includes('explicitly named entity')),'actual named-entity spread');
  assert.ok(selected.whyRecalled?.some(why=>why.includes('distinctive among admitted')),'actual distinctive spread');
  assert.ok(unifiedPrimerLines([selected])[0].includes(' [source via ref]'));
  assert.equal(selected.snippet,content);
});

test('exact fact observation reopens unchanged sourcePath and scope, and metadata never exposes a hidden fact', async () => {
  const scope={projectId:'origin-project',agentKey:'origin-agent'};
  const content='Juniper convention retains every exact source and scope condition.';
  const fact=rememberFact({kind:'user',content,path:SOURCE,scope});
  await withMemoryReadScope(scope,async()=>{
    const before=readFactObservation(fact.id);assert.ok(before);
    const recalled=await recallEverything('Juniper convention source scope',{stores:['fact'],graphDepth:0,limit:10});
    const selected=recalled.hits.find(value=>value.ref===String(fact.id));assert.ok(selected);
    assert.ok(unifiedPrimerLines([selected])[0].includes(' [source via ref]'));
    const after=readFactObservation(fact.id);assert.deepEqual(after,before);
    assert.equal(after?.content,content);assert.equal(after?.provenance.sourcePath,SOURCE);
    assert.deepEqual(after?.scope,scope);
  });
  await withMemoryReadScope({projectId:'other-project',agentKey:'other-agent'},async()=>{
    assert.equal(readFactObservation(fact.id),null);
    const recalled=await recallEverything('Juniper convention source scope',{stores:['fact'],graphDepth:0,limit:10});
    assert.ok(!recalled.hits.some(value=>value.ref===String(fact.id)));
  });
});

test('real source-backed fact with canonical evidence but null source.path retains its URI', async () => {
  const content='Our Bayberry explanation convention preserves every dated condition.';
  const episode=recordMemoryEpisode({kind:'user_turn',sourceUri:SOURCE,content,status:'available'});
  const fact=rememberFact({kind:'user',content,evidence:{episodeId:episode.id,excerpt:content,sourceUri:SOURCE}});
  assert.equal(fact.source.path,undefined,'the counterexample really has no admitted path');
  const recalled=await recallEverything('Bayberry explanation convention',{stores:['fact'],graphDepth:0,limit:10});
  const selected=recalled.hits.find(value=>value.ref===String(fact.id));
  assert.ok(selected);
  assert.ok(unifiedPrimerLines([selected])[0].includes(` [source: ${SOURCE}]`));
  assert.equal(unifiedPrimerLines([selected])[0].includes('[source via ref]'),false);
});

test('unchanged character budget now admits the full eligible fact while an unbound policy and full tools stay unchanged', () => {
  const target=hit('2');target.validTo=undefined;
  const emptyLine=unifiedPrimerLines([{...target,snippet:''}])[0];
  target.snippet='x'.repeat(394-emptyLine.length-2);
  assert.equal(unifiedPrimerLines([target])[0].length,394);
  const policy=hit('1','policy',[]);policy.validFrom=undefined;policy.validTo=undefined;
  policy.snippet='p'.repeat(365-unifiedPrimerLines([{...policy,snippet:''}])[0].length-2);
  assert.equal(unifiedPrimerLines([policy])[0].length,365);
  const result={objective:'fixture',hits:[policy,target],perStore:{policy:1,fact:1},purpose:'ambient' as const};
  const fullBefore=formatUnifiedRecall(result,4000);
  assert.deepEqual(visibleUnifiedPrimerHits(result,740,{header:false}).map(value=>value.ref),['1']);
  bind(target);
  assert.equal(unifiedPrimerLines([target])[0].length,312);
  assert.equal(365+312+2,679);
  assert.deepEqual(visibleUnifiedPrimerHits(result,740,{header:false}).map(value=>value.ref),['1','2']);
  assert.equal(unifiedPrimerLines([policy])[0].length,365);
  assert.equal(formatUnifiedRecall(result,4000),fullBefore);
});
