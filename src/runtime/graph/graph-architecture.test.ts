/**
 * Run: npx tsx --test src/runtime/graph/graph-architecture.test.ts
 *
 * The Stage 10 architecture lint, brought forward: rules that tonight's
 * modules each pin individually become DIRECTORY law, so a graph module
 * added next month is born under them instead of relying on its author to
 * copy a purity test.
 *
 *   1. No ambient reads in graph-module CODE: environment, wall clock,
 *      randomness, network. Time, durability, and policy are injected.
 *   2. No provider names in graph-module CODE (comments may explain defect
 *      classes; control flow may not know who is running).
 *   3. Graph modules import only: node builtins (crypto), sibling graph
 *      modules, and type-only imports. The executor layer never reaches into
 *      channels, dashboard, tools, memory, or provider implementations —
 *      those consume the graph, never the reverse.
 *
 * The known, deliberate exceptions are listed with their reasons; an
 * unlisted violation fails with the file and the rule, which is the review
 * conversation happening at the right moment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MODULE_FILES = readdirSync(HERE)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

/** Deliberate exceptions, each with the reason it is lawful. */
const IMPORT_EXCEPTIONS: Record<string, string[]> = {
  // The shadow recorder is the OBSERVATION seam: it reads the event log and
  // policy snapshot by design. It predates the executor and is deleted in a
  // later G5b slice once all callers execute rather than observe.
  'turn-graph-shadow.ts': ['../harness/eventlog.js', '../../agents/proactivity-policy.js', './turn-graph-compiler.js', 'node:perf_hooks'],
  // The chat spine intentionally bridges compiler + executor; its policy
  // snapshot type is a type-only concern but snapshotTurnGraphPolicy is a
  // value import from the compiler (a sibling).
  'chat-turn-spine.ts': ['./turn-graph-compiler.js', './graph-executor.js'],
  // The compiler consumes the pure classifier seams — deterministic string
  // classifiers, not providers or IO.
  'turn-graph-compiler.ts': ['node:crypto', '../../assistant/project-shape.js', '../../assistant/external-effect-taxonomy.js', '../../assistant/message-intent.js', '../harness/multi-item-intent.js'],
};

const AMBIENT_FORBIDDEN = ['process.env', 'Date.now', 'Math.random', 'fetch('];
const PROVIDER_NAMES = ['claude', 'codex', 'anthropic', 'openai'];

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(?<=[^:])\/\/[^\n]*$/gm, '');
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/^import (?!type )[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]!);
}

test('graph modules never read the world ambiently', () => {
  for (const file of MODULE_FILES) {
    const code = codeOnly(readFileSync(path.join(HERE, file), 'utf-8'));
    for (const forbidden of AMBIENT_FORBIDDEN) {
      assert.equal(code.includes(forbidden), false,
        `${file} reads the world ambiently (${forbidden}) — time, policy, and IO are injected in this layer`);
    }
    // `new Date` is ambient EXCEPT in the shadow/compile seams that timestamp
    // durable telemetry at the boundary; the executor itself stays clock-free.
    if (file === 'graph-executor.ts' || file === 'graph-admission.ts' || file === 'graph-journal.ts'
      || file === 'effect-lifecycle.ts' || file === 'provider-fallover.ts'
      || file === 'admission-envelope.ts' || file === 'surface-projection.ts') {
      assert.equal(code.includes('new Date'), false, `${file} reached for a clock`);
    }
  }
});

test('graph-module CODE never names a provider', () => {
  for (const file of MODULE_FILES) {
    const code = codeOnly(readFileSync(path.join(HERE, file), 'utf-8')).toLowerCase();
    for (const name of PROVIDER_NAMES) {
      assert.equal(code.includes(name), false,
        `${file} CODE references "${name}" — the graph layer must not know who is running`);
    }
  }
});

test('graph modules import only builtins, siblings, and listed exceptions', () => {
  for (const file of MODULE_FILES) {
    const imports = importsOf(readFileSync(path.join(HERE, file), 'utf-8'));
    const allowed = new Set(IMPORT_EXCEPTIONS[file] ?? []);
    for (const spec of imports) {
      const lawful = spec === 'node:crypto'
        || (spec.startsWith('./') && spec.endsWith('.js'))
        || allowed.has(spec);
      assert.ok(lawful,
        `${file} imports "${spec}" — the graph layer is consumed by the runtime, it does not reach into it. `
        + 'If this import is genuinely lawful, list it in IMPORT_EXCEPTIONS with its reason.');
    }
  }
});

test('the exception list cannot rot silently', () => {
  // An exception for a file that no longer exists (or no longer uses it) is a
  // stale permission waiting to be abused by a future file of the same name.
  for (const [file, exceptions] of Object.entries(IMPORT_EXCEPTIONS)) {
    assert.ok(MODULE_FILES.includes(file), `IMPORT_EXCEPTIONS lists "${file}", which does not exist`);
    const imports = new Set(importsOf(readFileSync(path.join(HERE, file), 'utf-8')));
    for (const exception of exceptions) {
      assert.ok(imports.has(exception),
        `IMPORT_EXCEPTIONS grants "${file}" -> "${exception}", which it no longer uses — remove the stale grant`);
    }
  }
});
