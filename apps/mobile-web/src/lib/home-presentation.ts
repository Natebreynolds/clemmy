/**
 * What the phone SAYS the moment it opens.
 *
 * Home used to open with a stack of lists at one visual weight — a greeting in
 * the largest type on screen, then "NEEDS YOU 86" over a card containing no
 * rows, then "RUNNING" over six two-day-old test runs. It never said what to
 * do. Every decision about what it leads with now lives here, as pure
 * functions, so it can be tested against the owner's own measured numbers
 * instead of being re-argued in JSX.
 *
 * The rule the owner gave for notifications is the rule here too: two things
 * matter — Clem needs you to answer something so she can continue, and Clem
 * finished something. Everything else is history, and history belongs below
 * the fold or behind a tap.
 *
 * Two disciplines are enforced in this file because the renderer is exactly
 * where they were lost:
 *
 *  1. NO PRESENT TENSE FOR A PAST FACT. Work that is merely non-terminal is
 *     not "running". A run nobody certified live is unfinished — it may lead
 *     nothing, it may wear no present-tense verb, and it is never a demand,
 *     because "waiting on you" means there is something to ANSWER.
 *
 *  2. NO UNBACKED COUNT. A pane's count is the number of rows that pane
 *     renders, never the shell's total. "Needs you · 86" over a card with no
 *     rows in it is what cost the owner his confidence in the whole app. A
 *     remainder is still sayable — but only as living somewhere else, named
 *     as that somewhere, on a screen that can actually show it.
 */

/** "1 thing" / "3 things", with the two forms written out. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function whole(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

// ─── all clear ──────────────────────────────────────────────────────────────

/**
 * Home may use the Inbox badge as its primary decision count, but the
 * Working-Now projection can contain blocked/stale work that has not produced
 * an Inbox card. Those rows are still user-visible truth and must prevent a
 * quiet/all-clear claim.
 */
export function homeCanSayAllClear(input: {
  loading: boolean;
  needsYouCount: number;
  needsYouCountKnown: boolean;
  currentTaskCount: number;
  currentTaskCountKnown: boolean;
  reminderCount: number;
  recentChatCount: number;
}): boolean {
  return !input.loading
    && input.needsYouCountKnown
    && input.needsYouCount === 0
    && input.currentTaskCountKnown
    && input.currentTaskCount === 0
    && input.reminderCount === 0
    && input.recentChatCount === 0;
}

// ─── how old the shell's count is ───────────────────────────────────────────

/**
 * The Needs-you total is the shell's ONE number, and the service worker
 * answers /m/api/inbox/summary off its shelf with a 200 while the Mac is
 * asleep. Chrome used to be the only place that said so: the header pill read
 * "Needs you · 86 · 6h ago", and `needs-you.ts` exists for exactly that
 * disclosure.
 *
 * Home now leads with that number in the largest type on the screen, and the
 * pill is (correctly) suppressed here — so the age has to travel with the
 * number, or the screen renders a past fact as a present one.
 *
 * It DISCLOSES; it never gates. The answer is still given, next to how old it
 * is, which is the binding rule.
 */
export interface CountProvenance {
  /** False when the most recent read did not actually reach the Mac. */
  countLive: boolean;
  /** How old the number is, in words ("6h ago"), when worth saying out loud. */
  countAge: string | null;
}

export function homeCountAsOf(input: CountProvenance): string {
  if (input.countLive) return '';
  return input.countAge
    ? `Counted ${input.countAge} — I can't reach your Mac.`
    : 'Not confirmed just now.';
}

// ─── the lead ───────────────────────────────────────────────────────────────

