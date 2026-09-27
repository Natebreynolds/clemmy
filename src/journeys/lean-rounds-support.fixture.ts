/**
 * Test-only fixtures for the Lean Rounds acceptance journey: planted fixture
 * data, the evidence-seeking scripted model, the Jev arms, and the metrics
 * table. No production imports with side effects; nothing here mints
 * authority. The journey file owns the environment and the production path.
 *
 * The scripted model is an oracle over what the harness shows it. Each round
 * it reads ONLY the request it was given: the tool names on the wire, the
 * catalog index in the instructions, and the tool outputs in the input. It
 * answers once every planted fact is visible in a tool output; otherwise it
 * makes the single next call a competent model would make, and only by a name
 * that is on the wire, in the catalog index, or disclosed by tool_search. So
 * `rounds` measures what the harness forces, not what the script wants.
 */

export type JevArm = 'jev_off' | 'jev_hang' | 'jev_http_500' | 'jev_scripted';
export const JEV_ARMS: readonly JevArm[] = ['jev_off', 'jev_hang', 'jev_http_500', 'jev_scripted'];

export type ScenarioId =
  | 'a_saved_work_lookup'
  | 'b_heartbeat_edit'
  | 'c_provider_carrier_read'
  | 'd_calendar_read'
  | 'e_no_signal_control'
  | 'f_calendar_read_warm';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

export const SPACE_SLUG = 'fixture-keyword-comparison';
/** Filler keyword rows that bring the space_get body to ~10,500 characters. */
export const SPACE_FILLER_ROWS = 75;
export const SPACE_TITLE = 'Keyword comparison: alpha-legal.example vs beta-defense.example vs gamma-counsel.example';
export const SPACE_DOMAINS = ['alpha-legal.example', 'beta-defense.example', 'gamma-counsel.example'] as const;
/** The three highest-CPC terms. They sit only in the dataset's tail. */
export const SPACE_PLANTED_FACTS = [
  'quillfeather probate lawyer',
  'marrowstone dui attorney',
  'tinsel creek injury counsel',
] as const;
const SPACE_PLANTED_CPC = ['$211.47', '$188.09', '$164.52'] as const;

function fillerTerm(index: number): string {
  const areas = ['estate', 'traffic', 'family', 'contract', 'tenant', 'workplace', 'records', 'appeals'];
  const kinds = ['lawyer', 'attorney', 'counsel', 'firm', 'advice'];
  const places = ['north ridge', 'east hollow', 'south fork', 'west bay', 'old mill', 'cedar park'];
  return `${places[index % places.length]} ${areas[index % areas.length]} ${kinds[index % kinds.length]}`;
}

/**
 * The saved comparison, a static Workspace document. Filler rows keep every
 * CPC below the planted ones and place the planted table in the middle of the
 * space_get body: past character 4,000 and clear of the tail, so a shortened
 * view that keeps head and tail does not show it. The journey asserts the
 * placement on the real handler output.
 */
export function spaceComparisonDocument(fillerRows: number): Record<string, unknown> {
  const keywords = Array.from({ length: fillerRows }, (_, index) => ({
    term: fillerTerm(index),
    domain: SPACE_DOMAINS[index % SPACE_DOMAINS.length],
    position: 3 + (index % 17),
    volume: 90 + ((index * 37) % 900),
    cpc: `$${(12 + ((index * 7) % 60) + (index % 10) / 10).toFixed(2)}`,
  }));
  return {
    meta: {
      title: SPACE_TITLE,
      snapshot: '2026-09-20',
      method: 'Organic keyword and paid-search value snapshot for three example domains.',
    },
    sites: SPACE_DOMAINS.map((domain, index) => ({
      domain,
      keywords: 1200 + index * 850,
      visits: 9000 + index * 7400,
      referringDomains: 280 + index * 190,
      rank: 180 + index * 23,
    })),
    keywords: keywords.slice(0, Math.ceil(keywords.length / 2)),
    topCpcTerms: SPACE_PLANTED_FACTS.map((term, index) => ({
      term,
      cpc: SPACE_PLANTED_CPC[index],
      domain: SPACE_DOMAINS[index],
    })),
    moreKeywords: keywords.slice(Math.ceil(keywords.length / 2)),
    takeaways: [
      'The smallest footprint carries the best domain rank.',
      'Paid-search value concentrates in a handful of terms.',
    ],
    _mobile: {
      headline: SPACE_DOMAINS.map((domain) => ({ label: domain, value: 'compared' })),
    },
  };
}

