/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/approval-call-preview.test.ts
 *
 * Live 2026-09-25: two Slack approvals read "Slack open dm" and "Send Slack
 * message". The message text sat in the frozen arguments and never reached the
 * card, and the owner approved without knowing what.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-preview-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { approvalCallPreview, approvalArgsWithFieldEdits } = await import('./approval-call-preview.js');
const { projectHarnessEventForPublic } = await import('./public-presentation.js');

test.after(() => rmSync(HOME, { recursive: true, force: true }));

const message = 'You\'re on the 4:15–4:45 PM review today. Would you be willing to run that one on your own?';
function workCall(slug: string, args: Record<string, unknown>) {
  return {
    toolName: 'work_call',
    rawArgs: '{}',
    args: {
      requirement_id: `cap:resolved:${slug.toLowerCase()}`,
      name: 'composio_execute_tool',
      args_json: JSON.stringify({ tool_slug: slug, arguments: JSON.stringify(args) }),
    },
  };
}

test('an approval shows the operation and every argument it would send, message text whole', () => {
  const send = approvalCallPreview(workCall('SLACK_SEND_MESSAGE', { channel: 'D0FIXTURE1', markdown_text: message }));
  assert.ok(send);
  assert.match(send!.operation, /slack/i);
  assert.deepEqual(send!.fields, [
    { name: 'channel', value: 'D0FIXTURE1' },
    { name: 'markdown_text', value: message },
  ]);
  const open = approvalCallPreview(workCall('SLACK_OPEN_DM', { users: 'U0FIXTURE1' }));
  assert.deepEqual(open?.fields, [{ name: 'users', value: 'U0FIXTURE1' }]);
});

test('a secret-looking value is withheld, long text is bounded, empty values are skipped', () => {
  const preview = approvalCallPreview(workCall('SLACK_SEND_MESSAGE', {
    channel: 'C1', markdown_text: 'token xoxb-1234567890-abcdefghij', blocks: [], thread_ts: '',
    note: 'x'.repeat(2_500),
  }));
  assert.deepEqual(preview?.fields.map((field) => field.name), ['channel', 'markdown_text', 'note']);
  assert.equal(preview?.fields[1]?.value, '[withheld: looks like a secret]');
  assert.match(preview?.fields[2]?.value ?? '', /… \(500 more characters\)$/);
});

test('a local tool shows its own arguments; a malformed carrier shows nothing', () => {
  const local = approvalCallPreview({ toolName: 'send_note', rawArgs: '{}', args: { to: 'team@example.com', body: 'Thanks all' } });
  assert.deepEqual(local, { operation: 'send_note', fields: [{ name: 'to', value: 'team@example.com' }, { name: 'body', value: 'Thanks all' }] });
  assert.equal(approvalCallPreview({ toolName: 'work_call', rawArgs: '{}', args: { name: 'composio_execute_tool' } }), null);
});

test('the public approval event carries a well-formed preview and drops a malformed one', () => {
  const preview = { operation: 'Send Slack message', fields: [{ name: 'markdown_text', value: message }] };
  const event = (data: Record<string, unknown>) => ({ id: 'e', seq: 1, sessionId: 's', turn: 1, role: 'Clem',
    type: 'approval_requested', createdAt: new Date().toISOString(),
    data: { approvalId: 'apr-1', subject: 'Send Slack message', tool: 'work_call', ...data } });
  const shown = projectHarnessEventForPublic(event({ preview }) as never);
  assert.deepEqual((shown?.data as Record<string, unknown> | undefined)?.preview, preview);
  const malformed = projectHarnessEventForPublic(event({ preview: { operation: 'x', fields: [{ name: 1, value: 'y' }] } }) as never);
  assert.equal((malformed?.data as Record<string, unknown> | undefined)?.preview, undefined);
  const named = { operation: 'Open Slack dm', fields: [{ name: 'users', value: 'U0FIXTURE1', label: 'Sam Rivera' }] };
  assert.deepEqual((projectHarnessEventForPublic(event({ preview: named }) as never)?.data as Record<string, unknown>)?.preview, named);
  // The card names a file by up to 300 characters (approvalCallPreview); one
  // past that is malformed.
  const badName = { operation: 'Open Slack dm', fields: [{ name: 'users', value: 'U0FIXTURE1', label: 'x'.repeat(301) }] };
  assert.equal((projectHarnessEventForPublic(event({ preview: badName }) as never)?.data as Record<string, unknown>)?.preview, undefined);
  const checked = { ...preview, check: { status: 'conflicts', conflicts: ['It names the research tool; you asked never to.'] } };
  assert.deepEqual((projectHarnessEventForPublic(event({ preview: checked }) as never)?.data as Record<string, unknown>)?.preview, checked);
  const badCheck = { ...preview, check: { status: 'maybe' } };
  assert.equal((projectHarnessEventForPublic(event({ preview: badCheck }) as never)?.data as Record<string, unknown>)?.preview, undefined);
});