export type HomeLeadTone =
  /** Nothing authoritative yet. Say so; never guess a zero. */
  | 'checking'
  /** Rows are on this screen with buttons on them. */
  | 'answer'
  /** Something is waiting, but only the Needs-you screen can show it. */
  | 'elsewhere'
  /** A run is parked on a question and has no Inbox card of its own. */
  | 'attention'
  /** Certified-live work, right now. */
  | 'working'
  /** Durable results she produced while you were gone. */
  | 'away'
  /** Nothing to answer; there is still history below. */
  | 'quiet'
  /** Nothing to answer, nothing running, nothing pending. */
  | 'clear';

export interface HomeLead {
  tone: HomeLeadTone;
  /** The one sentence that answers "what do I do?". Sentence case, no count
   *  the screen cannot stand behind. */
  headline: string;
  /** One supporting clause, or '' when nothing can be said honestly. */
  detail: string;
  /** Where the Needs-you number this lead rests on came from, when the last
   *  read did not reach the Mac. '' when it was just confirmed. */
  asOf: string;
  /** The one tap that acts on the headline, when there is one. */
  action: { label: string; target: 'inbox' | 'activity' } | null;
}

export interface HomeLeadFacts extends CountProvenance {
  /** Home's first load has not answered yet. */
  loading: boolean;
  /** Decision rows Home will actually render. Never the shell's total — this
   *  is the whole point: the lead speaks about what is on the screen. */
  answerableShown: number;
  /** The shell's ONE Needs-you count, and whether it has ever answered. */
  needsYouCount: number;
  needsYouCountKnown: boolean;
  /** Work the server certified LIVE. Not "non-terminal". */
  running: number;
  /**
   * Work rows where a PERSON is the blocker: the shared presenter's
   * `needsYou` membership — awaiting_approval / awaiting_input (which never
   * age out), plus recent blocked / paused / lease-lost rows.
   *
   * This is its own fact and not part of `unfinished` because it is the one
   * class of work that is a DEMAND. A workflow parked at awaiting_approval
   * produces no Inbox card, so `needsYouCount` can be a truthful zero while a
   * row on this very screen says "Waiting for approval".
   */
  workNeedsYou: number;
  /** Non-terminal work nobody certified live and nobody is blocking: started,
   *  gone quiet, never ended. A fact about the past, presented as one. */
  unfinished: number;
  /** Whether the working-now route has ever answered this session. */
  workKnown: boolean;
  /** Whether Home is actually rendering the work rows (the pane can be turned
   *  off in Customize). Decides whether a demand needs a door. */
  workPaneShown: boolean;
  /** Durable results waiting to be read ("while you were away"). */
  awayCount: number;
  /** Rows on the screen that are neither a decision nor work — reminders,
   *  projects. They are not a demand, but they mean the screen is not empty,
   *  so "all clear" would be overclaiming. */
  otherRows: number;
}

const OPEN_NEEDS_YOU = { label: 'Open Needs you', target: 'inbox' as const };
const OPEN_ACTIVITY = { label: 'Open Activity', target: 'activity' as const };

/** Unfinished work, said in the past tense it earned. '' at zero. */
export function homeUnfinishedNote(unfinished: number): string {
  const n = whole(unfinished);
  return n === 0 ? '' : `${plural(n, 'earlier run is', 'earlier runs are')} still open`;
}

/**
 * The single most important state, in plain words.
 *
 * Ordering IS the design: a thing you can answer here outranks a thing you
 * must go somewhere to answer, which outranks a run stopped on a question,
 * which outranks work happening now, which outranks what she finished.
 * Unfinished work never places at all — it only ever qualifies a headline,
 * because there is nothing to answer about it.
 */
