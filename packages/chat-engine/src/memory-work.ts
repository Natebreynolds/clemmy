/**
 * Memory at work — one contract and one presenter for every surface.
 *
 * The daemon runs background jobs that keep the owner's memory current: it
 * reads finished conversations, settles conflicting facts, finds patterns,
 * lets unused memories fade. `GET /api/console/memory/work` (desktop) and
 * `GET /m/api/memory/work` (phone) return one `MemoryWorkSnapshot` built by
 * the same daemon function. This module names what those jobs are doing in
 * plain words, so the Mac and the phone say the same thing.
 *
 * Honesty rules the snapshot already follows and the words must keep:
 * - "working" only while a job is running in the daemon right now; never
 *   inferred from a lease or a schedule.
 * - a count the daemon could not read is `null`, never 0.
 * - the model named is the one that served the call; a stand-in says so.
 */

/** Stable job ids. Owner-facing words live in `MEMORY_JOB_WORDS`, never in ids. */
export type MemoryJobId =
  | 'learn'
  | 'reconcile'
  | 'patterns'
  | 'skills'
  | 'identity'
  | 'import'
  | 'standing'
  | 'verify'
  | 'index'
  | 'tidy';

/** Which model does a job's thinking:
 *  memory  = the "Keeps your memory" role (Settings → Models);
 *  checker = "Checks the work", on purpose — its value is independence;
 *  local   = a model that runs on this Mac (the search index);
 *  none    = no model; rules only. */
export type MemoryJobModelOwner = 'memory' | 'checker' | 'local' | 'none';

export type MemoryJobTrigger =
  | 'after_conversation'
  | 'after_message'
  | 'on_save'
  | 'after_success'
  | 'after_correction'
  | 'every_few_minutes'
  | 'hourly'
  | 'daily'
  | 'nightly'
  | 'on_request';

export type MemoryWorkState = 'working' | 'resting' | 'waiting' | 'off' | 'unknown';

export type MemoryWorkOutcome = 'ok' | 'nothing_new' | 'failed' | 'waiting';

/** Why a model call could not run. Never a provider name. */
export type MemoryModelProblem = 'quota' | 'credit' | 'not_connected' | 'timeout' | 'error';

export interface MemoryWorkSource {
  kind: 'conversation' | 'workflow' | 'owner' | 'schedule' | 'tool';
  sessionId?: string;
  /** The conversation or workflow title when the daemon knows it. */
  title?: string;
}

export interface MemoryWorkRunning {
  job: MemoryJobId;
  startedAt: string;
  source?: MemoryWorkSource | null;
  /** A long conversation is read in parts. */
  part?: number;
  parts?: number;
}

export interface MemoryWorkWaiting {
  /** busy: something is running and learning yields to it;
   *  model_paused: the provider asked Clem to back off until `until`;
   *  model_unavailable: the memory model cannot be reached right now. */
  reason: 'busy' | 'model_paused' | 'model_unavailable';
  since?: string;
  until?: string;
  problem?: MemoryModelProblem;
  /** What learning is waiting behind, when `reason` is busy. */
  blocker?: { kind: 'chat' | 'workflow' | 'background' | 'other'; startedAt?: string } | null;
}

export interface MemoryWorkQueue {
  /** Parts of finished conversations not read yet. */
  toLearn: number | null;
  /** Claims set aside for a second look (they overlap an existing memory). */
  setAside: number | null;
  /** Parts that failed every retry. */
  failed: number | null;
}

export interface MemoryWorkModel {
  /** chosen = the owner picked it in Settings; automatic = Clem picks. */
  source: 'chosen' | 'automatic';
  /** The model the next memory job will ask for. Null when none is available. */
  modelId: string | null;
  /** Automatic only: whose model memory work borrows today. */
  follows?: 'checker' | 'brain' | null;
  /** The model that actually answered the most recent memory call. */
  lastServed?: { modelId: string; at: string; standIn: boolean } | null;
  unavailable?: { problem: MemoryModelProblem; until?: string } | null;
}

export interface MemoryWorkTotals {
  /** Runs started on their own. Work nested in another run (a reconcile
   *  inside a conversation read) is part of that run: its model calls and
   *  tokens count, but it adds no run. The hourly and daily strips count the
   *  same way. */
  runs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  learned: number;
  updated: number;
  faded: number;
}

