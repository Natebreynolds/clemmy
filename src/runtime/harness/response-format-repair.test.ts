import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWholeResponseFormatFinding, responseFormatRepairPacket, wholeResponseFormatFinding,
  wholeResponseFormatRequirement, exactJsonObjectOuterFence, normalizeWholeResponseFence,
  responseFenceNormalizationCurrent, captureOwnerResponseFormat, ownerResponseFormatCurrent,
  ownerResponseFormatGuidance, currentOwnerResponseFormatRequirement } from './response-format-repair.js';
import { bindCompletedModelResponse } from './model-response-binding.js';

test('author format guidance belongs only to the private exact current request owner and never approves a reply', () => {
  const owner = { sessionId: 'owner-format', sourceUserSeq: 4, attemptId: 'attempt:owner-format',
    objective: 'Return exactly one JSON object.', ownerInstructions: ['Return exactly one JSON object.'] };
  const capture = captureOwnerResponseFormat(owner)!;
  assert.ok(capture);
  const guidance = ownerResponseFormatGuidance(capture, owner)!;
  assert.match(guidance, /final answer only/);
  assert.match(guidance, /uncertainty, contrary evidence and qualifications inside/);
  assert.match(guidance, /does not change tool arguments/);
  assert.doesNotMatch(guidance, /independent.*review|REVISE_REPLY/);
  assert.equal(wholeResponseFormatFinding(capture, '{"uncertain":true}'), null);
  assert.ok(wholeResponseFormatFinding(capture, '```json\n{}\n```\nThe result is uncertain.'));
  for (const changed of [{ sessionId: 'foreign' }, { sourceUserSeq: 5 }, { attemptId: 'attempt:other' },
    { objective: 'Return exactly one JSON object with another value.' },
    { ownerInstructions: [...owner.ownerInstructions, 'Instead, reply in prose.'] }]) {
    assert.equal(ownerResponseFormatCurrent(capture, { ...owner, ...changed }), false);
    assert.equal(ownerResponseFormatGuidance(capture, { ...owner, ...changed }), undefined);
  }
  assert.equal(ownerResponseFormatGuidance({ ...capture }, owner), undefined, 'serialized metadata cannot supply the capture');
  assert.equal(captureOwnerResponseFormat({ ...owner, ownerInstructions: ['Discuss "Return exactly one JSON object."'] }), undefined);
  assert.equal(captureOwnerResponseFormat({ ...owner, ownerInstructions: [...owner.ownerInstructions, 'Reply in Markdown.'] }), undefined);
  assert.equal(captureOwnerResponseFormat({ ...owner, attemptId: '' }), undefined);
  owner.ownerInstructions.push('Reply in plain text.');
  assert.equal(ownerResponseFormatCurrent(capture, owner), false, 'late owner mutation cannot borrow earlier guidance');
});

test('current format cancellation is known while unavailable, proxy and accessor owners remain unknown without executing hooks', () => {
  const owner = { sessionId: 'owner-format-current', sourceUserSeq: 10, attemptId: 'attempt:owner-format-current',
    objective: 'Return exactly one JSON object.', ownerInstructions: ['Return exactly one JSON object.'], maxLogicalCalls: 20 };
  const capture = captureOwnerResponseFormat(owner)!;
  const changed = { ...owner, objective: 'Return exactly one JSON object and preserve uncertainty.',
    ownerInstructions: [...owner.ownerInstructions, 'Return exactly one JSON object and preserve uncertainty.'] };
  assert.equal(ownerResponseFormatCurrent(capture, changed), false);
  assert.deepEqual(currentOwnerResponseFormatRequirement(changed), { kind: 'whole_json_object' }, 'changed capture cannot waive a current contract');
  assert.equal(currentOwnerResponseFormatRequirement({ ...changed,
    ownerInstructions: [...changed.ownerInstructions, 'Instead, reply in plain text.'] }), null);
  assert.equal(currentOwnerResponseFormatRequirement(undefined), undefined);
  assert.equal(currentOwnerResponseFormatRequirement({ ...owner, attemptId: '' }), undefined);
  let hooks = 0;
  const accessor = { ...owner };
  Object.defineProperty(accessor, 'ownerInstructions', { get() { hooks += 1; return owner.ownerInstructions; } });
  const proxy = new Proxy(owner, { get() { hooks += 1; throw new Error('private data must not escape'); },
    ownKeys() { hooks += 1; throw new Error('private keys must not escape'); } });
  const withHook = { ...owner, toJSON() { hooks += 1; return owner; } };
  const instructionProxy = { ...owner, ownerInstructions: new Proxy(owner.ownerInstructions, {
    get() { hooks += 1; return 'Return exactly one JSON object.'; } }) };
  const sparse: string[] = []; sparse.length = 1; Object.defineProperty(sparse, '4294967295', { value: 'Return one JSON object.', enumerable: true });
  for (const unknown of [accessor, proxy, withHook, instructionProxy, { ...owner, ownerInstructions: sparse }]) {
    assert.equal(currentOwnerResponseFormatRequirement(unknown), undefined);
    assert.equal(captureOwnerResponseFormat(unknown), undefined);
    assert.equal(ownerResponseFormatGuidance(capture, unknown), undefined);
  }
  assert.equal(hooks, 0, 'no proxy/getter/toJSON is called to supply format authority');
});

