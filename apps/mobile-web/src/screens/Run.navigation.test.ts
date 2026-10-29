import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as engine from '@clem/chat-engine';
import type { DelegatedTask } from '@clem/chat-engine';
import type { RunDetail } from '../lib/api';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [];
}
function moduleAt(file: string, dependencies: Record<string, any>) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, jsxImportSource: 'preact',
  } }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, require(name: string) {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  } });
  return exports;
}
const hooks = { useState: (value: any) => [value, () => {}], useRef: (value: any) => ({ current: value }),
  useEffect() {}, useMemo: (read: () => any) => read() };
function task(phase: DelegatedTask['phase'] = 'needs_you'): DelegatedTask {
  return { taskId: 'exact-task', title: 'Prepare a report', status: 'running', phase,
    owner: { agentId: 'exact-agent', agentName: 'Researcher', chosenBy: 'owner' }, project: { id: 'exact-project', name: 'Research' },
    requestVersion: 1, revisions: [], correctionPending: false, artifactDestination: null, question: null,
    approvalId: 'opaque:approval/7', resultPreview: null, resultPath: null, error: null,
    originSessionId: 'owner-conversation', runSessionId: 'background:exact-task', followsTaskId: null,
    createdAt: '2026-10-29T00:00:00Z', startedAt: '2026-10-29T00:00:00Z', completedAt: null,
    updatedAt: '2026-10-29T00:01:00Z', controls: { canSteer: false, canStop: true, canResume: false, canAnswer: false } };
}
function runDetail(delegatedTask?: DelegatedTask): RunDetail {
  return { id: 'background:exact-task', title: 'Report', status: 'running', kind: 'agent',
    createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:01:00Z', startedAt: null, lastEventAt: null,
    events: [], receipts: [], deliverables: [], delegatedTask };
}
function renderRun(run: RunDetail, onOpenNeedsYou: (key?: string) => void) {
  const dependencies: Record<string, any> = {
    'preact/hooks': hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element }, '@clem/chat-engine': engine,
    '../lib/api': { runDetailPath: (id: string) => `/m/api/runs/${encodeURIComponent(id)}` },
    '../lib/mobile-navigation': { useMobileDetailHeader() {} },
    '../lib/last-good': { lastGoodAt: () => null, lastGoodNotice: () => null },
    '../lib/run-liveness': { runIsLive: () => false, runCanBeControlled: () => false, runElapsedLabel: () => null },
    '../lib/run-rows': { runStateLabel: () => 'Running' },
    '../lib/use-screen-data': { useScreenData: () => ({ data: run, refresh() {} }) },
  };
  for (const name of ['DelegatedTaskCard', 'TaskResultFiles', 'ChatBackButton', 'RunControl', 'ScreenNotice']) dependencies[`../components/${name}`] = { [name]: name };
  return moduleAt('./Run.tsx', dependencies).Run({ sessionId: 'addressed-run', onBack() {}, onOpenNeedsYou });
}
function renderCard(given: DelegatedTask, onOpenNeedsYou: (key?: string) => void) {
  return moduleAt('../components/DelegatedTaskCard.tsx', {
    'preact/hooks': hooks, 'preact/jsx-runtime': { jsx: element, jsxs: element }, '@clem/chat-engine': engine,
    '../lib/project-api': {}, '../lib/project-words': {}, '../lib/native-bridge': { haptic() {} },
    './Approvals': { relativeTime: () => 'now' }, './RunControl': { RunControl: 'RunControl' },
    './TaskResultFiles': { TaskResultFiles: 'TaskResultFiles' },
  }).DelegatedTaskCard({ task: given, onChanged() {}, onOpenNeedsYou });
}

test('mobile run forwards Review to the exact approval belonging to its delegated task', () => {
  const opened: Array<string | undefined> = [];
  const callback = (key?: string) => opened.push(key);
  const runCard = nodes(renderRun(runDetail(task()), callback)).find(node => node.type === 'DelegatedTaskCard')!;
  assert.equal(runCard.props.onOpenNeedsYou, callback);
  const reviewButtons = nodes(renderCard(runCard.props.task, runCard.props.onOpenNeedsYou))
    .filter(node => node.type === 'button' && ['Review', 'Review in Needs you'].includes(node.props.children));
  assert.equal(reviewButtons.length, 1, 'one clear Review action owns this approval');
  reviewButtons.forEach(button => button.props.onClick());
  assert.deepEqual(opened, ['approval:opaque:approval/7']);
});

test('remembered approval IDs do not create Review controls after the task resumes', () => {
  const reviewButtons = nodes(renderCard(task('working'), () => assert.fail('must not review an obsolete approval')))
    .filter(node => node.type === 'button' && ['Review', 'Review in Needs you'].includes(node.props.children));
  assert.equal(reviewButtons.length, 0);
});

test('ordinary mobile run outputs resolve through the server-recorded producing session', () => {
  const run = runDetail();
  run.deliverables = [{ at: 1, name: 'Report.pdf', dir: '/reported/path', excerpt: 'Report' }];
  const result = nodes(renderRun(run, () => {})).find(node => node.type === 'TaskResultFiles')!;
  assert.equal(result.props.sessionId, run.id);
  assert.equal(result.props.savedKey, JSON.stringify(run.deliverables));
  assert.equal('fileRef' in result.props, false, 'a reported path never becomes file authority');
});

test('a task report is presented once while a different final report remains available', () => {
  const given = { ...task('finished'), resultPreview: 'The complete report.\n\nA second paragraph.' };
  const run = runDetail(given);
  run.events = [{ seq: 1, id: 'report-event', turn: 1, role: 'assistant', createdAt: 0,
    type: 'conversation_completed', data: { reply: 'The complete report.\r\n\r\nA second paragraph.' } }];
  const hasFullReport = () => nodes(renderRun(run, () => {})).some(node => node.type === 'summary' && node.props.children === 'Full report');
  assert.equal(hasFullReport(), false, 'the task card already exposes this exact report');
  run.events = [{ ...run.events[0]!, data: { reply: 'A distinct final explanation, which must remain reviewable.' } }];
  assert.equal(hasFullReport(), true);
});
