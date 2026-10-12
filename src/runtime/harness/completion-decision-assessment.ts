import { createHash } from 'node:crypto';

export const REVIEW_ASSESSMENT_MAX_BYTES = 4096;
export const COMPLETION_DECISION_ASSESSMENT_INSTRUCTIONS = `HOST COMPLETION RESPONSE PROTOCOL: Within this same review, emit one REVIEW_ASSESSMENT: JSON line before exactly one existing control verdict line. Do not add a model call, a user deliverable or private scratch reasoning. Keep the JSON at most 4096 UTF-8 bytes, with version:1, coverage:"complete"|"partial"|"uncertain", and decisions:[{claim,premise,basis,consequence,contrary:{status:"none"|"resolved"|"unresolved",reason},status:"supported"|"contradicted"|"unverified"}]. Use exact closed object keys: root has only version,coverage,decisions; every decision has only claim,premise,basis,consequence,contrary,status; contrary has only status,reason. Do not omit or add keys, or repeat a JSON key at any depth. version is the number 1; coverage and both status fields are the named strings; decisions is an array of 1 to 16 objects. claim, premise, basis, consequence and contrary.reason must each be a string that is nonempty after trimming and at most 512 UTF-8 bytes. contrary must always be an object, and even status:"none" requires a nonempty reason, such as "No contrary evidence appears in the supplied view". Do not use null, arrays or objects for these text fields. These bounds are resource limits, not a decision quota: if the whole material assessment cannot fit, report partial or uncertain coverage instead of dropping material decisions or claiming complete coverage. Use concise externally checkable justifications: the actual candidate conclusion, its condition, applicable rule or exact observation at the required identity/time/scope, resulting consequence and any contrary evidence. Include materially requested decisions and artifact-only results; do not invent a decision quota. Missing evidence, uncertain authority or a counterexample consistent with the premise must remain unverified; resolve contrary evidence instead of counting topics or receipts. These are your assessments, not host-certified truth or upstream completeness. DONE and format-only REVISE_REPLY require complete assessment with every material decision supported and contrary evidence resolved. Preserve genuine CORRECT, INCOMPLETE, BLOCKED and AWAITING meanings. Existing NEEDS ALL OF and MEMORY_REQUIREMENT lines are independent and remain required when requested. Complete reply example:\nREVIEW_ASSESSMENT: {"version":1,"coverage":"complete","decisions":[{"claim":"B meets capacity","premise":"capacity required is 12","basis":"verified A=8/B=16; capacity precedes price","consequence":"B qualifies; A does not","contrary":{"status":"resolved","reason":"A is cheaper but cannot meet capacity"},"status":"supported"}]}\nDONE: B alone meets capacity 12; A=8 does not, and its lower price cannot overcome that requirement.`;

export type AssessmentReason = 'missing' | 'malformed' | 'over_budget' | 'control_invalid' | 'partial' | 'uncertain' | 'contradicted' | 'unverified' | 'original_unbound' | 'consistent';
const MALFORMED_ISSUES = ['framing', 'order', 'aux_duplicate', 'json', 'duplicate_keys', 'root_keys', 'types', 'decision_count', 'row_text_enum', 'contrary_shape'] as const;
export type AssessmentMalformedIssue = typeof MALFORMED_ISSUES[number];
interface UnverifiedAssessmentFlags {
  assessedDecisionCount: number;
  unverifiedDecisionCount: number;
  unresolvedContraryCount: number;
  firstUnverifiedDecisionIndex?: number;
  firstUnresolvedContraryIndex?: number;
  assessmentControlMarker: AssessmentControl['marker'];
}
const UNVERIFIED_FIELDS = ['assessedDecisionCount','unverifiedDecisionCount','unresolvedContraryCount',
  'firstUnverifiedDecisionIndex','firstUnresolvedContraryIndex','assessmentControlMarker'] as const;
