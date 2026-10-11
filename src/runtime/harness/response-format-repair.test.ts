import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWholeResponseFormatFinding, responseFormatRepairPacket, wholeResponseFormatFinding,
  wholeResponseFormatRequirement } from './response-format-repair.js';
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
