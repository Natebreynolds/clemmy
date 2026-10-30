import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CardReplyRecord, FromClem } from '../../lib/from-clem.js';

// Render the actual component, without browser globals, API requests or mocked
// presentation functions. Bundling shares one React/context instance and resolves
// the same console aliases as the shipped screen; only a disposable module is written.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-from-clem-render-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { FromClemPane } from './src/components/home/FromClemPane';
    import { CardRecord, CardRecordList, RecentCardRecords } from './src/components/home/CardRecord';
    import { NeedsYouPane } from './src/components/home/NeedsYouPane';
    export function renderRecords(records, mode='list') {
      const client = new QueryClient();
      client.setQueryData(['from-clem-replies'],{replies:records});
      const fetch = globalThis.fetch;
      globalThis.fetch=()=>{throw new Error('Rendering receipts must not read or mutate work');};
      try { return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}>
        {mode==='single' ? <CardRecord record={records[0]} showTitle/> : mode==='recent' ? <RecentCardRecords/> : <CardRecordList records={records}/>}
      </QueryClientProvider></MemoryRouter>); } finally { globalThis.fetch=fetch; client.clear(); }
    }
    export function renderNeeds(props) {
      const client = new QueryClient();
      try { return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}>
        <NeedsYouPane headingId="controlled-needs" loading={false} error={false} onRetry={() => { throw new Error('No reads'); }} {...props} />
      </QueryClientProvider></MemoryRouter>); } finally { client.clear(); }
    }
    export function render(props) {
      const client = new QueryClient();
      if(props.records)client.setQueryData(['from-clem-replies'],{replies:props.records});
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Rendering must not request data'); };
      try {
        return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}>
          <FromClemPane headingId="controlled-from-clem" onRetry={() => { throw new Error('Rendering must not retry'); }} {...props} />
        </QueryClientProvider></MemoryRouter>);
      } finally { globalThis.fetch = originalFetch; client.clear(); }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'from-clem-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent',
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
const { render, renderNeeds, renderRecords } = createRequire(import.meta.url)(fixtureFile) as {
  renderRecords: (records: CardReplyRecord[], mode?:'single'|'list'|'recent') => string;
  renderNeeds: (props: {items: Array<Record<string, unknown>>;total?:number}) => string;
  render: (props: { records?:CardReplyRecord[]; data?: FromClem; loading: boolean; error: boolean }) => string;
};

function snapshot(): FromClem {
  return { rows: [], pulses: [], covers: { questionIds: [], planProposalIds: [], notificationIds: [] } };
}
function historyIn(html: string): string {
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? [];
  assert.equal(details.length, 1, 'quiet history has one native disclosure');
  assert.doesNotMatch(details[0], /^<details\b[^>]*\bopen(?:[\s=>])/);
  assert.match(details[0], /<summary\b/);
  return details[0];
}

test('cached empty refresh failures remain visibly stale, including a subsequent loading state', () => {
  for (const loading of [false, true]) {
    const html = render({ data: snapshot(), error: true, loading });
    assert.match(html, /Couldn’t refresh what Clem noticed/);
    assert.match(html, /Showing the last saved reading/);
    assert.match(html, /<button[^>]*>Try again<\/button>/);
    assert.match(html, /No updates in the last saved reading/);
    assert.doesNotMatch(html, /right now|Nothing new from Clem/);
  }
});

test('a cached update and its exact conversation link survive a refresh failure', () => {
  const data = snapshot();
  data.rows.push({ key: 'controlled-update', heartbeat: 'noticing', heartbeatTitle: 'Controlled check',
    at: '2026-10-17T18:00:00Z', asks: false, text: 'Controlled retained update', voiceDigest: 'controlled-digest',
    handoff: { state: 'needs_attention', sessionId: 'sess-controlled', reason: 'Controlled continuation needs attention.' } });
  const html = render({ data, error: true, loading: false });
  assert.match(html, /Showing the last saved reading/);
  assert.match(html, /Controlled retained update/);
  assert.match(html, /Controlled continuation needs attention/);
  assert.match(html, /href="\/chat\/harness%3Asess-controlled"/);
  assert.match(html, /Open conversation/);
});