export interface CompletionReviewAssessmentDiagnostic extends Partial<UnverifiedAssessmentFlags> {
  version: 1;
  /** Protocol/self-consistency only; the caller separately requires an
   * original same-call binding. Neither is semantic or objective certification. */
  status: 'qualified' | 'unqualified';
  reason: AssessmentReason;
  rawOutputSha256: string;
  rawOutputBytes: number;
  packetSha256?: string;
  packetBytes?: number;
  /** Fixed first parser failure category only; never reviewer text or truth. */
  malformedIssue?: AssessmentMalformedIssue;
  /** First failing decision ordinal, only for row-local structural failures. */
  malformedRowIndex?: number;
  originalModelCallId?: string;
  physicalAttempt?: number;
  providerResponseIdDigest?: string;
}
export interface AssessmentControl { marker: 'DONE' | 'AWAITING' | 'INCOMPLETE' | 'CORRECT' | 'BLOCKED' | 'REVISE_REPLY' | 'NOT-DONE'; reason: string }
export interface CompletionDecisionAssessment {
  control?: AssessmentControl;
  /** Declared consistency only. It never establishes semantic truth. */
  diagnostic: CompletionReviewAssessmentDiagnostic;
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(',') === expected.sort().join(',');
const smallText = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 512;

/** JSON.parse alone accepts repeated keys. Walk the already-valid grammar and
 * reject them at every object depth, including the assessment's contrary row. */
function uniqueJsonKeys(text: string): boolean {
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) { const ch = text[at++]!; if (ch === '\\') at++; else if (ch === '"') return JSON.parse(text.slice(start, at)); }
    throw new Error('unterminated string');
  };
  const value = (): void => {
    whitespace();
    if (text[at] === '{') {
      at++; whitespace(); const seen = new Set<string>();
      if (text[at] === '}') { at++; return; }
      for (;;) {
        whitespace(); if (text[at] !== '"') throw new Error('key');
        const key = string(); if (seen.has(key)) throw new Error('duplicate'); seen.add(key);
        whitespace(); if (text[at++] !== ':') throw new Error('colon'); value(); whitespace();
        if (text[at] === '}') { at++; return; } if (text[at++] !== ',') throw new Error('comma');
      }
    }
    if (text[at] === '[') {
      at++; whitespace(); if (text[at] === ']') { at++; return; }
      for (;;) { value(); whitespace(); if (text[at] === ']') { at++; return; } if (text[at++] !== ',') throw new Error('comma'); }
    }
    if (text[at] === '"') { string(); return; }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    if (!primitive) throw new Error('value'); at += primitive[0].length;
  };
  try { value(); whitespace(); return at === text.length; } catch { return false; }
}

/** Only reserved top-level reviewer lines are control. Quoted/fenced JSON,
 * user candidates and marker strings inside packet values remain data. */