export const SPACE_VIEW_HTML = '<!doctype html><html><body><main id="app">Keyword comparison</main>'
  + '<script>document.getElementById("app").textContent = (window.__SPACE_DATA__||{}).meta?.title || "";</script>'
  + '</body></html>';

export const HEARTBEAT_ID = 'work-review';
export const HEARTBEAT_SEEDED_RULE = 'Skip reminders about fixture test runs.';
export const HEARTBEAT_NEW_RULE = 'Do not raise unsent drafts; I file those myself.';

export const PROVIDER_TOOLKIT = 'keywordintel';
export const PROVIDER_OPERATION = 'KEYWORDINTEL_GET_DOMAIN_GAPS';
export const PROVIDER_ACCOUNT = 'conn-keywordintel';
/** The three biggest gaps; only the payload's tail carries them. */
export const PROVIDER_PLANTED_FACTS = [
  'lanternwick custody mediation',
  'saltmarsh expungement help',
  'brindlecove lease dispute',
] as const;
export const PROVIDER_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['target', 'competitor', 'limit'],
  properties: {
    target: { type: 'string' },
    competitor: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
});
export const PROVIDER_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['gaps', 'total'],
  properties: { gaps: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } },
});

export function providerGapPayload(): Record<string, unknown> {
  const gaps = Array.from({ length: 40 }, (_, index) => ({
    keyword: fillerTerm(index + 3),
    target_rank: 4 + (index % 30),
    competitor_rank: 2 + (index % 9),
    volume: 110 + ((index * 53) % 1400),
    gap_score: 10 + ((index * 13) % 70),
  }));
  PROVIDER_PLANTED_FACTS.forEach((keyword, index) => {
    gaps.push({ keyword, target_rank: 61 + index, competitor_rank: 1, volume: 2400 - index * 100, gap_score: 99 - index });
  });
  return { gaps, total: gaps.length };
}

export const CALENDAR_TOOLKIT = 'googlecalendar';
export const CALENDAR_OPERATION = 'GOOGLECALENDAR_EVENTS_LIST';
export const CALENDAR_ACCOUNT = 'conn-googlecalendar';
export const CALENDAR_PLANTED_FACTS = [
  'Quarry Lane walkthrough',
  'Harbor docket review',
  'Juniper intake call',
] as const;
export const CALENDAR_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['calendar_id', 'time_min', 'time_max'],
  properties: {
    calendar_id: { type: 'string' },
    time_min: { type: 'string' },
    time_max: { type: 'string' },
  },
});
export const CALENDAR_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object' } } },
});
export function calendarPayload(): Record<string, unknown> {
  return {
    items: CALENDAR_PLANTED_FACTS.map((summary, index) => ({
      id: `fixture-event-${index + 1}`,
      summary,
      start: { dateTime: `2026-09-28T${13 + index}:00:00-07:00` },
      end: { dateTime: `2026-09-28T${13 + index}:45:00-07:00` },
    })),
  };
}

// ---------------------------------------------------------------------------
// What the scripted model can see
// ---------------------------------------------------------------------------

export interface RequestView {
  tools: Set<string>;
  instructions: string;
  /** Text of tool outputs only (function_call_result items), in order. */
  outputs: string[];
  outputText: string;
  /** Instructions plus the non-tool input items (context packet, host notes). */
  contextText: string;
  /** Arguments the model already sent, as JSON text, in order. */
  calls: Array<{ name: string; args: string }>;
  readCatalog: Set<string>;
  authoringCatalog: Set<string>;
}

