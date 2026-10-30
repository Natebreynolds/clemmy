import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { GoalSummary } from '../lib/goals';
import type { AgentWorker } from '../lib/agents';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-work-recovery-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const root = fileURLToPath(new URL('../../', import.meta.url));
const built = await build({ stdin: { contents: `
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MemoryRouter } from 'react-router-dom';
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
  import { GoalRecordDetails } from './src/components/goals/GoalRecordDetails';
  import { HelperOutput, ExistingThread } from './src/screens/AgentWorkspace';
  import { AgentForm } from './src/components/agents/AgentForm';
  import { Meetings } from './src/screens/Meetings';
  import { BackgroundTasks } from './src/screens/BackgroundTasks';
  const agent = {id:'controlled-agent',name:'Research',handles:'Research',instructions:'',skills:[],workflows:[],tools:[],model:null};
  export function render(kind, payload={}) {
    const originalWindow=globalThis.window;
    if(kind==='meeting' && payload.recording) globalThis.window={clemmy:{}};
    const client = new QueryClient({ defaultOptions: { queries: {retryOnMount:false} } });
    const set=(key,data,error=false)=>{client.setQueryData(key,data);if(error)client.getQueryCache().find({queryKey:key,exact:true}).setState({status:'error',error:new Error('Controlled offline')});};
    let content;
    if(kind==='meeting') {
      set(['meetings'],{meetings:payload.history ? [{id:'controlled-history',title:'Saved meeting',status:'completed',createdAt:'2026-10-30T00:00:00Z'}] : []});
      set(['recall-status'],{settings:{},credential:{status:'missing'}});
      set(['recall-sdk'],{recording:!!payload.recording});
      set(['local-meeting-status'],null);
      content=<Meetings/>;
    } else if(kind==='form') content=<AgentForm mode="create" catalog={{skills:[],workflows:[]}} onClose={()=>{throw new Error('Unexpected close')}} onSaved={()=>{throw new Error('Unexpected save')}}/>;
    else if(kind==='goal') content=<GoalRecordDetails goal={payload}/>;
    else if(kind==='output') {
      const w=payload.worker;
      if(payload.otherOutput) set(['agents','helper-output',w.workflowName,'other-run',w.id,w.outputRef],{output:payload.otherOutput});
      set(['agents','helper-output',w.workflowName,w.parentRunId,w.id,w.outputRef],payload.output ?? null,true);
      content=<HelperOutput worker={w}/>;
    } else if(kind==='thread') {
      if(payload.cached) set(['conversations','detail','chat:controlled-thread'],{session:{id:'chat:controlled-thread',title:'Controlled thread',source:'chat',updatedAt:'2026-10-30T00:00:00Z'},turns:[]},true);
      else set(['conversations','detail','chat:controlled-thread'],null,true);
      content=<ExistingThread agent={agent} sessionId="chat:controlled-thread"/>;
    } else {
      set(['board'],{cards:[],generatedAt:'2026-10-30T00:00:00Z'});
      set(['focus'],{agents:[],tools:[],runs:[]});
      if(payload.state!=='loading')set(['board-selected-run','controlled-session','controlled-attempt','controlled-scope'],null,payload.state==='error');
      content=<BackgroundTasks/>;
    }
    const fetch = globalThis.fetch;
    globalThis.fetch=()=>{throw new Error('Rendering must not fetch, retry, or mutate work');};
    try{return renderToStaticMarkup(<MemoryRouter initialEntries={['/tasks?select=controlled-session&attemptId=controlled-attempt&runScopeId=controlled-scope']}><QueryClientProvider client={client}>{content}</QueryClientProvider></MemoryRouter>);}
    finally{globalThis.fetch=fetch;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;client.clear();}
  }`, resolveDir: root, loader: 'tsx' }, tsconfig: path.join(root,'tsconfig.json'), bundle:true,write:false,
  platform:'node',format:'cjs',jsx:'automatic',target:'node22',logLevel:'silent',loader:{'.png':'dataurl','.css':'empty'},
  define:{'import.meta.env.DEV':'false','import.meta.env.VITE_CLEM_TOKEN':'""'},
  // Browser PDF canvas loading is outside these read/recovery cases.
  plugins:[{name:'no-pdf-preview-in-server-fixture',setup(builder){builder.onLoad({filter:/\/components\/chat\/PdfPreview\.tsx$/},()=>({contents:'export default function PdfPreview(){throw new Error("Unexpected PDF preview in Work recovery test")}',loader:'js'}));
    // ExistingThread's retention boundary is under test; the composer's browser-only external store is covered separately.
    builder.onLoad({filter:/\/components\/chat\/Composer\.tsx$/},()=>({contents:'export function Composer(){return <textarea aria-label="Controlled composer boundary"/>}',loader:'tsx'}));
  }}] });