test('exact outer envelope slices unchanged UTF-8 object bytes and declines every broader repair', () => {
  const text = ' \n{"value":"é","qualification":"unknown","nested":[1]}\t';
  const raw = `\`\`\`json\r\n${text}\r\n\`\`\``;
  const envelope = exactJsonObjectOuterFence(raw)!;
  assert.equal(envelope.text, text);
  assert.equal(Buffer.from(raw).subarray(envelope.startByte, envelope.endByte).toString(), text);
  for (const bad of [`Intro\n${raw}`, `${raw}\nDone.`, `${raw}\n${raw}`, '```json\n[]\n```',
    '```json\nnull\n```', '```json\n{}{}\n```', '```text\n{}\n```', '```json\n{bad}\n```',
    '```json\n{}\n```\n', '```json\n{}\n````']) assert.equal(exactJsonObjectOuterFence(bad), null);
});

test('private original-response and exact current owner proof fence normalization, never a same-ID clone', () => {
  const raw = '```json\n{"value":"é","unknown":true}\n```';
  const response = { responseId: 'exact-fence-response', output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: raw }] }] };
  const binding = bindCompletedModelResponse(response, 'exact-fence-model-call', 1)!;
  const owner = { sessionId: 'exact-fence-source', sourceUserSeq: 10, attemptId: 'attempt:exact-fence',
    objective: 'Return only one JSON object.', ownerInstructions: ['Return only one JSON object.'] };
  const normalization = normalizeWholeResponseFence({ owner, response, observedBinding: binding, rawReply: raw })!;
  assert.ok(normalization);
  assert.ok(responseFenceNormalizationCurrent(normalization, owner, raw));
  for (const changed of [{ sessionId: 'other' }, { sourceUserSeq: 11 }, { attemptId: 'attempt:other' },
    { objective: 'Amended request.' }, { ownerInstructions: [...owner.ownerInstructions, 'Instead, reply in Markdown.'] }]) {
    assert.equal(responseFenceNormalizationCurrent(normalization, { ...owner, ...changed }, raw), false);
  }
  assert.equal(responseFenceNormalizationCurrent({ ...normalization }, owner, raw), false);
  assert.equal(normalizeWholeResponseFence({ owner, response: structuredClone(response), observedBinding: binding, rawReply: raw }), null);
  assert.equal(normalizeWholeResponseFence({ owner, response, observedBinding: { ...binding, modelCallId: 'stale-call' }, rawReply: raw }), null);
  assert.equal(normalizeWholeResponseFence({ owner: { ...owner, ownerInstructions: ['Discuss "Return only one JSON object."'] },
    response, observedBinding: binding, rawReply: raw }), null);
  response.output[0]!.content[0]!.text = raw.replace('é', 'changed');
  assert.equal(responseFenceNormalizationCurrent(normalization, owner, raw), false, 'late original-output mutation cannot ship');
});
test('format repair retains the complete objective and draft and excludes work/Plan/failed reviews', () => {
  const input = { done: false, repairScope: 'reply_format' as const, plan: false,
    objective: 'Return only the count.', reply: 'In one batch: 4', reason: 'Remove preamble.' };
  const packet = responseFormatRepairPacket(input)!;
  assert.deepEqual(JSON.parse(packet.text), { objective: input.objective, draft: input.reply, correction: input.reason });
  for (const extra of [{done:true},{failedOpen:true},{awaitingUser:true},{blocked:true},{plan:true},{repairScope:undefined}]) {
    assert.equal(responseFormatRepairPacket({...input,...extra}), null);
  }
  assert.equal(responseFormatRepairPacket({...input,reply:'x'.repeat(24_001)}), null);
});