export function homeLead(facts: HomeLeadFacts): HomeLead {
  const answerable = whole(facts.answerableShown);
  const counted = whole(facts.needsYouCount);
  const running = whole(facts.running);
  const attention = whole(facts.workNeedsYou);
  const unfinished = whole(facts.unfinished);
  const away = whole(facts.awayCount);
  const note = homeUnfinishedNote(unfinished);
  // Every lead below rests on the shell's count: the ones that print it, and
  // the quiet ones that were only reached by believing its zero.
  const asOf = homeCountAsOf(facts);

  if (facts.loading) return { tone: 'checking', headline: 'Catching up…', detail: '', asOf: '', action: null };

  if (answerable > 0) {
    // The remainder is disclosed, but the HEADLINE only ever counts rows this
    // screen renders. 86 over three rows is the lie; "3 … 83 more there" isn't.
    const elsewhere = facts.needsYouCountKnown ? Math.max(0, counted - answerable) : 0;
    return {
      tone: 'answer',
      headline: answerable === 1 ? 'One thing needs your answer' : `${answerable} things need your answer`,
      detail: elsewhere > 0 ? `${elsewhere} more in Needs you` : note,
      asOf,
      action: elsewhere > 0 ? OPEN_NEEDS_YOU : null,
    };
  }

  if (facts.needsYouCountKnown && counted > 0) {
    // Home has no row for any of it. The count is still true — so it is stated
    // against the screen that can show all of it, with the tap to get there.
    return {
      tone: 'elsewhere',
      headline: `${plural(counted, 'thing is', 'things are')} waiting in Needs you`,
      detail: note,
      asOf,
      action: OPEN_NEEDS_YOU,
    };
  }

  // A run stopped on a question is a demand that lives ONLY in the working-now
  // projection: it never produced an Inbox card, so the branch above cannot
  // see it. Without this branch the screen answers "Nothing needs an answer"
  // three inches above a row reading "Waiting for approval" — which is the
  // exact class of lie this whole wave exists to kill.
  if (attention > 0) {
    return {
      tone: 'attention',
      headline: attention === 1
        ? 'One run is waiting on your answer'
        : `${attention} runs are waiting on your answer`,
      detail: note,
      asOf,
      // The rows are right below with their own tap — unless the user turned
      // that pane off, and then the screen owes them a door.
      action: facts.workPaneShown ? null : OPEN_ACTIVITY,
    };
  }

  if (running > 0) {
    return {
      tone: 'working',
      headline: running === 1 ? 'Clem is working on something' : `Clem is running ${running} things`,
      detail: note,
      asOf,
      action: null,
    };
  }

  // Only now may the screen speak about emptiness, and only from answers it
  // actually has. An unread source is disclosed, never rounded down to zero.
  if (!facts.needsYouCountKnown) return { tone: 'checking', headline: 'Checking what needs you…', detail: '', asOf: '', action: null };
  if (!facts.workKnown) return { tone: 'checking', headline: 'Checking current work…', detail: '', asOf: '', action: null };

  if (away > 0) {
    return {
      tone: 'away',
      headline: `${plural(away, 'update', 'updates')} while you were away`,
      detail: note,
      asOf,
      action: null,
    };
  }

  if (homeCanSayAllClear({
    loading: facts.loading,
    needsYouCount: counted,
    needsYouCountKnown: facts.needsYouCountKnown,
    currentTaskCount: running + attention + unfinished,
    currentTaskCountKnown: facts.workKnown,
    reminderCount: whole(facts.otherRows),
    recentChatCount: 0,
  })) {
    return { tone: 'clear', headline: 'All clear', detail: 'Nothing needs you and nothing is running.', asOf, action: null };
  }

  return { tone: 'quiet', headline: 'Nothing needs an answer', detail: note, asOf, action: null };
}

// ─── the Needs-you pane ─────────────────────────────────────────────────────

export interface NeedsYouPane {
  /** Render the pane at all. A card with no rows never earns a header — that
   *  card, headed with 86, is the defect this whole wave came from. */
  show: boolean;
  /** The number the pane header may print: what it renders. */
  count: number;
  /** The footer link. It names a remainder only as living somewhere else. */
  moreLabel: string;
}

