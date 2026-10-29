import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as engine from '@clem/chat-engine';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' && tree.props ? [tree,...nodes(tree.props.children)] : [];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return tree && typeof tree === 'object' && tree.props ? text(tree.props.children) : String(tree ?? '');
}
const reports = [
  {id:'credit-new',title:'Review the model account',body:'FULL CREDIT BODY stays in the selected detail',createdAt:'2026-10-29T00:02:00Z'},
  {id:'credit-old',title:'Review the model account',body:'FULL CREDIT BODY stays in the selected detail',createdAt:'2026-10-29T00:01:00Z'},
  {id:'permission',title:'Review computer access',body:'FULL PERMISSION BODY stays in the selected detail',createdAt:'2026-10-29T00:00:00Z'},
];

for (const [surface,file,jsxImportSource] of [
  ['desktop','./AttentionReportSelector.tsx','react'],
  ['phone','../../../../../apps/mobile-web/src/components/AttentionReportSelector.tsx','preact'],
] as const) {
  const exports: Record<string, any> = {};
  const dependencies: Record<string,unknown> = {
    '@clem/chat-engine':engine,
    'react/jsx-runtime':{jsx:element,jsxs:element},'preact/jsx-runtime':{jsx:element,jsxs:element},
    '../../lib/inbox':{relativeTime:()=> '2 minutes ago'},'./Approvals':{relativeTime:()=> '2 minutes ago'},
    './attention-report-groups.css':{},
  };
  const code=ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{
    module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,jsxImportSource,
  }}).outputText;
  runInNewContext(code,{exports,require(name:string){assert.ok(name in dependencies,`Unexpected chooser dependency: ${name}`);return dependencies[name];}});

  test(`${surface} chooser starts collapsed, retains all IDs and shows titles/times with the exact selected child`,()=>{
    const selected:string[]=[];
    const tree=exports.AttentionReportSelector({reports,attentionKey:'flow:controlled',selectedId:'permission',onSelect:(id:string)=>selected.push(id)});
    assert.equal(tree.type,'details');
    assert.equal(tree.props.open,undefined);
    assert.match(text(tree).replace(/\s+/g,' '),/3 reports/);
    assert.doesNotMatch(text(tree),/FULL CREDIT BODY|FULL PERMISSION BODY/);
    const buttons=nodes(tree).filter(node=>node.type==='button');
    assert.equal(buttons.length,3,'summary compaction never removes a report choice');
    assert.match(text(buttons[2]),/Review computer access/);
    assert.match(text(buttons[2]),/Selected/);
    assert.match(text(buttons[2]),/2 minutes ago/);
    assert.equal(buttons[2].props['aria-current'],'true');
    buttons[1].props.onClick();
    assert.deepEqual(selected,['credit-old'],'an older equivalent report retains its exact identity');
  });

  test(`${surface} chooser uses the body only when the report has no title`,()=>{
    const tree=exports.AttentionReportSelector({reports:[{...reports[0],title:'',body:'Untitled report fallback'}],selectedId:'credit-new',onSelect(){}});
    assert.match(text(tree),/Untitled report fallback/);
  });
}