test('a name the host found rides beside its id, never beside a withheld secret; call_tool unwraps like work_call', () => {
  const labelled = approvalCallPreview({
    ...workCall('SLACK_OPEN_DM', { users: 'U0FIXTURE1', note: 'token xoxb-1234567890-abcdefghij' }),
    previewLabels: { U0FIXTURE1: 'Sam Rivera', 'token xoxb-1234567890-abcdefghij': 'not a name' },
  });
  assert.deepEqual(labelled?.fields, [
    { name: 'users', value: 'U0FIXTURE1', label: 'Sam Rivera' },
    { name: 'note', value: '[withheld: looks like a secret]' },
  ]);
  const mcp = approvalCallPreview({
    toolName: 'call_tool',
    rawArgs: '{}',
    args: { name: 'fixture__send_message', args_json: JSON.stringify({ recipient: 'U0FIXTURE1', message: 'Hi' }) },
  });
  assert.equal(mcp?.operation, 'fixture__send_message');
  assert.deepEqual(mcp?.fields.map((field) => field.name), ['recipient', 'message']);
});

test('the pre-send check rides on the preview beside the fields', () => {
  const previewed = approvalCallPreview({
    ...workCall('SLACK_SEND_MESSAGE', { channel: 'D0FIXTURE1', markdown_text: message }),
    previewCheck: { status: 'clear' },
  });
  assert.deepEqual(previewed?.check, { status: 'clear' });
});


test('complete grouped preview retains long nested arguments and later fields', () => {
  const payload = { body: 'long content '.repeat(220), attendees: Array.from({ length: 25 }, (_, i) => ({ email: `person${i}@example.test` })),
    ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, `value${i}`])) };
  const preview = approvalCallPreview(workCall('OUTLOOK_CALENDAR_CREATE_EVENT', payload), true, true)!;
  assert.equal(preview.fields.find(field => field.name === 'body')?.value, payload.body.trim());
  assert.equal(preview.fields.find(field => field.name === 'attendees')?.value, JSON.stringify(payload.attendees));
  assert.equal(preview.fields.at(-1)?.name, 'field19');
});

