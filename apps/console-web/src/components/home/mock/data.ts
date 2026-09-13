/**
 * Fixture data for the Home command-center mock.
 * Synthetic owner-operator content. Not live accounts, not product defaults.
 */
import capture1 from '@/assets/home-mock/capture-1.jpg';
import capture2 from '@/assets/home-mock/capture-2.jpg';
import capture3 from '@/assets/home-mock/capture-3.jpg';
import capture4 from '@/assets/home-mock/capture-4.jpg';

export const MOCK_NAME = 'Nathan';

export const AGENDA = [
  { time: '9:00', title: 'Standup', when: 'past' as const },
  { time: '10:30', title: 'Pipeline review', when: 'past' as const },
  { time: '3:30', title: 'Aldous — intake', when: 'next' as const, note: 'In 40 minutes' },
];

export const NEEDS_YOU = [
  { title: 'Approve: send retainer letter to Alex Chen', meta: 'Mail · 2 waiting in this batch', when: '12m' },
  { title: 'Plan: deal board', meta: 'Approve shape & prepare to run', when: '1h' },
];

export const MAIL = [
  { title: 'Re: retainer', from: 'Alex Chen', preview: 'Can you send the letter this afternoon?', when: '2h', needsReply: true },
  { title: 'Intro from Darrin', from: 'Darrin Sennott', preview: 'Wanted you two to meet — he’s looking at intake this month.', when: '5h', needsReply: true },
];

export const ORGANIC_SERIES = [9800, 10120, 9940, 10480, 10860, 11540, 12400];

export const TRENDS = {
  headline: { label: 'Organic', value: '12,400' },
  delta: '+12% vs last refresh',
  brief: 'Titles from Tuesday are doing the work — three keywords moved into the first page. Social is flat.',
  series: ORGANIC_SERIES,
  sources: [
    { label: 'Search', delta: '+4.1%' },
    { label: 'Analytics', delta: '+2.8%' },
    { label: 'Social', delta: null as string | null },
  ],
  movers: [
    { title: 'personal injury birmingham', before: '14', after: '9' },
    { title: 'truck accident lawyer', before: '22', after: '18' },
    { title: 'car accident attorney near me', before: '31', after: '27' },
  ],
  refreshed: '6m ago',
};

export const CAPTURE = {
  newCount: 14,
  since: '8am',
  nextRefresh: '12m',
  sources: ['LinkedIn', 'Instagram'],
  items: [
    { title: 'Tuesday intake is open until 5.', source: 'LinkedIn', at: '8:14 am', thumb: capture2, isNew: true },
    { title: 'What to bring to a first meeting.', source: 'Instagram', at: '9:02 am', thumb: capture4, isNew: true },
    { title: 'Office hours this week.', source: 'LinkedIn', at: '10:40 am', thumb: capture3, isNew: true },
    { title: 'How we prepare for a deposition.', source: 'Instagram', at: 'Yesterday', thumb: capture1, isNew: false },
  ],
};

export const WATCH = {
  quiet: true,
  label: 'Quiet. Nothing crossed the threshold.',
  detail: 'Keywords vs page-one. Next check with the morning refresh.',
};

export type CatalogGroup = 'clem' | 'tools' | 'recipes';

export interface CatalogCard {
  id: string;
  group: CatalogGroup;
  title: string;
  pitch: string;
  ready: boolean;
  gate?: string;
  species: string;
}

export const CATALOG: CatalogCard[] = [
  { id: 'needs_you', group: 'clem', title: 'Needs you', pitch: 'Approvals, questions, and anything waiting on you.', ready: true, species: 'ops' },
  { id: 'running', group: 'clem', title: 'Running', pitch: 'Work Clem is in the middle of, live.', ready: true, species: 'ops' },
  { id: 'while_away', group: 'clem', title: 'While you were away', pitch: 'What finished, and what paused, since you last sat down.', ready: true, species: 'ops' },
  { id: 'made', group: 'clem', title: 'Made', pitch: 'Drafts, files, and sheets she produced.', ready: true, species: 'ops' },
  { id: 'projects', group: 'clem', title: 'Spaces', pitch: 'The live pages she built. Home glances; Spaces are the room.', ready: true, species: 'ops' },
  { id: 'brief', group: 'clem', title: 'Overnight brief', pitch: 'A grounded note from what moved on the tiles you placed.', ready: true, species: 'brief' },
  { id: 'calendar', group: 'tools', title: 'Calendar', pitch: 'Today’s remaining meetings, next event first.', ready: true, species: 'agenda' },
  { id: 'mail', group: 'tools', title: 'Mail', pitch: 'Unread that looks like work — needs a reply, not the whole mailbox.', ready: true, species: 'inbox' },
  { id: 'trends', group: 'recipes', title: 'Content trends', pitch: 'Search, analytics, and social joined into one brief, with verified movement.', ready: true, species: 'report' },
  { id: 'capture', group: 'recipes', title: 'Social capture', pitch: 'A refreshing wall of everything posted, with what’s new since you looked.', ready: true, species: 'capture' },
  { id: 'rank', group: 'recipes', title: 'Rank watch', pitch: 'Quiet until a keyword crosses the line you set. Then it shouts.', ready: true, species: 'watch' },
  { id: 'deals', group: 'recipes', title: 'Deal pulse', pitch: 'Open pipeline plus who you’re seeing today.', ready: false, gate: 'Connect a CRM to build this.', species: 'report' },
  { id: 'waiting', group: 'recipes', title: 'Waiting on them', pitch: 'Mail you sent with no reply.', ready: true, species: 'inbox' },
  { id: 'reputation', group: 'recipes', title: 'Reputation capture', pitch: 'Reviews and mentions as they come in — not a spreadsheet.', ready: false, gate: 'Connect a reviews source to build this.', species: 'capture' },
];
