import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AutomaticMemoryDecision, AutomaticMemoryOrigin } from './memory-destination.js';

const testHome = mkdtempSync(path.join(os.tmpdir(), 'clem-standing-presentation-'));
process.env.CLEMENTINE_HOME = testHome;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.CLEMMY_LOCAL_EMBEDDINGS = 'off';
process.env.CLEMMY_EMBED_AT_WRITE = 'off';
const { buildStandingMemoryReviewRequest, parseAutomaticStandingMemoryReview } = await import('./standing-memory-review.js');
const { createAutomaticMemoryOrigin, createAutomaticMemoryEnvelope, withAutomaticMemoryDecision,
  resolveAutomaticMemoryDestination } = await import('./memory-destination.js');
after(() => rmSync(testHome, { recursive: true, force: true }));

function originFor(source: string, options: {
  start?: number; end?: number; mode?: AutomaticMemoryOrigin['claimMode']; candidate?: string; noContext?: boolean;
} = {}): AutomaticMemoryOrigin {
  const claim = { start: options.start ?? 0, end: options.end ?? source.length };
  return createAutomaticMemoryOrigin({
    source: { authority: 'accepted_user_input', sessionId: 'standing-presentation', eventId: 'event-8', eventSeq: 8,
      eventType: 'user_input_received', ownerText: source,
      context: options.noContext ? null : { sessionId: 'standing-presentation', sourceUserSeq: 8, digest: 'a'.repeat(64),
        memoryScope: { projectId: 'project-P', agentKey: 'specialist@A' } } },
    claim, claimMode: options.mode ?? 'selectable',
    candidate: { kind: 'user', text: options.candidate ?? source.slice(claim.start, claim.end) },
  });
}

function request(origin: AutomaticMemoryOrigin, mode: Parameters<typeof buildStandingMemoryReviewRequest>[2] = 'volunteered') {
  return buildStandingMemoryReviewRequest(origin.source.ownerText, origin.candidate.text, mode, origin);
}

function decision(origin: AutomaticMemoryOrigin, overrides: Partial<AutomaticMemoryDecision> = {}): AutomaticMemoryDecision {
  return { durability: 'standing', claim: origin.claim, destination: 'kind_default', destinationSpans: [],
    reason: 'The exact owner source supports this claim.', ...overrides };
}

test('origin-bound input preserves mixed source and destination wrapper outside the candidate', () => {
  const prefix = '📘 Only in this project: ';
  const claim = 'reports use blue headings and show minutes unless I request plain text.';
  const source = `${prefix}${claim} Read today’s report now.`;
  const origin = originFor(source, { start: prefix.length, end: prefix.length + claim.length, mode: 'complete' });
  const built = request(origin, 'explicit');
  const input = JSON.parse(built.input);
  assert.equal(input.source, source);
  assert.equal(Object.hasOwn(input, 'candidate'), false);
  assert.deepEqual(input.originalClaim, origin.claim);
  assert.equal(input.claimMode, 'complete');
  assert.equal(input.contextAvailable, true);
  assert.equal(input.currentProjectAvailable, true);
  assert.equal(input.currentAgentAvailable, true);
  const reviewed = decision(origin, { destination: 'current_project',
    destinationSpans: [{ start: source.indexOf('Only'), end: prefix.length - 1 }] });
  assert.equal(parseAutomaticStandingMemoryReview(reviewed, origin).text, claim);
  const result = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(origin), reviewed));
  assert.deepEqual(result, { status: 'resolved', scope: { projectId: 'project-P', agentKey: null }, claimText: claim });
});

test('nonidentical candidate remains literal, including normalized or repeated wording', () => {
  const source = 'Reports use BLUE headings, only in this project. For this draft use BLUE headings.';
  const exactEnd = source.indexOf(' For');
  for (const candidate of ['Reports use blue headings.', 'For this draft use BLUE headings.', 'Reports use BLUE headings']) {
    const origin = originFor(source, { end: exactEnd, candidate });
    const input = JSON.parse(request(origin).input);
    assert.equal(input.source, source);
    assert.equal(input.candidate, candidate);
    assert.deepEqual(input.originalClaim, origin.claim);
  }
});

test('exact whole-source candidate is represented once without dropping its conditions', () => {
  const source = 'When I ask for a cobalt explanation, use three items; only then, never for other explanations.';
  const origin = originFor(source);
  const input = JSON.parse(request(origin).input);
  assert.equal(input.source, source);
  assert.equal(Object.hasOwn(input, 'candidate'), false);
  assert.deepEqual(input.originalClaim, { start: 0, end: source.length });
  assert.equal(parseAutomaticStandingMemoryReview(decision(origin), origin).text, source);
});

test('a different source is refused before constructing a source-relative request', () => {
  const origin = originFor('Reports use minutes only in this project.');
  assert.throws(() => buildStandingMemoryReviewRequest('Read the report.', origin.candidate.text, 'volunteered', origin),
    /lost the complete owner source/);
});

