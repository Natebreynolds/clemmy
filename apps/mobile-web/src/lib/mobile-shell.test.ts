/**
 * Run: npx tsx --test src/lib/mobile-shell.test.ts   (from apps/mobile-web)
 *
 * Pin: the PWA install/launch shell is "clementine in daylight". The
 * manifest and the host page must agree on the paper palette so an
 * installed app can never open through a dark splash or dark status bar
 * again — the regression becomes unrepresentable, not just unlikely.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Owner directive 2026-08-27: "the app kind of needs to have a white
// background". The page, the manifest splash, the theme-color and the iOS
// container must agree on ONE value — a mismatch shows as a tinted flash
// before first paint and a tinted band under the over-scroll bounce.
const PAPER = '#ffffff';
const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('manifest launches on the paper palette, never a dark shell', () => {
  const manifest = JSON.parse(read('../../public/manifest.webmanifest'));
  assert.equal(manifest.background_color, PAPER);
  assert.equal(manifest.theme_color, PAPER);
});

test('index.html status bar and theme-color match the light chrome', () => {
  const html = read('../../index.html');
  const statusBar = html.match(
    /name="apple-mobile-web-app-status-bar-style"\s+content="([^"]+)"/,
  );
  assert.equal(statusBar?.[1], 'default');
  const themeColor = html.match(/name="theme-color"\s+content="([^"]+)"/);
  assert.equal(themeColor?.[1], PAPER);
});

/**
 * Owner 2026-10-30 (replacing the 10-23 tab bar): "No user is going to want to
 * poke around this complicated UI on mobile." The phone is ONE screen, Clem's.
 * Every other place lives in Your stuff, opened beside the composer, and a
 * place pushes in with a back button to Clem. No tab bar, no header pills.
 */