export function parseCompletionDecisionAssessment(output: unknown): CompletionDecisionAssessment {
  const raw = typeof output === 'string' ? output : '';
  const base = { version: 1 as const, rawOutputSha256: hash(raw), rawOutputBytes: Buffer.byteLength(raw, 'utf8') };
  const lines = raw.split(/\r?\n/);
  const packets: Array<{ text: string; index: number }> = [];
  const controls: Array<AssessmentControl & { index: number }> = [];
  const auxiliary: Array<{ kind: string; index: number }> = [];
  let fenced = false; let extra = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; extra = true; continue; }
    if (fenced || /^\s*>/.test(line)) { if (line.trim()) extra = true; continue; }
    const packet = /^REVIEW_ASSESSMENT:[ \t]*(.*)$/.exec(line);
    if (packet) { packets.push({ text: packet[1]!, index }); continue; }
    const control = /^(DONE|AWAITING|INCOMPLETE|CORRECT|BLOCKED|REVISE_REPLY|NOT-DONE):[ \t]*(.*)$/.exec(line);
    if (control) { controls.push({ marker: control[1] as AssessmentControl['marker'], reason: control[2]!, index }); continue; }
    const auxiliaryLine = /^(NEEDS ALL OF|MEMORY_REQUIREMENT):/.exec(line);
    if (auxiliaryLine) auxiliary.push({kind:auxiliaryLine[1]!,index});
    else if (line.trim()) extra = true;
  }
  const control = controls.length === 1 && controls[0]!.reason.trim() ? controls[0]! : undefined;
  const fail = (reason: AssessmentReason, packet?: { text: string }, malformed?: { issue: AssessmentMalformedIssue; rowIndex?: number },
    unverified?: UnverifiedAssessmentFlags): CompletionDecisionAssessment => ({
    ...(control ? { control: { marker: control.marker, reason: control.reason } } : {}),
    diagnostic: { ...base, status: 'unqualified', reason,
      ...(packet ? { packetSha256: hash(packet.text), packetBytes: Buffer.byteLength(packet.text, 'utf8') } : {}),
      ...(malformed ? { malformedIssue: malformed.issue, ...(malformed.rowIndex !== undefined ? { malformedRowIndex: malformed.rowIndex } : {}) } : {}),
      ...(unverified ?? {}) },
  });
  if (!control || Buffer.byteLength(control.reason, 'utf8') > 6400) return fail('control_invalid');
  if (packets.length === 0) return fail('missing');
  if (packets.length !== 1) return fail('malformed', undefined, { issue: 'framing' });
  const packet = packets[0]!;
  if (Buffer.byteLength(packet.text, 'utf8') > REVIEW_ASSESSMENT_MAX_BYTES) return fail('over_budget', packet);
  if (packet.index >= control.index) return fail('malformed', packet, { issue: 'order' });
  if (extra) return fail('malformed', packet, { issue: 'framing' });
  if (auxiliary.some(line => line.index <= control.index)) return fail('malformed', packet, { issue: 'order' });
  if (new Set(auxiliary.map(line => line.kind)).size !== auxiliary.length) return fail('malformed', packet, { issue: 'aux_duplicate' });
  let parsed: unknown;
  try { parsed = JSON.parse(packet.text); } catch { return fail('malformed', packet, { issue: 'json' }); }
  if (!uniqueJsonKeys(packet.text)) return fail('malformed', packet, { issue: 'duplicate_keys' });
  if (!record(parsed)) return fail('malformed', packet, { issue: 'types' });
  if (!keys(parsed, ['version', 'coverage', 'decisions'])) return fail('malformed', packet, { issue: 'root_keys' });
  if (parsed.version !== 1 || (typeof parsed.coverage !== 'string' || !['complete', 'partial', 'uncertain'].includes(parsed.coverage))
    || !Array.isArray(parsed.decisions)) return fail('malformed', packet, { issue: 'types' });
  if (parsed.decisions.length === 0 || parsed.decisions.length > 16) return fail('malformed', packet, { issue: 'decision_count' });
  for (const [rowIndex, row] of parsed.decisions.entries()) {
    if (!record(row) || !keys(row, ['claim', 'premise', 'basis', 'consequence', 'contrary', 'status'])) return fail('malformed', packet, { issue: 'types', rowIndex });
    if (![row.claim, row.premise, row.basis, row.consequence].every(smallText)
      || (typeof row.status !== 'string' || !['supported', 'contradicted', 'unverified'].includes(row.status))) return fail('malformed', packet, { issue: 'row_text_enum', rowIndex });
    if (!record(row.contrary) || !keys(row.contrary, ['status', 'reason'])
      || (typeof row.contrary.status !== 'string' || !['none', 'resolved', 'unresolved'].includes(row.contrary.status)) || !smallText(row.contrary.reason)) return fail('malformed', packet, { issue: 'contrary_shape', rowIndex });
  }
  if (parsed.coverage === 'partial') return fail('partial', packet);
  if (parsed.coverage === 'uncertain') return fail('uncertain', packet);
  if (parsed.decisions.some(row => row.status === 'contradicted')) return fail('contradicted', packet);
  if (parsed.decisions.some(row => row.status === 'unverified' || row.contrary.status === 'unresolved')) {
    // Counts/ordinals describe only this already-valid declared packet. They
    // do not persist claims, infer resources or qualify its control as truth.
    const unverified = parsed.decisions.flatMap((row, index) => row.status === 'unverified' ? [index] : []);
    const unresolved = parsed.decisions.flatMap((row, index) => row.contrary.status === 'unresolved' ? [index] : []);
    return fail('unverified', packet, undefined, { assessedDecisionCount: parsed.decisions.length,
      unverifiedDecisionCount: unverified.length, unresolvedContraryCount: unresolved.length,
      ...(unverified.length ? { firstUnverifiedDecisionIndex: unverified[0]! } : {}),
      ...(unresolved.length ? { firstUnresolvedContraryIndex: unresolved[0]! } : {}), assessmentControlMarker: control.marker });
  }
  return { control: { marker: control.marker, reason: control.reason }, diagnostic: { ...base,
    status: 'qualified', reason: 'consistent', packetSha256: hash(packet.text), packetBytes: Buffer.byteLength(packet.text, 'utf8') } };
}

/** Durable diagnostic validation is deliberately content-free and lends no
 * verification authority. Never pass arbitrary journal objects to publication. */
