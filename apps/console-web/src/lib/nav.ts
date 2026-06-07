import {
  MessageCircle, Inbox, Zap, Plug, Brain, Video,
  BarChart3, Wrench, Stethoscope, Gauge, Sliders, Sparkles,
  Settings, HelpCircle,
  type LucideIcon,
} from 'lucide-react';

export interface NavDest {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Plain-language one-liner shown as a tooltip / subtitle. */
  hint: string;
}

/** The five primary destinations every user sees. */
export const PRIMARY_NAV: NavDest[] = [
  { path: '/chat', label: 'Chat', icon: MessageCircle, hint: 'Talk to Clementine' },
  { path: '/inbox', label: 'Inbox', icon: Inbox, hint: 'Approvals, activity & notifications' },
  { path: '/automate', label: 'Automate', icon: Zap, hint: 'Workflows, schedules & skills' },
  { path: '/connect', label: 'Connect', icon: Plug, hint: 'Apps, tools, CLIs & your phone' },
  { path: '/memory', label: 'Memory', icon: Brain, hint: 'What Clementine knows about you' },
  { path: '/meetings', label: 'Meetings', icon: Video, hint: 'Recorded meetings & summaries' },
];

/** Power tools, tucked under a collapsed "Advanced" disclosure. */
export const ADVANCED_NAV: NavDest[] = [
  { path: '/advanced/usage', label: 'Usage', icon: BarChart3, hint: 'Token spend & activity' },
  { path: '/advanced/tools', label: 'Tools', icon: Wrench, hint: 'Registered tool catalog' },
  { path: '/advanced/diagnostics', label: 'Diagnostics', icon: Stethoscope, hint: 'Health, logs & storage' },
  { path: '/advanced/budgets', label: 'How hard it works', icon: Gauge, hint: 'Runtime budgets' },
  { path: '/advanced/autonomy', label: 'Autonomy', icon: Sliders, hint: 'When Clementine acts on its own' },
  { path: '/advanced/evolution', label: 'Evolution', icon: Sparkles, hint: 'Nightly self-research reports' },
];

/** Pinned at the bottom of the sidebar. */
export const FOOTER_NAV: NavDest[] = [
  { path: '/settings', label: 'Settings', icon: Settings, hint: 'Appearance, profile & account' },
  { path: '/help', label: 'Help', icon: HelpCircle, hint: 'Guides, shortcuts & version' },
];

export const ALL_NAV: NavDest[] = [...PRIMARY_NAV, ...ADVANCED_NAV, ...FOOTER_NAV];
