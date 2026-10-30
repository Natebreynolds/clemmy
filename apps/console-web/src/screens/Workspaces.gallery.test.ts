import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { filterWorkspaceGallery } from '../lib/workspace-gallery';
import { PendingCommit } from '../lib/pending-commit';
import type { SpaceRecord } from '../lib/spaces';

const temporary=mkdtempSync(path.join(os.tmpdir(),'clem-spaces-gallery-'));
test.after(()=>rmSync(temporary,{recursive:true,force:true}));
const root=fileURLToPath(new URL('../../',import.meta.url));
const runtime=createRequire(path.join(root,'package.json')).resolve('react/jsx-runtime');
const built=await build({stdin:{contents:`
  import {renderToStaticMarkup} from 'react-dom/server';
  import {MemoryRouter} from 'react-router-dom';
  import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
  import {Workspaces,WorkspaceCard} from './src/screens/Workspaces';
  import {CreateWorkspaceModal} from './src/components/workspaces/CreateWorkspaceModal';
  import {nodes} from 'controlled-jsx';
  export function render({items,error=false,query='',card=false,previews=false}) {
    const client=new QueryClient({defaultOptions:{queries:{retryOnMount:false}}});
    if(items!==undefined || error){client.setQueryData(['spaces'],items??null);if(error)client.getQueryCache().find({queryKey:['spaces'],exact:true}).setState({status:'error',error:new Error('Controlled offline')});}
    client.setQueryData(['working-now-spaces'],{entries:[]});
    const fetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Rendering must not fetch or mutate Spaces');};
    try{return renderToStaticMarkup(<MemoryRouter initialEntries={['/workspaces'+(query?'?q='+encodeURIComponent(query):'')]}><QueryClientProvider client={client}>{card?<WorkspaceCard space={items[0]} previews={previews} onOpen={()=>{throw new Error('Render must not navigate')}}/>:<Workspaces/>}</QueryClientProvider></MemoryRouter>);}
    finally{globalThis.fetch=fetch;client.clear();}
  }
  export async function dialog({refuse=false,blank=false}={}) {
    nodes.length=0;
    let closed=0,nativeClosed=0,prevented=0;
    const created=[];
    const html=renderToStaticMarkup(<CreateWorkspaceModal open initialDescription="Exact authored objective" onClose={()=>closed++} onCreated={(...args)=>created.push(args)}/>);
    const dialog=nodes.find(node=>node.type==='dialog').props;
    const form=nodes.find(node=>node.type==='form').props;
    const native={close:()=>nativeClosed++};dialog.ref.current=native;
    let finish;
    const calls=[];
    const previous=globalThis.fetch;
    globalThis.fetch=(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Promise(resolve=>{finish=resolve;});};
    const event={preventDefault:()=>prevented++};
    const fire=()=>blank?nodes.find(node=>node.type==='button' && node.props.children==='Start blank instead').props.onClick():form.onSubmit(event);
    try{
      fire();fire();
      dialog.onCancel(event);dialog.onClick({target:native});
      const pending={calls:calls.length,closed,nativeClosed,prevented};
      finish(new Response(JSON.stringify(refuse?{error:'Controlled refusal'}:{space:{id:'exact-created-space'}}),{status:refuse?409:200}));
      await new Promise(resolve=>setImmediate(resolve));
      if(refuse){dialog.onCancel(event);dialog.onClick({target:native});}
      return {html,calls,pending,created,closed,nativeClosed};
    }finally{globalThis.fetch=previous;}
  }
`,resolveDir:root,loader:'tsx'},tsconfig:path.join(root,'tsconfig.json'),bundle:true,write:false,
  platform:'node',format:'cjs',jsx:'automatic',target:'node22',logLevel:'silent',loader:{'.css':'empty','.png':'dataurl'},
  define:{'import.meta.env.DEV':'false','import.meta.env.VITE_CLEM_TOKEN':'""'},
  plugins:[{name:'capture-actual-dialog-events',setup(builder){
    builder.onResolve({filter:/^(react\/jsx-runtime|controlled-jsx)$/},()=>({path:'captured-jsx',namespace:'controlled-jsx'}));
    builder.onLoad({filter:/.*/,namespace:'controlled-jsx'},()=>({contents:`import * as runtime from ${JSON.stringify(runtime)};export const nodes=[];export const Fragment=runtime.Fragment;export function jsx(type,props,key){if(type==='dialog'||type==='form'||type==='button')nodes.push({type,props});return runtime.jsx(type,props,key)}export const jsxs=jsx;`,loader:'js',resolveDir:root}));
  }}]});
