import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { DelegatedTask } from '@clem/chat-engine';

const temporary=mkdtempSync(path.join(os.tmpdir(),'clem-task-card-render-'));
test.after(()=>rmSync(temporary,{recursive:true,force:true}));
const root=fileURLToPath(new URL('../../../',import.meta.url));
const built=await build({stdin:{contents:`
  import {renderToStaticMarkup} from 'react-dom/server';
  import {MemoryRouter} from 'react-router-dom';
  import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
  import {DelegatedTaskCard} from './src/components/projects/DelegatedTaskCard';
  export function render(task) {
    const client=new QueryClient();
    const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Rendering must not request or approve')};
    try {return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}><DelegatedTaskCard task={task}/></QueryClientProvider></MemoryRouter>)}
    finally {globalThis.fetch=original;client.clear()}
  }`,resolveDir:root,loader:'tsx'},tsconfig:path.join(root,'tsconfig.json'),bundle:true,write:false,
  platform:'node',format:'cjs',jsx:'automatic',target:'node22',logLevel:'silent',loader:{'.png':'dataurl','.css':'empty'},
  plugins:[{name:'rendered-url-assets',setup(bundle){
    bundle.onResolve({filter:/\?url$/},args=>({path:args.path,namespace:'url-import'}));
    bundle.onLoad({filter:/.*/,namespace:'url-import'},args=>({contents:`export default ${JSON.stringify(args.path)};`,loader:'js'}));
  }}],
  define:{'import.meta.env.DEV':'false','import.meta.env.VITE_CLEM_TOKEN':'""'}});
const file=path.join(temporary,'fixture.cjs');writeFileSync(file,built.outputFiles[0].contents);
const {render}=createRequire(import.meta.url)(file) as {render:(task:DelegatedTask)=>string};
function task(patch:Partial<DelegatedTask>={}):DelegatedTask {return {
  taskId:'controlled-task',title:'Controlled delegated task',status:'pending',phase:'needs_you',
  owner:{agentId:'controlled-agent',agentName:'Controlled agent',chosenBy:'owner'},project:null,
  requestVersion:1,revisions:[],correctionPending:false,artifactDestination:null,question:null,
  approvalId:'controlled / approval',resultPreview:null,resultPath:null,error:null,originSessionId:'controlled-chat',
  runSessionId:'background:controlled-task',followsTaskId:null,createdAt:'2026-10-29T12:00:00Z',startedAt:null,
  completedAt:null,updatedAt:'2026-10-29T12:00:00Z',controls:{canSteer:false,canStop:false,canResume:false,canAnswer:false},...patch,
};}

test('an approval task offers one Review link to the canonical approval instead of duplicate waiting paragraphs',()=>{
  const html=render(task());
  const links=[...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)];
  const reviews=links.filter(([,href])=>href.includes('/inbox?tab=needs'));
  assert.equal(reviews.length,1,'the same approval must not produce Review and Review it actions');
  assert.equal(reviews[0][1],'/inbox?tab=needs&amp;select=approval%3Acontrolled%20%2F%20approval');
  assert.equal(reviews[0][2],'Review');
  assert.match(html,/Controlled agent is waiting for your approval before going on/);
  assert.doesNotMatch(html,/Waiting on your approval before it goes on|>Review it</);
});

test('a missing approval never fabricates an approval route or a stale waiting instruction',()=>{
  const html=render(task({approvalId:null}));
  assert.doesNotMatch(html,/\/inbox\?tab=needs|waiting for your approval|>Review</);
  assert.match(html,/Open the full run of Controlled delegated task/);
});
