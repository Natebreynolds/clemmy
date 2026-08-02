/**
 * Structural detection of PROJECT-shaped requests.
 *
 * The v3.6.2 regression classified "create an end-of-month sales summary … build
 * a shareable dashboard … host it somewhere my team can access" as complexity
 * `simple` / fastPath `single_action`, then tried to serve it inside one chat
 * turn. It spent 65 tool calls and died on the ceiling with no durable
 * checkpoint. The failure was not that the model chose badly; it was that
 * nothing upstream ever said "this is a project", so no durable lane was ever
 * compiled.
 *
 * What makes a request durable is its execution topology, not its subject. The
 * executable planner is the authoritative place to decide that topology. This
 * module only supplies a cheap, conservative candidate hint before planning:
 *
 *   CONSTRUCTION  — the user wants an artifact to exist that does not yet
 *                   ("build", "create", "set up", "put together").
 *   SOURCED       — that artifact must be derived from data the user already
 *                   has, or from analysis ("using my data", "pull", "analyze").
 *   CONTINUITY    — it is not a one-shot answer: it recurs or must keep
 *                   operating after this turn.
 *   ARTIFACT      — a small set of commonly multi-concern deliverables. This
 *                   vocabulary is an optimization, never an exhaustive list.
 *
 * A positive result may send a direct action to the planner early. A negative
 * result does not promise that work is small: planner topology and runtime
 * budget checkpoints must still promote unfamiliar long work before a chat
 * node approaches its safety ceiling. This result also cannot change semantic
 * intent or grant authority for an external effect.
 *
 * Keep this module pure and dependency-free, like the effect taxonomy beside
 * it, so intent routing, graph compilation, and telemetry all read one verdict.
 */
import type { IntentClassification } from './message-intent.js';

export type ProjectSignal =
  | 'construction'
  | 'sourced'
  | 'continuity'
  | 'durable_artifact'
  | 'compound';

export interface ProjectShapeClassification {
  /** True when the request should compile to a durable project execution. */
  isProject: boolean;
  signals: ProjectSignal[];
  /** Human-readable grounds, mirroring the intent classifier's style. */
  reasons: string[];
}

/** Build something that does not exist yet. */
const CONSTRUCTION_RE =
  /\b(?:assemble|author|automate|build|create|design|develop|generate|implement|make|migrate|prepare|produce|put\s+together|redesign|scaffold|set\s+up|stand\s+up|write)\b/i;

const CONSTRUCTION_GLOBAL_RE =
  /\b(?:assemble|author|automate|build|create|design|develop|generate|implement|make|migrate|prepare|produce|put\s+together|redesign|scaffold|set\s+up|stand\s+up|write)\b/gi;

/**
 * Excludes the trivial constructions that are really one-shot answers: making a
 * list, making a note, making a point. Those construct no durable artifact.
 */
const TRIVIAL_CONSTRUCTION_OBJECT_RE =
  /\b(?:author|build|create|generate|make|prepare|produce|write)\s+(?:me\s+)?(?:a|an|the|some)?\s*(?:note|point|list|bullet|sentence|paragraph|example|guess|suggestion|title|name|word|joke)\b/i;

/** Derived from data the user already has, or from real analysis. */
const SOURCED_RE =
  /\b(?:from|using)\s+(?:my|our|the)\s+(?:[\w-]+\s+){0,2}(?:data|numbers|records?|reports?|metrics|accounts?|files?|spreadsheets?)\b|\b(?:my|our|the)\s+(?:data|numbers|records?|reports?|metrics|sales|pipeline|accounts?|files?|spreadsheets?)\b|\b(?:data|tools?|sources?|accounts?|systems?)\s+(?:i|we)\s+(?:already\s+)?(?:have|use)\b|\balready\s+(?:have\s+)?connected\b|\b(?:pull|fetch|gather|collect|extract|aggregate|analy[sz]e|summari[sz]e|compute|calculate)\b/i;

/** Explicit standing operation. Bare adjectives such as "monthly report" can
 * describe the report's period rather than a schedule, so they do not qualify. */
