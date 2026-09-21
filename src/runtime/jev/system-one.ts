/**
 * TypeSafe System One request/response — pure build + parse.
 *
 * HTTP lives here too so the verify probe and the live client share one
 * POST /v1/systemone contract. Vault, kill-switch, and usage recording stay
 * in client.ts so parse/fail-open tests never need a home or a network.
 */

export const TYPESAFE_SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_MODEL = 'jev-latest';

export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
};

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
};

export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: string[];
};

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type SystemOneQuestions = Record<string, SystemOneQuestion>;

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type SystemOneAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequestPayload {
  model: string;
  state: unknown;
  questions: SystemOneQuestions;
}

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
}

export type SystemOneFailReason =
  | 'missing_key'
  | 'disabled'
  | 'timeout'
  | 'unauthorized'
  | 'http_error'
  | 'malformed';

export type SystemOneFailure = {
  ok: false;
  reason: SystemOneFailReason;
  status?: number;
  message?: string;
  body?: string;
};

export type SystemOneSuccess = {
  ok: true;
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: SystemOneUsage;
  status?: number;
};

export type SystemOneResult = SystemOneSuccess | SystemOneFailure;

export function buildSystemOneRequest(
  state: unknown,
  questions: SystemOneQuestions,
  model = TYPESAFE_MODEL,
): SystemOneRequestPayload {
  return { model, state, questions };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseNoul(raw: unknown): NoulAnswer | null {
  if (!isRecord(raw) || raw.type !== 'noul') return null;
  const noul = finiteNumber(raw.noul);
  if (noul === null || noul < 0 || noul > 1) return null;
  return { type: 'noul', noul };
}

function parseProbabilities(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const n = finiteNumber(value);
    if (n === null || n < 0) return null;
    out[key] = n;
  }
  return out;
}

function parseChoice(raw: unknown): ChoiceAnswer | null {
  if (!isRecord(raw) || raw.type !== 'choice') return null;
  if (typeof raw.choice !== 'string' || !raw.choice) return null;
  const probabilities = parseProbabilities(raw.probabilities);
  if (!probabilities || !(raw.choice in probabilities)) return null;
  const confidence = finiteNumber(raw.confidence);
  if (confidence === null || confidence < 0 || confidence > 1) return null;
  return { type: 'choice', choice: raw.choice, probabilities, confidence };
}

function parseScore(raw: unknown): ScoreAnswer | null {
  if (!isRecord(raw) || raw.type !== 'score') return null;
  const score = finiteNumber(raw.score);
  if (score === null) return null;
  if (!isRecord(raw.legend)) return null;
  const legend: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.legend)) {
    if (typeof value !== 'string') return null;
    legend[key] = value;
  }
  const probabilities = parseProbabilities(raw.probabilities);
  if (!probabilities) return null;
  const confidence = finiteNumber(raw.confidence);
  if (confidence === null || confidence < 0 || confidence > 1) return null;
  return { type: 'score', score, legend, probabilities, confidence };
}

export function parseSystemOneResponse(
  body: unknown,
  questions: SystemOneQuestions,
): SystemOneResult {
  if (!isRecord(body)) return { ok: false, reason: 'malformed', message: 'response is not an object' };
  if (!isRecord(body.answers)) return { ok: false, reason: 'malformed', message: 'answers missing' };
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : TYPESAFE_MODEL;
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const raw = body.answers[id];
    const parsed = question.type === 'noul' ? parseNoul(raw)
      : question.type === 'choice' ? parseChoice(raw)
      : parseScore(raw);
    if (!parsed) {
      return { ok: false, reason: 'malformed', message: `answer ${id} is not a valid ${question.type}` };
    }
    answers[id] = parsed;
  }
  const usageRaw = isRecord(body.usage) ? body.usage : {};
  const inputTokens = finiteNumber(usageRaw.input_tokens) ?? 0;
  const outputTokens = finiteNumber(usageRaw.output_tokens) ?? 0;
  return {
    ok: true,
    model,
    answers,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

export type SystemOneFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export async function postSystemOne(opts: {
  apiKey: string;
  request: SystemOneRequestPayload;
  timeoutMs?: number;
  fetchImpl?: SystemOneFetch;
}): Promise<SystemOneResult> {
  const key = opts.apiKey.trim();
  if (!key) return { ok: false, reason: 'missing_key' };
  const timeoutMs = Math.max(250, Math.min(30_000, opts.timeoutMs ?? 4_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as SystemOneFetch);
    const res = await fetchImpl(TYPESAFE_SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(opts.request),
      signal: controller.signal,
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'unauthorized', status: res.status, body: text };
    }
    if (!res.ok) {
      return { ok: false, reason: 'http_error', status: res.status, body: text };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return { ok: false, reason: 'malformed', status: res.status, body: text, message: 'response is not JSON' }; }
    const answers = parseSystemOneResponse(parsed, opts.request.questions);
    if (!answers.ok) return { ...answers, status: res.status, body: text };
    return { ...answers, status: res.status };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'http_error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTypesafeApiKey(
  apiKey: string,
  fetchImpl?: SystemOneFetch,
): Promise<{ result: 'valid' | 'invalid' | 'unknown'; message?: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) return { result: 'invalid', message: 'Empty value.' };
  const ping = await postSystemOne({
    apiKey: trimmed,
    request: buildSystemOneRequest(
      { ping: 'ok' },
      { alive: { type: 'noul', instructions: 'Is the state ping value `ok`?' } },
    ),
    timeoutMs: 5_000,
    fetchImpl,
  });
  if (ping.ok) return { result: 'valid' };
  if (ping.reason === 'unauthorized') {
    return { result: 'invalid', message: 'TypeSafe rejected this key (HTTP 401/403).' };
  }
  if (ping.reason === 'timeout') {
    return { result: 'unknown', message: 'Could not reach TypeSafe to validate; saved without confirmation.' };
  }
  return {
    result: 'unknown',
    message: `TypeSafe returned ${ping.status ? `HTTP ${ping.status}` : ping.reason} during validation; saved without confirmation.`,
  };
}