test('quiet heartbeat history stays mounted inside a closed native disclosure', () => {
  const data = snapshot();
  data.pulses.push({ heartbeat: 'controlled-history', title: 'Controlled historical check', enabled: true,
    lastAt: '2026-10-17T18:00:00Z', summary: 'Controlled retained summary',
    presentation: { state: 'scheduled', lastCheck: { state: 'recorded', at: '2026-10-17T18:00:00Z' } } });
  const html = render({ data, error: false, loading: false });
  const history = historyIn(html);
  assert.match(history, /Controlled historical check/);
  assert.match(history, /Last check recorded/);
  assert.match(history, /Controlled retained summary/);
  assert.doesNotMatch(html.replace(history, ''), /Controlled historical check/);
});

test('live and uncertain heartbeat states remain visible outside quiet history', () => {
  const data = snapshot();
  data.pulses.push({ heartbeat: 'quiet', title: 'Quiet fixture', enabled: true,
    presentation: { state: 'scheduled', lastCheck: { state: 'recorded' } } });
  for (const state of ['checking', 'due', 'failed', 'partial', 'unknown'] as const) {
    data.pulses.push({ heartbeat: state, title: `Visible ${state}`, enabled: true,
      presentation: { state, lastCheck: { state: 'recorded' } } });
  }
  data.pulses.push({ heartbeat: 'missing', title: 'Visible unavailable', enabled: null, availability: 'unavailable' });
  data.pulses.push({ heartbeat: 'prior-failure', title: 'Visible prior failure', enabled: true,
    presentation: { state: 'scheduled', lastCheck: { state: 'failed' } } });
  const html = render({ data, error: false, loading: false });
  const history = historyIn(html);
  const visible = html.replace(history, '');
  for (const title of ['checking', 'due', 'failed', 'partial', 'unknown', 'unavailable', 'prior failure']) {
    assert.ok(visible.includes(`Visible ${title}`), `${title} must not disappear into quiet history`);
    assert.ok(!history.includes(`Visible ${title}`));
  }
  assert.match(visible, /Status unavailable/);
});

test('an unreadable first snapshot shows recovery rather than empty or loading claims', () => {
  const html = render({ error: true, loading: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /Couldn’t load what Clem noticed/);
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /Nothing new|No updates|Background check history/);
});

test('fresh decision controls keep their existing choices and quiet history remains separate', () => {
  const data = snapshot();
  data.rows.push({ key: 'controlled-decision', heartbeat: 'controlled', heartbeatTitle: 'Controlled check',
    at: '2026-10-17T18:00:00Z', asks: true, text: 'Controlled owner decision', voiceDigest: 'controlled-digest',
    answer: { kind: 'yes_no', planProposalId: 'controlled-plan' } });
  data.pulses.push({ heartbeat: 'quiet', title: 'Quiet retained check', enabled: true,
    presentation: { state: 'scheduled', lastCheck: { state: 'recorded' } } });
  const html = render({ data, error: false, loading: false });
  assert.match(html, /Controlled owner decision/);
  assert.match(html, /href="\/inbox\?tab=needs&amp;select=controlled-plan"[^>]*>Review plan<\/a>/);
  assert.doesNotMatch(html, /<button[^>]*>Yes<\/button>/, 'Today must not approve from a short preview');
  assert.match(html, /Decline/);
  assert.match(historyIn(html), /Quiet retained check/);
  assert.doesNotMatch(html, /Showing the last saved reading/);
});


test('generic asks offer recoverable hide controls only with a rendered server generation', () => {
  const data=snapshot();
  const lifecycle={canDismiss:true,canDefer:true,effect:'hide_only' as const,dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'exact-rendered-generation'};
  const row={key:'controlled-generic',heartbeat:'controlled',heartbeatTitle:'Controlled check',at:'2026-10-29T12:00:00Z',asks:true,
    text:'Controlled generic request',voiceDigest:'controlled-digest',attentionKey:'calendar:controlled',done:{notificationId:'notice'},lifecycle};
  data.rows.push(row);
  const html=render({data,error:false,loading:false});
  assert.match(html,/>Tomorrow<\/button>/);assert.match(html,/>Dismiss<\/button>/);
  assert.doesNotMatch(html,/>Done<\/button>|>Mark as read</);
  data.rows[0]={...row,lifecycle:{...lifecycle,generation:undefined}};
  const unversioned=render({data,error:false,loading:false});
  assert.doesNotMatch(unversioned,/>Tomorrow<\/button>|>Dismiss<\/button>/);
});


