/**
 * A brain outage on Home, in Clem's words.
 *
 * When the chosen brain stops answering and the owner's backups take over,
 * Clem tells the owner once (a From Clem update, no push). When the chosen
 * brain answers again she asks once whether to switch back: yes switches
 * back; no keeps the backup as the brain and moves every conversation to it;
 * later leaves the backup answering and asks again tomorrow. The records
 * carry typed facts only; Clem's voice pass writes what the owner reads.
 */
import { addNotification, markNotificationRead, type NotificationRecord } from '../runtime/notifications.js';
import {
  brainModelLabel,
  closeBrainOutage,
  currentBrainOutage,
  noteBrainAnswered,
  onBrainOutageChange,
  scheduleProbe,
  type BrainOutageV1,
} from '../runtime/harness/brain-backups.js';
import { reviveDeadBrains } from '../runtime/harness/fallback-model.js';
import { repinSessionsFrom } from '../runtime/harness/model-roles.js';
import { activeBrainClassForModel, switchActiveBrain } from './active-brain-switch.js';

/** The From Clem source these records speak for. */
export const BRAIN_OUTAGE_SOURCE = 'brain-health';
const SOURCE_TITLE = 'Your brain';

/** The failure class as the owner would say it. */
function failureWords(reason: string): string {
  switch (reason) {
    case 'model.overloaded': return 'its provider said it was overloaded';
    case 'model.http_5xx': return 'its provider returned server errors';
    case 'model.empty_completion': return 'it came back empty';
    default: return 'it stopped responding';
  }
}

function noticeIds(outage: Pick<BrainOutageV1, 'id'>): { switched: string; back: string } {
  return { switched: `brain-outage-${outage.id}-switched`, back: `brain-outage-${outage.id}-back` };
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** The record for an outage as it stands: the update while it is open, the question once the chosen brain answers again. */
export function brainOutageNotice(outage: BrainOutageV1, nowIso = new Date().toISOString()): NotificationRecord {
  const down = brainModelLabel(outage.downModelId);
  const standIn = brainModelLabel(outage.standInModelId);
  const ids = noticeIds(outage);
  const common = {
    source: 'brain-backups',
    heartbeatId: BRAIN_OUTAGE_SOURCE,
    sourceTitle: SOURCE_TITLE,
    brainOutageId: outage.id,
    downModelId: outage.downModelId,
    standInModelId: outage.standInModelId,
  };
  if (outage.status === 'recovered') {
    return {
      id: ids.back,
      kind: 'system',
      title: `${down} is answering again`,
      body: [
        `The owner's chosen brain, ${down}, stopped answering at ${clock(outage.openedAt)} because ${failureWords(outage.reason)}.`,
        `Their backup, ${standIn}, has answered every conversation since, and still does.`,
        `${down} answered Clem's check${outage.recoveredAt ? ` at ${clock(outage.recoveredAt)}` : ''}.`,
        `Waiting on the owner: switch back to ${down}? If not, ${standIn} becomes the brain for every conversation.`,
      ].join(' '),
      createdAt: nowIso,
      read: false,
      metadata: { ...common, itemKey: `${outage.id}:back`, needsAttention: true },
    };
  }
  return {
    id: ids.switched,
    kind: 'system',
    title: `${down} stopped answering, so ${standIn} is answering for now`,
    body: [
      `The owner's chosen brain, ${down}, stopped answering twice in a row because ${failureWords(outage.reason)}.`,
      `Clem moved every conversation to their first backup, ${standIn}, so chats keep working.`,
      `Clem checks ${down} in the background and will ask before switching back.`,
    ].join(' '),
    createdAt: nowIso,
    read: false,
    metadata: { ...common, itemKey: `${outage.id}:switched`, inboxOnly: true },
  };
}

export interface BrainOutageCardDeps {
  add: (item: NotificationRecord) => void;
  markRead: (id: string) => void;
}

const productionDeps: BrainOutageCardDeps = {
  add: addNotification,
  markRead: (id) => { markNotificationRead(id); },
};

let stopCards: (() => void) | null = null;

/** Keep Home in step with the outage record, and its check running. */
export function startBrainOutageCards(deps: BrainOutageCardDeps = productionDeps): () => void {
  stopCards?.();
  const off = onBrainOutageChange((change) => {
    const ids = noticeIds(change.outage);
    if (change.kind === 'opened') deps.add(brainOutageNotice(change.outage));
    if (change.kind === 'recovered') {
      deps.markRead(ids.switched);
      deps.add(brainOutageNotice(change.outage));
    }
    if (change.kind === 'closed') {
      deps.markRead(ids.switched);
      deps.markRead(ids.back);
    }
  });
  // An outage that outlived a restart keeps its card and its check.
  const open = currentBrainOutage();
  if (open) {
    deps.add(brainOutageNotice(open));
    scheduleProbe();
  }
  stopCards = off;
  return off;
}

/**
 * The owner's answer. `switch_back` ends the outage and the chosen brain
 * serves again; `stay` makes the backup the brain and moves every
 * conversation pinned to the old one. False when the outage is gone or the
 * backup can no longer be chosen.
 */
export async function resolveBrainOutage(outageId: string, choice: 'switch_back' | 'stay'): Promise<boolean> {
  const outage = currentBrainOutage();
  if (!outage || outage.id !== outageId) return false;
  if (choice === 'switch_back') {
    closeBrainOutage('switch_back');
    reviveDeadBrains(outage.downModelId);
    noteBrainAnswered(outage.downModelId);
    return true;
  }
  const brain = activeBrainClassForModel(outage.standInModelId);
  if (!brain) return false;
  const switched = await switchActiveBrain({ brain, modelId: outage.standInModelId });
  if (!switched.ok) return false;
  repinSessionsFrom(outage.downModelId);
  closeBrainOutage('stay');
  return true;
}