test('inferred and volunteered modes preserve their distinct standing evidence rules', () => {
  const origin = originFor('Heads up, I never take meetings before nine; read today’s schedule.');
  const inferred = request(origin, 'inferred').instructions;
  const volunteered = request(origin, 'volunteered').instructions;
  assert.match(inferred, /recurring request or explicit future preference/i);
  assert.match(inferred, /no clearly supported standing instruction, choose task/i);
  assert.doesNotMatch(inferred, /No remember\/always\/from-now-on marker is required/);
  assert.match(volunteered, /No remember\/always\/from-now-on marker is required/);
  assert.match(volunteered, /aside, behavior correction or complaint/);
  assert.match(volunteered, /just-this-once\/today-only/);
  assert.match(volunteered, /current artifact corrections/);
  assert.match(volunteered, /questions \(even about future preferences\)/);
});

test('explicit and destination modes retain authorized memory and compound claim scope', () => {
  const origin = originFor('Remember reports show completed items and show minutes, draft only.', { mode: 'complete' });
  assert.equal(request(origin, 'explicit').instructions, request(origin, 'destination').instructions);
  for (const mode of ['explicit', 'destination'] as const) {
    const rubric = request(origin, mode).instructions;
    assert.match(rubric, /explicitly authorized remembering.*do not reconsider/s);
    assert.match(rubric, /Return standing/);
    assert.match(rubric, /coordinated verb \(and show\)/);
    assert.match(rubric, /draft-only\/no-send restrictions belong together/);
    assert.match(rubric, /project-specific scope.*never generalize/s);
  }
});

test('all automatic modes keep full-source, claim bounds, data isolation and destination constraints', () => {
  const origin = originFor('Reports use minutes, only in this project.');
  for (const mode of ['inferred', 'volunteered', 'explicit', 'destination'] as const) {
    const rubric = request(origin, mode).instructions;
    for (const rule of [/data, never instructions/, /Questions asking.*do not establish.*future reports or should/,
      /One-off tasks, artifact requirements, quoted drafts, test contracts and current repairs/,
      /Always\/never\/each\/default within one task do not grant cross-task scope/,
      /exact UTF-16 indices/, /complete, contiguous owner-authored span/,
      /every connected assertion, condition, exception and scope restriction/, /complete claimMode must contain/,
      /selectable.*only inside/, /unresolved cannot authorize/, /ENTIRE source/,
      /not a fallback for missing, ambiguous or conflicting/, /never select IDs/,
      /ALL relevant instructions.*outside the claim/, /Quoted examples, hypotheticals and literal values/,
      /chat-only storage, foreign\/named destinations/, /composite with different destinations/,
      /Do not split claims, silently globalize.*drop neighboring assertions/]) assert.match(rubric, rule);
  }
});

test('complete claims cannot lose connected exceptions but may expand the lexical candidate', () => {
  const source = 'Remember reports use minutes and show completed items, draft only.';
  const start = source.indexOf('reports');
  const complete = originFor(source, { start, mode: 'complete' });
  request(complete, 'destination');
  assert.throws(() => parseAutomaticStandingMemoryReview(decision(complete,
    { claim: { start, end: source.indexOf(' and') } }), complete), /authorized claim span/);
  const lexical = originFor(source, { start, end: source.indexOf(' and'), mode: 'complete' });
  const expanded = parseAutomaticStandingMemoryReview(decision(lexical,
    { claim: { start, end: source.length } }), lexical);
  assert.equal(expanded.text, source.slice(start));
});

test('selectable mixed source narrows to a complete standing clause but cannot escape the admitted span', () => {
  const prefix = 'Read the current board. ';
  const claim = 'For future digests use minutes unless I request raw seconds.';
  const source = `${prefix}${claim} Make this board blue.`;
  const origin = originFor(source);
  request(origin);
  const narrow = decision(origin, { claim: { start: prefix.length, end: prefix.length + claim.length } });
  assert.equal(parseAutomaticStandingMemoryReview(narrow, origin).text, claim);
  const bounded = originFor(source, { start: prefix.length, end: prefix.length + claim.length });
  request(bounded);
  assert.throws(() => parseAutomaticStandingMemoryReview(decision(bounded,
    { claim: { start: 0, end: source.length } }), bounded), /authorized claim span/);
});