test('Today shows one work parent with every cause and counts equivalent reports without changing choices', () => {
  const data = snapshot();
  const lifecycle = {canDismiss:true as const,canDefer:true as const,effect:'hide_only' as const,dismissLabel:'Dismiss' as const,deferLabel:'Tomorrow' as const,generation:'a'.repeat(64)};
  data.rows = [
    {key:'credit',attentionKey:'flow:controlled-review',lifecycle,heartbeat:'work-review',heartbeatTitle:'Work review',at:'2026-10-29T00:00:00Z',asks:true,text:'Credit limit',detail:'Add credit before trying again',voiceDigest:'credit-version',relatedNotificationIds:['credit-new','credit-old'],choices:['Review exact account']},
    {key:'permission',attentionKey:'flow:controlled-review',lifecycle,heartbeat:'work-review',heartbeatTitle:'Work review',at:'2026-10-29T00:00:00Z',asks:true,text:'Permission refused',detail:'Pick the exact source',voiceDigest:'permission-version',relatedNotificationIds:['permission'],choices:['Review exact source']},
  ];
  const html = render({data,loading:false,error:false});
  assert.equal((html.match(/data-attention-group="flow:controlled-review"/g)??[]).length,1);
  assert.match(html,/3 reports/);
  assert.match(html,/Add credit before trying again/);
  assert.match(html,/Pick the exact source/);
  assert.match(html,/Reported 2 times/);
  assert.match(html,/Review exact account/);
  assert.match(html,/Review exact source/);
  const summary=html.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0]??'';
  assert.doesNotMatch(summary,/<button|Reply|Do it/);
});


test('Today uses the canonical total while repeated reports occupy one visible work parent', () => {
  const lifecycle = {canDismiss:true,canDefer:true,effect:'hide_only',dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'a'.repeat(64),explanation:'Hide only'};
  const items = ['Credit needed','Permission refused','A retained repeat'].map((title,index) => ({title,meta:title,kind:'workflow',notifId:`report-${index}`,attentionKey:'flow:controlled-home',lifecycle}));
  const html = renderNeeds({items,total:6});
  assert.equal((html.match(/data-attention-group="flow:controlled-home"/g)??[]).length,1);
  assert.match(html,/3 reports/);
  const heading=html.slice(html.indexOf('id="controlled-needs"'),html.indexOf('Open Inbox'));
  assert.match(heading,/>6</,'the canonical total wins over both the three reports and one preview parent');
  const fallback=renderNeeds({items});
  const fallbackHeading=fallback.slice(fallback.indexOf('id="controlled-needs"'),fallback.indexOf('Open Inbox'));
  assert.match(fallbackHeading,/>1</,'the unavailable-summary fallback counts distinct work items');
});


const receipt = (id:string, state:'done'|'needs_you'|'working'|'stopped'='done'):CardReplyRecord => ({
  rowKey:`row-${id}`,title:`Source ${id}`,reply:`Exact user request ${id}`,runId:`from-clem:${id}`,since:'2026-10-30T00:00:00Z',
  outcome:state==='working' ? {state,steps:[{tool:'read_file',done:false}]} : {state,text:`Full response ${id}`,sessionId:`session-${id}`,steps:[{tool:'read_file',done:true}]},
});
function visibleReceipt(html:string):string {
  return html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g,'');
}

