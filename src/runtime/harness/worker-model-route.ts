/**
 * worker-model-route — which model a delegated helper (run_worker) runs on.
 *
 * One decision per run_worker call, shared by every item in it. Precedence:
 *   1. The packet names a model. It must be one of the owner's connected
 *      models: an exact id or picker label, else Jev maps the brain's wording
 *      onto the connected list. A name nothing resolves is refused before any
 *      helper starts, with the connected ids in the refusal, so the brain can
 *      retry with a real one. Nothing is ever quietly swapped for another
 *      model. A model the owner has not already chosen (brain, default helper,
 *      a saved rule) runs only when this request asked for it; Jev answers
 *      that from the request, and a confident "no" routes the helper to the
 *      owner's routing instead, with a note saying so.
 *   2. A saved rule for this kind of work. An exact word match is free; when
 *      the words differ, Jev picks among the saved rules or none.
 *   3. The owner's default helper model.
 *
 * Jev only ever selects among candidates the host prepared (connected models,
 * saved rules). It cannot introduce a model, and code never reads the
 * person's words to decide: the request is Jev's state, never a pattern.
 */
import { getRuntimeEnv } from '../../config.js';
import { evaluateSystemOne } from '../jev/client.js';
import { noteJevDecisionOutcome } from '../jev/decision-log.js';
import type { ChoiceAnswer, NoulAnswer, SystemOneQuestions, SystemOneResult } from '../jev/system-one.js';
import { slugifyIntent } from '../../memory/tool-choice-store.js';
import { connectedModelGroupsForRole, validateRoleModelBinding } from './model-role-options.js';
import { readDurableBindings, resolveRoleModel } from './model-roles.js';
import { resolveEffectiveProviderForModel } from './byo-providers.js';
import { listEvents } from './eventlog.js';
import type { ModelProviderClass } from './model-wire-registry.js';

/** A model the owner can put on a helper. */
export interface WorkerModelOption {
  id: string;
  label: string;
}

/** A saved "helpers for <kind of work> use <model>" rule. */
export interface WorkerIntentRule {
  intent: string;
  modelId: string;
  /** Where the owner saved it; the route trace carries it as its source. */
  source?: string;
}

export type WorkerAskCheck = 'not_needed' | 'asked' | 'not_asked' | 'unavailable';

export interface WorkerRouteTrace {
  seam: 'chat';
  attemptedIntent: string;
  matchedIntent: string | null;
  item: string;
  modelId: string;
  provider: string;
  source: string;
  /** The model the packet named, verbatim, when it named one. */
  requestedModel?: string;
  /** How the model was settled: an exact match, or Jev's pick. */
  decidedBy?: 'exact' | 'jev';
  askCheck?: WorkerAskCheck;
}

/** Offered to the owner after the turn: keep this model for this kind of work. */
export interface WorkerModelOffer {
  intent: string;
  modelId: string;
  modelName: string;
}

export type WorkerModelDecision =
  | { kind: 'refuse'; reason: string; shapes: string[] }
  | {
      kind: 'route';
      model: string;
      provider: ModelProviderClass;
      trace: WorkerRouteTrace;
      /** One line for the brain when the helper's model differs from the packet's. */
      hostNote?: string;
      offer?: WorkerModelOffer;
    };

export interface WorkerModelRouteInput {
  sessionId?: string | null;
  sourceUserSeq?: number | null;
  /** Defaults to the accepted source's own text. */
  requestText?: string;
  model?: string | null;
  /** The model pinned on the saved agent this work runs as. The owner set it
   *  (and sees it on the agent), so it counts as their choice, like a saved
   *  rule: a design agent pinned to a flagship model runs on it without the
   *  request having to name the model again. */
  ownerPinnedModel?: string | null;
  intent?: string | null;
  objective: string;
  item?: string;
}

type JevAsk = (input: {
  state: unknown;
  questions: SystemOneQuestions;
  timeoutMs: number;
  sessionId?: string;
  channel: string;
  decisionContext: Record<string, unknown>;
}) => Promise<SystemOneResult & { decisionId?: string }>;

export interface WorkerRouteDeps {
  catalog(): WorkerModelOption[];
  brainModelId(): string;
  defaultWorker(): { modelId: string; provider: ModelProviderClass; source: string };
  intentRules(): WorkerIntentRule[];
  providerFor(modelId: string): ModelProviderClass;
  requestText(sessionId: string, sourceUserSeq: number): string;
  ask: JevAsk;
  intentRoutingEnabled(): boolean;
}