export interface MemoryJobStatus {
  id: MemoryJobId;
  modelOwner: MemoryJobModelOwner;
  state: 'running' | 'idle' | 'waiting' | 'off';
  /** The model this job asks for now: the memory model's for the jobs it
   *  governs, the checker's for the checks, the embedder for the index. Null
   *  when none can be named. What answered each run is on its event. */
  modelId?: string | null;
  lastRun?: { at: string; outcome: MemoryWorkOutcome; durationMs?: number } | null;
  next?: { trigger: MemoryJobTrigger; at?: string } | null;
  today: MemoryWorkTotals;
}

export interface MemoryWorkToday extends MemoryWorkTotals {
  conversationsRead: number;
  claimsFound: number;
  /** Claims left out because the conversation did not support them. */
  leftOut: number;
  /** Claims set aside for a second look. */
  setAside: number;
  /** Priced spend when every call today has a known price; null otherwise. */
  costUsd?: number | null;
}

export interface MemoryWorkHour {
  hourStart: string;
  runs: number;
  modelCalls: number;
  learned: number;
}

export interface MemoryWorkDay {
  day: string;
  runs: number;
  modelCalls: number;
  learned: number;
  inputTokens: number;
  outputTokens: number;
}

export interface MemoryWorkProduced {
  claims?: number;
  learned?: number;
  updated?: number;
  reinforced?: number;
  leftOut?: number;
  setAside?: number;
  faded?: number;
  restored?: number;
  /** Records of finished work cleared once they aged out. Not memories. */
  agedOut?: number;
  patterns?: number;
  skills?: number;
  proposals?: number;
  embedded?: number;
  entities?: number;
  /** A check passed (a standing instruction, a memory repair). */
  approved?: number;
  /** A check stopped a change. */
  declined?: number;
}

export interface MemoryWorkFact {
  id: string;
  /** Current text of the memory, read when the snapshot was built. */
  text: string;
  change: 'learned' | 'updated' | 'reinforced' | 'faded' | 'restored';
  /** Whether the memory is active now (a later undo or fade turns it off). */
  active: boolean;
}

export interface MemoryWorkEvent {
  id: string;
  job: MemoryJobId;
  at: string;
  startedAt?: string;
  outcome: MemoryWorkOutcome;
  model?: { modelId: string; standIn: boolean } | null;
  usage?: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    durationMs?: number;
  } | null;
  source?: MemoryWorkSource | null;
  produced: MemoryWorkProduced;
  facts?: MemoryWorkFact[];
  /** Present only while undo would still change something:
   *  forget = turn off what this run learned; restore = bring back what it faded. */
  undo?: { kind: 'forget' | 'restore'; count: number } | null;
  failure?: { problem: MemoryModelProblem } | null;
  /** When this record ages out of the detailed history. */
  expiresAt: string;
}

export interface MemoryWorkSnapshot {
  generatedAt: string;
  state: MemoryWorkState;
  running: MemoryWorkRunning[];
  waiting?: MemoryWorkWaiting | null;
  lastWorkAt?: string | null;
  queue: MemoryWorkQueue;
  model: MemoryWorkModel;
  /** The local search-index model, read-only. */
  embedder?: { modelId: string | null; local: boolean } | null;
  jobs: MemoryJobStatus[];
  today: MemoryWorkToday;
  /** Last 24 hours, oldest first. An hour before the journal began is left
   *  out (never measured), not zero. */
  hourly: MemoryWorkHour[];
  /** Last 30 days, oldest first; a day before the journal began is left out. */
  daily: MemoryWorkDay[];
  /** When the journal began counting, while that is inside the 30 days the
   *  strips show. The hour and the day that hold it, and today's totals on
   *  that day, count only from then: say "since", not a full day's zero. */
  measuredSince?: string | null;
  /** Newest first. */
  recent: MemoryWorkEvent[];
  retention: { detailDays: number; summaryDays: number };
}

export type MemoryWorkUndoResult =
  | { ok: true; changed: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'nothing_to_undo' | 'failed' };

