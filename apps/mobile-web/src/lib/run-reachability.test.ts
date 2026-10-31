/**
 * Every place a run appears, it opens.
 *
 * The defect these pin: Run.tsx — the screen that leads with what CHANGED —
 * was reachable exactly one way (Activity → a live card that happened to carry
 * a sessionId), and Activity was not itself offered in the phone's switcher.
 * Meanwhile Home's Running rows carried a pulse, an elapsed clock and a
 * progress bar while being untappable, which reads as a typing indicator
 * rather than a work item.
 *
 * The shell tests read its actual JSX destinations and execute its navigation
 * callbacks with controlled state. The URL contract and row copy also have
 * focused coverage in deep-link.test.ts and run-rows.test.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { destinationSearch, runFromSearch, tabFromSearch } from './deep-link';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

function descendants<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => { if (guard(node)) found.push(node); ts.forEachChild(node, visit); };
  visit(root); return found;
}
const appSource = () => ts.createSourceFile('app.tsx', read('../app.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function initializer(source: ts.SourceFile, name: string): ts.Expression {
  const declaration = descendants(source, ts.isVariableDeclaration).find(node => ts.isIdentifier(node.name) && node.name.text === name);
  assert.ok(declaration?.initializer, `${name} must exist`); return declaration.initializer;
}
type JsxTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
const jsxTags = (source: ts.SourceFile) => descendants(source, (node): node is JsxTag => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node));
function attribute(tag: JsxTag, name: string): ts.Expression {
  const value = tag.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText() === name);
  assert.ok(value && ts.isJsxAttribute(value) && value.initializer, `${tag.tagName.getText()} requires ${name}`);
  if (ts.isJsxExpression(value.initializer)) { assert.ok(value.initializer.expression); return value.initializer.expression; }
  return value.initializer;
}
function callback(source: ts.SourceFile, name: string): ts.Expression {
  const value = initializer(source, name); assert.ok(ts.isCallExpression(value));
  assert.ok(value.arguments[0]); return value.arguments[0];
}
function evaluate(expression: ts.Expression, context: Record<string, any> = {}): any {
  const code = ts.transpileModule(`const value = ${expression.getText()};\nvalue;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(code, context);
}
function navigation(source: ts.SourceFile) {
  const state: Record<string, any> = {}; let url = '';
  const context: Record<string, any> = { userNavigated: { current: false }, guideReturn: { current: null }, destinationSearch,
    window: { location: { pathname: '/m/' }, history: { replaceState(_state: unknown, _title: string, next: string) { url = next; } } } };
  for (const field of ['Tab', 'GuideId', 'WorkspaceId', 'InboxNotification', 'RunId', 'ProjectId', 'AgentId']) {
    context[`set${field}`] = (value: unknown) => { state[field] = value; };
  }
  const navigateTo = evaluate(callback(source, 'navigateTo'), context);
  return { navigateTo, state, search: () => new URL(url, 'https://fixture.example').search };
}

test('the shell makes a run a destination and hands every surface the same door', () => {
  const source = appSource(); const tags = jsxTags(source);
  for (const name of ['Home', 'Inbox', 'Chats', 'Projects', 'Agents']) {
    const tag = tags.find(node => node.tagName.getText() === name); assert.ok(tag, `${name} is a reachable surface`);
    assert.equal(attribute(tag, 'onOpenRun').getText(), 'openRun', `${name} shares the exact canonical run destination`);
  }
  const route = navigation(source);
  const openRun = evaluate(callback(source, 'openRun'), { navigateTo: route.navigateTo, haptic() {} });
  const id = 'background:owner/report ?draft#résumé';
  openRun(id);
  assert.equal(route.state.Tab, 'activity'); assert.equal(route.state.RunId, id);
  assert.equal(tabFromSearch(route.search()), 'activity'); assert.equal(runFromSearch(route.search()), id);
  assert.equal(route.state.InboxNotification, null); assert.equal(route.state.ProjectId, null); assert.equal(route.state.AgentId, null);
  const activity = tags.find(node => node.tagName.getText() === 'Activity'); assert.ok(activity);
  assert.equal(attribute(activity, 'initialRunId').getText(), 'runId', 'an addressed run reaches the actual run list owner');
  const changeRun = evaluate(attribute(activity, 'onRunChange'), { navigateTo: route.navigateTo });
  changeRun('background:second-exact-run');
  assert.equal(runFromSearch(route.search()), 'background:second-exact-run', 'opening a run inside Activity updates its exact reload destination');
});

test('Tasks & results in Your stuff and Home See all open Activity without a stale run selection', () => {
  const source = appSource(); const tags = jsxTags(source); const route = navigation(source);
  const groups = evaluate(initializer(source, 'STUFF_GROUPS')) as string[][];
  assert.ok(groups.some(group => group.includes('activity')), 'Tasks & results remains discoverable in Your stuff');
  const tabs = initializer(source, 'TABS'); assert.ok(ts.isArrayLiteralExpression(tabs));
  const activity = tabs.elements.find(node => ts.isObjectLiteralExpression(node)
    && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText() === 'id' && property.initializer.getText() === "'activity'"));
  assert.ok(activity && ts.isObjectLiteralExpression(activity));
  const label = activity.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText() === 'label');
  assert.ok(label && ts.isPropertyAssignment(label)); assert.equal(evaluate(label.initializer), 'Tasks & results');
  const drawerItem = tags.find(node => node.tagName.getText() === 'button'
    && node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText() === 'class' && property.initializer?.getText() === '"drawer-item"'));
  assert.ok(drawerItem); let closed = false;
  const openTasks = evaluate(attribute(drawerItem, 'onClick'), { tab: 'home', t: { id: 'activity' }, navigateTo: route.navigateTo, haptic() {}, closeDrawer() { closed = true; } });
  route.navigateTo('activity', { runId: 'previous-exact-run' }); openTasks();
  assert.equal(closed, true); assert.equal(tabFromSearch(route.search()), 'activity'); assert.equal(runFromSearch(route.search()), null);
  const home = tags.find(node => node.tagName.getText() === 'Home'); assert.ok(home);
  const seeAll = evaluate(attribute(home, 'onOpenActivity'), { navigateTo: route.navigateTo });
  route.navigateTo('activity', { runId: 'another-previous-run' }); seeAll();
  assert.equal(route.state.RunId, null); assert.equal(route.search(), '?tab=activity');
});

test('a finished run row says what it did, not what the engine calls it', () => {
  const activity = read('../screens/Activity.tsx');
  assert.match(activity, /const label = runRowLabel\(run\)/);
  assert.match(activity, /\{label\.state\} · \{relativeTime\(run\.updatedAt\)\}/);
  assert.match(activity, /\{label\.detail \? <div class="run-outcome truncate">\{label\.detail\}<\/div> : null\}/);
  // The raw-token rendering is gone from every phone surface that had it.
  for (const screen of ['../screens/Activity.tsx', '../screens/Run.tsx', '../screens/Workflows.tsx']) {
    assert.doesNotMatch(
      read(screen),
      /(run|data)\??\.(status|terminalOutcome)[^\n]*\.replace\(\/_\/g, ' '\)/,
      `${screen} still prints a raw status token`,
    );
  }
});

test('the phone reads the enrichment the run list already sends', () => {
  const api = read('./api.ts');
  // Declaring the fields is not reading them: run-rows.ts is the consumer, and
  // run-rows.test.ts proves what it does with each one.
  assert.match(api, /statusLabel\?: string/);
  assert.match(api, /preview\?: string/);
  const rows = read('./run-rows.ts');
  assert.match(rows, /run\.statusLabel/);
  assert.match(rows, /run\.preview/);
});

test('a stale read is stamped and never mistaken for a live one', () => {
  const api = read('./api.ts');
  assert.match(api, /const lastGoodStamp = res\.headers\.get\(LAST_GOOD_HEADER\)/);
  assert.match(api, /noteLastGood\(path, lastGoodStamp\)/);
  assert.match(api, /if \(lastGoodStamp\) \{\s*\n\s*setConnectionDoor\('offline'\)/,
    'a cached 200 must not report the door open');
  assert.match(api, /const rotatedFp = lastGoodStamp \? null : res\.headers\.get\('x-clem-session-fp'\)/,
    "a remembered copy's fingerprint has since rotated; adopting it 401s every later proof");
  // Sign-out drops the remembered reads WHETHER OR NOT the daemon answers:
  // offline the logout POST throws, and a `clearLastGood()` after that await
  // never ran — the cache and the badge outlived the credential.
  assert.match(
    api,
    /try \{\s*\n\s*await api\('\/m\/auth\/logout', \{ method: 'POST' \}\);\s*\n\s*\} finally \{[\s\S]*?clearLastGood\(\);/,
    'the clear must be in a finally, not after the await',
  );

  // Activity reads a collection path; Run reads the ENCODED detail path, and
  // must ask for the stamp with the same string getRun fetched with — the raw
  // spelling missed for every `background:task-1`-shaped session id.
  assert.match(
    read('../screens/Activity.tsx'),
    /lastGood=\{lastGoodNotice\(lastGoodAt\('\/m\/api\/runs'\), Date\.now\(\)\)\}/,
  );
  const runScreen = read('../screens/Run.tsx');
  assert.match(runScreen, /const stampedAt = lastGoodAt\(runDetailPath\(sessionId\)\);/);
  assert.match(runScreen, /lastGood=\{lastGoodNotice\(stampedAt, Date\.now\(\)\)\}/);
  assert.doesNotMatch(
    runScreen,
    /lastGoodAt\(`\/m\/api\/runs\/\$\{sessionId\}`\)/,
    'the hand-spelled, unencoded key is the defect — it must not come back',
  );
  const notice = read('../components/ScreenNotice.tsx');
  assert.match(notice, /Check again/, 'stale data always offers a re-check');
});