test('held approval receipts keep the exact review target while full request and response live in a closed disclosure',()=>{
  const record=receipt('held','needs_you');
  record.reply='A complete exact user request';
  record.outcome={state:'needs_you',asks:'approval',approvalId:'approval / ?&',sessionId:'session / ?&',text:'Full approval paragraph. '.repeat(80)+'EXACT-FINAL-LINE',steps:[{tool:'read_file',done:true}]};
  const before=JSON.stringify(record);
  const html=renderRecords([record],'single');
  assert.match(html,/href="\/inbox\?tab=needs&amp;select=approval%20%2F%20%3F%26"/);
  assert.match(html,/Review and approve/);assert.match(html,/Read request, full reply &amp; activity/);
  const visible=visibleReceipt(html);
  assert.match(visible,/Clem needs your OK/);assert.doesNotMatch(visible,/A complete exact user request|Full approval paragraph|EXACT-FINAL-LINE|What Clem did/);
  assert.match(html,/<details[^>]*>/);assert.doesNotMatch(html,/<details[^>]*\bopen[= >]|line-clamp-6/);
  assert.match(html,/A complete exact user request/);assert.match(html,/EXACT-FINAL-LINE/);assert.equal(JSON.stringify(record),before);
});

test('receipt state, rather than response wording, controls live progress and exact conversation actions',()=>{
  const done=receipt('done');
  done.outcome={state:'done',text:'I am still working and need approval',sessionId:'chat / ?&'};
  const html=renderRecords([done],'single');
  assert.match(visibleReceipt(html),/>Done</);assert.match(html,/href="\/chat\/harness%3Achat%20%2F%20%3F%26"/);assert.match(html,/Open the conversation/);
  const answer=receipt('answer','needs_you');
  assert.match(visibleReceipt(renderRecords([answer],'single')),/Answer Clem/);
  const working=receipt('live','working');
  assert.match(visibleReceipt(renderRecords([working],'single')),/What Clem is doing/);
  assert.doesNotMatch(visibleReceipt(renderRecords([working],'single')),/Exact user request live/);
});

test('all loaded receipts remain readable while earlier settled activity is counted and live or held work stays visible',()=>{
  const records=[receipt('latest'),receipt('old-1'),receipt('old-2'),receipt('live','working'),receipt('held','needs_you')];
  for(const mode of ['list','recent'] as const){
    const html=renderRecords(records,mode);
    assert.equal((html.match(/data-testid="card-record"/g)??[]).length,5,'no loaded receipt is sliced away');
    assert.match(html,/Earlier reply activity · 2/);assert.doesNotMatch(html,/Just now/);
    const historyAt=html.indexOf('Earlier reply activity');
    assert.ok(html.indexOf('Source live')<historyAt);assert.ok(html.indexOf('Source held')<historyAt);assert.ok(html.indexOf('Source old-2')>historyAt);
  }
  const html=render({records,data:snapshot(),loading:false,error:false});
  assert.equal((html.match(/data-testid="card-record"/g)??[]).length,5);
  assert.match(html,/Earlier reply activity · 2/);
});

test('a pure noticing coordinate becomes a plain origin while prose and exact question navigation survive',()=>{
  const items=[{kind:'question',title:'Which account should Clem use?',meta:'noticing:ntc-mupqxx8k-aa8684',questionId:'checkin:question / ?&'}];
  const html=renderNeeds({items});
  assert.match(html,/From Clem/);assert.doesNotMatch(html,/noticing:ntc-mupqxx8k-aa8684/);
  assert.match(html,/>Reply<\/button>|aria-expanded="false"/);
  const prose='noticing:ntc-mupqxx8k-aa8684 is the source mentioned in my notes';
  assert.match(renderNeeds({items:[{...items[0],meta:prose}]}),/is the source mentioned in my notes/);
});


test('earlier replies on a still-listed source remain readable instead of disappearing behind its latest receipt',()=>{
  const data=snapshot();
  data.rows.push({key:'same-source',heartbeat:'controlled',heartbeatTitle:'Controlled source',at:'2026-10-30T00:00:00Z',asks:false,text:'Current source update',voiceDigest:'current-generation'});
  const latest={...receipt('latest-source'),rowKey:'same-source'};
  const earlier={...receipt('earlier-source'),rowKey:'same-source'};
  const html=render({records:[latest,earlier],data,loading:false,error:false});
  assert.equal((html.match(/data-testid="card-record"/g)??[]).length,2);
  assert.match(html,/Exact user request latest-source/);assert.match(html,/Exact user request earlier-source/);
});