export function homeNeedsYouPane(input: {
  /** Rows the pane will actually put on the screen. */
  rendered: number;
  /** The shell's total, and whether it has ever answered. */
  counted: number;
  countedKnown: boolean;
}): NeedsYouPane {
  const rendered = whole(input.rendered);
  const counted = input.countedKnown ? whole(input.counted) : 0;
  const elsewhere = Math.max(0, counted - rendered);
  return {
    show: rendered > 0,
    count: rendered,
    moreLabel: elsewhere > 0 ? `${elsewhere} more in Needs you` : 'Open Needs you',
  };
}

// ─── the work pane ──────────────────────────────────────────────────────────

/**
 * What to call the pane, from what is actually in it. A pane of blocked
 * two-day-old runs was headed "Running"; the heading is now derived, so it
 * cannot describe the past in the present tense. '' means: render nothing.
 */
export function homeWorkPaneTitle(input: {
  running: number;
  /** Rows a person is blocking. Not "still open" — a question. */
  needsYou: number;
  unfinished: number;
}): string {
  const running = whole(input.running);
  const needsYou = whole(input.needsYou);
  const unfinished = whole(input.unfinished);
  if (running > 0 && needsYou + unfinished > 0) return 'Working now';
  if (running > 0) return 'Running';
  if (needsYou > 0) return 'Waiting on you';
  if (unfinished > 0) return 'Still open';
  return '';
}

export interface WorkPane {
  /** Render the pane at all. */
  show: boolean;
  /** The heading, derived from what is in it. */
  title: string;
  /** How many rows the pane may render. Home slices to exactly this. */
  shown: number;
  /** The footer link, naming the remainder against the screen that can show
   *  all of it. '' when nothing is hidden. */
  moreLabel: string;
}

/**
 * Every other pane on Home is capped — three decision rows, four updates,
 * three projects — and this one was not, so the owner's twenty-one stalled
 * runs were the tallest thing on his phone. It is capped here, and the
 * remainder obeys the same rule the Needs-you pane obeys: a number is only
 * ever named against a screen that renders all of it. Activity does
 * (`screens/Activity.tsx` maps the whole projection under "Happening now").
 */
export function homeWorkPane(input: {
  running: number;
  needsYou: number;
  unfinished: number;
  /** Rows this pane is allowed to put on the glass. */
  max: number;
}): WorkPane {
  const running = whole(input.running);
  const needsYou = whole(input.needsYou);
  const unfinished = whole(input.unfinished);
  const total = running + needsYou + unfinished;
  const shown = Math.min(total, whole(input.max));
  const hidden = total - shown;
  return {
    show: shown > 0,
    title: homeWorkPaneTitle({ running, needsYou, unfinished }),
    shown,
    moreLabel: hidden > 0 ? `${hidden} more in Activity` : '',
  };
}

// ─── the header row ─────────────────────────────────────────────────────────

/** Screens that put the Needs-you list in their own content. */
const NEEDS_YOU_IN_CONTENT: ReadonlySet<string> = new Set(['home', 'inbox']);
/** Screens that put current work in their own content. */
const WORK_IN_CONTENT: ReadonlySet<string> = new Set(['home', 'activity']);

export interface PhoneHeaderChrome {
  needsPill: boolean;
  workChip: boolean;
}

/**
 * The header carries identity, where you are, and connection state. It carries
 * a signal for anything else ONLY on screens that cannot show that thing
 * themselves — which is the opposite of what it did: the Needs-you pill
 * appeared only on Home, the one screen already leading with that answer, and
 * the work chip appeared everywhere including the screens that list the work.
 * Five controls in one cramped row crushed the title out; this is the rule
 * that keeps it to three.
 */
export function phoneHeaderChrome(input: { tab: string; needsYouSignal: boolean }): PhoneHeaderChrome {
  return {
    needsPill: input.needsYouSignal && !NEEDS_YOU_IN_CONTENT.has(input.tab),
    workChip: !WORK_IN_CONTENT.has(input.tab),
  };
}
