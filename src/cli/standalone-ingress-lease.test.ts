/**
 * Run: npx tsx --test src/cli/standalone-ingress-lease.test.ts
 *
 * Source-order contract for the top-level CLI. Importing index.ts would execute
 * main and open real listeners, so this focused AST test verifies admission
 * without binding ports or connecting production transports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const INDEX_SOURCE = readFileSync(new URL('../index.ts', import.meta.url), 'utf-8');
const SOURCE_FILE = ts.createSourceFile(
  'index.ts',
  INDEX_SOURCE,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function descendants<T extends ts.Node>(
  root: ts.Node,
  matches: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (matches(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function namedFunction(name: string): ts.FunctionDeclaration {
  const fn = descendants(
    SOURCE_FILE,
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node),
  ).find((candidate) => candidate.name?.text === name);
  assert.ok(fn, `${name} declaration must exist`);
  return fn;
}

function callName(call: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name.text;
  return undefined;
}

function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  return descendants(
    root,
    (node): node is ts.CallExpression => ts.isCallExpression(node) && callName(node) === name,
  );
}

function variableDeclaration(root: ts.Node, name: string): ts.VariableDeclaration {
  const declaration = descendants(
    root,
    (node): node is ts.VariableDeclaration => ts.isVariableDeclaration(node),
  ).find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  assert.ok(declaration, `${name} declaration must exist`);
  return declaration;
}

function containingIf(node: ts.Node): ts.IfStatement | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isIfStatement(current)) return current;
  }
  return undefined;
}

test('standalone mutating ingress claims the foreground lease before constructing or starting', () => {
  const main = namedFunction('main');
  const standalone = variableDeclaration(main, 'standaloneIngress');
  const standaloneExpression = standalone.initializer?.getText(SOURCE_FILE).replaceAll(' ', '') ?? '';
  assert.match(standaloneExpression, /command==='webhook'/);
  assert.match(standaloneExpression, /command==='discord'/);
  assert.match(standaloneExpression, /command==='slack'/);

  const standaloneBranch = descendants(
    main,
    (node): node is ts.IfStatement => ts.isIfStatement(node) && node.expression.getText(SOURCE_FILE) === 'standaloneIngress',
  );
  assert.equal(standaloneBranch.length, 1, 'standalone ingress must have one shared admission branch');

  const claims = callsNamed(standaloneBranch[0].thenStatement, 'claimForegroundDaemonLease');
  const shutdownRegistrations = callsNamed(standaloneBranch[0].thenStatement, 'registerShutdownHandlers');
  const canonicalMigrations = callsNamed(
    standaloneBranch[0].thenStatement,
    'migrateToolChoicesToCanonicalProcedures',
  );
  assert.equal(claims.length, 1, 'standalone ingress must claim the singleton lease once');
  assert.equal(shutdownRegistrations.length, 1, 'standalone ingress must register normal shutdown handling once');
  assert.equal(canonicalMigrations.length, 1, 'standalone ingress must run canonical migration once');
  assert.ok(
    claims[0].getStart() < shutdownRegistrations[0].getStart()
      && shutdownRegistrations[0].getStart() < canonicalMigrations[0].getStart(),
    'shutdown and explicit migration run only after the singleton lease is acquired',
  );

  const assistantConstruction = descendants(
    main,
    (node): node is ts.NewExpression =>
      ts.isNewExpression(node) && node.expression.getText(SOURCE_FILE) === 'ClementineAssistant',
  ).find((node) => node.getStart() > standalone.getStart());
  assert.ok(assistantConstruction, 'service command assistant construction must exist');

  const listenerCalls = ['startWebhookServer', 'startDiscordBot', 'startSlackBot']
    .flatMap((name) => callsNamed(main, name))
    .filter((call) => {
      const branch = containingIf(call);
      return branch?.expression.getText(SOURCE_FILE).startsWith("command === '") ?? false;
    });
  assert.equal(listenerCalls.length, 3, 'all three standalone listener branches must remain present');
  assert.ok(
    canonicalMigrations[0].getStart() < assistantConstruction.getStart()
      && listenerCalls.every((call) => assistantConstruction.getStart() < call.getStart()),
    'lease, shutdown, and migration must precede assistant construction and every standalone listener',
  );
});

test('read-only Discord and Slack helpers return before standalone lease admission', () => {
  const main = namedFunction('main');
  const standalone = variableDeclaration(main, 'standaloneIngress');

  const readOnlyBranches = descendants(
    main,
    (node): node is ts.IfStatement => ts.isIfStatement(node),
  ).filter((branch) => {
    const condition = branch.expression.getText(SOURCE_FILE).replaceAll(' ', '');
    return condition === "subcommand==='invite'"
      || condition === "subcommand==='scopes'||subcommand==='manifest'";
  });
  assert.equal(readOnlyBranches.length, 2, 'Discord invite and Slack scopes/manifest helpers must remain explicit');
  for (const branch of readOnlyBranches) {
    assert.ok(
      descendants(branch.thenStatement, (node): node is ts.ReturnStatement => ts.isReturnStatement(node)).length > 0,
      'each read-only helper must return without falling through to ingress admission',
    );
    assert.ok(
      branch.getStart() < standalone.getStart(),
      'read-only helper must run before standalone ingress claims the foreground lease',
    );
    assert.equal(callsNamed(branch.thenStatement, 'claimForegroundDaemonLease').length, 0);
  }
});
