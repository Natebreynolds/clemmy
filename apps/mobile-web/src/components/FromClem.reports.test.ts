import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as engine from '@clem/chat-engine';
import type { FromClem as FromClemData } from '../lib/api';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join(' ');
  return tree && typeof tree === 'object' && tree.props ? text(tree.props.children) : String(tree ?? '');
}
function render(data: FromClemData, maxRows = 3) {
  const frames: Array<() => void> = [];
  const refs: Array<{current:any}> = [];
  const calls: { replies: unknown[][]; presentations: unknown[][] } = { replies: [], presentations: [] };
  const dependencies: Record<string, unknown> = {
    './attention-report-groups.css': {},
    'preact/hooks': { useState: (value: unknown) => [typeof value === 'function' ? (value as () => unknown)() : value, () => {}], useRef: (current: unknown) => { const ref={current}; refs.push(ref); return ref; }, useEffect: () => {} },
    'preact/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
    '@clem/chat-engine': engine,
    '../lib/api': {
      replyFromClem: async (...args: unknown[]) => { calls.replies.push(args); return { outcome: 'started', sessionId: 'controlled-thread', runId: 'controlled-run' }; },
      presentInboxAttention: async (...args: unknown[]) => { calls.presentations.push(args); return { generation: args[2], mutationToken: 'exact-receipt' }; },
      markInboxNotificationRead: () => assert.fail('Grouping must not acknowledge a source report'),
      presentInboxQuestion: () => assert.fail('Generic grouping must not answer or set aside a question'),
    },
    '../lib/attention-presentation': {}, './Approvals': { relativeTime: () => 'now' }, '../lib/native-bridge': { haptic() {} },
    '../lib/card-records': { cardRecordInMotion: () => false, getCardRecords: async () => ({ replies: [] }) }, './CardRecord': { CardRecord: () => null },
  };
  const code = ts.transpileModule(readFileSync(new URL('./FromClem.tsx', import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'preact',
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, window:{requestAnimationFrame:(read:()=>void)=>frames.push(read)}, require(name: string) {
    assert.ok(name in dependencies, `Unexpected component dependency: ${name}`); return dependencies[name];
  } });
  const tree = exports.FromClem({ data, mode: 'decisions', maxRows, onChanged() {}, onOpenThread() {} });
  return { tree, calls, frames, refs };
}

function fixture(): FromClemData {
  const lifecycle = { canDismiss: true, canDefer: true, effect: 'hide_only' as const, dismissLabel: 'Dismiss', deferLabel: 'Tomorrow', generation: 'a'.repeat(64) };
  const base = { attentionKey: 'flow:controlled-review', lifecycle, heartbeat: 'work-review', heartbeatTitle: 'Work review', at: '2026-10-29T00:00:00Z', asks: true };
  return { rows: [
    { ...base, key: 'credit', text: 'Needs credit', detail: 'Add credit first', voiceDigest: 'credit-version', choices: ['Review exact account'], relatedNotificationIds: ['credit-new', 'credit-old'] },
    { ...base, key: 'permission', text: 'Permission refused', detail: 'Choose the exact source', voiceDigest: 'permission-version', choices: ['Review exact source'], relatedNotificationIds: ['permission'] },
    { ...base, key: 'other', attentionKey: 'flow:other-work', text: 'Other work remains visible', voiceDigest: 'other-version' },
  ], pulses: [], covers: { questionIds: [], notificationIds: [], planProposalIds: [] } };
}

test('phone limits work parents, retains every report and keeps exact child choices', async () => {
  const { tree, calls } = render(fixture(), 2);
  const all = nodes(tree);
  const parent = all.find(node => node.type === 'details' && node.props['data-attention-group'] === 'flow:controlled-review')!;
  assert.ok(parent);
  assert.match(text(parent).replace(/\s+/g,' '), /3 reports/);
  assert.match(text(parent), /Add credit first/);
  assert.match(text(parent), /Choose the exact source/);
  assert.match(text(parent), /Reported 2 times/);
  assert.match(text(tree), /Other work remains visible/);
  const parentActions = nodes(parent).find(node => node.props.class === 'attention-work-actions')!;
  assert.deepEqual(nodes(parentActions).filter(node => node.type === 'button').map(node => text(node)), ['Later', 'Dismiss']);
  const choice = all.find(node => node.type === 'button' && text(node) === 'Review exact source')!;
  choice.props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(calls.replies, [['permission', 'Review exact source', 'permission-version', undefined, 0]]);
  assert.deepEqual(calls.presentations, []);
});

test('parent Later submits one exact hide-only preference without touching reports or choices', async () => {
  const { tree, calls, frames, refs } = render(fixture());
  assert.equal(frames.length,0,'ordinary rendering and refreshed data never steal focus');
  const parentActions = nodes(tree).find(node => node.props.class === 'attention-work-actions')!;
  nodes(parentActions).find(node => node.type === 'button' && text(node) === 'Later')!.props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(calls.presentations, [['flow:controlled-review', 'defer', 'a'.repeat(64)]]);
  assert.deepEqual(calls.replies, []);
  const effects:string[]=[];
  refs.find(ref=>ref.current===null)!.current={scrollIntoView(){effects.push('scroll');},focus(input:{preventScroll:boolean}){assert.equal(input.preventScroll,true);effects.push('focus');}};
  assert.equal(frames.length,1);
  frames.shift()!(); frames.shift()!();
  assert.deepEqual(effects,['scroll','focus'],'the explicit action brings Undo into view after the group collapses');
});