// ───────────────────────────── words ─────────────────────────────

export interface MemoryJobWords {
  /** Card title: what the job is. */
  title: string;
  /** Present tense, while it runs. */
  doing: string;
  /** One sentence: when it runs and what it keeps. */
  blurb: string;
}

export const MEMORY_JOB_WORDS: Record<MemoryJobId, MemoryJobWords> = {
  learn: {
    title: 'Learning from conversations',
    doing: 'Reading a finished conversation',
    blurb: 'When a conversation ends and nothing else is running, Clem reads what was found and keeps what is worth remembering.',
  },
  reconcile: {
    title: 'Settling conflicting facts',
    doing: 'Checking a new memory against what Clem knows',
    blurb: 'When something new is saved, decides whether it adds to, updates or repeats a memory Clem already has.',
  },
  patterns: {
    title: 'Finding patterns',
    doing: 'Looking for patterns across recent memories',
    blurb: 'Each night, looks across recent memories for patterns worth keeping.',
  },
  skills: {
    title: 'Turning finished work into skills',
    doing: 'Writing down how a task was done',
    blurb: 'After a task succeeds, writes down how it was done so it goes faster next time.',
  },
  identity: {
    title: 'Updating your profile',
    doing: 'Reviewing what Clem knows about you',
    blurb: 'About once a day, suggests updates to your profile when there is new evidence.',
  },
  import: {
    title: 'Importing memories',
    doing: 'Importing memories',
    blurb: 'Runs when you import memories from a file or another assistant.',
  },
  standing: {
    title: 'Checking standing instructions',
    doing: 'Checking whether your message is a standing instruction',
    blurb: 'When you tell Clem how to do something from now on, a second model checks it before it becomes a rule.',
  },
  verify: {
    title: 'Double-checking memory repairs',
    doing: 'Checking a proposed memory repair',
    blurb: 'Before Clem repairs a memory on its own, a second model checks the repair.',
  },
  index: {
    title: 'Keeping memory searchable',
    doing: 'Indexing new memories',
    blurb: 'Indexes new memories so Clem can find them, using a model that runs on this Mac.',
  },
  tidy: {
    title: 'Letting old memories fade',
    doing: 'Tidying memory',
    blurb: 'Lets memories that are no longer used fade, and clears finished work once it ages out.',
  },
};

/** The display order: learning first, upkeep last. */
export const MEMORY_JOB_ORDER: readonly MemoryJobId[] = [
  'learn', 'reconcile', 'patterns', 'skills', 'identity', 'import', 'standing', 'verify', 'index', 'tidy',
];

/** Settings → Models wording for the memory role. Both apps use these strings. */
export const MEMORY_ROLE_WORDS = {
  title: 'Keeps your memory',
  explain: 'Learns from finished conversations, settles conflicting facts and finds patterns, in the background.',
  automaticChecker: 'Uses the same model as Checks the work.',
  automaticBrain: 'Uses the model that does the work.',
  /** Automatic, a model named, neither the checker's nor the brain's (a
   *  cheaper model of the same family, say). */
  automaticOwn: 'Clem’s pick for memory work.',
  /** Automatic, and no model can be named right now. */
  automaticNone: 'Clem picks a model when one is available.',
} as const;

/** The note beside "Automatic": whose model memory work borrows, Clem's own
 *  pick when it borrows nobody's, or that none is available. `modelId` is
 *  the automatic model named beside it (null when there is none). */
export function memoryRoleAutomaticText(follows: MemoryWorkModel['follows'], modelId: string | null | undefined): string {
  if (!modelId) return MEMORY_ROLE_WORDS.automaticNone;
  if (follows === 'checker') return MEMORY_ROLE_WORDS.automaticChecker;
  if (follows === 'brain') return MEMORY_ROLE_WORDS.automaticBrain;
  return MEMORY_ROLE_WORDS.automaticOwn;
}

export function memoryJobModelOwnerText(owner: MemoryJobModelOwner): string {
  switch (owner) {
    case 'memory': return MEMORY_ROLE_WORDS.title;
    case 'checker': return 'Checks the work';
    case 'local': return 'Runs on this Mac';
    default: return 'No model';
  }
}