function strings(value: unknown, sink: string[]): void {
  if (typeof value === 'string') sink.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => strings(entry, sink));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => strings(entry, sink));
}

function catalogSection(instructions: string, header: string): Set<string> {
  const start = instructions.indexOf(header);
  if (start < 0) return new Set();
  const lines = instructions.slice(start).split('\n').slice(1);
  const names = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('- ')) break;
    for (const name of line.slice(2).split(',')) {
      const trimmed = name.trim();
      if (/^[a-z][a-z0-9_]*$/.test(trimmed)) names.add(trimmed);
    }
  }
  return names;
}

export function requestView(raw: unknown): RequestView {
  const request = (raw ?? {}) as { tools?: Array<{ name?: string }>; systemInstructions?: unknown; input?: unknown };
  const instructions = typeof request.systemInstructions === 'string' ? request.systemInstructions : '';
  const outputs: string[] = [];
  const context: string[] = [instructions];
  const calls: RequestView['calls'] = [];
  for (const item of Array.isArray(request.input) ? request.input : []) {
    const entry = item as { type?: string; name?: string; arguments?: string; output?: unknown; content?: unknown };
    if (entry.type === 'function_call_result') {
      const sink: string[] = [];
      strings(entry.output, sink);
      outputs.push(sink.join('\n'));
    } else if (entry.type === 'function_call') {
      calls.push({ name: String(entry.name ?? ''), args: String(entry.arguments ?? '') });
    } else {
      strings(entry.content, context);
    }
  }
  return {
    tools: new Set((request.tools ?? []).map((tool) => tool.name ?? '').filter(Boolean)),
    instructions,
    outputs,
    outputText: outputs.join('\n'),
    contextText: context.join('\n'),
    calls,
    readCatalog: catalogSection(instructions, '[native-read-catalog]'),
    authoringCatalog: catalogSection(instructions, '[native-authoring-catalog]'),
  };
}

// ---------------------------------------------------------------------------
// The evidence-seeking oracle
// ---------------------------------------------------------------------------

export interface OracleStep {
  /** The exact tool this step needs (native name or provider slug). */
  tool: string;
  /** How a person would say the need, for tool_search when the name is not visible. */
  need: string;
  /** Arguments, derived only from what is visible; null when not formable yet. */
  args: (view: RequestView) => Record<string, unknown> | null;
  /** The step's own result is visible. */
  done: (view: RequestView) => boolean;
  /** Provider operation reached through work_call via the Composio carrier. */
  provider?: { account: string };
}

export interface ScenarioScript {
  id: ScenarioId;
  prompt: string;
  /** Facts that must be visible in tool output before answering. */
  evidence: readonly string[];
  steps: readonly OracleStep[];
  answer: (view: RequestView) => string;
  /** Ask the same thing once first, in another conversation, so the measured
   *  turn starts from learned state (remembered runs, proven operations). */
  warmUp?: boolean;
}

export interface OracleDecision {
  kind: 'answer' | 'call';
  name?: string;
  args?: Record<string, unknown>;
  text?: string;
  /** Why this call: 'direct' | 'call_tool' | 'work_call' | 'tool_search' | 'reader'. */
  route?: string;
}

const MAX_ORACLE_ROUNDS = 12;

/** A capability ref for `tool` that tool_search disclosed, or that the host
 *  already disclosed in the request context (a proven-operation note). */
function capabilityRefFor(view: RequestView, tool: string): string | null {
  const lower = tool.toLowerCase();
  const refs = `${view.outputText}\n${view.contextText}`.match(/cap:[A-Za-z0-9:._/-]+/g) ?? [];
  return refs.find((ref) => ref.toLowerCase().includes(`:${lower}`)) ?? null;
}