/** Jev must be this sure a wording names one connected model. */
export const WORKER_MODEL_MATCH_SURE = 0.8;
/** Jev must be this sure the request asked for the named model. */
export const WORKER_MODEL_ASKED_SURE = 0.8;
/** A saved rule is taken on a confident pick that also fits the work. */
export const WORKER_RULE_CONFIDENCE_MIN = 0.6;
export const WORKER_RULE_FIT_MIN = 0.8;
const WORKER_ROUTE_TIMEOUT_MS = 1_200;
const WORKER_RULE_WINDOW = 10;
const WORKER_CATALOG_WINDOW = 24;

function productionCatalog(): WorkerModelOption[] {
  const out: WorkerModelOption[] = [];
  const seen = new Set<string>();
  for (const group of connectedModelGroupsForRole('worker')) {
    for (const model of group.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      out.push({ id: model.id, label: model.label || model.id });
    }
  }
  return out;
}

function productionIntentRules(): WorkerIntentRule[] {
  return readDurableBindings()
    .filter((binding) => binding.role === 'worker' && binding.whenIntent?.trim())
    .filter((binding) => validateRoleModelBinding('worker', binding.modelId).ok)
    .map((binding) => ({ intent: binding.whenIntent!.trim(), modelId: binding.modelId, source: binding.source }));
}