test('edit by hand applies the retyped field onto the exact stored call, along the preview\'s own unwrapping', () => {
  // Owner-approved design, 2026-10-07: the card shows the call's fields; the
  // owner retypes one; what runs is exactly what the card showed, edited.
  const stored = {
    requirement_id: 'cap:resolved:slack_send_message', name: 'composio_execute_tool',
    args_json: JSON.stringify({ tool_slug: 'SLACK_SEND_MESSAGE', arguments: JSON.stringify({ channel: 'D0FIXTURE1', markdown_text: 'Could you run the 4:15 review on your own today?' }) }),
  };
  const edited = approvalArgsWithFieldEdits(stored, { markdown_text: 'Could you run the 4:15 review today? Thanks!' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  if (!edited.ok) return;
  assert.equal(edited.args.requirement_id, stored.requirement_id, 'everything but the field stays exact');
  const inner = JSON.parse(edited.args.args_json as string) as { tool_slug: string; arguments: string };
  assert.equal(inner.tool_slug, 'SLACK_SEND_MESSAGE');
  assert.deepEqual(JSON.parse(inner.arguments), { channel: 'D0FIXTURE1', markdown_text: 'Could you run the 4:15 review today? Thanks!' });
  // A plain (non-carrier) call edits in place.
  const plain = approvalArgsWithFieldEdits({ to: 'a@example.test', body: 'hi' }, { body: 'hello' });
  assert.deepEqual(plain.ok && plain.args, { to: 'a@example.test', body: 'hello' });
  // Only fields the card showed; never a new or structured one.
  assert.equal(approvalArgsWithFieldEdits(stored, { recipient: 'x' }).ok, false, 'an unknown field is refused');
  assert.equal(approvalArgsWithFieldEdits({ items: [1] }, { items: 'x' }).ok, false, 'a structured value is not editable here');
  assert.equal(approvalArgsWithFieldEdits(stored, {}).ok, false, 'no edits, nothing to apply');
});

test('a file argument is named on the card by name, size and folder, and one that cannot be sent says why', async () => {
  // Owner 2026-10-09: "the PDF we just produced" with two PDFs around; the
  // card names the exact file that will leave before the owner says yes.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { approvalCallPreview } = await import('./approval-call-preview.js');
  // Clem's own folder is one the owner's files may be sent from (outside her stores).
  const dir = mkdtempSync(path.join(process.env.CLEMENTINE_HOME!, 'card-file-'));
  try {
    mkdirSync(path.join(dir, 'Reports'), { recursive: true });
    const report = path.join(dir, 'Reports', 'staging report.pdf');
    writeFileSync(report, 'x'.repeat(2048));
    const preview = approvalCallPreview({
      toolName: 'composio_execute_tool',
      args: { tool_slug: 'ACME_CREATE_DRAFT', arguments: JSON.stringify({ subject: 'Hi', attachment: [report], other: path.join(dir, 'missing.pdf') }) },
    } as never);
    const attachment = preview!.fields.find((field) => field.name === 'attachment')!;
    assert.equal(attachment.label, 'staging report.pdf · 2 KB · in Reports');
    const other = preview!.fields.find((field) => field.name === 'other')!;
    assert.match(other.label ?? '', /^cannot be sent: There is no file at /);
    assert.equal(preview!.fields.find((field) => field.name === 'subject')!.label, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The phone test of 2026-10-09: an Outlook draft edited three times. Each card
// listed the provider call's plumbing (user_id, two ~170-character Graph ids,
// an OData type tag, response_detail, the HTML update as JSON) as what the
// owner was approving.
const MESSAGE_ID = `AAMkADExOGRmNmY1LWQ1MmEtNGUwMi05MTk0LTA4MmY5NTg2NTgxYQBGAAAAAAD-yrYzWhDuRp3B0nXllfXnBwCM9mY4rqw1TrpigdngpBZ0AAAAAAEPAACM9mY4rqw1TrpigdngpBZ0AAJN54yLAAA=`;
const ATTACHMENT_ID = `${MESSAGE_ID.slice(0, -4)}ABEgAQAOJsWtE0jXFHv0564sc55yo=`;
const outlookCall = (slug: string, args: Record<string, unknown>) => ({
  toolName: 'work_call',
  args: { name: 'composio_execute_tool', args_json: JSON.stringify({ tool_slug: slug, arguments: JSON.stringify(args) }) },
});

test('opaque ids, flags and type tags are folded as details; what the owner approves stays in view', () => {
  const preview = approvalCallPreview(outlookCall('OUTLOOK_ADD_MAIL_ATTACHMENT', {
    message_id: MESSAGE_ID, user_id: 'me', attachment: '/Users/example/Downloads/team-legal-q4-slide7.png',
    name: 'slide7.png', odata_type: '#microsoft.graph.fileAttachment', contentType: 'image/png', isInline: false,
  }) as never)!;
  const detail = Object.fromEntries(preview.fields.map((field) => [field.name, field.detail === true]));
  assert.deepEqual(detail, {
    message_id: true, user_id: false, attachment: false, name: false,
    odata_type: true, contentType: false, isInline: true,
  });
  assert.equal(preview.fields.find((field) => field.name === 'message_id')!.value, MESSAGE_ID, 'a detail is folded, never dropped');
});

test('an id with a name from the conversation reads as that name, not as a detail', () => {
  const preview = approvalCallPreview({
    ...outlookCall('OUTLOOK_DELETE_ME_MESSAGES_ATTACHMENTS', { user_id: 'me', message_id: MESSAGE_ID, attachment_id: ATTACHMENT_ID }),
    previewLabels: { [ATTACHMENT_ID]: 'team-legal-q4-slide7.png' },
  } as never)!;
  const attachment = preview.fields.find((field) => field.name === 'attachment_id')!;
  assert.equal(attachment.label, 'team-legal-q4-slide7.png');
  assert.equal(attachment.detail, undefined);
  assert.equal(preview.fields.find((field) => field.name === 'message_id')!.detail, true);
});

test('an HTML body inside a JSON update reads as its words, with the image named', () => {
  const preview = approvalCallPreview(outlookCall('OUTLOOK_BATCH_UPDATE_MESSAGES', {
    user_id: 'me', response_detail: 'full',
    updates: [{ message_id: MESSAGE_ID, patch: { body: { contentType: 'html',
      content: '<html><body><p>Here is slide 7 from the kickoff deck.</p><img src="cid:slide7" /><ul><li>New technology and bundles on Oct 19</li></ul></body></html>' } } }],
  }) as never)!;
  const updates = preview.fields.find((field) => field.name === 'updates')!;
  assert.match(updates.display ?? '', /Here is slide 7 from the kickoff deck\./);
  assert.match(updates.display ?? '', /\[image\]/);
  assert.match(updates.display ?? '', /New technology and bundles on Oct 19/);
  assert.doesNotMatch(updates.display ?? '', /<|message_id|AAMk/);
  assert.ok(updates.value.startsWith('['), 'the exact JSON is kept for Details and edits');
});

test('the public card carries the folds and a file name up to the card\'s own label bound', () => {
  const longLabel = `${'quarterly-board-pack-'.repeat(8)}final.pdf · 2.1 MB · in Board`;
  const projected = projectHarnessEventForPublic({
    type: 'approval_requested', data: { approvalId: 'apr-fold', preview: {
      operation: 'Add Outlook mail attachment',
      fields: [
        { name: 'message_id', value: MESSAGE_ID, detail: true },
        { name: 'attachment', value: '/Users/example/Board/x.pdf', label: longLabel },
        { name: 'updates', value: '[{"a":1}]', display: 'Here is the pack.' },
      ],
    } },
  } as never) as { data?: { preview?: { fields?: Array<Record<string, unknown>> } } } | null;
  const fields = projected?.data?.preview?.fields ?? [];
  assert.equal(fields.length, 3, JSON.stringify(projected).slice(0, 400));
  assert.equal(fields[0]!.detail, true);
  assert.equal(fields[1]!.label, longLabel);
  assert.equal(fields[2]!.display, 'Here is the pack.');
});