const PROBLEM_WORDS: Record<MemoryModelProblem, string> = {
  quota: 'is out of quota',
  credit: 'is out of credit',
  not_connected: 'is not connected',
  timeout: 'did not answer in time',
  error: 'returned an error',
};

export function memoryModelProblemText(problem: MemoryModelProblem): string {
  return PROBLEM_WORDS[problem] ?? PROBLEM_WORDS.error;
}

/** The Settings line when the memory model cannot serve right now: what is
 *  wrong, until when if the provider said, and that learning waits.
 *  `modelName` is the named model's display name, null when none is named. */
export function memoryModelUnavailableText(
  unavailable: NonNullable<MemoryWorkModel['unavailable']>,
  modelName: string | null,
  fmt: Pick<MemoryTimeFormat, 'clock'>,
): string {
  const until = unavailable.until ? ` until about ${fmt.clock(unavailable.until)}` : '';
  return `${modelName ?? 'The memory model'} ${memoryModelProblemText(unavailable.problem)}${until}. Learning waits; nothing is lost.`;
}

const TRIGGER_WORDS: Record<MemoryJobTrigger, string> = {
  after_conversation: 'After each conversation, when Clem is idle',
  after_message: 'After you send a message',
  on_save: 'Whenever a memory is saved',
  after_success: 'After a task succeeds',
  after_correction: 'After you correct Clem',
  every_few_minutes: 'Every few minutes',
  hourly: 'About every hour',
  daily: 'About once a day',
  nightly: 'Nightly',
  on_request: 'When you ask',
};

export interface MemoryTimeFormat {
  /** "4 min ago", "yesterday". */
  age(iso: string): string;
  /** "3:00 AM", "Tue 3:00 AM". */
  clock(iso: string): string;
}

/** "Nightly · next 3:00 AM", "After each conversation, when Clem is idle". */
export function memoryNextText(next: MemoryJobStatus['next'], fmt: MemoryTimeFormat): string {
  if (!next) return '';
  const words = TRIGGER_WORDS[next.trigger] ?? '';
  return next.at ? `${words} · next ${fmt.clock(next.at)}` : words;
}

const BLOCKER_WORDS: Record<NonNullable<MemoryWorkWaiting['blocker']>['kind'], string> = {
  chat: 'a conversation',
  workflow: 'a workflow',
  background: 'a background task',
  other: 'other work',
};

export interface MemoryHeadline {
  tone: MemoryWorkState;
  text: string;
  detail?: string;
}

function sourceWords(source: MemoryWorkSource | null | undefined): string {
  const title = source?.title?.trim();
  return title ? `“${title}”` : '';
}

/** One line for the top of the panel. Built only from what the snapshot says. */
export function memoryWorkHeadline(
  snapshot: Pick<MemoryWorkSnapshot, 'state' | 'running' | 'waiting' | 'lastWorkAt' | 'queue' | 'model'>,
  fmt: MemoryTimeFormat,
  modelName: (modelId: string) => string,
): MemoryHeadline {
  const { state } = snapshot;
  if (state === 'working' && snapshot.running.length > 0) {
    const first = snapshot.running[0];
    const words = MEMORY_JOB_WORDS[first.job]?.doing ?? 'Working on memory';
    const from = sourceWords(first.source);
    const part = first.part && first.parts && first.parts > 1 ? `part ${first.part} of ${first.parts}` : '';
    const more = snapshot.running.length > 1 ? `${snapshot.running.length - 1} more job${snapshot.running.length > 2 ? 's' : ''} running` : '';
    return {
      tone: 'working',
      text: from ? `${words} · ${from}` : words,
      detail: [part, more].filter(Boolean).join(' · ') || undefined,
    };
  }
  if (state === 'waiting' && snapshot.waiting) {
    const w = snapshot.waiting;
    const model = snapshot.model.modelId ? modelName(snapshot.model.modelId) : 'The memory model';
    if (w.reason === 'busy') {
      const what = BLOCKER_WORDS[w.blocker?.kind ?? 'other'];
      const started = w.blocker?.startedAt ? `started ${fmt.age(w.blocker.startedAt)}` : undefined;
      return { tone: 'waiting', text: `Waiting for ${what} to finish before learning`, detail: started };
    }
    const problem = w.problem ? memoryModelProblemText(w.problem) : 'is not available';
    const until = w.until ? `Learning resumes around ${fmt.clock(w.until)}` : 'Nothing is lost; learning resumes when it is back';
    return { tone: 'waiting', text: `${model} ${problem}`, detail: until };
  }
  if (state === 'off') {
    return { tone: 'off', text: 'Learning is turned off' };
  }
  if (state === 'unknown') {
    return { tone: 'unknown', text: 'Couldn’t read memory work just now' };
  }
  const queued = snapshot.queue.toLearn;
  const lastWorked = snapshot.lastWorkAt ? `Last worked ${fmt.age(snapshot.lastWorkAt)}` : undefined;
  if (typeof queued === 'number' && queued > 0) {
    return {
      tone: 'resting',
      text: `${queued} ${queued === 1 ? 'part' : 'parts'} of finished conversations to read next`,
      detail: lastWorked,
    };
  }
  // "Up to date" is a claim about the queue; an unread queue cannot back it.
  if (queued !== 0) {
    return {
      tone: 'resting',
      text: 'No memory work running right now',
      detail: ['Couldn’t read what is left to learn', lastWorked].filter(Boolean).join(' · '),
    };
  }
  return { tone: 'resting', text: 'Memory is up to date', detail: lastWorked };
}

