/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/removed-program-surface.test.ts
 *
 * Regression for the 2026-08-20 program-executor subtraction. Historical
 * event/result decoders remain intentionally readable, but no package command,
 * dev flag, smoke probe, registry lane, or model-visible tool may resurrect the
 * removed executor accidentally.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

import { TOOL_REGISTRY } from '../../tools/tool-registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readRepo = (relativePath: string): string => readFileSync(path.join(ROOT, relativePath), 'utf8');

const RETIRED_PROGRAM_FILES = [
  'scripts/measure-code-mode-opportunity.ts',
  'scripts/probe-code-mode.ts',
  'scripts/soak-code-mode-escape.ts',
  'src/runtime/harness/code-mode-metrics.test.ts',
  'src/runtime/harness/code-mode-metrics.ts',
  'src/runtime/wire-agents-codemode.red.test.ts',
  'src/tools/code-mode-coordination-evidence.red.test.ts',
  'src/tools/code-mode-efficiency-e2e.test.ts',
  'src/tools/code-mode-exact-carrier.red.test.ts',
  'src/tools/code-mode-gate-parity.test.ts',
  'src/tools/code-mode-sandbox.test.ts',
  'src/tools/code-mode-sandbox.ts',
  'src/tools/code-mode-tool.test.ts',
  'src/tools/code-mode-tool.ts',
  'src/tools/code-mode-work-carrier.red.test.ts',
] as const;

const RETIRED_MODULE_STEMS = new Set(
  RETIRED_PROGRAM_FILES.map((relativePath) => path.posix.basename(relativePath).replace(/\.(?:[cm]?[jt]sx?)$/, '')),
);

function gitVisibleModulePaths(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((relativePath) => /\.[cm]?[jt]sx?$/.test(relativePath) && existsSync(path.join(ROOT, relativePath)));
}

function importedModuleSpecifiers(relativePath: string): string[] {
  const source = ts.createSourceFile(
    relativePath,
    readRepo(relativePath),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

test('removed program executor has no package, smoke, dev-flag, or registry surface', () => {
  const pkg = JSON.parse(readRepo('package.json')) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.['measure:code-mode'], undefined);
  assert.equal(pkg.scripts?.['probe:code-mode'], undefined);

  for (const relativePath of RETIRED_PROGRAM_FILES) {
    assert.equal(existsSync(path.join(ROOT, relativePath)), false, `${relativePath} must stay deleted`);
  }

  const scriptSurface = Object.values(pkg.scripts ?? {}).join('\n');
  for (const stem of RETIRED_MODULE_STEMS) {
    assert.equal(scriptSurface.includes(stem), false, `package scripts must not reference ${stem}`);
  }
  assert.doesNotMatch(scriptSurface, /\brun_tool_program\b/);

  for (const relativePath of gitVisibleModulePaths()) {
    for (const specifier of importedModuleSpecifiers(relativePath)) {
      const stem = path.posix.basename(specifier).replace(/\.(?:[cm]?[jt]sx?)$/, '');
      assert.equal(
        RETIRED_MODULE_STEMS.has(stem),
        false,
        `${relativePath} must not import retired program module ${specifier}`,
      );
    }
  }

  const executableSurfaces = [
    readRepo('scripts/dev-up.sh'),
    readRepo('scripts/smoke-all.sh'),
    readRepo('src/runtime/dev-flags.ts'),
    readRepo('src/runtime/harness/discovery-boundary.ts'),
  ].join('\n');
  assert.doesNotMatch(executableSurfaces, /CLEMMY_CODE_?MODE(?:_[A-Z0-9_]+)?/);
  assert.doesNotMatch(executableSurfaces, /(?:probe|measure)-code-mode/);
  assert.doesNotMatch(executableSurfaces, /code_mode_(?:list_tools|describe)/);

  assert.equal(TOOL_REGISTRY.some((tool) => tool.name === 'run_tool_program'), false);
  assert.equal(
    TOOL_REGISTRY.some((tool) => (tool.lanes as readonly string[]).includes('code-mode')),
    false,
    'the registry must use the transport-neutral inner-dispatch lane',
  );
  assert.equal(
    TOOL_REGISTRY.some((tool) => Object.prototype.hasOwnProperty.call(tool, 'codeMode')),
    false,
    'the registry must not retain the retired program-mode field',
  );
});
