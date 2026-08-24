import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');

function importHasRuntimeBinding(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportHasRuntimeBinding(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.some((element) => !element.isTypeOnly);
}

function resolveLocalRuntimeImport(importer: string, specifier: string): string {
  const unresolved = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    unresolved,
    unresolved.replace(/\.js$/, '.ts'),
    unresolved.replace(/\.mjs$/, '.mts'),
    `${unresolved}.ts`,
    path.join(unresolved, 'index.ts'),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  assert.ok(resolved, `unable to resolve runtime import ${specifier} from ${path.relative(ROOT, importer)}`);
  return resolved;
}

function runtimeImportClosure(entry: string): { modules: string[]; packages: string[] } {
  const pending = [path.join(ROOT, entry)];
  const visited = new Set<string>();
  const packages = new Set<string>();

  while (pending.length > 0) {
    const file = pending.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node)
        && importHasRuntimeBinding(node)
        && ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node)
        && exportHasRuntimeBinding(node)
        && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.ok(
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]),
          `computed dynamic import is forbidden in held graph: ${path.relative(ROOT, file)}`,
        );
        specifiers.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);

    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) pending.push(resolveLocalRuntimeImport(file, specifier));
      else if (!specifier.startsWith('node:')) packages.add(specifier);
    }
  }

  return {
    modules: [...visited].map((file) => path.relative(ROOT, file)).sort(),
    packages: [...packages].sort(),
  };
}

test('held foreground is a dedicated entry and sheds the migration graph before opening ingress', () => {
  const source = read('src/daemon/cutover-hold-entry.ts');
  assert.match(source, /await runSchemaMigrationChild\(\)/);
  assert.match(source, /const build = requireHarnessSchemaReady\(\)/);
  assert.match(source, /await startCutoverHoldServer\(\)/);
  assert.ok(
    source.indexOf('await runSchemaMigrationChild()')
      < source.indexOf('await startCutoverHoldServer()'),
    'the migration child must exit before authenticated ingress opens',
  );
  assert.ok(
    source.indexOf('registerShutdownHandlers(stopHeldRuntime)')
      < source.indexOf('await runSchemaMigrationChild()'),
    'shutdown ownership must be installed before the migration child starts',
  );
  assert.doesNotMatch(source, /assistant\/core|daemon\/runner|channels\/(?:webhook|discord|slack)/);
  assert.doesNotMatch(source, /processBackgroundTasks|processWorkflowRuns|processWorkflowSchedules|fireDueTimers/);

  const migration = read('src/daemon/cutover-hold-migrate.ts');
  assert.match(migration, /applyHarnessMigrations\(db\)/);
  assert.match(migration, /db\?\.close\(\)/);
  assert.doesNotMatch(migration, /eventlog\.js/);
});

test('held parent and migration child have exact minimal runtime import closures', () => {
  assert.deepEqual(runtimeImportClosure('src/daemon/cutover-hold-entry.ts'), {
    modules: [
      'src/channels/cutover-hold-server.ts',
      'src/config.ts',
      'src/daemon/cutover-hold-entry.ts',
      'src/daemon/phase.ts',
      'src/daemon/process.ts',
      'src/runtime/build-info.ts',
      'src/runtime/cutover-hold.ts',
      'src/runtime/harness/schema-version.ts',
      'src/runtime/security.ts',
      'src/runtime/source-fingerprint.ts',
    ],
    packages: ['better-sqlite3', 'pino'],
  });
  assert.deepEqual(runtimeImportClosure('src/daemon/cutover-hold-migrate.ts'), {
    modules: [
      'src/config.ts',
      'src/daemon/cutover-hold-migrate.ts',
      'src/daemon/process.ts',
      'src/runtime/build-info.ts',
      'src/runtime/cutover-hold.ts',
      'src/runtime/harness/eventlog-schema.ts',
      'src/runtime/harness/schema-version.ts',
      'src/runtime/security.ts',
      'src/runtime/source-fingerprint.ts',
    ],
    packages: ['better-sqlite3'],
  });
  assert.deepEqual(runtimeImportClosure('src/runtime/harness/eventlog-schema.ts'), {
    modules: [
      'src/runtime/harness/eventlog-schema.ts',
      'src/runtime/harness/schema-version.ts',
    ],
    packages: ['better-sqlite3'],
  });
});

