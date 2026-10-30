import { api } from './api';

/** One thing Clem did for a reply, by the operation it ran. */
export interface CardStep { tool: string; effect?: string; done: boolean }

export type CardOutcome =
  | { state: 'working'; steps?: CardStep[] }
  | { state: 'not_found' }
  | { state: 'done' | 'needs_you' | 'stopped'; text: string; sessionId: string; steps?: CardStep[]; asks?: 'approval' | 'answer'; approvalId?: string };

/** What the owner asked Clem from one of her items, with what she is doing about it. */
export interface CardRecord {
  rowKey: string;
  title: string;
  reply: string;
  runId: string;
  since: string;
  outcome: CardOutcome;
}

export async function getCardRecords(): Promise<{ replies: CardRecord[] }> {
  return api('/m/api/home/from-clem/replies') as Promise<{ replies: CardRecord[] }>;
}

export function cardRecordInMotion(record: Pick<CardRecord, 'outcome'>): boolean {
  return record.outcome.state === 'working';
}

/** How an operation's verb reads once it ran, and while it runs. Grammar for
 *  common verbs only: no app or operation is named here. */
const VERB_TENSES: Readonly<Record<string, readonly [done: string, running: string]>> = {
  get: ['Checked', 'Checking'], list: ['Checked', 'Checking'], fetch: ['Checked', 'Checking'],
  read: ['Read', 'Reading'], search: ['Searched', 'Searching'], find: ['Searched', 'Searching'],
  query: ['Checked', 'Checking'], create: ['Created', 'Creating'], add: ['Added', 'Adding'],
  update: ['Updated', 'Updating'], edit: ['Updated', 'Updating'], send: ['Sent', 'Sending'],
  reply: ['Replied in', 'Replying in'], post: ['Posted to', 'Posting to'], delete: ['Deleted', 'Deleting'],
  move: ['Moved', 'Moving'], draft: ['Drafted', 'Drafting'], schedule: ['Scheduled', 'Scheduling'],
};

/** A step as the owner reads it: what Clem did, in plain words. An app
 *  operation named APP_VERB_OBJECT reads "Checked Outlook calendar view";
 *  anything else keeps its own words. */
export function cardStepLabel(step: Pick<CardStep, 'tool'> & { done?: boolean }): string {
  const words = step.tool.replace(/[_-]+/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const tense = words.length >= 3 ? VERB_TENSES[words[1]] : undefined;
  if (tense) {
    const app = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    return `${tense[step.done === false ? 1 : 0]} ${app} ${words.slice(2).join(' ')}`;
  }
  const plain = words.join(' ');
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

export function cardRecordHeadline(outcome: CardOutcome): { tone: 'info' | 'done' | 'ask' | 'fail'; text: string } {
  switch (outcome.state) {
    case 'done': return { tone: 'done', text: 'Done' };
    case 'needs_you': return { tone: 'ask', text: outcome.asks === 'approval' ? 'Clem needs your OK' : 'Clem needs one more thing' };
    case 'stopped': return { tone: 'fail', text: 'This didn’t finish' };
    case 'not_found': return { tone: 'fail', text: 'Couldn’t confirm this — check the conversation before trying again' };
    default: return { tone: 'info', text: 'Clem is working on it…' };
  }
}
