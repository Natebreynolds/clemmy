/**
 * Run: node scripts/run-tests-isolated.mjs src/memory/memory-work-types.test.ts
 *
 * The daemon's copy of the Memory-at-work contract must match the one the
 * apps build against, field for field and union for union. The daemon cannot
 * import packages/, so this compares the two declarations as source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.resolve(here, '../../packages/chat-engine/src/memory-work.ts');
const MIRROR = path.resolve(here, './memory-work-types.ts');
const REGISTRY = path.resolve(here, './memory-jobs.ts');
/** Types the mirror re-exports from the job registry instead of copying. */
const FROM_REGISTRY = new Set(['MemoryJobId', 'MemoryJobModelOwner', 'MemoryJobTrigger']);

/** `export interface X {…}` / `export type X = …;` bodies, comments and
 *  whitespace normalised away. */
function typeDeclarations(source: string): Map<string, string> {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const out = new Map<string, string>();
  const head = /export\s+(interface|type)\s+(\w+)/g;
  for (let match = head.exec(text); match; match = head.exec(text)) {
    let end = head.lastIndex;
    if (match[1] === 'interface') {
      let depth = 0;
      for (end = text.indexOf('{', end); end < text.length; end += 1) {
        if (text[end] === '{') depth += 1;
        else if (text[end] === '}' && --depth === 0) break;
      }
      end += 1;
    } else {
      let depth = 0;
      for (; end < text.length; end += 1) {
        const c = text[end];
        if ('{([<'.includes(c)) depth += 1;
        else if ('})]>'.includes(c)) depth -= 1;
        else if (c === ';' && depth === 0) break;
      }
    }
    out.set(match[2], text.slice(head.lastIndex, end).replace(/\s+/g, ' ').trim());
  }
  return out;
}

function contractTypes(): Map<string, string> {
  const source = readFileSync(CONTRACT, 'utf-8');
  const typesOnly = source.split('// ───────────────────────────── words')[0];
  return typeDeclarations(typesOnly);
}

test('every contract type is mirrored in the daemon with identical fields and unions', () => {
  const contract = contractTypes();
  const mirror = typeDeclarations(readFileSync(MIRROR, 'utf-8'));
  const registry = typeDeclarations(readFileSync(REGISTRY, 'utf-8'));
  assert.ok(contract.size >= 20, `expected the contract's types, found ${contract.size}`);
  for (const [name, body] of contract) {
    const ours = FROM_REGISTRY.has(name) ? registry.get(name) : mirror.get(name);
    assert.equal(ours, body, `${name} drifted from packages/chat-engine/src/memory-work.ts`);
  }
});

test('the mirror declares nothing the contract does not', () => {
  const contract = contractTypes();
  const mirror = typeDeclarations(readFileSync(MIRROR, 'utf-8'));
  assert.deepEqual([...mirror.keys()].filter((name) => !contract.has(name)), []);
  assert.match(readFileSync(MIRROR, 'utf-8'), /export type \{ MemoryJobId, MemoryJobModelOwner, MemoryJobTrigger \} from '\.\/memory-jobs\.js'/);
});