export function completionReviewAssessmentDiagnostic(value: unknown): CompletionReviewAssessmentDiagnostic | undefined {
  try {
  if (!record(value)) return undefined;
  const allowed = ['version','status','reason','rawOutputSha256','rawOutputBytes','packetSha256','packetBytes','malformedIssue','malformedRowIndex','originalModelCallId','physicalAttempt','providerResponseIdDigest', ...UNVERIFIED_FIELDS];
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string' || !allowed.includes(key))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const afterKeys = Reflect.ownKeys(value);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (afterKeys.length !== ownKeys.length || descriptorKeys.length !== ownKeys.length
    || ownKeys.some((key, index) => key !== afterKeys[index] || key !== descriptorKeys[index])) return undefined;
  // Never evaluate journal accessors or re-read a source object after validation.
  // Only immutable primitives from this inert own-data snapshot can be returned.
  const captured: Record<string, unknown> = {};
  for (const key of ownKeys) {
    const descriptor = descriptors[key as string]!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return undefined;
    captured[key as string] = descriptor.value;
  }
  if (Object.keys(captured).some(key => !allowed.includes(key))
    || captured.version !== 1 || typeof captured.status !== 'string' || !['qualified','unqualified'].includes(captured.status)
    || typeof captured.reason !== 'string' || !['missing','malformed','over_budget','control_invalid','partial','uncertain','contradicted','unverified','original_unbound','consistent'].includes(captured.reason)
    || typeof captured.rawOutputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(captured.rawOutputSha256) || !Number.isSafeInteger(captured.rawOutputBytes) || (captured.rawOutputBytes as number) < 0) return undefined;
  if (captured.malformedIssue !== undefined && (captured.status !== 'unqualified' || captured.reason !== 'malformed'
    || typeof captured.malformedIssue !== 'string' || !MALFORMED_ISSUES.includes(captured.malformedIssue as AssessmentMalformedIssue))) return undefined;
  if (captured.malformedRowIndex !== undefined && (!['types','row_text_enum','contrary_shape'].includes(captured.malformedIssue as string)
    || !Number.isSafeInteger(captured.malformedRowIndex) || (captured.malformedRowIndex as number) < 0 || (captured.malformedRowIndex as number) > 15)) return undefined;
  if ((captured.packetSha256 !== undefined) !== (captured.packetBytes !== undefined)
    || (captured.packetSha256 !== undefined && (typeof captured.packetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(captured.packetSha256) || !Number.isSafeInteger(captured.packetBytes) || (captured.packetBytes as number) < 0))) return undefined;
  const bound = ['originalModelCallId','physicalAttempt','providerResponseIdDigest'].map(key => captured[key] !== undefined);
  if (bound.some(Boolean) && (!bound.every(Boolean) || typeof captured.originalModelCallId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(captured.originalModelCallId) || !Number.isSafeInteger(captured.physicalAttempt)
    || (captured.physicalAttempt as number) <= 0 || typeof captured.providerResponseIdDigest !== 'string' || !/^[a-f0-9]{64}$/.test(captured.providerResponseIdDigest))) return undefined;
  if (UNVERIFIED_FIELDS.some(key => Object.hasOwn(captured, key))) {
    // Presence is by own-key, so undefined fields cannot masquerade as an old
    // absent group or as an absent zero-count ordinal.
    if (captured.status !== 'unqualified' || captured.reason !== 'unverified'
      || !['assessedDecisionCount','unverifiedDecisionCount','unresolvedContraryCount','assessmentControlMarker',
        'packetSha256','packetBytes'].every(key => Object.hasOwn(captured, key))
      || typeof captured.packetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(captured.packetSha256)
      || !Number.isSafeInteger(captured.packetBytes) || (captured.packetBytes as number) < 1
      || (captured.packetBytes as number) > REVIEW_ASSESSMENT_MAX_BYTES
      || !['assessedDecisionCount','unverifiedDecisionCount','unresolvedContraryCount'].every(key => Number.isSafeInteger(captured[key]))) return undefined;
    const n = captured.assessedDecisionCount as number;
    const unverified = captured.unverifiedDecisionCount as number;
    const unresolved = captured.unresolvedContraryCount as number;
    if (n < 1 || n > 16 || unverified < 0 || unverified > n || unresolved < 0 || unresolved > n
      || unverified + unresolved === 0 || unverified + unresolved > 2 * n
      || typeof captured.assessmentControlMarker !== 'string'
      || !['DONE','AWAITING','INCOMPLETE','CORRECT','BLOCKED','REVISE_REPLY','NOT-DONE'].includes(captured.assessmentControlMarker)) return undefined;
    for (const [key, count] of [['firstUnverifiedDecisionIndex', unverified], ['firstUnresolvedContraryIndex', unresolved]] as const) {
      if (count === 0 ? Object.hasOwn(captured, key) : !Object.hasOwn(captured, key)
        || !Number.isSafeInteger(captured[key]) || (captured[key] as number) < 0
        || (captured[key] as number) >= n || (captured[key] as number) > n - count) return undefined;
    }
  }
  return captured as unknown as CompletionReviewAssessmentDiagnostic;
  } catch { return undefined; }
}
