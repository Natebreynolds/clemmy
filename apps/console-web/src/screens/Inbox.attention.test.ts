import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { AttentionItem } from '../lib/attention-presentation';
import type { HomeFeedItem } from '../components/home/home-model';
import type { ApprovalRow, NotificationRow } from '../lib/inbox';

const temporary = mkdtempSync(path.join(os.tmpdir(),'clem-inbox-attention-'));
test.after(()=>rmSync(temporary,{recursive:true,force:true}));
const root = fileURLToPath(new URL('../../',import.meta.url));
const built = await build({stdin:{contents:`
  import {renderToStaticMarkup} from 'react-dom/server';
  import {MemoryRouter} from 'react-router-dom';
  import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
  import {Inbox} from './src/screens/Inbox';
  import {NeedsYouPane} from './src/components/home/NeedsYouPane';
  export function renderHome(items) {
    const client=new QueryClient();
    try{return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><NeedsYouPane items={items} headingId="controlled-home" loading={false} error={false} onRetry={()=>{throw new Error('Rendering must not retry')}}/></QueryClientProvider></MemoryRouter>)}
    finally{client.clear()}
  }
  export function render({items,notifications=[],unlisted=[],approvals=[],select,summaryError=false,allError=false}) {
    const client=new QueryClient({defaultOptions:{queries:{retryOnMount:false}}});
    const data={approvals:{approvals},'workspace-choosers':{choosers:[]},notifications:{notifications},
      'trust-proposals':{proposals:[]},'plan-proposals':{proposals:[]},'inbox-questions':{questions:[]},
      'needs-you-summary':{total:items.length+approvals.length,unlisted,attentionItems:items},
      'home-from-clem':{rows:[],pulses:[],covers:{questionIds:[],planProposalIds:[],notificationIds:[]}}};
    for(const [name,value] of Object.entries(data)) {
      const queryKey=[name];client.setQueryData(queryKey,value);
      if(allError || name==='needs-you-summary' && summaryError) client.getQueryCache().find({queryKey}).setState({status:'error',error:new Error('Controlled offline')});
    }
    const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Rendering must not fetch or mutate')};
    try {return renderToStaticMarkup(<MemoryRouter initialEntries={['/inbox?tab=needs&select='+encodeURIComponent(select)]}><QueryClientProvider client={client}><Inbox/></QueryClientProvider></MemoryRouter>)}
    finally {globalThis.fetch=original;client.clear()}
  }`,resolveDir:root,loader:'tsx'},tsconfig:path.join(root,'tsconfig.json'),bundle:true,write:false,
  platform:'node',format:'cjs',jsx:'automatic',target:'node22',logLevel:'silent',loader:{'.png':'dataurl'},
  define:{'import.meta.env.DEV':'false','import.meta.env.VITE_CLEM_TOKEN':'""'}});
const file=path.join(temporary,'fixture.cjs');writeFileSync(file,built.outputFiles[0].contents);
const {render,renderHome}=createRequire(import.meta.url)(file) as {renderHome:(items:HomeFeedItem[])=>string;render:(props:{items:AttentionItem[];notifications?:NotificationRow[];approvals?:ApprovalRow[];unlisted?:unknown[];select:string;summaryError?:boolean;allError?:boolean})=>string};
const lifecycle={canDismiss:true,canDefer:true,effect:'hide_only' as const,dismissLabel:'Dismiss',deferLabel:'Tomorrow',generation:'exact-controlled-generation',explanation:'Hide only'};
const item:AttentionItem={key:'heartbeat:controlled',kind:'notification',title:'Controlled request',detail:'The retained request needs an owner reply.',createdAt:'',lifecycle};

test('summary-only generic requests open full actionable details without answering or marking read',()=>{
  const html=render({items:[item],select:item.key});
  assert.match(html,/retained request needs an owner reply/);
  assert.match(html,/>Tomorrow<\/button>/);assert.match(html,/>Dismiss<\/button>/);
  assert.match(html,/Nothing is answered or resolved/);
  assert.doesNotMatch(html,/>Mark as read<|>Resume<|1970|exact-controlled-generation/);
});

test('workflow-only asks select details before offering their exact workflow context',()=>{
  const workflow={...item,key:'flow:controlled',kind:'workflow' as const,workflowSlug:'controlled workflow'};
  const html=render({items:[workflow],select:workflow.key,unlisted:[{key:workflow.key,kind:'workflow_binding',title:workflow.title,detail:workflow.detail,workflowSlug:workflow.workflowSlug,lifecycle}]});
  assert.match(html,/id="needs-you-detail-title"/);
  assert.match(html,/href="\/automate\?workflow=controlled\+workflow"/);
  assert.match(html,/>Dismiss<\/button>/);
});

