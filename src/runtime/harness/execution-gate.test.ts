/**
 * Run: npx tsx --test src/runtime/harness/execution-gate.test.ts
 *
 * Pure-function tests for the execution-wrap gate. No SDK, no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMutatingExternalWrite,
  isGateEnabled,
  MissingExecutionWrapError,
  isIrreversibleSendSlug,
} from './execution-gate.js';

// ─── isIrreversibleSendSlug — the ONE canonical predicate ─────────
// Permanent regression fixtures for the 2026-07-09 re-hunt Lane 5:
// the classifier both UNDER-gated real sends and OVER-gated reversible writes.

test('isIrreversibleSendSlug: SEND_DRAFT dispatches an existing draft — is a send (DRAFT no longer short-circuits before the SEND verb)', () => {
  for (const s of ['outlook_send_draft', 'GMAIL_SEND_DRAFT', 'OUTLOOK_SEND_DRAFT']) {
    assert.equal(isIrreversibleSendSlug(s), true, `${s} must be an irreversible send`);
  }
});

test('isIrreversibleSendSlug: CREATE_DRAFT / CREATE_REPLY_DRAFT compose without sending — reversible', () => {
  for (const s of ['outlook_create_draft', 'outlook_create_reply_draft', 'outlook_create_reply_all_draft', 'GMAIL_CREATE_DRAFT']) {
    assert.equal(isIrreversibleSendSlug(s), false, `${s} is a reversible draft`);
  }
});

test('isIrreversibleSendSlug: FORWARD and REPLY dispatch a real email — are sends', () => {
  assert.equal(isIrreversibleSendSlug('outlook_forward_mail'), true);
  assert.equal(isIrreversibleSendSlug('GMAIL_REPLY_TO_THREAD'), true);
});

test('isIrreversibleSendSlug: dispatch-verb + comm-object native sends are caught', () => {
  for (const s of ['claude_ai_Google_Calendar__create_event', 'respond_to_event', 'DISCORD_CREATE_MESSAGE', 'TWILIO_CREATE_MESSAGE', 'VAPI_CREATE_CALL', 'TWILIO_MAKE_OUTBOUND_CALL', 'make_outbound_call']) {
    assert.equal(isIrreversibleSendSlug(s), true, `${s} must be an irreversible send`);
  }
});

test('isIrreversibleSendSlug: CALL as a noun (reads) is NOT a send — the bare verb was removed', () => {
  for (const s of ['VAPI_GET_CALL', 'mcp__vapi__get_call', 'TWILIO_LIST_CALLS', 'mcp__vapi__list_calls']) {
    assert.equal(isIrreversibleSendSlug(s), false, `${s} is a call READ, not a send`);
  }
});

test('isIrreversibleSendSlug: reversible writes stay free (no over-gate on CHAT/COMMENT/spreadsheet/contact)', () => {
  for (const s of ['OPENAI_CREATE_CHAT_COMPLETION', 'NOTION_CREATE_COMMENT', 'create_record_comment', 'GOOGLESHEETS_CREATE_SPREADSHEET', 'GOOGLESHEETS_VALUES_UPDATE', 'CREATE_CONTACT', 'CREATE_LABEL', 'AIRTABLE_CREATE_RECORD', 'NOTION_CREATE_PAGE']) {
    assert.equal(isIrreversibleSendSlug(s), false, `${s} is a reversible write — must not force a card`);
  }
});

test('isIrreversibleSendSlug: ADD-a-label / ADD-a-reaction are reversible metadata ops, not sends (re-hunt round 2)', () => {
  // 'ADD' is not a dispatch verb — there is no add-a-communication send. These
  // reversible metadata ops must NOT be gated as irreversible sends (it would
  // silently break auto-triage/labeling workflows).
  for (const s of ['GMAIL_ADD_LABEL_TO_EMAIL', 'SLACK_ADD_REACTION_TO_A_MESSAGE', 'GMAIL_REMOVE_LABEL', 'GOOGLECALENDAR_QUICK_ADD']) {
    assert.equal(isIrreversibleSendSlug(s), false, `${s} is a reversible metadata op`);
  }
});

// ─── isMutatingExternalWrite — composio_execute_tool ──────────────

test('isMutatingExternalWrite: GOOGLESHEETS_VALUES_UPDATE is a write', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_VALUES_UPDATE' }),
    true,
  );
});

test('isMutatingExternalWrite: GOOGLESHEETS_VALUES_GET is a READ — not gated', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_VALUES_GET' }),
    false,
  );
});

test('isMutatingExternalWrite: OUTLOOK_CREATE_DRAFT is a write', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'OUTLOOK_CREATE_DRAFT' }),
    true,
  );
});

test('isMutatingExternalWrite: OUTLOOK_LIST_MESSAGES is a read', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'OUTLOOK_LIST_MESSAGES' }),
    false,
  );
});

test('isMutatingExternalWrite: CALL is a read object after GET/LIST/RETRIEVE', () => {
  for (const slug of ['GONG_GET_CALL_TRANSCRIPT', 'VAPI_RETRIEVE_CALL', 'TWILIO_LIST_CALLS']) {
    assert.equal(
      isMutatingExternalWrite('composio_execute_tool', { tool_slug: slug }),
      false,
      slug,
    );
  }
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GONG_GET_CALL_AND_UPDATE_CONTACT' }),
    true,
    'another mutation token must still win',
  );
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'VAPI_CREATE_CALL' }),
    true,
    'placing a call remains a mutation',
  );
});

test('isMutatingExternalWrite: GOOGLESHEETS_BATCH_UPDATE is a write (BATCH verb)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_BATCH_UPDATE' }),
    true,
  );
});

test('isMutatingExternalWrite: GOOGLESHEETS_BATCH_GET is a read (canonical GET action wins over BATCH noun)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_BATCH_GET' }),
    false,
  );
});

test('isMutatingExternalWrite: SALESFORCE_LIST_ACCOUNTS is a read', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'SALESFORCE_LIST_ACCOUNTS' }),
    false,
  );
});

test('isMutatingExternalWrite: INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH is a write (POST + PUBLISH)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH' }),
    true,
  );
});

test('isMutatingExternalWrite: canonical mutations without the legacy verb list are still gated', () => {
  for (const slug of [
    'ONE_DRIVE_UPLOAD_FILE',
    'GMAIL_MARK_AS_READ',
    'DROPBOX_MOVE_FILE',
    'SLACK_ADD_REACTION_TO_A_MESSAGE',
    'ACME_DO_THING',
  ]) {
    assert.equal(
      isMutatingExternalWrite('composio_execute_tool', { tool_slug: slug }),
      true,
      slug,
    );
  }
});

test('isMutatingExternalWrite: every Composio carrier resolves to the same canonical write action', () => {
  const wrapperArgs = { tool_slug: 'AIRTABLE_UPDATE_RECORD', arguments: '{}' };
  for (const [toolName, args] of [
    ['composio_execute_tool', wrapperArgs],
    ['mcp__clementine-local__composio_execute_tool', wrapperArgs],
    ['mcp__composio__execute_tool', wrapperArgs],
    ['cx_airtable_update_record', { record_id: 'rec_1' }],
    ['mcp__clementine-local__cx_airtable_update_record', { record_id: 'rec_1' }],
  ] as const) {
    assert.equal(isMutatingExternalWrite(toolName, args), true, toolName);
  }
});

test('isMutatingExternalWrite: every Composio carrier resolves to the same canonical read action', () => {
  const wrapperArgs = { tool_slug: 'OUTLOOK_LIST_MESSAGES', arguments: '{}' };
  for (const [toolName, args] of [
    ['composio_execute_tool', wrapperArgs],
    ['mcp__clementine-local__composio_execute_tool', wrapperArgs],
    ['mcp__composio__execute_tool', wrapperArgs],
    ['cx_outlook_list_messages', { folder: 'Inbox' }],
    ['mcp__clementine-local__cx_outlook_list_messages', { folder: 'Inbox' }],
  ] as const) {
    assert.equal(isMutatingExternalWrite(toolName, args), false, toolName);
  }
});

test('isMutatingExternalWrite: documented noun-shaped reads stay reads on wrapper, dynamic, and native MCP lanes', () => {
  for (const slug of [
    'SLACK_CONVERSATIONS_HISTORY',
    'TWITTER_USER_TIMELINE',
    'GOOGLEDRIVE_DOWNLOAD_FILE',
  ]) {
    assert.equal(
      isMutatingExternalWrite('composio_execute_tool', { tool_slug: slug }),
      false,
      `wrapper ${slug}`,
    );
    assert.equal(
      isMutatingExternalWrite(`cx_${slug.toLowerCase()}`, {}),
      false,
      `dynamic ${slug}`,
    );
  }
  assert.equal(
    isMutatingExternalWrite('mcp__slack__conversations_history', {}),
    false,
    'native MCP Slack history is a catalog read',
  );
  assert.equal(
    isMutatingExternalWrite('mcp__twitter__user_timeline', {}),
    false,
    'native MCP Twitter timeline is a catalog read',
  );
  assert.equal(
    isMutatingExternalWrite('mcp__googledrive__download_file', {}),
    false,
    'native MCP Drive download is a catalog read',
  );
});

test('isMutatingExternalWrite: catalog read exemptions are exact and cannot be borrowed by an unknown provider action', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', {
      tool_slug: 'ACME_SLACK_CONVERSATIONS_HISTORY',
    }),
    true,
  );
  assert.equal(
    isMutatingExternalWrite('mcp__acme__slack_conversations_history', {}),
    true,
  );
});

test('isMutatingExternalWrite: deferred call_tool dispatch inherits the inner action effect', () => {
  assert.equal(
    isMutatingExternalWrite('call_tool', {
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'AIRTABLE_UPDATE_RECORD', arguments: '{}' }),
    }),
    true,
  );
  assert.equal(
    isMutatingExternalWrite('mcp__clementine-local__call_tool', {
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: 'SLACK_CONVERSATIONS_HISTORY', arguments: '{}' }),
    }),
    false,
  );
});

test('isMutatingExternalWrite: unknown external actions fail closed on every externally-dispatched lane', () => {
  assert.equal(isMutatingExternalWrite('composio_execute_tool', {}), true, 'missing wrapper slug');
  assert.equal(isMutatingExternalWrite('composio_execute_tool', '{not valid json'), true, 'malformed wrapper');
  assert.equal(isMutatingExternalWrite('cx_acme_do_thing', {}), true, 'unknown dynamic action');
  assert.equal(isMutatingExternalWrite('mcp__acme__do_thing', {}), true, 'unknown native MCP action');
  for (const toolName of [
    'mcp__stripe__refund_payment',
    'mcp__aws__reboot_instance',
    'mcp__cloudflare__purge_cache',
    'mcp__acme__transact',
    'mcp__github__merge_pull_request',
    'mcp__secrets__rotate_key',
    'mcp__billing__charge_customer',
  ]) {
    assert.equal(isMutatingExternalWrite(toolName, {}), true, toolName);
  }
});

// ─── isMutatingExternalWrite — exempt slug patterns ──────────────

test('isMutatingExternalWrite: structural DataForSEO research jobs and polls are reads on every carrier', () => {
  for (const toolSlug of [
    'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST',
    'DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID',
    'DATAFORSEO_SERP_GOOGLE_ORGANIC_TASKS_READY',
    'DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE',
    'DATAFORSEO_BACKLINKS_SUMMARY_LIVE',
  ]) {
    assert.equal(
      isMutatingExternalWrite('composio_execute_tool', { tool_slug: toolSlug }),
      false,
      toolSlug,
    );
  }
  for (const toolName of [
    'cx_dataforseo_serp_google_organic_live_advanced',
    'mcp__dataforseo__DATAFORSEO_LABS_GOOGLE_KEYWORDS_FOR_SITE',
    'mcp__dataforseo__DATAFORSEO_BACKLINKS_SUMMARY_LIVE',
  ]) {
    assert.equal(isMutatingExternalWrite(toolName, {}), false, toolName);
  }
});

test('isMutatingExternalWrite: FIRECRAWL_SCRAPE is exempt (external read, not mutation)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'FIRECRAWL_SCRAPE' }),
    false,
  );
});

test('isMutatingExternalWrite: FIRECRAWL_BATCH_SCRAPE is exempt (provider-side read job)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'FIRECRAWL_BATCH_SCRAPE' }),
    false,
  );
});

test('isMutatingExternalWrite: explicit mutations cannot borrow a provider read-job exemption', () => {
  for (const toolSlug of [
    'DATAFORSEO_DELETE_ACCOUNT',
    'DATAFORSEO_PUBLISH_REPORT',
    'DATAFORSEO_SET_CREDENTIALS',
    'DATAFORSEO_ENABLE_WEBHOOK',
    'DATAFORSEO_ARCHIVE_REPORT',
    'DATAFORSEO_SERP_SET_WEBHOOK',
    'DATAFORSEO_ACCOUNT_SNAPSHOT',
    'DATAFORSEO_ACCOUNT_SERP_SNAPSHOT',
    'FIRECRAWL_SCRAPE_AND_PUBLISH',
    'FIRECRAWL_CRAWL_AND_DELETE',
  ]) {
    assert.equal(
      isMutatingExternalWrite('composio_execute_tool', { tool_slug: toolSlug }),
      true,
      toolSlug,
    );
  }
  for (const toolName of [
    'mcp__dataforseo__delete_account',
    'mcp__dataforseo__publish_report',
    'mcp__dataforseo__set_credentials',
    'mcp__dataforseo__enable_webhook',
    'mcp__dataforseo__archive_report',
    'mcp__firecrawl__scrape_and_publish',
    'mcp__firecrawl__crawl_and_delete',
  ]) {
    assert.equal(isMutatingExternalWrite(toolName, {}), true, toolName);
  }
});

// ─── isMutatingExternalWrite — exempt tool names ──────────────

test('isMutatingExternalWrite: execution_create is exempt (this is HOW Clem satisfies the gate)', () => {
  assert.equal(
    isMutatingExternalWrite('execution_create', { objective: 'x' }),
    false,
  );
});

test('isMutatingExternalWrite: notify_user is exempt', () => {
  assert.equal(
    isMutatingExternalWrite('notify_user', { title: 'x', body: 'y' }),
    false,
  );
});

test('isMutatingExternalWrite: tool_choice_recall is exempt (pure cache)', () => {
  assert.equal(
    isMutatingExternalWrite('tool_choice_recall', { intent: 'x' }),
    false,
  );
});

test('isMutatingExternalWrite: ask_user_question is exempt', () => {
  assert.equal(
    isMutatingExternalWrite('ask_user_question', { question: 'x' }),
    false,
  );
});

// ─── isMutatingExternalWrite — defensive / edge cases ────────────

test('isMutatingExternalWrite: missing tool_slug → true (unknown external dispatch fails closed)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', {}),
    true,
  );
});

test('isMutatingExternalWrite: null args → true (unknown external dispatch fails closed)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', null),
    true,
  );
});

test('isMutatingExternalWrite: string args (legacy serialized form) parse and check', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', JSON.stringify({ tool_slug: 'GOOGLESHEETS_VALUES_UPDATE' })),
    true,
  );
});

test('isMutatingExternalWrite: corrupt JSON string args → true (unknown external dispatch fails closed)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', '{not valid json'),
    true,
  );
});

test('isMutatingExternalWrite: non-composio tool (run_shell_command) NOT gated by this rule', () => {
  // Future enhancement: classify shell commands. For now, only
  // composio_execute_tool is gated. Documented in execution-gate.ts.
  assert.equal(
    isMutatingExternalWrite('run_shell_command', { command: 'echo hi' }),
    false,
  );
});

test('isMutatingExternalWrite: random unknown tool → false', () => {
  assert.equal(
    isMutatingExternalWrite('some_random_internal_tool', { x: 1 }),
    false,
  );
});

// ─── isGateEnabled — env flag parsing ─────────────────────────────

test('isGateEnabled: default ON when env unset', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  delete process.env.CLEMMY_EXECUTION_GATE;
  try {
    assert.equal(isGateEnabled(), true);
  } finally {
    if (prev !== undefined) process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

test('isGateEnabled: explicit off disables', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  try {
    assert.equal(isGateEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

test('isGateEnabled: explicit on enables', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'on';
  try {
    assert.equal(isGateEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

test('isGateEnabled: unrecognized value treated as OFF (permissive — don\'t block on typo)', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'enabled';
  try {
    assert.equal(isGateEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

// ─── MissingExecutionWrapError — message shape ───────────────────

test('MissingExecutionWrapError: message tells Clem how to recover', () => {
  const err = new MissingExecutionWrapError({
    toolName: 'composio_execute_tool',
    toolSlug: 'GOOGLESHEETS_VALUES_UPDATE',
    sessionId: 'sess-test',
  });
  assert.match(err.message, /EXECUTION_WRAP_REQUIRED/);
  assert.match(err.message, /GOOGLESHEETS_VALUES_UPDATE/);
  assert.match(err.message, /execution_create/);
  assert.match(err.message, /re-issue this tool call/);
  assert.equal(err.sessionId, 'sess-test');
});

test('MissingExecutionWrapError: message handles missing slug gracefully', () => {
  const err = new MissingExecutionWrapError({
    toolName: 'composio_execute_tool',
    toolSlug: undefined,
    sessionId: 'sess-test',
  });
  assert.match(err.message, /composio_execute_tool/);
  // No double parens / weird formatting when slug is absent
  assert.ok(!err.message.includes('()'));
});

// ─── Cross-provider write-path coverage sweep (2026-07-21) ────────────────
// The measurable form of "any possible write goes through validation": a broad
// corpus of real send slugs across every common provider MUST gate, and the
// adjacent reversible writes/reads/drafts MUST NOT over-gate. Found + fixed a
// real hole in this sweep: ZOOM_CREATE_MEETING (MEETING was not a comm-object).
test('coverage sweep: irreversible sends across all common providers gate', () => {
  const mustGate = [
    // Email
    'GMAIL_SEND_EMAIL', 'OUTLOOK_SEND_EMAIL', 'OUTLOOK_SEND_DRAFT', 'SENDGRID_SEND_MAIL', 'HUBSPOT_SEND_EMAIL',
    'GMAIL_REPLY_TO_THREAD', 'OUTLOOK_FORWARD_MAIL',
    // Chat / messaging
    'SLACK_CHAT_POST_MESSAGE', 'MICROSOFT_TEAMS_SEND_CHANNEL_MESSAGE', 'DISCORD_SEND_MESSAGE',
    'WHATSAPP_SEND_MESSAGE', 'TELEGRAM_SEND_MESSAGE', 'TWILIO_CREATE_MESSAGE',
    // Social
    'LINKEDIN_CREATE_POST', 'TWITTER_CREATE_TWEET', 'X_POST_TWEET', 'FACEBOOK_CREATE_POST',
    'INSTAGRAM_CREATE_POST', 'REDDIT_SUBMIT_POST',
    // Voice
    'VAPI_CREATE_CALL', 'TWILIO_MAKE_OUTBOUND_CALL',
    // Calendar / meetings (the hole this sweep fixed)
    'GOOGLECALENDAR_CREATE_EVENT', 'OUTLOOK_CREATE_EVENT', 'GOOGLECALENDAR_RESPOND_TO_EVENT',
    'ZOOM_CREATE_MEETING', 'MICROSOFT_TEAMS_CREATE_MEETING',
  ];
  for (const slug of mustGate) {
    assert.equal(isIrreversibleSendSlug(slug), true, `${slug} MUST be gated as an irreversible send`);
  }
});

test('coverage sweep: reversible writes / drafts / reads never over-gate', () => {
  const mustNotGate = [
    // Drafts (composed, not dispatched)
    'GMAIL_CREATE_DRAFT', 'OUTLOOK_CREATE_REPLY_DRAFT', 'OUTLOOK_CREATE_REPLY_ALL_DRAFT',
    // Reversible record/doc writes
    'SALESFORCE_CREATE_RECORD', 'HUBSPOT_CREATE_CONTACT', 'NOTION_CREATE_PAGE', 'AIRTABLE_CREATE_RECORD',
    'GOOGLESHEETS_BATCH_UPDATE', 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', 'GOOGLEDRIVE_CREATE_FILE',
    // Metadata ops (labels/reactions — reversible, must not read as sends)
    'GMAIL_ADD_LABEL_TO_EMAIL', 'SLACK_ADD_REACTION_TO_A_MESSAGE',
    // Reads
    'GMAIL_LIST_MESSAGES', 'SLACK_LIST_CHANNELS', 'ZOOM_LIST_MEETINGS', 'LINKEDIN_GET_PROFILE',
    'VAPI_GET_CALL', 'OPENAI_CREATE_CHAT_COMPLETION',
    // Meeting reads/edits (adjacent to the gated CREATE_MEETING)
    'ZOOM_GET_MEETING', 'ZOOM_UPDATE_MEETING', 'ZOOM_DELETE_MEETING',
  ];
  for (const slug of mustNotGate) {
    assert.equal(isIrreversibleSendSlug(slug), false, `${slug} must NOT over-gate (reversible/read/draft)`);
  }
});
