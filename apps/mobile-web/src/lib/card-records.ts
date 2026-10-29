import { api } from './api';

/** One thing Clem did for a reply, by the operation it ran. */
export interface CardStep { tool: string; effect?: string; done: boolean }

export type CardOutcome =
  | { state: 'working'; steps?: CardStep[] }
  | { state: 'not_found' }
  | { state: 'done' | 'needs_you' | 'stopped'; text: string; sessionId: string; steps?: CardStep[]; asks?: 'approval' | 'answer' };

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

/** A step as the owner reads it: the operation in plain words. */
export function cardStepLabel(step: Pick<CardStep, 'tool'>): string {
  const words = step.tool.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
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
