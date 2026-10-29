import { appGuidanceHref, appPlaceHref } from './app-places.js';

export interface AppGuidance {
  id: string;
  title: string;
  instruction: string;
  /** A named semantic target, never a screen coordinate. */
  target: string;
  placeHref: string;
}

interface GuidanceDefinition {
  title: string;
  desktop: { target: string; instruction: string };
  phone: { target: string; instruction: string };
}

const guidance: Readonly<Record<string, GuidanceDefinition>> = {
  inbox: {
    title: 'Your Inbox',
    desktop: { target: '[data-clem-guide="inbox"]', instruction: 'Choose a request to review it. Answer when you are ready, or use Later or Dismiss where offered. Declining a request and stopping work are separate actions.' },
    phone: { target: '[data-clem-guide="inbox"]', instruction: 'Tap a request to review it and see its actions. You can answer, return to it later, or dismiss an eligible update.' },
  },
  work: {
    title: 'Your work with Clem',
    desktop: { target: 'main', instruction: 'Use the Work tabs to move between projects, tasks, agents, and results. Open a task to see what happened and what it needs next.' },
    phone: { target: 'main', instruction: 'Projects, tasks, and agents live together here. Choose a tab, then tap the item you want to continue.' },
  },
  projects: {
    title: 'Keep a project together',
    desktop: { target: '[data-clem-guide="create-project"]', instruction: 'Choose New project to give a body of work its own goal and context. Open a project to find its agents, conversations and saved results together.' },
    phone: { target: '[data-clem-guide="create-project"]', instruction: 'Tap the plus button at the top to give a body of work its own goal and context. Tap an existing project to find its agents, conversations and results.' },
  },
  agents: {
    title: 'Work with a specialist',
    desktop: { target: '[data-clem-guide="create-agent"]', instruction: 'Choose New agent to give a specialist standing instructions and skills. Open an agent to continue its conversations, or assign it to a project.' },
    phone: { target: '[data-clem-guide="create-agent"]', instruction: 'Tap the plus button at the top to create a specialist with its own instructions. Tap an existing agent to see its work, projects and conversations.' },
  },
  spaces: {
    title: 'Build a Space',
    desktop: { target: '[data-clem-guide="create-space"]', instruction: 'Choose New Space and tell Clem what you want to track or manage. A Space is a live page you can return to after the conversation.' },
    phone: { target: '[data-clem-guide="create-space"]', instruction: 'Use the create button to tell Clem what you want to track. Tap an existing Space to open its live page.' },
  },
  automate: {
    title: 'Let Clem handle recurring work',
    desktop: { target: '[data-clem-guide="create-automation"]', instruction: 'Choose New automation and describe the work and when it should happen. Review the proposed setup before enabling it.' },
    phone: { target: '[data-clem-guide="create-automation"]', instruction: 'Choose the create action and describe what should happen and when. Open an existing automation to review its schedule, readiness, and recent runs.' },
  },
  connect: {
    title: 'Connect what you need',
    desktop: { target: '[data-clem-guide="connections"]', instruction: 'Name the app or tool you need. Clem can guide setup; complete any private sign-in in the provider’s own window.' },
    phone: { target: '[data-clem-guide="connections"]', instruction: 'Review your connected apps and their status here. For sign-in or app setup, open Apps & devices on the computer running Clem.' },
  },
  phone: {
    title: 'Your phone and computer',
    desktop: { target: '[data-clem-guide="phone"]', instruction: 'Open Clem on your phone and scan the pairing code while both devices are on the same Wi-Fi. Allow Local Network access when asked, then check the remote connection.' },
    phone: { target: '[data-clem-guide="phone"]', instruction: 'Your phone connects to the computer running Clem. Review the connection and device settings here; new pairing starts from Apps & devices on the computer.' },
  },
  memory: {
    title: 'What Clem knows',
    desktop: { target: '[data-clem-guide="memory"]', instruction: 'Search for something Clem remembers. Open its source to understand it, and use the memory controls to correct or forget information.' },
    phone: { target: '[data-clem-guide="memory"]', instruction: 'Search for a fact, person, or procedure. Open a memory to see its context and available correction controls.' },
  },
  models: {
    title: 'Who does what',
    desktop: { target: '#who-does-what', instruction: 'Each role shows the model assigned to it. Open the role’s selector to review your choices. Navigation here has not changed any selection.' },
    phone: { target: '[data-clem-guide="models"]', instruction: 'Review the model assigned to each role. Open a selector to choose a different model; nothing changes just by opening this guide.' },
  },
  'model-accounts': {
    title: 'Your model accounts',
    desktop: { target: '#accounts', instruction: 'Review an account’s connection and available usage. Choose Manage to continue its sign-in or account setup.' },
    phone: { target: '[data-clem-guide="accounts"]', instruction: 'Review your model accounts and usage here. If a billing link is available, it opens the provider’s page. Sign-in and account setup are in Settings on your computer.' },
  },
  notifications: {
    title: 'How Clem reaches you',
    desktop: { target: '#notifications', instruction: 'Choose where you want Clem’s updates and requests to arrive. Review each destination before changing its notification preference.' },
    phone: { target: '[data-clem-guide="notifications"]', instruction: 'Review where Clem sends updates and requests. Change only the destinations you want to receive them.' },
  },
};

/** A reply can only guide to an existing, explicitly supported app destination. */
export function getAppGuidance(id: string | null | undefined, surface: 'desktop' | 'phone'): AppGuidance | null {
  if (!id || !appGuidanceHref(id, surface)) return null;
  const definition = guidance[id === 'needs-you' ? 'inbox' : id];
  const placeHref = appPlaceHref(id, surface);
  if (!definition || !placeHref) return null;
  return { id, title: definition.title, ...definition[surface], placeHref };
}