const file=path.join(temporary,'fixture.cjs');writeFileSync(file,built.outputFiles[0].contents);
const {render,dialog}=createRequire(import.meta.url)(file) as {
  render:(input:{items?:SpaceRecord[];error?:boolean;query?:string;card?:boolean;previews?:boolean})=>string;
  dialog:(input?:{refuse?:boolean;blank?:boolean})=>Promise<{html:string;calls:Array<{url:string;body:Record<string,unknown>}>;pending:{calls:number;closed:number;nativeClosed:number;prevented:number};created:unknown[][];closed:number;nativeClosed:number}>;
};
const space=(id:string,title:string,objective:string):SpaceRecord=>({id,title,status:'paused',contract:{objective,successCriteria:[],invariants:[]},dataSources:[{id:'daily',schedule:'0 9 * * *'}],actions:[],viewEntry:'view.html',version:1,revisions:[],createdAt:'2026-10-30T00:00:00Z',updatedAt:'2026-10-30T00:00:00Z',health:{id,title,status:'paused',version:1,generatedAt:'2026-10-30T00:00:00Z',counts:{dataSources:2,actions:3,revisions:1,runners:0},view:{entry:'view.html',exists:true,bytes:42},runners:[],freshness:{state:'fresh',staleAfterMs:1000},issues:[]}} as SpaceRecord);
const items=[space('first-space','Research','Review client evidence'),space('older / ?&','Operations','Track delayed invoices')];

test('search uses all loaded titles, full objectives and IDs without mutating collection order',()=>{
  const before=JSON.stringify(items);
  assert.deepEqual(filterWorkspaceGallery(items,'DELAYED operations'),[items[1]]);
  assert.deepEqual(filterWorkspaceGallery(items,'older / ?&'),[items[1]]);
  assert.deepEqual(filterWorkspaceGallery(items,'  '),items);
  assert.deepEqual(filterWorkspaceGallery(items,'absent'),[]);
  assert.equal(JSON.stringify(items),before);
});

test('the default gallery keeps metadata and exact Open Space links while mounting no live frames',()=>{
  const html=render({items});
  assert.doesNotMatch(html,/<iframe/);assert.match(html,/Live previews/);assert.doesNotMatch(html,/<input[^>]*type="checkbox"[^>]*checked/);
  for(const text of ['Research','Operations','Track delayed invoices','Up to date','paused','2 sources','3 actions'])assert.ok(html.includes(text),text);
  assert.match(html,/href="\/workspaces\/older%20%2F%20%3F%26"/);
  assert.match(html,/2 Spaces/);
  assert.doesNotMatch(html,/About Spaces|No Spaces yet/);
});

test('opting into near-viewport previews retains the existing sandboxed, read-only frame',()=>{
  const html=render({items:[items[0]],card:true,previews:true});
  assert.match(html,/<iframe/);assert.match(html,/title="Research preview"/);assert.match(html,/tabindex="-1"/);assert.match(html,/aria-hidden="true"/);assert.match(html,/sandbox="/);
  assert.doesNotMatch(render({items:[items[0]],card:true,previews:false}),/<iframe/);
});

test('search counts, clear recovery and no-match copy distinguish filtering from a genuinely empty collection',()=>{
  const match=render({items,query:'delayed'});
  assert.match(match,/1 of 2 Spaces/);assert.match(match,/Clear search/);assert.match(match,/Operations/);assert.doesNotMatch(match,/>Research</);
  const missing=render({items,query:'absent'});
  assert.match(missing,/0 of 2 Spaces/);assert.match(missing,/No Spaces match your search/);assert.match(missing,/every loaded Space/);assert.doesNotMatch(missing,/About Spaces|No Spaces yet/);
  const empty=render({items:[]});
  assert.equal((empty.match(/aria-label="About Spaces"/g)??[]).length,1);
  assert.doesNotMatch(empty,/No Spaces yet|No Spaces match/);
});

test('cached collection failures retain searchable Spaces with Retry while an unread first load never claims empty',()=>{
  const stale=render({items,error:true,query:'invoices'});
  assert.match(stale,/Showing the last loaded collection/);assert.match(stale,/Retry/);assert.match(stale,/Operations/);assert.match(stale,/1 of 2 Spaces/);
  const unread=render({error:true});
  assert.match(unread,/Spaces are unavailable/);assert.doesNotMatch(unread,/About Spaces|No Spaces yet|No Spaces match/);
});

test('native dialog events cannot close a pending creation or admit duplicate submissions',async()=>{
  const result=await dialog();
  assert.match(result.html,/<dialog[^>]*aria-label="New Space"/);assert.match(result.html,/<form/);assert.match(result.html,/<button[^>]*type="submit"/);
  assert.deepEqual(result.pending,{calls:1,closed:0,nativeClosed:0,prevented:3});
  assert.equal(result.calls[0].url,'/api/console/spaces');assert.equal(result.calls[0].body.objective,'Exact authored objective');
  assert.deepEqual(result.created,[['exact-created-space','Exact authored objective']]);assert.equal(result.nativeClosed,1);
});

test('a refused creation releases dialog close without losing blank-mode intent',async()=>{
  const refused=await dialog({refuse:true});
  assert.equal(refused.pending.closed,0);assert.equal(refused.created.length,0);assert.equal(refused.closed,2);assert.equal(refused.nativeClosed,2);
  const blank=await dialog({blank:true});
  assert.deepEqual(blank.calls[0].body,{title:'New workspace'});assert.deepEqual(blank.created,[['exact-created-space',undefined]]);
});

test('a replaced dialog owner cannot claim a late creation or unlock the replacement request',()=>{
  const commit=new PendingCommit('open');const old=commit.begin()!;
  commit.setScope('closed');commit.setScope('open');const replacement=commit.begin()!;
  assert.equal(commit.owns(old),false);assert.equal(commit.finish(old),false);assert.equal(commit.owns(replacement),true);
});