/** A read vouches that a job is running for this long (about three missed
 *  polls on either app). After it, the words stay and the motion stops. */
export const MEMORY_WORK_LIVE_MS = 30_000;

/** Whether a surface may move: the read says a job is running in the daemon
 *  right now, and it arrived within MEMORY_WORK_LIVE_MS. `readAt` is when
 *  the surface received the snapshot (its own clock, like `now`). */
export function memoryWorkReadIsLive(
  snapshot: Pick<MemoryWorkSnapshot, 'state' | 'running'> | null | undefined,
  readAt: number | null | undefined,
  now: number,
): boolean {
  if (!snapshot || snapshot.state !== 'working' || !Array.isArray(snapshot.running) || snapshot.running.length === 0) return false;
  if (typeof readAt !== 'number' || !Number.isFinite(readAt)) return false;
  return now - readAt <= MEMORY_WORK_LIVE_MS;
}

/** A job with no run on record. The journal keeps 90 days and began at
 *  install, and a run that changed nothing leaves no trace after a restart,
 *  so this is never "never ran" or "not in N days". */
export const MEMORY_JOB_NO_RUN = 'No run recorded yet';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Learned 3 memories from “SEO prospect research”". */
export function memoryEventSentence(event: MemoryWorkEvent): string {
  const p = event.produced ?? {};
  const from = sourceWords(event.source);
  const suffix = from ? ` from ${from}` : '';
  if (event.outcome === 'failed') {
    const why = event.failure ? `: the model ${memoryModelProblemText(event.failure.problem)}` : '';
    return `${MEMORY_JOB_WORDS[event.job]?.title ?? 'Memory work'} did not finish${why}`;
  }
  if (event.outcome === 'waiting') return `${MEMORY_JOB_WORDS[event.job]?.title ?? 'Memory work'} is waiting`;
  const parts: string[] = [];
  switch (event.job) {
    case 'learn': {
      if (p.learned) parts.push(`learned ${plural(p.learned, 'memory', 'memories')}`);
      if (p.updated) parts.push(`updated ${p.updated}`);
      if (p.reinforced) parts.push(`confirmed ${p.reinforced}`);
      if (p.setAside) parts.push(`set ${p.setAside} aside`);
      if (parts.length === 0) return `Read a conversation${suffix}; nothing new to keep`;
      break;
    }
    case 'reconcile': {
      if (p.learned) parts.push(`added ${plural(p.learned, 'memory', 'memories')}`);
      if (p.updated) parts.push(`updated ${p.updated}`);
      if (p.reinforced) parts.push(`confirmed ${p.reinforced}`);
      break;
    }
    case 'patterns': if (p.patterns) parts.push(`found ${plural(p.patterns, 'pattern', 'patterns')}`); break;
    case 'skills': if (p.skills) parts.push(`wrote ${plural(p.skills, 'skill', 'skills')}`); break;
    case 'identity': if (p.proposals) parts.push(`suggested ${plural(p.proposals, 'profile update', 'profile updates')}`); break;
    case 'import': if (p.learned) parts.push(`imported ${plural(p.learned, 'memory', 'memories')}`); break;
    case 'index': if (p.embedded) parts.push(`indexed ${plural(p.embedded, 'memory', 'memories')}`); break;
    case 'tidy': {
      if (p.faded) parts.push(`let ${plural(p.faded, 'memory', 'memories')} fade`);
      if (p.restored) parts.push(`restored ${p.restored}`);
      if (p.agedOut) parts.push(`cleared ${plural(p.agedOut, 'record', 'records')} of finished work`);
      break;
    }
    case 'standing':
      if (p.approved) parts.push(p.approved === 1 ? 'approved a standing instruction' : `approved ${p.approved} standing instructions`);
      break;
    case 'verify':
      if (p.approved) parts.push(p.approved === 1 ? 'approved a memory repair' : `approved ${p.approved} memory repairs`);
      if (p.declined) parts.push(p.declined === 1 ? 'stopped a memory repair' : `stopped ${p.declined} memory repairs`);
      break;
  }
  if (parts.length === 0) return `${MEMORY_JOB_WORDS[event.job]?.title ?? 'Memory work'}: nothing new`;
  const sentence = parts.join(', ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${suffix}`;
}

/** What an undo did, in the same words on both apps. `null` = the request
 *  never got an answer (the network, a restarting daemon): nothing changed. */
export function memoryUndoResultText(result: MemoryWorkUndoResult | null, kind: 'forget' | 'restore'): string {
  if (!result) return 'Couldn’t undo just now. Nothing was changed.';
  if (result.ok) {
    if (result.changed <= 0) return 'Nothing left to undo.';
    const what = plural(result.changed, 'memory', 'memories');
    return kind === 'forget' ? `Forgot ${what}.` : `Brought back ${what}.`;
  }
  switch (result.reason) {
    case 'not_found': return 'That run is no longer in the history.';
    case 'expired': return 'That run is too old to undo now.';
    case 'nothing_to_undo': return 'Nothing left to undo.';
    default: return 'Couldn’t undo just now. Nothing was changed.';
  }
}

/** Undo button words, or null when there is nothing to undo. */
export function memoryUndoText(event: Pick<MemoryWorkEvent, 'undo'>): string | null {
  if (!event.undo || event.undo.count <= 0) return null;
  return event.undo.kind === 'forget'
    ? (event.undo.count === 1 ? 'Forget this' : `Forget these ${event.undo.count}`)
    : (event.undo.count === 1 ? 'Bring it back' : `Bring back ${event.undo.count}`);
}

/** The five stages of the learning pipeline for the day, left to right.
 *  `value` is null when the daemon could not count it. */
export interface MemoryPipelineStage {
  id: 'read' | 'found' | 'kept' | 'aside' | 'faded';
  label: string;
  value: number | null;
  /** The job whose run lights this stage up. */
  job: MemoryJobId;
}

export function memoryPipeline(
  today: MemoryWorkToday | null | undefined,
  opts: { unknown?: boolean } = {},
): MemoryPipelineStage[] {
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // A combined stage is unknown only when every part is; an unread snapshot counts nothing.
  const sum = (a: number | undefined, b: number | undefined) => {
    const x = n(a); const y = n(b);
    return x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  };
  if (opts.unknown) today = null;
  const kept = today ? sum(today.learned, today.updated) : null;
  const aside = today ? sum(today.leftOut, today.setAside) : null;
  return [
    { id: 'read', label: 'Conversations read', value: today ? n(today.conversationsRead) : null, job: 'learn' },
    { id: 'found', label: 'Things noticed', value: today ? n(today.claimsFound) : null, job: 'learn' },
    { id: 'kept', label: 'Kept or updated', value: kept, job: 'reconcile' },
    { id: 'aside', label: 'Left out', value: aside, job: 'learn' },
    { id: 'faded', label: 'Faded', value: today ? n(today.faded) : null, job: 'tidy' },
  ];
}