function nativeWorkCallRequirement(view: RequestView, tool: string): string | null {
  // tool_search returns a callable example for an exact native name; copy its
  // requirement label, as the catalog text instructs.
  for (const output of view.outputs) {
    if (!output.includes(tool)) continue;
    const pattern = /"requirement_id"\s*:\s*"([^"]+)"/g;
    for (const match of output.matchAll(pattern)) {
      const window = output.slice(Math.max(0, match.index! - 600), match.index! + 600);
      if (window.includes(tool)) return match[1]!;
    }
    const ref = capabilityRefFor(view, tool);
    if (ref) return ref;
  }
  return null;
}

function searchedFor(view: RequestView, query: string): boolean {
  return view.calls.some((call) => call.name === 'tool_search' && call.args.includes(JSON.stringify(query).slice(1, -1)));
}

/** The next reader hint the latest clipped output names, not yet followed. */
function nextReaderCall(view: RequestView): Record<string, unknown> | null {
  const followed = new Set(view.calls
    .filter((call) => call.name === 'recall_tool_result'
      || (call.name === 'call_tool' && call.args.includes('recall_tool_result')))
    .map((call) => call.args));
  const hints: Array<Record<string, unknown>> = [];
  for (const output of view.outputs) {
    // Text digests write `recall_tool_result {...}`; structured projections
    // carry `"recall_tool_result":{...}` under their recovery block.
    for (const match of output.matchAll(/recall_tool_result"?\s*:?\s*(\{[^{}]*\})/g)) {
      try {
        const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
        if (typeof parsed.call_id === 'string') hints.push(parsed);
      } catch {
        // A truncated hint is not a callable example.
      }
    }
    const offset = /offset:\s*(\d+)/.exec(output);
    const last = hints.at(-1);
    if (offset && last && output.includes(String(last.call_id))) {
      hints.push({ call_id: last.call_id, offset: Number(offset[1]) });
    }
  }
  for (const hint of hints.reverse()) {
    const args = { call_id: hint.call_id, offset: typeof hint.offset === 'number' ? hint.offset : null, max_chars: null };
    const text = JSON.stringify(args);
    if (![...followed].some((sent) => sent.includes(String(hint.call_id)) && sent.includes(`"offset":${args.offset}`))
      && !followed.has(text)) {
      return args;
    }
  }
  return null;
}

/** One oracle decision for one request. Pure: reads only the request. */
export function decide(script: ScenarioScript, raw: unknown, round: number): OracleDecision {
  const view = requestView(raw);
  const evidenceVisible = script.evidence.every((fact) => view.outputText.includes(fact));
  const pending = script.steps.find((step) => !step.done(view));
  if (round > MAX_ORACLE_ROUNDS) {
    return { kind: 'answer', text: 'I could not finish this within the round budget.' };
  }
  if (!pending && evidenceVisible) return { kind: 'answer', text: script.answer(view) };
  if (!pending) {
    const reader = nextReaderCall(view);
    if (reader) {
      return view.tools.has('recall_tool_result')
        ? { kind: 'call', name: 'recall_tool_result', args: reader, route: 'reader' }
        : { kind: 'call', name: 'call_tool', args: { name: 'recall_tool_result', args_json: JSON.stringify(reader) }, route: 'reader' };
    }
    return { kind: 'answer', text: 'I could not find that in what I read.' };
  }
  const args = pending.args(view);
  if (args === null) return { kind: 'answer', text: 'I could not work out what to read.' };
  if (view.tools.has(pending.tool)) {
    return { kind: 'call', name: pending.tool, args, route: 'direct' };
  }
  if (pending.provider) {
    const ref = capabilityRefFor(view, pending.tool);
    if (ref && view.tools.has('work_call')) {
      return {
        kind: 'call',
        name: 'work_call',
        route: 'work_call',
        args: {
          requirement_id: ref,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: pending.tool,
            arguments: JSON.stringify(args),
            connected_account_id: pending.provider.account,
          }),
        },
      };
    }
    if (searchedFor(view, pending.need)) return { kind: 'answer', text: 'I could not find a tool for that.' };
    return { kind: 'call', name: 'tool_search', route: 'tool_search', args: { query: pending.need, account_selection: null, role_key: null, limit: 8 } };
  }
  if (view.readCatalog.has(pending.tool) && view.tools.has('call_tool')) {
    return { kind: 'call', name: 'call_tool', route: 'call_tool', args: { name: pending.tool, args_json: JSON.stringify(args) } };
  }
  if (view.authoringCatalog.has(pending.tool) && view.tools.has('work_call')) {
    const requirement = nativeWorkCallRequirement(view, pending.tool);
    if (requirement) {
      return {
        kind: 'call',
        name: 'work_call',
        route: 'work_call',
        args: {
          requirement_id: requirement,
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          name: pending.tool,
          args_json: JSON.stringify(args),
        },
      };
    }
    if (searchedFor(view, pending.tool)) return { kind: 'answer', text: 'I could not find how to call that.' };
    return { kind: 'call', name: 'tool_search', route: 'tool_search', args: { query: pending.tool, account_selection: null, role_key: null, limit: 8 } };
  }
  if (searchedFor(view, pending.need)) return { kind: 'answer', text: 'I could not find a tool for that.' };
  return { kind: 'call', name: 'tool_search', route: 'tool_search', args: { query: pending.need, account_selection: null, role_key: null, limit: 8 } };
}

function titleWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9.-]+/).filter((word) => word.length > 3));
}

/** Pick the listed Workspace whose title shares the most words with the request. */
export function workspaceSlugFromListing(view: RequestView, prompt: string): string | null {
  const wanted = titleWords(prompt);
  let best: { slug: string; score: number } | null = null;
  for (const match of view.outputText.matchAll(/^- ([a-z0-9-]+) · "([^"]+)"/gm)) {
    const score = [...titleWords(match[2]!)].filter((word) => wanted.has(word)).length;
    if (!best || score > best.score) best = { slug: match[1]!, score };
  }
  return best && best.score > 0 ? best.slug : null;
}

export function scenarioScripts(): Record<ScenarioId, ScenarioScript> {
  const savedWorkPrompt = 'What did the keyword comparison of alpha-legal.example against beta-defense.example and gamma-counsel.example find? Give me the three highest-CPC terms from it.';
  const heartbeatPrompt = 'About my work review heartbeat: stop telling me about unsent drafts, I file those myself.';
  const providerPrompt = 'Compare alpha-legal.example against beta-defense.example on organic keywords and tell me the three biggest gaps.';
  const calendarPrompt = 'What is on my calendar tomorrow afternoon?';
  return {
    a_saved_work_lookup: {
      id: 'a_saved_work_lookup',
      prompt: savedWorkPrompt,
      evidence: SPACE_PLANTED_FACTS,
      steps: [
        {
          tool: 'space_list',
          need: 'list my saved workspaces',
          args: () => ({}),
          done: (view) => /^- [a-z0-9-]+ · "/m.test(view.outputText),
        },
        {
          tool: 'space_get',
          need: 'read a saved workspace',
          args: (view) => {
            const slug = workspaceSlugFromListing(view, savedWorkPrompt);
            return slug ? { slug } : null;
          },
          done: (view) => /Workspace "[^"]+" \([a-z0-9-]+\)/.test(view.outputText),
        },
      ],
      answer: () => `The comparison's three highest-CPC terms are ${SPACE_PLANTED_FACTS.join(', ')}.`,
    },
    b_heartbeat_edit: {
      id: 'b_heartbeat_edit',
      prompt: heartbeatPrompt,
      evidence: [],
      steps: [{
        tool: 'heartbeat_refine',
        need: 'change a heartbeat rule',
        args: () => ({ heartbeat: HEARTBEAT_ID, action: 'add_rule', rule: HEARTBEAT_NEW_RULE }),
        done: (view) => view.outputText.includes(`Added: "${HEARTBEAT_NEW_RULE}"`),
      }],
      answer: () => 'Done: the work review heartbeat will no longer raise unsent drafts.',
    },
    c_provider_carrier_read: {
      id: 'c_provider_carrier_read',
      prompt: providerPrompt,
      evidence: PROVIDER_PLANTED_FACTS,
      steps: [{
        tool: PROVIDER_OPERATION,
        need: 'compare two domains on organic keyword gaps',
        provider: { account: PROVIDER_ACCOUNT },
        args: () => ({ target: 'alpha-legal.example', competitor: 'beta-defense.example', limit: 100 }),
        done: (view) => view.outputText.includes('gap_score'),
      }],
      answer: () => `The three biggest gaps are ${PROVIDER_PLANTED_FACTS.join(', ')}.`,
    },
    d_calendar_read: {
      id: 'd_calendar_read',
      prompt: calendarPrompt,
      evidence: CALENDAR_PLANTED_FACTS,
      steps: [{
        tool: CALENDAR_OPERATION,
        need: 'list my calendar events for a time range',
        provider: { account: CALENDAR_ACCOUNT },
        args: () => ({ calendar_id: 'primary', time_min: '2026-09-28T12:00:00-07:00', time_max: '2026-09-28T18:00:00-07:00' }),
        done: (view) => view.outputText.includes('fixture-event-'),
      }],
      answer: () => `Tomorrow afternoon: ${CALENDAR_PLANTED_FACTS.join('; ')}.`,
    },
    f_calendar_read_warm: {
      id: 'f_calendar_read_warm',
      prompt: calendarPrompt,
      evidence: CALENDAR_PLANTED_FACTS,
      warmUp: true,
      steps: [{
        tool: CALENDAR_OPERATION,
        need: 'list my calendar events for a time range',
        provider: { account: CALENDAR_ACCOUNT },
        args: () => ({ calendar_id: 'primary', time_min: '2026-09-28T12:00:00-07:00', time_max: '2026-09-28T18:00:00-07:00' }),
        done: (view) => view.outputText.includes('fixture-event-'),
      }],
      answer: () => `Tomorrow afternoon: ${CALENDAR_PLANTED_FACTS.join('; ')}.`,
    },
    e_no_signal_control: {
      id: 'e_no_signal_control',
      prompt: 'Can you take care of the thing from earlier?',
      evidence: [],
      steps: [],
      answer: () => 'Which thing do you mean? I do not see an earlier request in this conversation.',
    },
  };
}