function productionRequestText(sessionId: string, sourceUserSeq: number): string {
  try {
    const source = listEvents(sessionId, {
      sinceSeq: sourceUserSeq - 1, types: ['user_input_received'], limit: 1,
    }).find((event) => event.seq === sourceUserSeq);
    const text = (source?.data as { text?: unknown } | undefined)?.text;
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

const productionDeps: WorkerRouteDeps = {
  catalog: productionCatalog,
  brainModelId: () => resolveRoleModel('brain').modelId,
  defaultWorker: () => {
    const resolved = resolveRoleModel('worker');
    return { modelId: resolved.modelId, provider: resolved.provider, source: resolved.source };
  },
  intentRules: productionIntentRules,
  providerFor: (modelId) => resolveEffectiveProviderForModel(modelId),
  requestText: productionRequestText,
  ask: (input) => evaluateSystemOne(input),
  intentRoutingEnabled: () => (getRuntimeEnv('CLEMMY_WORKER_INTENT_ROUTING', 'on') || 'on').trim().toLowerCase() !== 'off',
};

let deps: WorkerRouteDeps = productionDeps;

/** Test seam: replace any subset of the production dependencies. */
export function _setWorkerRouteDepsForTests(overrides: Partial<WorkerRouteDeps> | null): void {
  deps = overrides ? { ...productionDeps, ...overrides } : productionDeps;
}

function exactCatalogMatch(catalog: readonly WorkerModelOption[], requested: string): WorkerModelOption | undefined {
  const wanted = requested.trim().toLowerCase();
  return catalog.find((model) => model.id.toLowerCase() === wanted)
    ?? catalog.find((model) => model.label.trim().toLowerCase() === wanted);
}

function labelFor(catalog: readonly WorkerModelOption[], modelId: string): string {
  return catalog.find((model) => model.id === modelId)?.label ?? modelId;
}

function listForRefusal(catalog: readonly WorkerModelOption[]): string {
  return catalog
    .slice(0, WORKER_CATALOG_WINDOW)
    .map((model) => (model.label && model.label !== model.id ? `${model.id} (${model.label})` : model.id))
    .join(', ');
}

/**
 * Decide the helper model for one run_worker call. Never throws: any failure
 * inside the decision falls back to the owner's default helper model.
 */
export async function routeWorkerModel(input: WorkerModelRouteInput): Promise<WorkerModelDecision> {
  const item = input.item ?? '';
  const intent = input.intent?.trim() ?? '';
  const requested = input.model?.trim() ?? '';
  const sessionId = input.sessionId?.trim() || undefined;
  let def: ReturnType<WorkerRouteDeps['defaultWorker']>;
  try {
    def = deps.defaultWorker();
  } catch {
    return { kind: 'refuse', reason: 'no helper model is available right now.', shapes: ['model:no_default'] };
  }
  const baseTrace = (modelId: string, provider: string, source: string, extra: Partial<WorkerRouteTrace> = {}): WorkerRouteTrace => ({
    seam: 'chat',
    attemptedIntent: intent,
    matchedIntent: null,
    item,
    modelId,
    provider,
    source,
    ...(requested ? { requestedModel: requested } : {}),
    ...extra,
  });
  const defaultRoute = (extra: Partial<WorkerRouteTrace> = {}, hostNote?: string): WorkerModelDecision => ({
    kind: 'route',
    model: def.modelId,
    provider: def.provider,
    trace: baseTrace(def.modelId, def.provider, def.source, extra),
    ...(hostNote ? { hostNote } : {}),
  });

  try {
    const catalog = deps.catalog();
    const routingOn = deps.intentRoutingEnabled();
    const rules = routingOn ? deps.intentRules() : [];
    const intentSlug = intent ? slugifyIntent(intent) : '';
    const exactRule = intentSlug ? rules.find((rule) => slugifyIntent(rule.intent) === intentSlug) : undefined;

    // An empty catalog means the connected-model read failed, not that the
    // owner has no models: keep the packet's id as the legacy door did.
    if (requested && catalog.length === 0) {
      const provider = deps.providerFor(requested);
      return { kind: 'route', model: requested, provider, trace: baseTrace(requested, provider, 'packet', { decidedBy: 'exact', askCheck: 'unavailable' }) };
    }

    let resolved = requested ? exactCatalogMatch(catalog, requested) : undefined;
    let brainId = '';
    try { brainId = deps.brainModelId(); } catch { brainId = ''; }
    const pinned = input.ownerPinnedModel?.trim() ?? '';
    const pinnedId = pinned ? (exactCatalogMatch(catalog, pinned)?.id ?? pinned) : '';
    const ownerChosen = new Set([brainId, def.modelId, pinnedId, ...rules.map((rule) => rule.modelId)].filter(Boolean));
    const needWhich = Boolean(requested && !resolved);
    const needAsked = Boolean(requested && (needWhich || (resolved && !ownerChosen.has(resolved.id))));
    const ruleCandidates = !exactRule && rules.length > 0 ? rules.slice(0, WORKER_RULE_WINDOW) : [];
    const shownCatalog = catalog.slice(0, WORKER_CATALOG_WINDOW);

    const questions: SystemOneQuestions = {};
    if (needWhich) {
      const criteria: Record<string, string | null> = { none: 'None of these is that model, or not sure.' };
      shownCatalog.forEach((model, index) => {
        criteria[`m_${index}`] = model.label && model.label !== model.id ? `${model.label} (${model.id})` : model.id;
      });
      questions.which = {
        type: 'choice',
        instructions: `The work names a model written as "${requested.slice(0, 80)}". Which connected model is that same model? Choose none unless one clearly is.`,
        criteria,
      };
    }
    if (needAsked) {
      const named = resolved ? `${resolved.label} (written here as "${requested.slice(0, 80)}")` : `"${requested.slice(0, 80)}"`;
      questions.asked = {
        type: 'noul',
        instructions: `Does the person's request ask for the model ${named}, in any wording, to do this part of the work?`,
        criteria: {
          true: 'The request names that model for this work or for all of it.',
          false: 'The request names no model, names a different one, or not sure.',
        },
      };
    }
    if (ruleCandidates.length > 0) {
      const criteria: Record<string, string | null> = { none: 'No saved rule covers this kind of work, or not sure.' };
      ruleCandidates.forEach((rule, index) => {
        criteria[`r_${index}`] = `Work of this kind: ${rule.intent.slice(0, 120)}`;
        questions[`fit_${index}`] = {
          type: 'noul',
          instructions: `Is this part of the work the kind the owner described as "${rule.intent.slice(0, 120)}"?`,
          criteria: {
            true: 'Yes, it is that kind of work.',
            false: 'It is a different kind of work, or not sure.',
          },
        };
      });
      questions.rule = {
        type: 'choice',
        instructions: 'Which saved rule, if any, covers this part of the work? Choose none unless one clearly does.',
        criteria,
      };
    }

    let answers: Record<string, unknown> | null = null;
    let decisionId: string | undefined;
    if (Object.keys(questions).length > 0) {
      const text = sessionId && input.sourceUserSeq
        ? (input.requestText ?? deps.requestText(sessionId, input.sourceUserSeq))
        : (input.requestText ?? '');
      const result = await deps.ask({
        state: {
          request: text.replace(/\s+/g, ' ').trim().slice(0, 3_000),
          part: input.objective.replace(/\s+/g, ' ').trim().slice(0, 600),
          ...(intent ? { kindOfWork: intent.slice(0, 120) } : {}),
        },
        questions,
        timeoutMs: WORKER_ROUTE_TIMEOUT_MS,
        ...(sessionId ? { sessionId } : {}),
        channel: 'jev-worker-route',
        decisionContext: {
          ...(needWhich ? { models: shownCatalog.map((model) => model.id) } : {}),
          ...(ruleCandidates.length ? { rules: ruleCandidates.map((rule) => `${rule.intent}->${rule.modelId}`) } : {}),
        },
      });
      if (result.ok) answers = result.answers;
      decisionId = result.decisionId;
    }

    let decidedBy: 'exact' | 'jev' = 'exact';
    if (needWhich && answers) {
      const which = answers.which as ChoiceAnswer | undefined;
      const index = which && which.confidence >= WORKER_MODEL_MATCH_SURE ? /^m_(\d+)$/.exec(which.choice)?.[1] : undefined;
      resolved = index === undefined ? undefined : shownCatalog[Number(index)];
      if (resolved) decidedBy = 'jev';
    }

    const finish = (decision: WorkerModelDecision, outcome: string): WorkerModelDecision => {
      noteJevDecisionOutcome(decisionId, outcome, decision.kind === 'route'
        ? { model: decision.model, source: decision.trace.source }
        : { refused: true });
      return decision;
    };

    if (requested && !resolved) {
      return finish({
        kind: 'refuse',
        reason: `the helper model "${requested.slice(0, 80)}" is not one of the owner's connected models, so no helper started. Connected models: ${listForRefusal(catalog)}. Call run_worker again with one of these exact ids, or with model: null to use the owner's routing.`,
        shapes: ['model:not_connected'],
      }, 'refused');
    }

    let askCheck: WorkerAskCheck = 'not_needed';
    let gatedNote: string | undefined;
    if (requested && resolved) {
      if (ownerChosen.has(resolved.id)) {
        askCheck = 'not_needed';
      } else if (!answers) {
        // A check that could not run is not a "no": the brain's pick stands
        // and the trace says the request was never checked.
        askCheck = 'unavailable';
      } else {
        const asked = (answers.asked as NoulAnswer | undefined)?.noul;
        askCheck = typeof asked === 'number' && asked >= WORKER_MODEL_ASKED_SURE ? 'asked' : 'not_asked';
      }
      if (askCheck !== 'not_asked') {
        const provider = deps.providerFor(resolved.id);
        const coveredByRule = exactRule?.modelId === resolved.id;
        const offer = askCheck === 'asked' && intent && !coveredByRule
          ? { intent, modelId: resolved.id, modelName: resolved.label }
          : undefined;
        return finish({
          kind: 'route',
          model: resolved.id,
          provider,
          trace: baseTrace(resolved.id, provider, 'packet', { decidedBy, askCheck }),
          ...(decidedBy === 'jev' ? { hostNote: `Host routing: "${requested.slice(0, 80)}" is the connected model ${resolved.id}; the helper ran on it.` } : {}),
          ...(offer ? { offer } : {}),
        }, 'packet');
      }
      gatedNote = `the request did not ask for ${resolved.label} and no saved rule names it`;
    }

    const withGate = (target: string): string | undefined => (gatedNote
      ? `Host routing: the helper ran on ${target}, not ${resolved?.label ?? requested}, because ${gatedNote}. Say so if it matters to the answer.`
      : undefined);

    if (exactRule) {
      const provider = deps.providerFor(exactRule.modelId);
      return finish({
        kind: 'route',
        model: exactRule.modelId,
        provider,
        trace: baseTrace(exactRule.modelId, provider, exactRule.source ?? 'settings', { matchedIntent: exactRule.intent, decidedBy: 'exact', askCheck }),
        ...(withGate(labelFor(catalog, exactRule.modelId)) ? { hostNote: withGate(labelFor(catalog, exactRule.modelId)) } : {}),
      }, 'rule');
    }

    if (ruleCandidates.length > 0 && answers) {
      const pick = answers.rule as ChoiceAnswer | undefined;
      const index = pick && pick.choice !== 'none' && pick.confidence >= WORKER_RULE_CONFIDENCE_MIN
        ? /^r_(\d+)$/.exec(pick.choice)?.[1]
        : undefined;
      const fit = index === undefined ? undefined : (answers[`fit_${index}`] as NoulAnswer | undefined)?.noul;
      const rule = index !== undefined && typeof fit === 'number' && fit >= WORKER_RULE_FIT_MIN ? ruleCandidates[Number(index)] : undefined;
      if (rule) {
        const provider = deps.providerFor(rule.modelId);
        const label = labelFor(catalog, rule.modelId);
        return finish({
          kind: 'route',
          model: rule.modelId,
          provider,
          trace: baseTrace(rule.modelId, provider, rule.source ?? 'settings', { matchedIntent: rule.intent, decidedBy: 'jev', askCheck }),
          hostNote: withGate(label) ?? `Host routing: the owner's saved rule for "${rule.intent}" put this helper on ${label}.`,
        }, 'rule');
      }
    }

    return finish(defaultRoute({ askCheck }, withGate(labelFor(catalog, def.modelId))), 'default');
  } catch {
    return defaultRoute();
  }
}