test('rich calendar requests retain their details and generic hide controls during a partial refresh failure',()=>{
  const calendar={...item,key:'calendar:controlled',kind:'calendar' as const,notificationId:'notice'};
  const notification={id:'notice',title:'Controlled invitation',body:'Full original meeting context',createdAt:'',read:false,needsAttention:true,needsYouKey:calendar.key,lifecycle};
  const html=render({items:[calendar],notifications:[notification],select:'notice',summaryError:true});
  assert.match(html,/Full original meeting context/);assert.match(html,/>Tomorrow<\/button>/);
  assert.doesNotMatch(html,/>Mark as read<|all caught up/);
});

test('a failed refresh retains the last-good mixed list rather than replacing it with unavailable',()=>{
  const html=render({items:[item],select:item.key,allError:true});
  assert.match(html,/Controlled request/);assert.match(html,/retained request needs an owner reply/);
  assert.match(html,/Couldn’t check/);assert.doesNotMatch(html,/Inbox is unavailable|all caught up/);
});


test('Today opens summary-only asks by exact key and enables safe controls only with a generation',()=>{
  const row={title:'Controlled Today request',attentionKey:'heartbeat:controlled / ask',lifecycle};
  const html=renderHome([row]);
  assert.match(html,/href="\/inbox\?tab=needs&amp;select=heartbeat%3Acontrolled%20%2F%20ask"/);
  assert.match(html,/>Tomorrow<\/button>/);assert.match(html,/aria-label="Dismiss/);
  const unversioned=renderHome([{...row,lifecycle:undefined,dismissKind:'notif',dismissId:'legacy-carrier'}]);
  assert.doesNotMatch(unversioned,/>Tomorrow<\/button>|aria-label="Dismiss/,'a typed generic ask cannot fall through to legacy mark-read');
});


test('a canonical workflow projected through notification and summary renders once with its owning action intact',()=>{
  const workflow={...item,key:'flow:controlled',kind:'workflow' as const,title:'Controlled workflow needs a review',workflowSlug:'controlled-flow'};
  const distinct={...workflow,key:'flow:distinct',workflowSlug:'distinct-flow'};
  const notification={id:'controlled-notice',title:workflow.title,body:'Full retained workflow details',createdAt:'',read:false,needsAttention:true,needsYouKey:workflow.key,lifecycle,
    workflowEnableGate:{workflowName:'controlled-flow',displayName:'Controlled flow',reason:'Review before enabling'}};
  const html=render({items:[workflow,distinct],notifications:[notification],select:workflow.key,unlisted:[workflow,distinct].map(row=>({key:row.key,kind:'workflow_paused',title:row.title,detail:row.detail,workflowSlug:row.workflowSlug,lifecycle}))});
  const stopped=html.match(/<section[^>]*aria-label="Stopped"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(stopped,'stopped workflows remain in their own section');
  assert.equal((stopped.match(/<li>/g)??[]).length,2,'two canonical workflow asks produce two rows, including the distinct same-title ask');
  assert.doesNotMatch(stopped,/Stopped · 3/);
  assert.equal((stopped.match(/aria-pressed="true"/g)??[]).length,1,'canonical-key navigation selects the retained notification row');
  assert.match(html,/Full retained workflow details/);
  assert.match(html,/>Turn on Controlled flow<\/button>/,'the richer notification action survives deduplication');
  assert.match(html,/>Tomorrow<\/button>/);assert.match(html,/>Dismiss<\/button>/);
});


test('canonical and existing bare approval links select the exact approval and its full draft',()=>{
  const approval={approvalId:'controlled / approval',subject:'Review controlled outbound draft',status:'pending',contentPreview:{body:'Exact controlled draft requiring approval'}};
  for(const select of [`approval:${approval.approvalId}`,approval.approvalId]) {
    const html=render({items:[],approvals:[{...approval,approvalId:'different-approval',subject:'Another approval',contentPreview:{body:'Another draft'}},approval],select});
    assert.match(html,/<h2 id="needs-you-detail-title"[^>]*>Review controlled outbound draft<\/h2>/);
    assert.match(html,/Exact controlled draft requiring approval/);
    assert.equal((html.match(/aria-pressed="true"/g)??[]).length,1,'only the requested approval row is selected');
  }
});