test('only explicit direct whole-output object commands supply a format requirement', () => {
  for (const command of ['Return one bounded JSON object with counts and scenarios.',
    'Return only a JSON object, no prose or fences.', 'Respond with exactly one JSON object.',
    'Explain the evidence.\nPlease output a single valid JSON object.']) {
    assert.deepEqual(wholeResponseFormatRequirement([command]), { kind: 'whole_json_object' }, command);
  }
  for (const example of ['Explain what a JSON object is.', 'Return a JSON object as an example.',
    'Summarize this example: "Return only one JSON object."', "Discuss 'Return only one JSON object.'",
    'Describe this code:\n```text\nReturn only one JSON object.\n```', 'Describe this code:\n```text\nReturn only one JSON object.',
    'Describe this quote: "\nReturn only one JSON object.\n"', '> Return only one JSON object.',
    'Do not return one JSON object.', 'Write a function that returns one bounded JSON object.',
    'Return only a JSON array.']) assert.equal(wholeResponseFormatRequirement([example]), null, example);
});

test('current format amendments override an inherited requirement without inventing a new schema', () => {
  const original = 'Return one bounded JSON object with scenarios.';
  assert.equal(wholeResponseFormatRequirement([original, 'Continue. Instead, reply in plain text.']), null);
  assert.equal(wholeResponseFormatRequirement([original, "Do not use JSON anymore."]), null);
  assert.equal(wholeResponseFormatRequirement([original, "Don't use JSON. It's not the required format."]), null,
    'apostrophes in owner amendments are not quoted examples');
  assert.equal(wholeResponseFormatRequirement([original, 'Actually, return a JSON array.']), null);
  assert.deepEqual(wholeResponseFormatRequirement([original, 'Continue with the same deliverable.']), { kind: 'whole_json_object' });
  assert.deepEqual(wholeResponseFormatRequirement(['Reply in Markdown. Return only one JSON object.']), { kind: 'whole_json_object' });
});