const STANDING_OPERATION_RE =
  /\b(?:alert\s+(?:me\s+)?(?:if|when)|every\s+(?:day|week|month|quarter|morning|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each\s+(?:day|week|month|quarter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|keep\s+(?:it\s+)?(?:updated?|current|running)|monitor(?:ing)?\b|notify\s+(?:me\s+)?(?:if|when)|on\s+a\s+schedule|recurring|run(?:s|ning)?\s+every|watch\s+for)\b/i;

/** Reuse is weaker than a standing operation. It contributes to a project only
 * when paired with sourced or compound implementation work. */
const REUSE_RE =
  /\b(?:going\s+forward|keep\s+using|ongoing|reus(?:e|ing|able)|use\s+again)\b/i;

/** Artifact classes whose implementation normally spans multiple independently
 * verifiable concerns. This is an optimization hint, not an authority grant;
 * an unrecognized artifact can still escalate durably at a runtime checkpoint. */
const DURABLE_ARTIFACT_OBJECT_SOURCE =
  'admin\\s+console|app(?:lication)?|automation|backend|book|course|crm|dashboard|database|data\\s+pipeline|hub|integration|knowledge\\s+base|platform|portal|service|site|system|web\\s+app|website|workflow|api';
const BOUNDED_SUBARTIFACT_SOURCE =
  'button|class|component|endpoint|field|footer|form|function|header|method|module|page|property|screen|section|table|type|widget';
const DURABLE_ARTIFACT_MODIFIER_SOURCE =
  'admin|client|company|custom|customer|internal|local-only|marketing|new|onboarding|operations|private|production|public|research|sales|shareable|team';
const DURABLE_ARTIFACT_OBJECT_RE = new RegExp(
  `\\b(?:assemble|author|automate|build|create|design|develop|generate|implement|migrate|prepare|produce|put\\s+together|redesign|scaffold|set\\s+up|stand\\s+up|write)\\s+(?:me\\s+)?(?:(?:a|an|my|our|the|this|that|your)\\s+)?(?:(?:${DURABLE_ARTIFACT_MODIFIER_SOURCE})\\s+){0,2}(?:${DURABLE_ARTIFACT_OBJECT_SOURCE})\\b(?!\\s+(?:${BOUNDED_SUBARTIFACT_SOURCE})\\b)`,
  'i',
);
const MAKE_DURABLE_ARTIFACT_OBJECT_RE = new RegExp(
  `\\bmake\\s+(?:me\\s+)(?:(?:a|an|my|our|the|this|that|your)\\s+)?(?:(?:${DURABLE_ARTIFACT_MODIFIER_SOURCE})\\s+){0,2}(?:${DURABLE_ARTIFACT_OBJECT_SOURCE})\\b(?!\\s+(?:${BOUNDED_SUBARTIFACT_SOURCE})\\b)`,
  'i',
);
const COMPOUND_DURABLE_ARTIFACT_RE = new RegExp(
  `(?:\\+|\\b(?:after\\s+that|and\\s+then|followed\\s+by|then)\\b)\\s*(?:(?:a|an|my|our|the|this|that|your)\\s+)?(?:(?:${DURABLE_ARTIFACT_MODIFIER_SOURCE})\\s+){0,2}(?:${DURABLE_ARTIFACT_OBJECT_SOURCE})\\b(?!\\s+(?:${BOUNDED_SUBARTIFACT_SOURCE})\\b)`,
  'i',
);

const DIRECT_PROJECT_REQUEST_RE =
  /^(?:(?:please|kindly)\s+|(?:can|could|would|will)\s+(?:you|clem|clementine)\s+|(?:i(?:'d| would)\s+like|i\s+(?:want|need))\s+(?:you|clem|clementine)\s+to\s+|(?:go\s+ahead\s+and|make\s+sure\s+to|let'?s|now)\s+)*(?:assemble|author|automate|build|create|design|develop|generate|implement|make|migrate|monitor|prepare|produce|put\s+together|redesign|scaffold|set\s+up|stand\s+up|watch|write)\b/i;

const EXPLICIT_COMPOUND_RE =
  /\b(?:after\s+that|and\s+then|end\s+to\s+end|followed\s+by|from\s+start\s+to\s+finish|then)\b|\s\+\s/i;

export function classifyProjectShape(
  text: string,
  intent: Pick<IntentClassification, 'intent'>,
): ProjectShapeClassification {
  const value = (text ?? '').trim();
  if (!value) return { isProject: false, signals: [], reasons: [] };

  const signals: ProjectSignal[] = [];
  const reasons: string[] = [];

  const constructs = CONSTRUCTION_RE.test(value) && !TRIVIAL_CONSTRUCTION_OBJECT_RE.test(value);
  if (constructs) {
    signals.push('construction');
    reasons.push('asks for an artifact that does not exist yet');
  }

  if (SOURCED_RE.test(value)) {
    signals.push('sourced');
    reasons.push('the artifact must be derived from existing data or analysis');
  }

  if (
    DURABLE_ARTIFACT_OBJECT_RE.test(value)
    || MAKE_DURABLE_ARTIFACT_OBJECT_RE.test(value)
    || COMPOUND_DURABLE_ARTIFACT_RE.test(value)
  ) {
    signals.push('durable_artifact');
    reasons.push('requests a durable multi-concern artifact');
  }

  const constructionCount = value.match(CONSTRUCTION_GLOBAL_RE)?.length ?? 0;
  if (constructionCount >= 2 || EXPLICIT_COMPOUND_RE.test(value)) {
    signals.push('compound');
    reasons.push('combines multiple implementation stages');
  }

  const standing = STANDING_OPERATION_RE.test(value);
  const automates = /\bautomate\b/i.test(value);
  const reusable = REUSE_RE.test(value);
  if (standing || automates || reusable) {
    signals.push('continuity');
    reasons.push(standing || automates
      ? 'the result must keep operating after this turn'
      : 'the result is intended for repeated use');
  }

  // Shape never grants action authority. Only a request already classified as
  // a direct action can become an early project candidate. Explicit standing
  // work or a commonly multi-concern artifact is enough for the hint. Unknown
  // artifacts remain eligible for promotion by the planner/runtime checkpoint;
  // sourced transforms such as "create a CSV" are not assumed to be projects.
  const directRequest = DIRECT_PROJECT_REQUEST_RE.test(value.replace(/[’]/g, "'"));
  const isStandingOperation = intent.intent === 'action' && directRequest && (standing || automates);
  const isProject = intent.intent === 'action' && directRequest && (
    isStandingOperation
    || (constructs && signals.includes('durable_artifact'))
  );

  return { isProject, signals, reasons: isProject ? reasons : [] };
}
