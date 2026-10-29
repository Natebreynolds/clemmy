import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attentionItemContext, sameAttentionPresentation } from './attention-presentation';

test('generic recovery uses the server store and exact generation and receipt, without answer or acknowledgement calls', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-attention-client-'));
  const originalFetch = globalThis.fetch;
  const calls: Array<{url:string;body?:Record<string,string>}> = [];
  try {
    const root = fileURLToPath(new URL('../../',import.meta.url));
    const built = await build({stdin:{contents:`export {listAttentionPresentations,presentAttentionItem} from './src/lib/attention-presentation'`,loader:'ts',resolveDir:root},
      tsconfig:path.join(root,'tsconfig.json'),bundle:true,write:false,platform:'node',format:'cjs',target:'node22',logLevel:'silent',
      define:{'import.meta.env.DEV':'false','import.meta.env.VITE_CLEM_TOKEN':'""'}});
    const file = path.join(temporary,'client.cjs');writeFileSync(file,built.outputFiles[0].contents);
    const client = createRequire(import.meta.url)(file) as typeof import('./attention-presentation');
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({url:String(url),...(body?{body}:{})});
      return new Response(JSON.stringify(body ? {ok:true,...body,mutationToken:body.mutationToken || 'issued-receipt'} : {items:[{key:'calendar:one'}],count:1}),{status:200});
    }) as typeof fetch;
    assert.equal((await client.listAttentionPresentations()).count,1);
    const receipt = await client.presentAttentionItem('calendar:one','dismiss','rendered-generation');
    await client.presentAttentionItem(receipt.key,'restore',receipt.generation,receipt.mutationToken);
    assert.deepEqual(calls,[
      {url:'/api/console/inbox/attention/presentation'},
      {url:'/api/console/inbox/attention/presentation',body:{key:'calendar:one',action:'dismiss',generation:'rendered-generation'}},
      {url:'/api/console/inbox/attention/presentation',body:{key:'calendar:one',action:'restore',generation:'rendered-generation',mutationToken:'issued-receipt'}},
    ]);
    await assert.rejects(client.presentAttentionItem('calendar:one','dismiss',''),/Refresh/);
    await assert.rejects(client.presentAttentionItem('calendar:one','restore','rendered-generation'),/Refresh/);
    assert.equal(calls.length,3,'missing fences fail before a request');
    globalThis.fetch = (async () => new Response(JSON.stringify({ok:true,key:'other',action:'dismiss',generation:'rendered-generation',mutationToken:'token'}),{status:200})) as typeof fetch;
    await assert.rejects(client.presentAttentionItem('calendar:one','dismiss','rendered-generation'),/could not be confirmed/);
  } finally {globalThis.fetch=originalFetch;rmSync(temporary,{recursive:true,force:true});}
});

test('generic receipt identity fences older restores and context links require recorded navigation', () => {
  const receipt = {key:'calendar:one',generation:'one',mutationToken:'one'};
  assert.equal(sameAttentionPresentation(receipt,{...receipt}),true);
  assert.equal(sameAttentionPresentation(receipt,{...receipt,generation:'two'}),false);
  assert.equal(sameAttentionPresentation(receipt,{...receipt,mutationToken:'two'}),false);
  assert.equal(sameAttentionPresentation(receipt,{...receipt,key:'notification:one'}),false);
  assert.equal(attentionItemContext({key:'calendar:one',notificationId:'one'}),null,'a hidden request cannot link back to an absent live row');
  assert.deepEqual(attentionItemContext({key:'session:one',sessionId:'one / two'}),{href:'/chat/harness%3Aone%20%2F%20two',label:'Open conversation'});
});
