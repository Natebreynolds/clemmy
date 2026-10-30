import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const temporary=mkdtempSync(path.join(os.tmpdir(),'clem-home-first-use-'));
test.after(()=>rmSync(temporary,{recursive:true,force:true}));
const root=fileURLToPath(new URL('../../',import.meta.url));
const built=await build({stdin:{contents:`
  import React from 'react';
  import {renderToStaticMarkup} from 'react-dom/server';
  import {MemoryRouter} from 'react-router-dom';
  import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
  import {Home} from './src/screens/Home';
  import {DEFAULT_HOME_PREFERENCES} from './src/lib/home-prefs';
  import {onboardingCompletionNavigation} from './src/lib/onboarding-entry';
  import {newComposerDraftKey,readComposerDraft,writeComposerDraft} from './src/lib/composer-drafts';
  export function render({established=false,entry=true,failed,missing,stale,text,nonempty=false}={}) {
    const client=new QueryClient({defaultOptions:{queries:{retryOnMount:false}}});
    const now=Date.now();
    const data=[
      {key:['settings','home'],value:{...DEFAULT_HOME_PREFERENCES,updatedAt:established?'2026-10-30T00:00:00Z':'1970-01-01T00:00:00.000Z'}},
      {key:['home-layout'],value:{version:1,revision:0,updatedAt:null,tiles:[]}},
      {key:['command-center'],value:{needsYou:[],recentCompleted:[],counts:{},focus:{active:null,parked:[],parkedCount:0,needsConfirm:false}}},
      {key:['needs-you-summary'],value:{total:0,keys:[],unlisted:[]}},
      {key:['working-now-badge'],value:{schemaVersion:1,observedAt:new Date(now).toISOString(),entries:[]}},
      {key:['delegated-tasks','open'],value:[]},
      {key:['spaces'],value:nonempty?[{id:'existing-space',title:'Existing work',status:'active',dataSources:[],actions:[],version:1,revisions:[],createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()}]:[]},
      {key:['user-context'],value:{profile:{},goals:[],files:[]}},
      {key:['delivered'],value:[]},
      {key:['home-today'],value:{connected:false,asOf:null,nextCheckAt:null,lastError:null,events:[]}},
      {key:['home-from-clem'],value:{rows:[],pulses:[],covers:{questionIds:[],planProposalIds:[],notificationIds:[]}}},
      {key:['watches'],value:{watches:[]}},
      {key:['from-clem-replies'],value:{replies:[]}},
    ];
    for(const {key,value} of data){
      const name=key.join('/');if(missing===name)continue;
      client.setQueryData(key,value,{updatedAt:name===stale?now-90_001:now});
      if(failed===name)client.getQueryCache().find({queryKey:key,exact:true}).setState({status:'error',error:new Error('Controlled failed reading')});
    }
    const state=entry?onboardingCompletionNavigation(true,303040201).state:undefined;
    const key=newComposerDraftKey('/chat','controlled-home',entry?303040201:undefined);
    writeComposerDraft(key,()=>({text:text??'',attachments:[]}));
    const before=readComposerDraft(key);
    // Browser draft stores have no SSR snapshot. Supply that same read function
    // only in this fixture; Home and Composer themselves render unmodified.
    const useStore=React.useSyncExternalStore;
    React.useSyncExternalStore=(subscribe,getSnapshot,getServerSnapshot)=>useStore(subscribe,getSnapshot,getServerSnapshot??getSnapshot);
    const fetch=globalThis.fetch;let calls=0;
    globalThis.fetch=()=>{calls++;throw new Error('Rendering guidance must not send, create a session or fetch');};
    try{
      const html=renderToStaticMarkup(<MemoryRouter initialEntries={[{pathname:'/chat',key:'controlled-home',state}]}><QueryClientProvider client={client}><Home/></QueryClientProvider></MemoryRouter>);
      return {html,calls,unchanged:readComposerDraft(key)===before,draft:readComposerDraft(key)};
    }finally{React.useSyncExternalStore=useStore;globalThis.fetch=fetch;client.clear();}
  }
`,resolveDir:root,loader:'tsx'},tsconfig:path.join(root,'tsconfig.json'),bundle:true,write:false,
  platform:'node',format:'cjs',jsx:'automatic',target:'node22',logLevel:'silent',loader:{'.css':'empty','.png':'dataurl','.svg':'dataurl','.jpg':'dataurl'},
  define:{'import.meta.env.DEV':'false','import.meta.env.VITE_CLEM_TOKEN':'""'},
  plugins:[{name:'no-pdf-preview-in-home-render',setup(builder){builder.onLoad({filter:/\/components\/chat\/PdfPreview\.tsx$/},()=>({contents:'export default function PdfPreview(){throw new Error("Unexpected PDF preview in first-use Home")}',loader:'js'}));}}]});
const file=path.join(temporary,'fixture.cjs');writeFileSync(file,built.outputFiles[0].contents);
const {render}=createRequire(import.meta.url)(file) as {render:(input?:{established?:boolean;entry?:boolean;failed?:string;missing?:string;stale?:string;text?:string;nonempty?:boolean})=>{html:string;calls:number;unchanged:boolean;draft:{text:string;attachments:unknown[]}}};

test('verified fresh empty exploration renders existing editable goal guidance without sending or dashboard scaffolding',()=>{
  const result=render();
  assert.match(result.html,/What would you like to get done/);assert.match(result.html,/Describe your goal in your own words/);
  assert.match(result.html,/Make a plan/);assert.match(result.html,/Understand a file/);assert.match(result.html,/Choose an example to edit before sending/);
  assert.doesNotMatch(result.html,/id="home-spaces"|id="home-made"|id="home-projects"|Make this Home yours/);
  assert.match(result.html,/Arrange/);assert.match(result.html,/Plan first/);
  assert.equal(result.calls,0);assert.equal(result.unchanged,true);assert.deepEqual(result.draft,{text:'',attachments:[]});
});

test('established accounts and ordinary Today navigation retain their normal composer and dashboard',()=>{
  for(const input of [{established:true},{entry:false},{nonempty:true}]){
    const {html,calls}=render(input);assert.doesNotMatch(html,/What would you like to get done|Choose an example to edit before sending/);
    assert.match(html,/id="home-spaces"|id="home-made"|id="home-projects"/);assert.equal(calls,0);
  }
});

test('cached failed, unknown and stale readings never qualify as empty first use',()=>{
  for(const name of ['settings/home','home-layout','command-center','needs-you-summary','working-now-badge','delegated-tasks/open','spaces','delivered','home-today','home-from-clem','watches']){
    for(const condition of ['failed','missing','stale'] as const){
      const {html,calls}=render({[condition]:name});
      assert.doesNotMatch(html,/What would you like to get done|Choose an example to edit before sending/,condition+': '+name);
      assert.equal(calls,0);
    }
  }
});

test('first-use guidance preserves authored drafts and keeps editable examples out of their way',()=>{
  const {html,draft,calls,unchanged}=render({text:'Automate my weekly invoice follow-up'});
  assert.match(html,/Automate my weekly invoice follow-up/);assert.match(html,/What would you like to get done/);
  assert.doesNotMatch(html,/Examples to edit|Choose an example to edit before sending/);
  assert.equal(draft.text,'Automate my weekly invoice follow-up');assert.equal(unchanged,true);assert.equal(calls,0);
});
