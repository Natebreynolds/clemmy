import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserbaseCdpClient, BrowserbaseCdpError, parseBrowserbaseOperation, type BrowserbaseSocket } from './browserbase-cdp.js';
const sessionId='20000000-0000-4000-8000-000000000002', endpoint=`wss://connect.browserbase.com/?sessionId=${sessionId}&apiKey=private-key`;
class Socket implements BrowserbaseSocket {
  readyState=1; readonly calls: Array<Record<string,any>>=[];
  readonly listeners=new Map<string, Set<(event:any)=>void>>();
  constructor(private readonly reply: (call: Record<string,any>) => Record<string,unknown>|'close'|null) {}
  addEventListener(type:string,listener:(event:any)=>void) { const list=this.listeners.get(type)??new Set();list.add(listener);this.listeners.set(type,list); }
  removeEventListener(type:string,listener:(event:any)=>void) { this.listeners.get(type)?.delete(listener); }
  send(text:string) {const call=JSON.parse(text);this.calls.push(call);const value=this.reply(call);queueMicrotask(()=>{if(value==='close')this.close();else if(value!==null)this.emit('message',{data:JSON.stringify({id:call.id,result:value})});});}
  emit(type:string,event:unknown={}) {for(const listener of this.listeners.get(type)??[])listener(event);}
  close() {this.readyState=3;this.emit('close');}
}
function fixture(overrides?: (call:Record<string,any>)=>Record<string,unknown>|'close'|null|undefined) {
  let url='https://example.com/private?access_token=private-page-token#fragment';
  const info=()=>({targetId:'exact-page',type:'page',url,title:'Working page'});
  const socket=new Socket(call=> {
    const override=overrides?.(call);if(override!==undefined)return override;
    switch(call.method){
      case 'Target.getTargets':return{targetInfos:[info()]};
      case 'Target.getTargetInfo':return{targetInfo:info()};
      case 'Target.createTarget':return{targetId:'exact-page'};
      case 'Target.attachToTarget':return{sessionId:'explicit-page-session'};
      case 'Runtime.evaluate':return{result:{value:call.params.expression==='document.readyState'?'complete':JSON.stringify({url,title:'Working page',text:'Observed body',truncated:false})}};
      case 'Page.navigate':url=call.params.url;return{loaderId:'new-loader'};
      case 'Page.getFrameTree':return{frameTree:{frame:{url,loaderId:'new-loader'}}};
      case 'DOM.getDocument':return{root:{nodeId:10}};
      case 'DOM.querySelector':return{nodeId:11};
      case 'DOM.resolveNode':return{object:{objectId:'element-object'}};
      case 'DOM.getBoxModel':return{model:{content:[0,0,10,0,10,10,0,10]}};
      case 'Runtime.callFunctionOn':return{result:{value:true}};
      default:return{};
    }
  });
  const client=new BrowserbaseCdpClient({socketFactory:actual=>{assert.equal(actual,endpoint);return socket;},timeoutMs:1000});
  return{client,socket,setUrl:(value:string)=>{url=value;}};
}
test('strict normalized URLs and argument shapes fail before connection',async()=>{
  assert.throws(()=>parseBrowserbaseOperation('navigate',{targetId:'x',url:'https://user:secret@example.com/'}),/invalid_arguments/);
  assert.throws(()=>parseBrowserbaseOperation('navigate',{targetId:'x',url:'https://example.com/'+ '猫'.repeat(1000)}),/invalid_arguments/);
  assert.throws(()=>parseBrowserbaseOperation('read',{targetId:'x',code:'arbitrary JS'}),/invalid_arguments/);
  const t=fixture();await assert.rejects(t.client.execute('wss://elsewhere.example/?sessionId='+sessionId,sessionId,'tabs',{}),/connection_identity_changed/);assert.equal(t.socket.calls.length,0);
});
test('tabs and read observe the exact session target without mutations and remove secret URL query',async()=>{
  const tabs=fixture();const listed=await tabs.client.execute(endpoint,sessionId,'tabs',{});assert.equal(listed.effect,'none');assert.equal(listed.pages?.[0]?.url,'https://example.com/private');
  const read=fixture();const observed=await read.client.execute(endpoint,sessionId,'read',{targetId:'exact-page',maxChars:100});assert.equal(observed.result.text,'Observed body');assert.equal(observed.targetId,'exact-page');assert.doesNotMatch(JSON.stringify(observed),/private-page-token|private-key|access_token/);
  const body=read.socket.calls.find(call=>call.method==='Runtime.evaluate')!;assert.equal(body.sessionId,'explicit-page-session');assert.equal(read.socket.calls.find(call=>call.method==='Target.attachToTarget')?.params.targetId,'exact-page');
});
test('navigation reserves durable boundary before dispatch and proves the exact new loader',async()=>{
  const t=fixture();let reserved=false;
  const result=await t.client.execute(endpoint,sessionId,'navigate',{targetId:'exact-page',url:'https://example.com/new'},{beforeMutation:async()=>{assert.equal(t.socket.calls.some(call=>call.method==='Page.navigate'),false);reserved=true;}});
  assert.equal(reserved,true);assert.equal(result.effect,'confirmed');assert.equal(result.result.url,'https://example.com/new');
  assert.equal(t.socket.calls.find(call=>call.method==='Page.navigate')?.sessionId,'explicit-page-session');
});
test('a blank tab is confirmed only after exact created target readback',async()=>{
  const t=fixture();t.setUrl('about:blank');let boundary=false;
  const opened=await t.client.execute(endpoint,sessionId,'open',{}, {beforeMutation:async()=>{boundary=true;}});
  assert.equal(boundary,true);assert.equal(opened.targetId,'exact-page');assert.equal(opened.result.url,'about:blank');assert.equal(opened.effect,'confirmed');
  assert.deepEqual(t.socket.calls.find(call=>call.method==='Target.createTarget')?.params,{url:'about:blank'});
});
test('lost mutation acknowledgment is uncertain; abort before connection is known no effect; neither retries',async()=>{
  const lost=fixture(call=>call.method==='Page.navigate'?'close':undefined);
  await assert.rejects(lost.client.execute(endpoint,sessionId,'navigate',{targetId:'exact-page',url:'https://example.com/'},{beforeMutation:async()=>{}}),error=>error instanceof BrowserbaseCdpError&&error.effect==='uncertain');
  assert.equal(lost.socket.calls.filter(call=>call.method==='Page.navigate').length,1);
  const before=fixture();const controller=new AbortController();controller.abort();await assert.rejects(before.client.execute(endpoint,sessionId,'open',{}, {signal:controller.signal}),error=>error instanceof BrowserbaseCdpError&&error.effect==='none');assert.equal(before.socket.calls.length,0);
});
test('click/fill/key are fixed exact-target CDP; mobile text uses insertText, never caller JS',async()=>{
  for(const operation of ['click','fill','key'] as const){
    const t=fixture();const args=operation==='key'?{targetId:'exact-page',key:'Enter'}:{targetId:'exact-page',selector:'input[name="q"]',...(operation==='fill'?{text:'quotes " and script-looking text; do not execute'}:{})};
    const result=await t.client.execute(endpoint,sessionId,operation,args);assert.equal(result.effect,'confirmed');assert.equal(result.result.ok,true);
    for(const call of t.socket.calls.filter(call=>/^(DOM|Runtime|Input)\./.test(call.method)))assert.equal(call.sessionId,'explicit-page-session');
    if(operation==='fill'){const fill=t.socket.calls.find(call=>call.method==='Runtime.callFunctionOn')!;assert.equal(fill.params.arguments[0].value,args.text);assert.doesNotMatch(fill.params.functionDeclaration,/script-looking/);}
  }
  const text=fixture();await text.client.humanText(endpoint,sessionId,'exact-page','hello');assert.deepEqual(text.socket.calls.find(call=>call.method==='Input.insertText')?.params,{text:'hello'});
});
test('different target observation cannot attach or mutate a replacement page',async()=>{
  const t=fixture(call=>call.method==='Target.getTargetInfo'?{targetInfo:{targetId:'replacement-page',type:'page',url:'https://example.com/',title:'Same title'}}:undefined);
  await assert.rejects(t.client.execute(endpoint,sessionId,'navigate',{targetId:'exact-page',url:'https://example.com/'}),error=>error instanceof BrowserbaseCdpError&&error.effect==='none');
  assert.equal(t.socket.calls.some(call=>call.method==='Target.attachToTarget'||call.method==='Page.navigate'),false);
});
test('malformed CDP result arrays cannot turn a dispatched input into a successful receipt',async()=>{
  const t=fixture(call=>call.method==='Input.insertText'?[]:undefined);
  await assert.rejects(t.client.humanText(endpoint,sessionId,'exact-page','hello'),error=>error instanceof BrowserbaseCdpError&&error.effect==='uncertain');
  assert.equal(t.socket.calls.filter(call=>call.method==='Input.insertText').length,1);
  const before=fixture(call=>call.method==='Target.getTargets'?[]:undefined);
  await assert.rejects(before.client.execute(endpoint,sessionId,'tabs',{}),error=>error instanceof BrowserbaseCdpError&&error.effect==='none');
});
