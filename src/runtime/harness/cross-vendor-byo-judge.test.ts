import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./debate-model.ts', import.meta.url), 'utf8');

// `provider` is a coarse TRANSPORT bucket ('claude' | 'codex' | 'byo'), so two
// models from different vendors both answer 'byo'. Comparing the bucket
// declared a GLM 5.3 (z.ai) brain and a Kimi K3 (Moonshot) judge to be the same
// family — self-grading — which halves the judge's corrective budget, and made
// cross-family judging impossible for a BYO-only user.
test('selfJudge compares the resolved backend, not the transport bucket', () => {
  assert.ok(
    !SRC.includes('selfJudge: checker.provider === brain.provider'),
    'the coarse bucket comparison must be gone',
  );
  assert.match(SRC, /selfJudge: sameJudgeFamily\(checker, brain\)/);
  assert.match(SRC, /function sameJudgeFamily\(/);
});

test('a different transport is still trivially a different family', () => {
  const fn = SRC.split('function sameJudgeFamily(')[1]!.split('\nexport function')[0]!;
  assert.match(fn, /if \(checker\.provider !== brain\.provider\) return false;/);
  assert.match(fn, /if \(checker\.provider !== 'byo'\) return true;/);
});

test('two BYO models are the same family only on the same backend URL', () => {
  const fn = SRC.split('function sameJudgeFamily(')[1]!.split('\nexport function')[0]!;
  assert.match(fn, /resolveByoProviderForModel\(modelId\)/, 'must resolve the per-model backend');
  assert.match(fn, /baseURL/, 'the backend identity is the baseURL');
  assert.match(fn, /return judgeBackend === brainBackend;/);
});

// Self-judge grants FEWER hard bounces, never more, so an unresolvable backend
// must fall back to "same family" — the conservative direction.
test('an unresolvable backend falls back to same-family, not cross-family', () => {
  const fn = SRC.split('function sameJudgeFamily(')[1]!.split('\nexport function')[0]!;
  assert.match(
    fn,
    /if \(!judgeBackend \|\| !brainBackend\) return true;/,
    'uncertainty must NOT manufacture a cross-family judge',
  );
});
