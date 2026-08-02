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
 * What makes a request a project is its SHAPE, not its subject. This module
 * therefore scores three independent structural signals and never mentions a
 * domain:
 *
 *   CONSTRUCTION  — the user wants an artifact to exist that does not yet
 *                   ("build", "create", "set up", "put together").
 *   SOURCED       — that artifact must be derived from data the user already
 *                   has, or from analysis ("using my data", "pull", "analyze").
 *   CONTINUITY    — it is not a one-shot answer: it either recurs
 *                   ("keep using", "every month", "track") or it must become
 *                   available to someone else (any external publication).
 *
 * A project is CONSTRUCTION plus at least one of the other two. That rule is
 * deliberately shape-level: a sales dashboard, a marketing site, a research
 * portal, and a recurring ops report all satisfy it, while "summarize last
 * month's numbers" and "what's my pipeline?" do not — they construct nothing.
 *
 * Keep this module pure and dependency-free, like the effect taxonomy beside
 * it, so intent routing, graph compilation, and telemetry all read one verdict.
 */
import { classifyExternalEffectRequest } from './external-effect-taxonomy.js';

export type ProjectSignal = 'construction' | 'sourced' | 'continuity';

export interface ProjectShapeClassification {
  /** True when the request should compile to a durable project execution. */
  isProject: boolean;
  signals: ProjectSignal[];
  /** Human-readable grounds, mirroring the intent classifier's style. */
  reasons: string[];
}

/** Build something that does not exist yet. */
const CONSTRUCTION_RE =
  /\b(?:build|create|make|set\s+up|stand\s+up|put\s+together|assemble|design|generate|produce|author|develop|implement|scaffold)\b/i;

/**
 * Excludes the trivial constructions that are really one-shot answers: making a
 * list, making a note, making a point. Those construct no durable artifact.
 */
const TRIVIAL_CONSTRUCTION_OBJECT_RE =
  /\b(?:build|create|make|generate|produce)\s+(?:me\s+)?(?:a|an|the|some)?\s*(?:note|point|list|bullet|sentence|paragraph|example|guess|suggestion|title|name|word|joke)\b/i;

/** Derived from data the user already has, or from real analysis. */
const SOURCED_RE =
  /\b(?:my|our|the)\s+(?:data|numbers|records?|reports?|metrics|sales|pipeline|accounts?|files?|spreadsheets?)\b|\b(?:data|tools?|sources?|accounts?|systems?)\s+(?:i|we)\s+(?:already\s+)?(?:have|use)\b|\balready\s+(?:have\s+)?connected\b|\b(?:pull|fetch|gather|collect|extract|aggregate|analy[sz]e|summari[sz]e|compute|calculate)\b/i;

/** Recurring use, ongoing tracking, or a standing deliverable. */
const RECURRENCE_RE =
  /\b(?:keep\s+(?:using|updated?|current)|reus(?:e|able)|ongoing|recurring|every\s+(?:day|week|month|quarter|morning)|dai(?:ly|y)|weekly|monthly|quarterly|each\s+(?:day|week|month|quarter)|over\s+time|track(?:ing)?\s+(?:trends?|progress|performance)|on\s+a\s+schedule|going\s+forward)\b/i;

export function classifyProjectShape(text: string): ProjectShapeClassification {
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

  const recurs = RECURRENCE_RE.test(value);
  const published = classifyExternalEffectRequest(value).requested;
  if (recurs || published) {
    signals.push('continuity');
    reasons.push(recurs && published
      ? 'the result must keep working and be available beyond this machine'
      : recurs
        ? 'the result must keep working after this turn'
        : 'the result must be available beyond this machine');
  }

  // Construction alone is a task. Construction that must consume real data, or
  // outlive the turn, is a project: it needs bounded nodes, durable receipts,
  // and a lane that can be resumed.
  const isProject = constructs && (signals.includes('sourced') || signals.includes('continuity'));

  return { isProject, signals, reasons: isProject ? reasons : [] };
}