test('the original controlled live prompt supplies its Then-return object contract without inventing a scenarios array', () => {
  const prompt = 'Use read_file to actually read this exact local file once: controlled-fixture.txt. '
    + 'Do not infer its contents from its name or this prompt. Use path and max_chars:null. '
    + 'Then return one bounded JSON object with keys first_count, remaining_count, byte_count, '
    + 'and scenarios. Compute both exact-line counts and UTF-8 byte count from the file. '
    + 'scenarios must contain six concise entries: Stop before dispatch, Stop after settled read, '
    + 'Stop after settled write, uncertain write outcome, repeated Continue, and stale Stop. '
    + 'For each give the correct next action and what evidence would justify it. '
    + 'Keep the complete reply under 350 words. This is analysis only: no writes, sends, external '
    + 'calls, browser, shell, models-as-tools, delegation, settings changes or workflow execution.';
  const requirement = wholeResponseFormatRequirement([prompt]);
  assert.deepEqual(requirement, { kind: 'whole_json_object' });
  assert.equal(wholeResponseFormatRequirement([`Discuss this example: "${prompt}"`]), null);
  assert.equal(wholeResponseFormatRequirement([`Describe this code:\n\`\`\`text\n${prompt}\n\`\`\``]), null);
  assert.equal(wholeResponseFormatFinding(requirement, JSON.stringify({ first_count: 1, remaining_count: 1,
    byte_count: 16, scenarios: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f' } })), null);
  assert.match(wholeResponseFormatFinding(requirement, 'Here is the answer:\n```json\n{}\n```')!, /whole-output JSON/);
});

test('whole-response validation never accepts a JSON substring or manufactures nested shape requirements', () => {
  const requirement = wholeResponseFormatRequirement(['Return one bounded JSON object.']);
  const truthful = { first_count: 1, remaining_count: 1, byte_count: 16,
    scenarios: { uncertain: 'Unresolved: do not repeat the write.' }, semanticCompleteness: 'unknown' };
  const text = JSON.stringify(truthful);
  for (const bad of [`Here is the answer:\n${text}`, `\`\`\`json\n${text}\n\`\`\``, `${text}\nDone.`,
    `Notes.\n\`\`\`json\n${text}\n\`\`\`\nNo writes.`, JSON.stringify(text), '[]', 'null', '{}{}']) {
    assert.match(wholeResponseFormatFinding(requirement, bad)!, /complete answer does not parse as a JSON object/);
  }
  assert.equal(wholeResponseFormatFinding(requirement, ` \n${text}\t`), null);
  assert.equal(wholeResponseFormatFinding(null, 'Ordinary prose.'), null);
});

test('a format floor only rejects and preserves semantic findings, review provenance and honest pauses', () => {
  const finding = wholeResponseFormatFinding({ kind: 'whole_json_object' }, 'prose')!;
  const positive = { done: true, reason: 'The factual values are supported.', selfJudge: true,
    evidenceCoverage: { status: 'sufficient' }, judgeModelId: 'owner-selected-reviewer' };
  assert.deepEqual(applyWholeResponseFormatFinding(positive, finding), { ...positive,
    done: false, repairScope: 'reply_format', reason: `${positive.reason}\n${finding}` });
  const semantic = { ...positive, done: false, repairScope: 'claims' as const, reason: 'The write outcome is uncertain.' };
  const rejected = applyWholeResponseFormatFinding(semantic, finding);
  assert.equal(rejected.done, false);
  assert.equal(rejected.repairScope, 'claims');
  assert.match(rejected.reason, /^The write outcome is uncertain/);
  assert.match(rejected.reason, /whole-output/);
  for (const qualifier of [{ failedOpen: true }, { awaitingUser: true }, { blocked: true }]) {
    const verdict = { ...positive, ...qualifier };
    assert.equal(applyWholeResponseFormatFinding(verdict, finding), verdict);
  }
  assert.equal(applyWholeResponseFormatFinding(semantic, null), semantic, 'format passing cannot approve semantic failure');
});

test('a format packet preserves full stopped/current/standing requirements and truthful raw draft', () => {
  const draft = 'Evidence:\n```json\n{"byte_count":16,"uncertain":"do not repeat","scenarios":{"read":"retained"}}\n```';
  const effectiveObjective = 'Stopped objective: Return one bounded JSON object. No repeated writes.\n'
    + 'Current amendment: Continue using saved reads.\nStanding rule: keep unknown effects uncertain.';
  const packet = responseFormatRepairPacket({ done: false, repairScope: 'reply_format', plan: false,
    objective: 'Continue.', effectiveObjective, reply: draft, reason: 'Remove prose and fence.' })!;
  assert.deepEqual(JSON.parse(packet.text), { objective: effectiveObjective, draft, correction: 'Remove prose and fence.' });
  assert.match(packet.instructions, /Preserve all factual values, qualifications/);
  assert.match(packet.instructions, /same independent evidence review/);
  assert.equal(responseFormatRepairPacket({ done: false, repairScope: 'reply_format', plan: false,
    objective: 'Continue.', effectiveObjective: effectiveObjective.repeat(1_000), reply: draft, reason: 'Remove prose.' }), null,
    'oversize full context falls back to normal review feedback rather than clipping required facts');
});

test('P0 direct bare object wording reaches current author guidance and rejects plain key-value output', () => {
  const prompt = 'Use read_file to actually read the named controlled fixture once. '
    + 'Return a bare JSON object with keys first_count, remaining_count, byte_count, and uncertain_write_next_action. '
    + 'Compute the counts from the file. Explain the next action for an uncertain write without treating missing receipts as settlement. '
    + 'This is analysis only; do not write or send anything.';
  const owner = { sessionId: 'bare-p0-owner', sourceUserSeq: 25, attemptId: 'attempt:bare-p0-owner',
    objective: prompt, ownerInstructions: [prompt] };
  const capture = captureOwnerResponseFormat(owner);
  assert.ok(capture, 'the actual P0 command wording must reach the existing request-owner capture');
  assert.deepEqual(currentOwnerResponseFormatRequirement(owner), { kind: 'whole_json_object' });
  assert.ok(ownerResponseFormatGuidance(capture, owner), 'recognized owner contract enables the existing final-answer-only guidance');
  const lines = 'first_count: 1\nremaining_count: 1\nbyte_count: 16\nuncertain_write_next_action: Reconcile the exact operation before deciding whether to retry.';
  const finding = wholeResponseFormatFinding(currentOwnerResponseFormatRequirement(owner)!, lines);
  assert.ok(finding, 'four plain key/value lines are not an entire JSON object');
  const contradictory = { done: false, reason: 'The claimed operation settlement is unsupported.', repairScope: 'claims' as const,
    evidenceCoverage: { status: 'unsupported' }, judgeModelId: 'controlled-reviewer' };
  const held = applyWholeResponseFormatFinding(contradictory, finding);
  assert.equal(held.done, false); assert.equal(held.repairScope, 'claims');
  assert.equal(held.evidenceCoverage, contradictory.evidenceCoverage); assert.equal(held.judgeModelId, contradictory.judgeModelId);
  assert.ok(held.reason.startsWith(contradictory.reason), 'recognition cannot turn a semantic rejection into formatting-only work');
  const valid = JSON.stringify({ first_count: 1, remaining_count: 1, byte_count: 16,
    uncertain_write_next_action: 'Reconcile the exact operation; current authority remains required.', unknown: true });
  assert.equal(wholeResponseFormatFinding(currentOwnerResponseFormatRequirement(owner)!, valid), null,
    'valid object may carry facts and uncertainty; no nested schema is invented');
  for (const bad of [`\`\`\`json\n${valid}\n\`\`\``, `${valid}\nDone.`, `[${valid}]`, 'null']) {
    assert.ok(wholeResponseFormatFinding(currentOwnerResponseFormatRequirement(owner)!, bad));
  }
  for (const extra of [{ failedOpen: true }, { awaitingUser: true }, { blocked: true }]) {
    const unavailable = { done: true, reason: 'An existing truthful control or unavailable review.', ...extra };
    assert.equal(applyWholeResponseFormatFinding(unavailable, finding), unavailable);
  }
});

test('bare is an explicit direct whole-output modifier, never quoted or value-data authority', () => {
  for (const command of ['Return a bare JSON object.', 'Please output one bare JSON object.',
    'Respond with a bare valid JSON object.', 'Reply with only a bare JSON object.',
    'Explain the evidence.\nThen, emit a bare JSON object.', 'RETURN A BARE JSON OBJECT.']) {
    assert.deepEqual(wholeResponseFormatRequirement([command]), { kind: 'whole_json_object' }, command);
  }
  for (const data of ['Discuss "Return a bare JSON object."', "Discuss 'Return a bare JSON object.'",
    'Describe this code:\n```text\nReturn a bare JSON object.\n```',
    'Describe this code:\n```text\nReturn a bare JSON object.', '> Return a bare JSON object.',
    'Inspect `Return a bare JSON object.`', 'The tool returned: Return a bare JSON object.',
    'Write a function that returns a bare JSON object.', 'Do not return a bare JSON object.',
    'Return a bare JSON array.', 'Return a JSON object with the word bare in a value.']) {
    assert.equal(wholeResponseFormatRequirement([data]), null, data);
  }
});

test('bare-format amendments retain ordering and cannot borrow a stale owner capture', () => {
  const bare = 'Return a bare JSON object.';
  const owner = { sessionId: 'bare-amendment-owner', sourceUserSeq: 26, attemptId: 'attempt:bare-amendment-owner',
    objective: bare, ownerInstructions: [bare] };
  const capture = captureOwnerResponseFormat(owner)!;
  for (const replacement of ['Actually, reply in plain text.', "Don't use JSON anymore.", 'Instead, return a JSON array.',
    'Reply in Markdown.']) {
    const amended = { ...owner, ownerInstructions: [bare, replacement] };
    assert.equal(currentOwnerResponseFormatRequirement(amended), null, replacement);
    assert.equal(ownerResponseFormatGuidance(capture, amended), undefined, 'later cancellation cannot retain earlier guidance');
  }
  assert.deepEqual(wholeResponseFormatRequirement(['Reply in plain text.', bare]), { kind: 'whole_json_object' });
  assert.equal(wholeResponseFormatRequirement([`${bare} Actually, reply in plain text.`]), null);
  assert.deepEqual(wholeResponseFormatRequirement([`Reply in plain text. Then, ${bare}`]), { kind: 'whole_json_object' });
  assert.deepEqual(wholeResponseFormatRequirement([bare, 'Continue with the same deliverable.']), { kind: 'whole_json_object' });
  for (const change of [{ sourceUserSeq: 27 }, { attemptId: 'attempt:other-bare' }, { objective: 'Different objective.' }]) {
    assert.equal(ownerResponseFormatGuidance(capture, { ...owner, ...change }), undefined);
  }
  assert.equal(ownerResponseFormatGuidance({ ...capture }, owner), undefined, 'serialized copy grants no format-owner proof');
});
