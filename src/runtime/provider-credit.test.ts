/**
 * Run: npx tsx --test src/runtime/provider-credit.test.ts
 *
 * An account that refuses work for lack of credit is latched out of credit by
 * the call site that saw the refusal, and cleared by the next answer from that
 * account — never by a catalog read, never by a rate limit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
const {
  noteCreditRefused, noteCreditAnswered, creditRefusal, creditRefusals, __resetProviderCreditForTests,
} = await import('./provider-credit.js');
const { isProviderCreditRefusal } = await import('../shared/provider-capacity.js');
const { noteByoCreditOutcome } = await import('./harness/byo-model.js');
const { noteJevCreditOutcome } = await import('./jev/client.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('a refusal latches the account; its first refusal time survives later refusals', () => {
  __resetProviderCreditForTests();
  noteCreditRefused('together-ai', { status: 402, detail: 'Credit limit exceeded' });
  const first = creditRefusal('together-ai');
  assert.equal(first?.status, 402);
  assert.equal(first?.detail, 'Credit limit exceeded');
  noteCreditRefused('together-ai', { status: 402 });
  assert.equal(creditRefusal('together-ai')?.since, first?.since, 'since marks the start of the run of refusals');
  assert.equal(creditRefusal('together-ai')?.detail, 'Credit limit exceeded', 'a later refusal without words keeps the provider words');
});

test('an answer from the account clears it; other accounts stay latched', () => {
  __resetProviderCreditForTests();
  noteCreditRefused('together-ai', { status: 402 });
  noteCreditRefused('jev', { status: 402 });
  noteCreditAnswered('together-ai');
  assert.equal(creditRefusal('together-ai'), undefined);
  assert.ok(creditRefusal('jev'));
  assert.deepEqual(Object.keys(creditRefusals()), ['jev']);
});

test('the provider words are redacted and clipped', () => {
  __resetProviderCreditForTests();
  noteCreditRefused('x', { status: 402, detail: `${'word '.repeat(80)}` });
  assert.ok((creditRefusal('x')?.detail?.length ?? 0) <= 160);
});

test('credit refusals are told apart from rate limits and plan windows', () => {
  // 402 needs no words.
  assert.equal(isProviderCreditRefusal(402, ''), true);
  // Providers that refuse with another status say so in their own error.
  assert.equal(isProviderCreditRefusal(429, '{"error":{"code":"credit_balance_exhausted","type":"insufficient_quota"}}'), true);
  assert.equal(isProviderCreditRefusal(429, '{"error":{"type":"exceeded_current_quota_error","message":"Your account is suspended, please check your plan and billing details"}}'), true);
  assert.equal(isProviderCreditRefusal(429, '{"error":{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}}'), true);
  assert.equal(isProviderCreditRefusal(403, 'Your team has either used all available credits or reached its monthly spending limit.'), true);
  assert.equal(isProviderCreditRefusal(400, 'Your credit balance is too low to access the Anthropic API.'), true);
  // A rate limit is not a credit refusal, even when it mentions credits.
  assert.equal(isProviderCreditRefusal(429, 'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day'), false);
  assert.equal(isProviderCreditRefusal(429, '{"error":{"code":"1302","message":"High concurrency usage"}}'), false);
  assert.equal(isProviderCreditRefusal(429, 'Too Many Requests'), false);
  // A plan window resets on its own; it is capacity, not credit.
  assert.equal(isProviderCreditRefusal(429, '{"error":{"type":"usage_limit_reached"}}'), false);
  // Words on a server error are not trusted as a credit refusal.
  assert.equal(isProviderCreditRefusal(500, 'insufficient balance'), false);
});

test('a BYO generation that answers clears the account; a catalog read does not', () => {
  __resetProviderCreditForTests();
  noteCreditRefused('together-ai', { status: 402 });
  noteByoCreditOutcome('together-ai', new Response('{"data":[]}', { status: 200 }), 'GET');
  assert.ok(creditRefusal('together-ai'), 'a model list answers even with an empty balance');
  noteByoCreditOutcome('together-ai', new Response('{}', { status: 200 }), 'POST');
  assert.equal(creditRefusal('together-ai'), undefined);
});

test('a BYO 402 latches at once; a 429 latches only when its body names spent credit', async () => {
  __resetProviderCreditForTests();
  noteByoCreditOutcome('together-ai', new Response('{"error":{"message":"Credit limit exceeded"}}', { status: 402 }), 'POST');
  assert.equal(creditRefusal('together-ai')?.status, 402);
  await settle();
  assert.match(creditRefusal('together-ai')?.detail ?? '', /Credit limit exceeded/);

  noteByoCreditOutcome('moonshot', new Response('{"error":{"type":"rate_limit_reached_error"}}', { status: 429 }), 'POST');
  await settle();
  assert.equal(creditRefusal('moonshot'), undefined, 'a plain rate limit leaves the account alone');

  noteByoCreditOutcome('moonshot', new Response('{"error":{"type":"exceeded_current_quota_error"}}', { status: 429 }), 'POST');
  await settle();
  assert.equal(creditRefusal('moonshot')?.status, 429);
});

test('the response the SDK reads is untouched by the credit check', async () => {
  __resetProviderCreditForTests();
  const res = new Response('{"error":{"message":"insufficient balance"}}', { status: 429 });
  noteByoCreditOutcome('deepseek', res, 'POST');
  assert.equal(await res.text(), '{"error":{"message":"insufficient balance"}}');
});

test('Jev: an answer clears the account; a credit refusal latches it; a timeout does neither', () => {
  __resetProviderCreditForTests();
  noteJevCreditOutcome({ ok: false, reason: 'http_error', status: 402, body: 'Payment Required' });
  assert.equal(creditRefusal('jev')?.status, 402);
  noteJevCreditOutcome({ ok: false, reason: 'timeout' });
  assert.ok(creditRefusal('jev'));
  noteJevCreditOutcome({ ok: true, model: 'jev-test', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } });
  assert.equal(creditRefusal('jev'), undefined);
});