// ---------------------------------------------------------------------------
// Jev arms
// ---------------------------------------------------------------------------

type JevFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** A wire that never answers; it rejects only when the caller's timeout aborts, as fetch does. */
export const hangingJevFetch: JevFetch = (_url, init) => new Promise((_resolve, reject) => {
  const abort = () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    reject(error);
  };
  if (init.signal.aborted) abort();
  else init.signal.addEventListener('abort', abort, { once: true });
});

export const failingJevFetch: JevFetch = async () => ({ status: 500, ok: false, text: async () => 'fixture outage' });

type Question = { type: 'noul' | 'choice' | 'score'; instructions?: string; criteria?: Record<string, string | null>; legend?: Record<string, string> };

/**
 * Scripted System One answers. Routing questions (turn-start operation and
 * remembered-run choices, discovery ranking) pick a candidate only when its
 * text names a tool the scenario needs, surely and as fitting; every other
 * question gets an unsure answer, so it falls back exactly as a
 * low-confidence live answer would. The log records each lane and its picks.
 */
export function scriptedJevFetch(neededTools: readonly string[], log: string[]): JevFetch {
  const needed = neededTools.map((name) => name.toLowerCase());
  const names = (text: string) => needed.some((name) => text.toLowerCase().includes(name));
  return async (_url, init) => {
    const body = JSON.parse(init.body) as { questions: Record<string, Question> };
    const answers: Record<string, unknown> = {};
    const turnStartQuestion = 'select' in body.questions || 'run_0' in body.questions;
    const routing = turnStartQuestion || 'which' in body.questions;
    const lane = turnStartQuestion ? 'turn_start' : routing ? 'rank' : Object.keys(body.questions).slice(0, 3).join('+');
    for (const [id, question] of Object.entries(body.questions)) {
      const criteria = question.criteria ?? {};
      const keys = Object.keys(criteria);
      if (question.type === 'choice') {
        const hit = routing ? keys.find((key) => key !== 'none' && names(`${key} ${criteria[key] ?? ''}`)) : undefined;
        const choice = hit ?? (keys.includes('none') ? 'none' : keys[0]!);
        const confidence = hit ? 0.9 : 0.3;
        answers[id] = { type: 'choice', choice, confidence, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? confidence : (1 - confidence) / Math.max(1, keys.length - 1)])) };
      } else if (question.type === 'noul') {
        answers[id] = { type: 'noul', noul: routing && names(question.instructions ?? '') ? 0.95 : 0.5 };
      } else {
        const legend = question.legend ?? { '0': 'unsure' };
        const first = Object.keys(legend)[0] ?? '0';
        answers[id] = { type: 'score', score: Number(first) || 0, legend, probabilities: { [first]: 1 }, confidence: 0.3 };
      }
    }
    const picks = Object.entries(answers)
      .filter(([, answer]) => (answer as { type?: string }).type === 'choice')
      .map(([id, answer]) => `${id}=${(answer as { choice: string }).choice}`);
    log.push(`${lane}${picks.length ? ` [${picks.join(', ')}]` : ''} over ${JSON.stringify(Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, Object.keys(question.criteria ?? {})])))}`);
    return { status: 200, ok: true, text: async () => JSON.stringify({ model: 'jev-fixture', answers, usage: { input_tokens: 100, output_tokens: 10 } }) };
  };
}

