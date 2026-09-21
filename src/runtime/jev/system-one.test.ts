import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TYPESAFE_SYSTEMONE_URL,
  buildSystemOneRequest,
  parseSystemOneResponse,
  postSystemOne,
  probeTypesafeApiKey,
  type SystemOneFetch,
} from './system-one.js';

const RECORDED = {
  model: 'jev-1.13.0',
  answers: {
    is_urgent: { type: 'noul', noul: 0.95 },
    department: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.88, technical: 0.12, sales: 0 },
      confidence: 0.81,
    },
    frustration: {
      type: 'score',
      score: 1.05,
      legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
      probabilities: { '0': 0, '1': 0.95, '2': 0.05 },
      confidence: 0.92,
    },
  },
  usage: { input_tokens: 318, output_tokens: 34 },
};

const QUESTIONS = {
  is_urgent: { type: 'noul' as const, instructions: 'Does this convey urgency?' },
  department: {
    type: 'choice' as const,
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payments', technical: 'Bugs', sales: 'Pricing' },
  },
  frustration: {
    type: 'score' as const,
    instructions: 'How frustrated is the customer?',
    criteria: ['Calm', 'Frustrated', 'Very angry'],
  },
};

test('parseSystemOneResponse reads recorded Choice, Score, and Noul answers', () => {
  const parsed = parseSystemOneResponse(RECORDED, QUESTIONS);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.model, 'jev-1.13.0');
  assert.equal(parsed.usage.input_tokens, 318);
  assert.equal(parsed.answers.is_urgent.type, 'noul');
  if (parsed.answers.is_urgent.type === 'noul') assert.equal(parsed.answers.is_urgent.noul, 0.95);
  assert.equal(parsed.answers.department.type, 'choice');
  if (parsed.answers.department.type === 'choice') {
    assert.equal(parsed.answers.department.choice, 'billing');
    assert.equal(parsed.answers.department.confidence, 0.81);
  }
  assert.equal(parsed.answers.frustration.type, 'score');
});

test('parseSystemOneResponse fails open on missing answers, out-of-range noul, and broken choice', () => {
  assert.equal(parseSystemOneResponse({}, QUESTIONS).ok, false);
  assert.equal(parseSystemOneResponse({ answers: { is_urgent: { type: 'noul', noul: 2 } } }, {
    is_urgent: QUESTIONS.is_urgent,
  }).reason, 'malformed');
  assert.equal(parseSystemOneResponse({
    answers: { department: { type: 'choice', choice: 'other', probabilities: { billing: 1 }, confidence: 1 } },
  }, { department: QUESTIONS.department }).reason, 'malformed');
});

test('buildSystemOneRequest pins jev-latest and the typed questions map', () => {
  const request = buildSystemOneRequest('hello', { alive: { type: 'noul', instructions: 'yes?' } });
  assert.equal(request.model, 'jev-latest');
  assert.equal(request.questions.alive.type, 'noul');
});

function jsonFetch(status: number, body: unknown, urlSeen: { url?: string; method?: string }): SystemOneFetch {
  return async (url, init) => {
    urlSeen.url = url;
    urlSeen.method = init.method;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
    };
  };
}

test('postSystemOne posts to /v1/systemone and parses a recorded body', async () => {
  const seen: { url?: string; method?: string } = {};
  const result = await postSystemOne({
    apiKey: 'ts_test',
    request: buildSystemOneRequest('Help! payouts failing.', QUESTIONS),
    fetchImpl: jsonFetch(200, RECORDED, seen),
  });
  assert.equal(seen.url, TYPESAFE_SYSTEMONE_URL);
  assert.equal(seen.method, 'POST');
  assert.match(TYPESAFE_SYSTEMONE_URL, /\/v1\/systemone$/);
  assert.doesNotMatch(TYPESAFE_SYSTEMONE_URL, /chat\/completions/);
  assert.equal(result.ok, true);
});

test('postSystemOne fail-opens on missing key, timeout, 401, and malformed JSON', async () => {
  assert.equal((await postSystemOne({
    apiKey: '   ',
    request: buildSystemOneRequest('x', { a: { type: 'noul', instructions: 'y' } }),
  })).reason, 'missing_key');

  const timeout = await postSystemOne({
    apiKey: 'ts_test',
    request: buildSystemOneRequest('x', { a: { type: 'noul', instructions: 'y' } }),
    timeoutMs: 250,
    fetchImpl: async (_url, init) => {
      await new Promise<void>((_, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      throw new Error('unreachable');
    },
  });
  assert.equal(timeout.reason, 'timeout');

  const unauthorized = await postSystemOne({
    apiKey: 'bad',
    request: buildSystemOneRequest('x', { a: { type: 'noul', instructions: 'y' } }),
    fetchImpl: jsonFetch(401, { error: 'nope' }, {}),
  });
  assert.equal(unauthorized.reason, 'unauthorized');

  const malformed = await postSystemOne({
    apiKey: 'ts_test',
    request: buildSystemOneRequest('x', { a: { type: 'noul', instructions: 'y' } }),
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => 'not-json' }),
  });
  assert.equal(malformed.reason, 'malformed');
});

test('probeTypesafeApiKey uses /v1/systemone and treats 401 as invalid', async () => {
  const seen: { url?: string } = {};
  const valid = await probeTypesafeApiKey('ts_good', jsonFetch(200, {
    model: 'jev-1.13.0',
    answers: { alive: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 10, output_tokens: 2 },
  }, seen));
  assert.equal(valid.result, 'valid');
  assert.equal(seen.url, TYPESAFE_SYSTEMONE_URL);

  const invalid = await probeTypesafeApiKey('ts_bad', jsonFetch(403, { error: 'no' }, {}));
  assert.equal(invalid.result, 'invalid');
});