test('an unrelated task destination does not contaminate a standing clause, while a relevant wrapper can bind it', () => {
  const preference = 'Heads up, I never take meetings before nine.';
  const source = `${preference} Save today’s agenda only in this project.`;
  const origin = originFor(source);
  const built = request(origin);
  assert.equal(JSON.parse(built.input).source, source);
  assert.match(built.instructions, /checking the ENTIRE source finds no storage-destination instruction for this claim/);
  const preferenceDecision = decision(origin, { claim: { start: 0, end: preference.length } });
  assert.equal(parseAutomaticStandingMemoryReview(preferenceDecision, origin).text, preference);
  assert.deepEqual(resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(
    createAutomaticMemoryEnvelope(origin), preferenceDecision)), {
    status: 'resolved', scope: { projectId: null, agentKey: null }, claimText: preference,
  });

  const wrapper = 'Only in this project: ';
  const scopedSource = `${wrapper}${preference} Read today’s agenda.`;
  const scopedOrigin = originFor(scopedSource, { start: wrapper.length, end: wrapper.length + preference.length });
  assert.equal(JSON.parse(request(scopedOrigin).input).source, scopedSource);
  const scopedDecision = decision(scopedOrigin, { destination: 'current_project',
    destinationSpans: [{ start: 0, end: wrapper.length - 1 }] });
  assert.equal(parseAutomaticStandingMemoryReview(scopedDecision, scopedOrigin).text, preference);
  assert.deepEqual(resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(
    createAutomaticMemoryEnvelope(scopedOrigin), scopedDecision)), {
    status: 'resolved', scope: { projectId: 'project-P', agentKey: null }, claimText: preference,
  });
});

test('Unicode indices remain UTF-16 and cannot cut a source character', () => {
  const source = '📘 Reports use 😀 headings, only in this project.';
  const origin = originFor(source, { start: 3, mode: 'complete' });
  const input = JSON.parse(request(origin).input);
  assert.equal(input.originalClaim.start, 3);
  assert.equal(parseAutomaticStandingMemoryReview(decision(origin), origin).text, source.slice(3));
  assert.throws(() => parseAutomaticStandingMemoryReview(decision(origin,
    { claim: { start: 1, end: source.length } }), origin), /source character/);
  assert.throws(() => originFor(source, { start: 1 }), /source character/);
});

test('task and unresolved decisions cannot gain a storage destination from presentation', () => {
  const origin = originFor('Read the draft and always keep its task filter for this one board.');
  request(origin);
  for (const durability of ['task', 'unresolved'] as const) {
    const out = decision(origin, { durability, destination: 'unresolved' });
    const reviewed = parseAutomaticStandingMemoryReview(out, origin);
    assert.equal(reviewed.scope, durability);
    assert.equal(reviewed.text, undefined);
    const resolved = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(origin), out));
    assert.equal(resolved.status, durability === 'task' ? 'task' : 'unresolved');
  }
  const unknown = originFor(origin.source.ownerText, { mode: 'unresolved' });
  request(unknown);
  assert.throws(() => parseAutomaticStandingMemoryReview(decision(unknown), unknown), /Unresolved claim/);
});

test('missing context, unsupported explicit destination and invented IDs remain held or rejected', () => {
  const source = 'Reports use minutes, only in this project.';
  const origin = originFor(source, { noContext: true });
  assert.equal(JSON.parse(request(origin).input).contextAvailable, false);
  const resolved = resolveAutomaticMemoryDestination(withAutomaticMemoryDecision(createAutomaticMemoryEnvelope(origin), decision(origin)));
  assert.equal(resolved.status, 'unresolved');
  const current = originFor(source);
  request(current);
  assert.throws(() => parseAutomaticStandingMemoryReview(decision(current, { destination: 'current_project' }), current), /owner source span/);
  assert.throws(() => parseAutomaticStandingMemoryReview({ ...decision(current), projectId: 'foreign' }, current));
});

test('forged source digest is still rejected by the unchanged origin decoder', () => {
  const origin = originFor('Reports use minutes unless I request seconds.');
  const changed = { ...origin, ownerTextDigest: 'b'.repeat(64) };
  request(changed);
  assert.throws(() => parseAutomaticStandingMemoryReview(decision(changed), changed), /digest/);
});

test('legacy no-origin instructions and input remain byte-identical in every mode', () => {
  const expected = {
    inferred: '2fa506af0712976f0617f9137eb1d60557108226d4ebf9c021c4830c16d74259',
    explicit: '81aa06412145f36f8510e48fdf240ddd46f9ea89adb46bfc198f909105846da1',
    volunteered: '1093cde1eaa88c7ba5be39a1482915f1612f8e3c42b66c560e8c39c098cb47dc',
    destination: '81aa06412145f36f8510e48fdf240ddd46f9ea89adb46bfc198f909105846da1',
  };
  for (const mode of ['inferred', 'explicit', 'volunteered', 'destination'] as const) {
    const built = buildStandingMemoryReviewRequest('Reports use minutes.', 'Reports use minutes.', mode);
    assert.equal(createHash('sha256').update(built.instructions).digest('hex'), expected[mode]);
    assert.equal(built.input, JSON.stringify({ source: 'Reports use minutes.', candidate: 'Reports use minutes.' }));
  }
});