// ---------------------------------------------------------------------------
// Metrics and ratchet
// ---------------------------------------------------------------------------

export interface CaseMetrics {
  scenario: ScenarioId;
  arm: JevArm;
  rounds: number;
  round1Bytes: number;
  round1Layers: Record<string, number>;
  round1BucketTokens: Record<string, number>;
  round1BucketBytes: Record<string, number>;
  round1WireTools: string[];
  totalRequestBytes: number;
  toolRoute: string[];
  jevRouterRows: number;
  /** The scorer's reading of the router rows: answered, unavailable, not called. */
  jevArmObserved: string;
  reviews: number;
  turnMs: number;
  completed: boolean;
}

export interface BaselineEntry {
  rounds: number;
  round1Bytes: number;
  totalRequestBytes: number;
  round1WireTools: string[];
}

/** Round-1 and per-turn bytes may grow by at most this fraction (plus a
 *  small absolute allowance for dates and ids that vary in length). */
export const BYTE_TOLERANCE_FRACTION = 0.01;
export const BYTE_TOLERANCE_ABSOLUTE = 64;

export function byteCeiling(baseline: number): number {
  return Math.ceil(baseline * (1 + BYTE_TOLERANCE_FRACTION)) + BYTE_TOLERANCE_ABSOLUTE;
}

export function formatMetricsTable(rows: readonly CaseMetrics[]): string {
  const layers = ['stablePolicy', 'turnContext', 'memoryContext', 'catalog', 'task'];
  const head = ['scenario', 'arm', 'rounds', 'r1 bytes', ...layers.map((layer) => `r1 ${layer}`), 'turn bytes', 'r1 tools', 'jev rows', 'done', 'route'];
  const lines = [head.join(' | ')];
  for (const row of rows) {
    lines.push([
      row.scenario,
      row.arm,
      String(row.rounds),
      String(row.round1Bytes),
      ...layers.map((layer) => String(row.round1Layers[layer] ?? 0)),
      String(row.totalRequestBytes),
      String(row.round1WireTools.length),
      String(row.jevRouterRows),
      row.completed ? 'yes' : 'no',
      row.toolRoute.join(' > ') || '-',
    ].join(' | '));
  }
  return lines.join('\n');
}
