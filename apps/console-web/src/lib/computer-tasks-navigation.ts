export type AutomationTab = 'workflows' | 'skills' | 'computer';

export function automationTab(value: string | null): AutomationTab {
  return value === 'skills' || value === 'computer' ? value : 'workflows';
}

/** Tabs are navigation only; preserve exact run and guide parameters. */
export function automationTabSearch(search: URLSearchParams, tab: AutomationTab): URLSearchParams {
  const next = new URLSearchParams(search);
  if (tab === 'workflows') next.delete('tab'); else next.set('tab', tab);
  return next;
}

export const COMPUTER_TASKS_HREF = '/automate?tab=computer';
