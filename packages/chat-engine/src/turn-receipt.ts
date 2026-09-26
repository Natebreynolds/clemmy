/**
 * The last lines under an answer: whether it was checked, by whose work, and
 * what it changed outside Clem.
 *
 * Every fact is already on the turn's activity. The brain the route chose is
 * the model-phase row's detail, every review lands as a verdict row naming
 * the model that ruled, and every external write is a ledger row with its
 * disposition. This module reads them back so a surface never re-derives any
 * of them from a label.
 */
import { MODEL_PHASE_ACTIVITY_ID } from './reduce-activity.js';
import { externalWriteKind, type ExternalWriteKind } from './tool-labels.js';
import type { ActivityItem, ModelRuleOffer } from './types.js';

/** `checked` is a review that passed. `unchecked` is a turn whose reviewer
 *  never ran: it must never read as a pass. `rejected` is the last review
 *  saying no. */
export type TurnReview = 'checked' | 'unchecked' | 'rejected';

/** The latest verdict decides; an earlier rejection followed by a passing
 *  rewrite is a checked answer. No verdict row means no claim at all. */
export function turnReview(
  activity: readonly Pick<ActivityItem, 'kind' | 'verdict'>[] | undefined,
): TurnReview | null {
  if (!activity) return null;
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    const row = activity[i];
    if (row.kind !== 'check' || !row.verdict) continue;
    if (row.verdict === 'passed') return 'checked';
    return row.verdict === 'unreviewed' ? 'unchecked' : 'rejected';
  }
  return null;
}

/** The display name of the model the route chose for this turn. Only a real
 *  model id counts: a provider on its own is a family, not a name. */
export function turnModelName(
  activity: readonly Pick<ActivityItem, 'id' | 'modelName'>[] | undefined,
): string | undefined {
  const row = activity?.find((item) => item.id === MODEL_PHASE_ACTIVITY_ID);
  const name = row?.modelName?.trim();
  return name ? name : undefined;
}

/** The saved agent this turn ran as, by the name the owner gave it. */
export function turnAgentName(
  activity: readonly Pick<ActivityItem, 'id' | 'agentName'>[] | undefined,
): string | undefined {
  const row = activity?.find((item) => item.id === MODEL_PHASE_ACTIVITY_ID);
  const name = row?.agentName?.trim();
  return name ? name : undefined;
}

/** The model behind the verdict that decided this turn (the latest one), when
 *  the harness named it. A turn with no reviewer has no reviewer name. */
export function turnReviewerName(
  activity: readonly Pick<ActivityItem, 'kind' | 'verdict' | 'modelName'>[] | undefined,
): string | undefined {
  if (!activity) return undefined;
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    const row = activity[i];
    if (row.kind !== 'check' || !row.verdict) continue;
    if (row.verdict === 'unreviewed') return undefined;
    const name = row.modelName?.trim();
    return name ? name : undefined;
  }
  return undefined;
}

/** A model other than the brain that did part of the turn as a helper. */
export interface TurnHelper {
  modelName: string;
  /** The kind of work, in the brain's words, when every one of these helpers named the same one. */
  work?: string;
  count: number;
}

/** Helpers that ran on a model other than the brain, one entry per model,
 *  in the order they first appeared. Helpers on the brain's own model are
 *  the brain's work and are not listed. */
export function turnHelpers(
  activity: readonly Pick<ActivityItem, 'id' | 'kind' | 'status' | 'modelName' | 'helperFor'>[] | undefined,
): TurnHelper[] {
  if (!activity) return [];
  const brain = turnModelName(activity);
  const byModel = new Map<string, { count: number; works: Set<string> }>();
  for (const row of activity) {
    if (row.kind !== 'agent' || row.status === 'failed') continue;
    const name = row.modelName?.trim();
    if (!name || name === brain) continue;
    const entry = byModel.get(name) ?? { count: 0, works: new Set<string>() };
    entry.count += 1;
    const work = row.helperFor?.trim();
    if (work) entry.works.add(work);
    byModel.set(name, entry);
  }
  return [...byModel.entries()].map(([modelName, entry]) => ({
    modelName,
    count: entry.count,
    ...(entry.works.size === 1 ? { work: [...entry.works][0] } : {}),
  }));
}

function helperPhrase(helper: TurnHelper): string {
  return helper.work ? `${helper.modelName} handled ${helper.work}` : `${helper.modelName} helped`;
}

/** "<brain> did the work, <helper> handled <work>, <reviewer> checked it."
 *  Every model that produced the answer, in words, from the turn's own
 *  events. Empty when the turn named no model. */