test('eventlog has one schema migration owner and delegates ordinary open through it', () => {
  const eventlog = read('src/runtime/harness/eventlog.ts');
  const schema = read('src/runtime/harness/eventlog-schema.ts');
  assert.doesNotMatch(eventlog, /const MIGRATIONS:/);
  assert.match(schema, /const MIGRATIONS: EventLogMigration\[\]/);
  assert.equal(
    `${eventlog}\n${schema}`.match(/const MIGRATIONS: EventLogMigration\[\]/g)?.length,
    1,
    'migration array has exactly one source of truth',
  );
  assert.match(eventlog, /from '\.\/eventlog-schema\.js'/);
  assert.match(eventlog, /applyHarnessMigrations\(db\)/);
});

test('held source attestation disables every Git execution and mutation extension point', () => {
  const buildInfo = read('src/runtime/build-info.ts');
  const fingerprint = read('src/runtime/source-fingerprint.ts');
  for (const source of [buildInfo, fingerprint]) {
    assert.match(source, /GIT_NO_LAZY_FETCH: '1'/);
    assert.match(source, /GIT_OPTIONAL_LOCKS: '0'/);
    assert.match(source, /GIT_PAGER: 'cat'/);
    assert.match(source, /core\.fsmonitor=false/);
  }
  assert.match(fingerprint, /'--no-ext-diff', '--no-textconv', '--binary'/);
});

test('ordinary index refuses a held environment instead of constructing a held daemon', () => {
  const source = read('src/index.ts');
  const main = source.slice(source.indexOf('async function main()'), source.indexOf('startSupervisorIpcHeartbeat()'));
  assert.match(main, /if \(CUTOVER_HOLD\)/);
  assert.match(main, /cutover-hold-entry\.ts/);
  assert.doesNotMatch(source, /startHeldDaemon|startCutoverHoldServer/);
});

test('dev-up forces held launches onto loopback host_v1 with every external warm/listener disabled', () => {
  const source = read('scripts/dev-up.sh');
  assert.match(source, /DEV_CUTOVER_HOLD="\$\{DEV_CUTOVER_HOLD:-off\}"/);
  assert.match(source, /DEV_TURN_ENGINE=host_v1/);
  assert.match(source, /DEV_DISCORD=false/);
  assert.match(source, /WEBHOOK_ENABLED=true WEBHOOK_HOST=127\.0\.0\.1/);
  assert.match(source, /DISCORD_ENABLED=false SLACK_ENABLED=false CLEMENTINE_MOBILE_APP_LISTENER=off/);
  assert.match(source, /CLEMMY_BOOT_WARMUP=off CLEMMY_CLI_DISCOVERY_WARMUP=off CLEMMY_MCP_PREWARM=off/);
  assert.match(source, /src\/daemon\/cutover-hold-entry\.ts start/);
  assert.match(source, /NODE_OPTIONS= node --import tsx src\/daemon\/cutover-hold-entry\.ts start/);
  assert.doesNotMatch(source, /npx tsx/);
  assert.match(source, /build\?\.cutoverHold === expectedCutoverHold/);
  assert.match(source, /build\?\.cutoverHoldProcessId === Number\(process\.env\.EXPECTED_CLEMENTINE_PID\)/);
  assert.match(source, /build\?\.effectiveFreshTurnEngine === "host_v1"/);
  assert.match(source, /if \[ "\$DEV_CUTOVER_HOLD" != "on" \]; then/);
});