test('a phone is one Clem screen with every other place in Your stuff, one tap back', () => {
  const app = read('../app.tsx');
  assert.doesNotMatch(app, /<TabBar|TAB_BAR_PLACES/, 'the bottom tab bar is gone');
  assert.match(app, /const STUFF_GROUPS: ReadonlyArray<ReadonlyArray<Tab>> = \[/);
  for (const place of ['chats', 'inbox', 'spaces', 'workflows', 'projects', 'activity', 'agents', 'memory', 'settings']) {
    assert.match(app.slice(app.indexOf('const STUFF_GROUPS')), new RegExp(`'${place}'`), `${place} is reachable from Your stuff`);
  }
  assert.match(app, /home: 'Clem',/, 'the one screen is named for her');
  assert.match(app, /class="nav-back" onClick=\{\(\) => \{ haptic\('light'\); navigateTo\('home'\); \}\}/,
    'every other place goes back to Clem in one tap');
  assert.match(app, /onOpenStuff=\{openDrawer\}/, 'the composer carries the Your stuff door');
  assert.doesNotMatch(app, /header-chat-button|needs-pill|<RunningTasksSheet/, 'the header carries no pills');
  const capsule = read('../components/AskCapsule.tsx');
  assert.match(capsule, /class="stuff-button"[\s\S]*?aria-label="Your stuff"[\s\S]*?aria-haspopup="dialog"/);
  const adaptive = read('../adaptive-layout.css');
  assert.doesNotMatch(adaptive, /\.tab-bar/, 'the tab bar styles are deleted, not hidden');
  // The old dock stays deleted too.
  assert.doesNotMatch(app, /class="dock"|dock-icon|dock-label|dock-badge/);
  const styles = read('../styles.css');
  assert.doesNotMatch(styles, /--dock-height|\.dock\b|\.dock-/);
  assert.match(styles, /\.app-main \{[\s\S]*?env\(safe-area-inset-bottom\)/);
});

test('320px and 393px places keep whole labels, separate counts and readable targets', () => {
  const app = read('../app.tsx');
  const inbox = read('../screens/Inbox.tsx');
  const project = read('../screens/Project.tsx');
  const styles = read('../styles.css');
  assert.match(app, /id: 'workflows',\s*label: 'Automations'/);
  assert.match(app, /workflows: 'Automations'/, 'the actual screen title remains the full destination');
  assert.match(inbox, /class="inbox-tab-label">Needs you<\/span><span class="inbox-tab-count"/);
  assert.match(inbox, /class="inbox-tab-label">Updates<\/span><span class="inbox-tab-count"/);
  const rules = styles.slice(styles.indexOf('.inbox-tabs button {'), styles.indexOf('.inbox-tabs button.active'));
  assert.match(rules, /flex-direction: column/);
  assert.match(rules, /white-space: nowrap/);
  assert.doesNotMatch(rules, /overflow-wrap: anywhere/);
  assert.match(styles, /\.inbox-tab-label \{[^}]*white-space: nowrap/);
  assert.match(styles, /\.drawer-item \{[\s\S]*?min-height: 52px/, 'Your stuff rows clear the 44px floor');
  assert.match(project, /`Agents, \$\{overview\.agents\.length\} assigned/,
    'assigned-agent counts have a readable accessible name rather than concatenated text');
});

test('Your stuff is a modal, focus-trapped, keyboard dismissible sheet that marks the current place', () => {
  const app = read('../app.tsx');
  const menuButton = read('../components/NavigationMenuButton.tsx');
  assert.match(menuButton, /aria-label="More places and settings"[\s\S]*?aria-haspopup="dialog"[\s\S]*?aria-expanded=\{navigation.navigationOpen\}/,
    'a detail screen\'s own Clemmy mark still opens the same sheet');
  assert.match(app, /<span class="title-text">\{TAB_TITLES\[tab\]\}<\/span>/);
  assert.doesNotMatch(app, /TitleSwitcher|switcherOpen|title-switch/);
  // Dialog semantics + Escape + scrim close.
  assert.match(app, /class=\{`drawer-layer\$\{drawerClosing \? ' closing' : ''\}`\}[\s\S]*?role=\{drawerClosing \? undefined : 'dialog'\}/);
  assert.match(app, /aria-label=\{drawerClosing \? undefined : 'Your stuff'\}/);
  assert.match(app, /aria-hidden=\{drawerClosing \? true : undefined\}/);
  assert.match(app, /inert=\{drawerClosing \? true : undefined\}/,
    'the animated closing layer is immediately non-interactive');
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /class="drawer-scrim"[\s\S]*?aria-label="Close Your stuff"/);
  assert.match(app, /class="drawer-close" type="button" onClick=\{\(\) => closeDrawer\(\)\}>Done<\/button>/);
  const closeStart = app.indexOf('const closeDrawer =');
  const closeEnd = app.indexOf('\n  };', closeStart);
  const closeSource = app.slice(closeStart, closeEnd);
  const restoreFocusAt = closeSource.indexOf('drawerOpenerRef.current.focus()');
  assert.ok(restoreFocusAt >= 0 && restoreFocusAt < closeSource.indexOf('window.setTimeout'),
    'focus returns before the exit animation rather than staying inside aria-hidden content');
  // The current place carries the page marker.
  assert.match(app, /aria-current=\{tab === t\.id \? 'page' : undefined\}/);
  const css = read('../styles.css');
  assert.match(css, /\.drawer \{[\s\S]*?bottom: 0;[\s\S]*?env\(safe-area-inset-bottom\)/, 'the sheet rises from the bottom, clear of the home indicator');
  assert.match(css, /\.drawer \{[\s\S]*?env\(safe-area-inset-left\)/);
  assert.match(css, /\.drawer-item\[aria-current='page'\] \{/);
});

test('drawer tab selection cannot be undone by a synthetic history-back entry', () => {
  const app = read('../app.tsx');
  assert.doesNotMatch(app, /useBackGesture\(drawerOpen/,
    'the drawer must not push history: closing that entry after replaceState returns to the old tab');
  assert.match(app, /onTouchEnd=\{\(event\) => \{[\s\S]*?clientY - s\.y > 72 && \(drawerRef\.current\?\.scrollTop \?\? 0\) <= 0\) closeDrawer\(\)/,
    'the sheet pulls down to close, only from its top, without browser history');
  assert.match(app, /navigateTo\(t\.id\);[\s\S]*?closeDrawer\(false\);/,
    'a section tap selects its exact peer tab and then closes the menu');
  assert.match(app, /window\.history\.replaceState/,
    'peer tab selection updates the deep-link URL in place rather than adding back-stack depth');
});

/**
 * Owner mandates 2026-08-25: the header sign-out moves into Settings > Devices
 * & security, and trust is minted at home on the Mac and only EXERCISED in
 * the pocket — so nothing key-shaped may ever render on the phone. Settings
 * (Apps & devices) is a row in Your stuff (owner 2026-10-30).
 */
test('Settings is reachable from Your stuff and the header sign-out is gone', () => {
  const app = read('../app.tsx');
  assert.match(app, /\['memory', 'settings'\],/, 'Settings is the last row of Your stuff');
  assert.doesNotMatch(app, /aria-label="Sign out"/,
    'the header sign-out moved into Settings > Devices & security');
});

test('Settings holds nothing key-shaped — routing choices only', () => {
  const settings = read('../screens/Settings.tsx');
  assert.doesNotMatch(settings, /<input/i,
    'no input fields at all: connecting accounts and minting trust happen on the Mac');
  assert.doesNotMatch(settings, /type="password"|autocomplete="current-password"/i);
});

test('the brain switcher renders from the live catalog, never a hardcoded roster', () => {
  const sheet = read('../components/BrainSheet.tsx');
  assert.match(sheet, /getModelSettings/,
    'the roster comes from the daemon catalog route');
  const settings = read('../screens/Settings.tsx');
  for (const literal of ['gpt-5', 'claude-opus', 'claude-sonnet', 'glm-', 'deepseek', 'minimax']) {
    const re = new RegExp(literal, 'i');
    assert.doesNotMatch(sheet, re, `model id "${literal}" must not be hardcoded in the sheet`);
    assert.doesNotMatch(settings, re, `model id "${literal}" must not be hardcoded in Settings`);
  }
});

test('the Models card names each part of a request and picks only from the live catalog', () => {
  const copy = read('./model-roles.ts');
  const sheet = read('../components/RoleSheet.tsx');
  const api = read('./api.ts');
  for (const title of ['Does the work', 'Writes the final answer', 'Checks the work', 'Helps in parallel']) {
    assert.match(copy, new RegExp(`title: '${title}'`), `the "${title}" row is named in plain words`);
  }
  assert.match(sheet, /settings\.roleOptions\?\.\[role\]/,
    'the picker lists the daemon catalog for that role');
  assert.match(sheet, /setModelRole\(role, modelId\)/,
    'a pick is saved through the one role route');
  assert.match(api, /\/m\/api\/settings\/models\/role/);
  assert.match(api, /modelId === null \? \{ role, clear: true \} : \{ role, modelId \}/,
    'the only role write is an exact model id or a clear back to automatic');
  for (const literal of ['gpt-5', 'claude-opus', 'claude-sonnet', 'glm-', 'deepseek', 'minimax', 'grok']) {
    const re = new RegExp(literal, 'i');
    assert.doesNotMatch(sheet, re, `model id "${literal}" must not be hardcoded in the role picker`);
    assert.doesNotMatch(copy, re, `model id "${literal}" must not be hardcoded in the role wording`);
  }
  assert.doesNotMatch(sheet, /<input/i, 'the role picker is taps only');
});

test('the mobile model API saves the owner\'s backup order with exact ids and no credentials', () => {
  const api = read('../lib/api.ts');
  assert.match(api, /brainBackups\?: BrainBackupsSettings/,
    'the model-settings response carries the daemon-owned backup list');
  assert.match(api, /setBrainBackups\(modelIds: string\[\]\)/);
  assert.match(api, /\/m\/api\/settings\/models\/brain-backups/);
  assert.doesNotMatch(api, /brainBackups[\s\S]{0,500}(apiKey|accessToken|refreshToken|password)/i,
    'the backup API never carries credentials');
});

test('Settings offers backups only from the connected catalog and refreshes after save', () => {
  const settings = read('../screens/Settings.tsx');
  assert.match(settings, /option\.available && option\.modelId && option\.modelId !== settings\.brain\.modelId/,
    'only connected models other than the one doing the work are offered');
  assert.match(settings, /value=\{option\.modelId\}/,
    'the selected value is the exact catalog id, never a label heuristic');
  assert.match(settings, /await setBrainBackups[\s\S]*?await onChanged\(\)/,
    'a successful save refreshes the parent model snapshot before settling');
});

test('the keyboard stays in daylight: color-scheme meta + shell trait override', () => {
  // WebKit decides KEYBOARD appearance from the color-scheme meta (read
  // before CSS) and the native view's trait override — the CSS property
  // alone leaves a dark-mode phone summoning a dark keyboard over the light
  // page (live 2026-08-26).
  const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(indexHtml, /<meta name="color-scheme" content="light" \/>/);
  const shell = readFileSync(new URL('../../../ios/Clem/PinnedWebView.swift', import.meta.url), 'utf8');
  assert.match(shell, /overrideUserInterfaceStyle = \.light/);
});

/**
 * Owner design 2026-09-04: the title is the navigator and the floating ask
 * capsule is the app's ONE persistent control. Navigation lives in a
 * bottom sheet fed by HomePreferences.phoneSwitcher; the inline ask box on
 * Home is gone; the capsule floats above the safe area with 44px targets.
 */
test('the one drawer and the ask capsule replace the hamburger, the title sheet and the inline ask box', () => {
  const app = read('../app.tsx');
  assert.doesNotMatch(app, /<TitleSwitcher|phoneSwitcherIds\(/, 'the title-tap sheet and its preference are gone');
  assert.match(app, /<AskCapsule onAsk=\{\(draft, attachments\) => goToChat\(\{ draft, attachments, autoSend: true \}\)\}/,
    'the capsule sends through the same path Home\'s ask box used, files included');
  assert.doesNotMatch(app, /class="menu-btn"/);
  const home = read('../screens/Home.tsx');
  assert.doesNotMatch(home, /class="ask rise"|class="ask-input"/, 'the inline ask box is gone from Home');
  assert.doesNotMatch(home, /listRecentRuns|useScreenData\(listChatSessions/, 'no dead run fetch, no duplicate polls: Recent loads once per open');
  assert.match(home, /useWorkingNow\(\)/, 'Running renders from the ONE shared snapshot');
  const css = read('../styles.css');
  assert.match(css, /\.ask-capsule \{[\s\S]*?position: fixed;[\s\S]*?env\(safe-area-inset-bottom\)/);
  // The capsule and thread share 44px controls that remain reachable on phones.
  const capsule = read('../components/AskCapsule.tsx');
  assert.match(capsule, /<Composer[\s\S]*?compact/);
  assert.match(css, /\.composer-icon \{[^}]*width: 44px;[^}]*height: 44px/);
  assert.doesNotMatch(css, /\.ask-capsule-send \{|\.ask-capsule-mic \{|\.chat-composer \{|\.chat-mode-seg \{/, 'the old capsule and thread composer styles are deleted, not hidden');
  assert.doesNotMatch(css, /\.menu-btn \{|\.inbox-intro \{/, 'dead chrome styles are deleted, not hidden');
});

test('one working-now poll feeds the header chip and Home', () => {
  const sheet = read('../components/RunningTasksSheet.tsx');
  assert.match(sheet, /useWorkingNow\(\)/);
  assert.doesNotMatch(sheet, /useScreenData\(listWorkingNow/);
  const app = read('../app.tsx');
  assert.match(app, /useWorkingNow\(authenticated\)/, 'the shell keeps the poll alive while signed in');
});

/**
 * Projects is a place of its own in the menu, a link can open one project,
 * and a decision settled inside a project moves the ONE Needs-you count at
 * once instead of at the next poll.
 */
test('Projects is a primary place, deep-linkable, and settles the shared Needs-you count', () => {
  const app = read('../app.tsx');
  assert.match(app, /projects: 'Work',/, 'Projects is grouped under Work with tasks and agents');
  assert.match(app, /useState<string \| null>\(\(\) => projectFromSearch\(window\.location\.search\)\)/,
    'a cold open on a project link lands on that project');
  assert.match(app, /setProjectId\(projectFromSearch\(window\.location\.search\)\)/,
    'a link arriving while the app is open moves it too');
  assert.match(app, /<Projects[\s\S]*?onProjectChange=\{\(id\) => navigateTo\('projects', \{ projectId: id \}\)\}/);
  assert.match(app, /<Projects[\s\S]*?onDecided=\{\(\) => recountNeedsYou\.current\(\)\}/);
  assert.match(app, /recountNeedsYou\.current = \(\) => \{ void refreshCount\(\); \};/,
    'the recount is the shell\'s own poll, not a second source for the number');
  const deepLink = read('./deep-link.ts');
  assert.match(deepLink, /if \(input\.tab === 'projects' && input\.projectId\) params\.set\('project', input\.projectId\);/);
});

test('an agent pinned to a model: the chat chip names it, and a pick in the conversation lands after the switch', () => {
  const chat = read('../screens/Chat.tsx');
  const sheet = read('../components/BrainSheet.tsx');
  const api = read('./api.ts');
  assert.match(api, /\/m\/api\/chat\/answering-model\?/, 'the phone asks the daemon what answers next');
  assert.match(chat, /getNextAnsweringModel\(answeringSessionId, answeringAgentId\)/);
  assert.match(chat, /modelDisplayName\(brainLabel\)/, 'the chip names the scoped model using its catalog label');
  assert.match(chat, /answeringAgent=\{agentModel\}/);
  assert.match(chat, /beforeChange=\{\(\) => applyAgentChoice\(/);
  assert.match(sheet, /await beforeChange\?\.\(\)[\s\S]{0,180}await setBrain\(value, sessionId\)/,
    'a pending agent switch lands before the pick, so the pick is the later choice');
  assert.match(sheet, /\{!answering && answeringModel === undefined && settings\.brain\.inactiveBinding/,
    'no "answers instead" note about the owner\'s model while the agent\'s own model answers');
});

test('the phone\'s approval card reads like a question card and Needs you is titled with Clem\'s question', () => {
  const chat = read('../screens/Chat.tsx');
  assert.match(chat, /const ask = message\.approval\.preview\?\.ask && !message\.approval\.preview\.items/);
  assert.match(chat, /<div class="approval-ask">\{ask\}<\/div>/);
  assert.match(chat, /approvalId && !approvalDecided && ask \? \(\s*<div class="answer-choices"/);
  assert.match(chat, /APPROVAL_ANSWER_WORDS\.approve/);
  assert.match(read('../screens/Home.tsx'), /title = row\.presentation\?\.ask \?\? approvalQuestion\(row\.subject\)/);
  assert.match(read('../components/Approvals.tsx'), /row\.presentation\?\.ask \?\? approvalQuestion\(row\.subject\)/);
});


test('legacy chat plans navigate to exact full review and preserve rejection without approving a clipped preview', () => {
  const chat = read('../screens/Chat.tsx');
  const start = chat.indexOf("message.planProposalId && planStatus === 'pending' && !message.planProposalNeedsUserInput");
  const end = chat.indexOf("message.planProposalId && planStatus === 'pending' && message.planProposalNeedsUserInput", start);
  assert.ok(start >= 0 && end > start);
  const legacy = chat.slice(start, end);
  assert.match(legacy, /Review full plan/);
  assert.match(legacy, /destinationSearch\(\{ tab: 'inbox', decisionKey: `plan:\$\{message\.planProposalId!\}` \}\)/);
  assert.match(legacy, /window\.dispatchEvent\(new PopStateEvent\('popstate'\)\)/);
  assert.doesNotMatch(legacy, /onPlanAction\([^)]*'approve'/, 'a clipped chat preview cannot approve the underlying proposal');
  assert.match(legacy, /onPlanAction\(message\.planProposalId!, 'reject'\)/);
  assert.match(chat, /<PlanReview planRef=/, 'modern revision-bound review is preserved');
});

test('Inbox history applies an empty item selection when browser Back returns to the list URL', () => {
  const inbox = read('../screens/Inbox.tsx');
  assert.match(inbox, /const key = inboxDecisionFromSearch\(window\.location\.search\); setOpenKey\(key\); setTab\(key \? 'needs' : inboxViewFromSearch\(window\.location\.search\)\)/,
    'null from a list URL must be applied, not ignored behind a truthy-key guard');
  assert.match(inbox, /handledDeepLink\.current = null;\s*setLocationRevision\(value => value \+ 1\)/,
    'Back to an already-presented notification is a new navigation, not suppressed by its old one-time receipt');
  assert.match(inbox, /\[approvalIds, data, initialNotificationId, locationRevision,/,
    'an unchanged notification id and retained data still re-run the exact-row selection after Back');
  assert.match(inbox, /navigateInboxView\(next\)/, 'local tabs use the navigation path that also synchronizes the shell');
  assert.match(inbox, /!inboxNotificationIsCurrent\(window\.location\.search, initialNotificationId\)/,
    'a pending presentation first verifies that the notification still owns the current URL');
});

test('the mounted project editor compares its draft with the record captured when editing began', () => {
  const project = read('../screens/Project.tsx');
  assert.match(project, /const \[baseline\] = useState\(\(\) => projectEditBaseline\(project\)\)/);
  assert.match(project, /projectDraftFrom\(baseline\)/);
  assert.match(project, /projectDraftChanges\(baseline, draft\)/);
  assert.doesNotMatch(project, /projectDraftChanges\(project, draft\)/, 'a polled overview cannot redefine which fields the owner edited');
});


test('chat tools are contextual while conversation files retain an explicit lazy, focus-safe door', () => {
  const chat = read('../screens/Chat.tsx');
  const files = read('../components/CompletedFiles.tsx');
  const browser = read('../components/CloudBrowserDock.tsx');
  const composer = read('../components/Composer.tsx');
  assert.doesNotMatch(chat, /browserOpenRequest|Open browser tools|Browser tools are available after your first message/);
  assert.match(chat, /Conversation files/);
  assert.match(chat, /<CompletedFiles[^>]*openRequest=\{filesOpenRequest\}[^>]*onReturn=\{\(\) => optionsTrigger\.current\?\.focus\(\)\}/);
  assert.doesNotMatch(files, /class="chat-files-bar"|class="chat-files-trigger"/, 'no empty Files strip competes with the transcript');
  assert.match(files, /if \(!open\) return;[\s\S]*listSessionFiles\(sessionId/, 'saved files still load only on explicit open');
  assert.match(files, /FilePreview/);
  assert.match(files, /onDiscuss\(context\)/, 'saved files can still become revision-bound conversation context');
  assert.doesNotMatch(browser, /openRequest/);
  assert.match(browser, /const inUse = conversationBrowsersInUse\(resources\)/);
  assert.match(browser, /Take control/);
  assert.match(browser, /Watch/);
  assert.match(browser, /cloudBrowser\.stop\(/, 'real session controls remain reachable');
  assert.match(composer, /ref=\{filesRef\} type="file" multiple/, 'phone file attachments are retained');
});
