/**
 * Run: npx tsx --test src/daemon/runner-loop-containment.test.ts
 *
 * Structural pin for the daemon main loop. 3.18.35 on Windows: one scheduler
 * read threw EPERM inside an uncontained loop step, the error reached main(),
 * and the daemon exited at every boot. Every awaited loop step now goes
 * through loopStep, which contains and logs the failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('./runner.ts', import.meta.url), 'utf-8');
const file = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function descendants<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

const calleeName = (call: ts.CallExpression): string | undefined =>
  ts.isIdentifier(call.expression) ? call.expression.text : undefined;

const startDaemon = descendants(file, (node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'startDaemon')[0];
const mainLoop = startDaemon && descendants(startDaemon, (node): node is ts.WhileStatement =>
  ts.isWhileStatement(node) && node.expression.kind === ts.SyntaxKind.TrueKeyword)[0];

test('every awaited step of the daemon main loop is contained by loopStep', () => {
  assert.ok(mainLoop, 'startDaemon keeps one while (true) main loop');
  const calls = descendants(mainLoop, ts.isCallExpression);
  assert.deepEqual(
    calls.filter((call) => calleeName(call) === 'withDaemonRuntimePhase').map((call) => call.getText().slice(0, 90)),
    [],
    'a raw withDaemonRuntimePhase step rethrows into main() and exits the daemon',
  );
  // Awaits written directly in the loop (not inside a step's own callback).
  const isFunction = (node: ts.Node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
  const direct = descendants(mainLoop, ts.isAwaitExpression).filter((node) => {
    for (let parent = node.parent; parent && parent !== mainLoop; parent = parent.parent) {
      if (isFunction(parent)) return false;
    }
    return true;
  });
  const uncontained = direct.filter((node) => {
    const call = ts.isCallExpression(node.expression) ? node.expression : undefined;
    const name = call && calleeName(call);
    return name !== 'loopStep' && name !== 'sleep';
  });
  assert.deepEqual(uncontained.map((node) => node.getText().slice(0, 90)), []);
  const steps = calls
    .filter((call) => calleeName(call) === 'loopStep')
    .map((call) => (ts.isStringLiteral(call.arguments[0]!) ? call.arguments[0].text : '<non-literal>'));
  assert.equal(new Set(steps).size, steps.length, 'each loop step keeps one phase name');
  for (const step of steps) assert.match(step, /^daemon\.loop\.[a-z0-9_]+$/);
  for (const required of [
    'daemon.loop.cron_schedules',
    'daemon.loop.workflow_schedules',
    'daemon.loop.execution_controller',
    'daemon.loop.persist_heartbeat',
  ]) assert.ok(steps.includes(required), `${required} runs through loopStep`);
});

test('loopStep contains through withContainedDaemonRuntimePhase and logs the failing phase', () => {
  const declaration = startDaemon && descendants(startDaemon, (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && node.name.getText() === 'loopStep')[0];
  const text = declaration?.initializer?.getText() ?? '';
  assert.match(text, /withContainedDaemonRuntimePhase\(name, \{ tickCount \}, fn,/);
  assert.match(text, /logger\.warn\(/);
  assert.match(text, /phase: name/);
});