const file=path.join(temporary,'fixture.cjs');writeFileSync(file,built.outputFiles[0].contents);
const {render}=createRequire(import.meta.url)(file) as {render:(kind:string,payload?:unknown)=>string};

test('goal details disclose every loaded criterion, progress entry and evidence detail', () => {
  const goal = {
    objective:'Full exact validation contract',successCriteria:Array.from({length:7},(_,i)=>`Criterion ${i+1}`),
    progressLedger:Array.from({length:8},(_,i)=>`Progress ${i+1}`),
    evidenceSummary:{total:12,passed:5,failed:0,latest:Array.from({length:5},(_,i)=>({at:'2026-10-30T00:00:00Z',attempt:i+1,criterion:`Evidence ${i+1}`,pass:true,method:'deterministic',detail:`Exact evidence detail ${i+1}`}))},
    steps:[{n:1,action:'Verify the final file',verification:'Open the saved copy'}],risks:['Keep the original'],
    stages:[{id:'stage',title:'Finish review',status:'pending',criteria:['Final stage criterion']}],
  } as GoalSummary;
  const html=render('goal',goal);
  for(const text of ['Criterion 7','Progress 1','Progress 8','Exact evidence detail 1','Exact evidence detail 5','5 loaded of 12','Verify the final file','Open the saved copy','Final stage criterion','Full exact validation contract']) assert.ok(html.includes(text),text);
  assert.match(html,/<details/);assert.doesNotMatch(html,/12 loaded/);
});

test('Activity distinguishes exact selection loading, unavailable and failed reads', () => {
  assert.match(render('activity',{state:'loading'}),/Opening the selected run/);
  const unavailable=render('activity',{state:'unavailable'});
  assert.match(unavailable,/This exact run is unavailable/);assert.match(unavailable,/Retry<\/button>/);assert.match(unavailable,/Dismiss selection/);
  assert.match(render('activity',{state:'error'}),/This run couldn’t load/);
});

test('a failed helper output keeps its preview, offers Retry and never borrows another run’s output', () => {
  const worker={id:'helper',workflowName:'controlled-flow',parentRunId:'current-run',outputRef:'artifact-current',outputPreview:'Saved preview'} as AgentWorker;
  const html=render('output',{worker,otherOutput:'Wrong neighboring output'});
  assert.match(html,/Saved preview/);assert.match(html,/full output couldn’t load/);assert.match(html,/Retry<\/button>/);assert.doesNotMatch(html,/Wrong neighboring output/);
  assert.match(render('output',{worker,output:{output:'Retained exact full output'}}),/Retained exact full output/);
});

test('an offline thread retains the loaded conversation and composer instead of claiming it is missing', () => {
  const cached=render('thread',{cached:true});
  assert.match(cached,/conversation and draft are still here/);assert.match(cached,/<textarea/);assert.doesNotMatch(cached,/This thread could not be found|Start a new thread/);
  const unread=render('thread',{cached:false});
  assert.match(unread,/This thread couldn’t load right now/);assert.match(unread,/Retry<\/button>/);assert.doesNotMatch(unread,/This thread could not be found/);
});


test('idle meeting history stays visible before setup while first-use guidance stays expanded', () => {
  const history=render('meeting',{history:true});
  assert.match(history,/<details[^>]*class="group\/recording-settings/);assert.doesNotMatch(history,/<details[^>]*open=""[^>]*class="group\/recording-settings/);
  assert.match(history,/Record a meeting/);assert.match(history,/Saved meeting/);assert.match(history,/href="\/connect"[^>]*>Apps &amp; devices/);
  assert.match(render('meeting',{history:true,recording:true}),/<details[^>]*open=""[^>]*class="group\/recording-settings/);
  assert.match(render('meeting',{history:false}),/<details[^>]*open=""[^>]*class="group\/recording-settings/);
});


test('agent editor uses a native modal and form submit semantics for keyboard access', () => {
  const html=render('form');
  assert.match(html,/<dialog[^>]*aria-label="New agent"/);assert.match(html,/<form/);
  assert.match(html,/<button[^>]*type="submit"[^>]*>Create agent<\/button>/);
  assert.match(html,/<button[^>]*type="button"[^>]*>Cancel<\/button>/);
});