export function turnByline(
  activity: readonly Pick<ActivityItem, 'id' | 'kind' | 'status' | 'verdict' | 'modelName' | 'helperFor' | 'agentName'>[] | undefined,
): string {
  const worker = turnModelName(activity);
  const reviewer = turnReviewerName(activity);
  const helpers = turnHelpers(activity).map(helperPhrase);
  const verb = turnReview(activity) === 'checked' ? 'checked' : 'reviewed';
  const parts = [
    ...(worker ? [`${worker} did the work`] : []),
    ...helpers,
  ];
  if (reviewer) parts.push(parts.length ? `${reviewer} ${verb} it` : `${reviewer} ${verb} the work`);
  const byline = parts.join(', ');
  // A turn inside a saved agent says so first: "Prospect Research Desk · Luna
  // did the work, Jev checked it".
  const agent = turnAgentName(activity);
  return agent ? (byline ? `${agent} · ${byline}` : agent) : byline;
}

/** The open or answered "keep this model for this kind of work?" offer from
 *  this turn, if the harness made one. */
export function turnModelOffer(
  activity: readonly Pick<ActivityItem, 'offer'>[] | undefined,
): ModelRuleOffer | null {
  if (!activity) return null;
  for (let i = activity.length - 1; i >= 0; i -= 1) {
    const offer = activity[i].offer;
    if (offer) return offer;
  }
  return null;
}

/** One card per app and kind of change the turn made outside Clem. Only
 *  writes the provider confirmed become cards; an unconfirmed write never
 *  borrows a receipt. */
export interface OutsideWorkCard {
  key: string;
  kind: ExternalWriteKind;
  count: number;
  app?: string;
  appUrl?: string;
  /** "5 drafts in <app>" */
  title: string;
  /** "Saved as drafts · not sent", or who it went to. */
  subtitle: string;
}

const plural = (n: number, one: string): string => (n === 1 ? one : `${one}s`);

function recipients(targets: readonly string[]): string {
  if (targets.length === 0) return '';
  const shown = targets.slice(0, 2).join(', ');
  return targets.length > 2 ? `${shown} +${targets.length - 2}` : shown;
}

function cardWords(kind: ExternalWriteKind, n: number, app: string | undefined, targets: readonly string[]): { title: string; subtitle: string } {
  const at = (prep: string): string => (app ? ` ${prep} ${app}` : '');
  const to = recipients(targets);
  const settled = to ? `To ${to}` : `Confirmed${app ? ` by ${app}` : ''}`;
  switch (kind) {
    case 'draft_created':
      return { title: `${n} ${plural(n, 'draft')}${at('in')}`, subtitle: `Saved as ${n === 1 ? 'a draft' : 'drafts'} · not sent` };
    case 'draft_updated':
      return { title: `${n} ${plural(n, 'draft')} updated${at('in')}`, subtitle: 'Still drafts · not sent' };
    case 'message_sent': return { title: `${n} ${plural(n, 'message')} sent${at('from')}`, subtitle: settled };
    case 'post_published': return { title: `${n} ${plural(n, 'post')} published${at('on')}`, subtitle: settled };
    case 'record_created': return { title: `${n} ${plural(n, 'record')} created${at('in')}`, subtitle: settled };
    case 'record_updated': return { title: `${n} ${plural(n, 'record')} updated${at('in')}`, subtitle: settled };
    case 'record_deleted': return { title: `${n} ${plural(n, 'record')} deleted${at('in')}`, subtitle: settled };
    case 'file_saved': return { title: `${n} ${plural(n, 'file')} saved${at('to')}`, subtitle: settled };
    case 'other': return { title: `${n} ${plural(n, 'change')}${at('in')}`, subtitle: settled };
  }
}

export function outsideWorkCards(
  activity: readonly Pick<ActivityItem, 'write'>[] | undefined,
): OutsideWorkCard[] {
  const groups = new Map<string, { kind: ExternalWriteKind; count: number; app?: string; appUrl?: string; targets: string[] }>();
  for (const item of activity ?? []) {
    const row = item.write;
    if (!row || row.disposition !== 'confirmed') continue;
    const kind = externalWriteKind(row.shapeKey, row.toolName ?? '', {
      ...(row.irreversible === null ? {} : { irreversible: row.irreversible }),
      ...(row.consequence ? { consequence: row.consequence } : {}),
    });
    const key = `${row.app ?? ''}|${kind}`;
    const group = groups.get(key) ?? {
      kind,
      count: 0,
      ...(row.app ? { app: row.app } : {}),
      ...(row.appUrl ? { appUrl: row.appUrl } : {}),
      targets: [],
    };
    group.count += 1;
    for (const t of row.targets) if (!group.targets.includes(t)) group.targets.push(t);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    kind: g.kind,
    count: g.count,
    ...(g.app ? { app: g.app } : {}),
    ...(g.appUrl ? { appUrl: g.appUrl } : {}),
    ...cardWords(g.kind, g.count, g.app, g.targets),
  }));
}
