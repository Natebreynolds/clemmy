import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { taskResultFiles } from '../../lib/task-results';
import { readSavedFileNavigation, savedFilesDestination } from '../../lib/saved-file-navigation';

type Element = { type: unknown; props: Record<string, any> };
const element = (type: unknown, props: Record<string, any>, key?: string): Element => ({ type, props: { ...props, key } });
function nodes(tree: any): Element[] {
  return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [];
}
function render(dock: any, count = 1) {
  const files = Array.from({ length: count }, (_, index) => ({ fileId: `opaque-${index}`, name: `Report ${index}.pdf`, folder: 'Saved' }));
  const dependencies: Record<string, any> = {
    'react/jsx-runtime': { jsx: element, jsxs: element }, 'react-router-dom': { Link: 'Link' }, 'lucide-react': { FileText: 'FileText' },
    '@tanstack/react-query': { useQuery: () => ({ data: files, refetch() {} }) },
    '@/components/chat/FileDock': { useFileDock: () => dock }, '@/lib/session-files': {},
    '@/lib/task-results': { taskResultFiles }, '@/lib/saved-file-navigation': { savedFilesDestination },
  };
  const code = ts.transpileModule(readFileSync(new URL('./TaskResultFiles.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, { exports, require(name: string) { assert.ok(name in dependencies); return dependencies[name]; } });
  return nodes(exports.TaskResultFiles({ taskId: 'task-exact', sessionId: 'background:producer', savedKey: 'saved' }));
}
test('a saved result without a dock opens the exact canonical file instead of reopening its run', () => {
  const link = render(null).find(node => node.type === 'Link')!;
  assert.equal(link.props.to, '/chat/harness%3Abackground%3Aproducer');
  assert.deepEqual(readSavedFileNavigation(link.props.state.openSavedFile, 'background:producer'), {
    sessionId: 'background:producer', fileId: 'opaque-0', name: 'Report 0.pdf', folder: 'Saved',
  });
});
test('all results in a run uses its current file list even when the toolbar is outside the header', () => {
  let lists = 0;
  const opened: any[] = [];
  const tree = render({ hasFilesList: true, showFiles: () => { lists++; }, open: (item: any) => opened.push(item) }, 4);
  assert.equal(tree.some(node => node.type === 'Link'), false, 'no same-route link that leaves an already-mounted viewer unchanged');
  const buttons = tree.filter(node => node.type === 'button');
  buttons[0].props.onClick();
  buttons.at(-1)!.props.onClick();
  assert.equal(lists, 1);
  assert.equal(opened[0].ref.fileId, 'opaque-0');
  assert.equal(opened[0].ref.sessionId, 'background:producer');
});
