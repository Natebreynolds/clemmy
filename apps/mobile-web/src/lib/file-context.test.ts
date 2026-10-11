import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MobileDraftStore, currentDraftStep, fileContextKey, fileContextProblem, fileSendWasNotAdmitted, prepareSelectedFile, selectedFileContext, settledFileRequest, submitFileDraft, type MobileDraft, type SelectedFileContext } from './file-context';
import { sessionFilePath, type SessionFile } from './session-files';
import type { ApiError } from './api';

const context: SelectedFileContext = { ref: { sessionId: 'worker/a', fileId: 'sf_exact', name: 'Budget.csv', folder: 'Results' }, revision: `sha256:${'a'.repeat(64)}` };
const attachment = { id: 'inbox-snapshot', name: 'Budget.csv', kind: 'file' as const };
const draft = (): MobileDraft => ({ text: 'What changed?', context });

test('file selection and window-local drafts remain isolated by conversation without clobbering typed text', () => {
  const store = new MobileDraftStore();
  store.read('chat:a', 'Already typing');
  store.select('chat:a', context);
  assert.equal(store.read('chat:a', 'Incoming suggestion').text, 'Already typing');
  assert.equal(store.read('chat:b').context, null);
  store.patch('chat:a', { context: null });
  assert.equal(store.read('chat:a').text, 'Already typing');
  store.select('new:1', context);
  store.move('new:1', 'chat:created');
  assert.deepEqual(store.read('chat:created').context, context);
  assert.equal(store.read('new:2').context, null);
  store.clear();
  assert.equal(store.read('chat:created').context, null);
});

test('selection and binary preview require the exact observed revision', () => {
  const file = { fileId: context.ref.fileId, name: context.ref.name, folder: context.ref.folder, revision: context.revision } as SessionFile;
  assert.deepEqual(selectedFileContext(context.ref.sessionId, file), context);
  assert.equal(selectedFileContext(context.ref.sessionId, { ...file, revision: undefined }), null);
  assert.equal(selectedFileContext(context.ref.sessionId, { ...file, revision: 'latest' }), null);
  const url = new URL(sessionFilePath(context.ref.sessionId, file, true), 'https://fixture.test');
  assert.equal(url.searchParams.get('expectedRevision'), context.revision);
  assert.notEqual(fileContextKey(context), fileContextKey({ ...context, revision: `sha256:${'b'.repeat(64)}` }));
});

test('preparation submits only the recorded source identity and expected revision, returning a normal attachment', async t => {
  t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    assert.equal(path, '/m/api/chat/sessions/worker%2Fa/file/context');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { fileId: context.ref.fileId, expectedRevision: context.revision });
    return new Response(JSON.stringify({ ok: true, id: attachment.id, name: attachment.name }), { headers: { 'content-type': 'application/json' } });
  });
  assert.deepEqual(await prepareSelectedFile(context), attachment);
});

test('preparation failure retains the draft and visible context and sends nothing', async () => {
  let saved = draft(); let sends = 0;
  await assert.rejects(submitFileDraft({ draft: saved, text: saved.text, attachments: [], busy: () => false, current: () => true,
    prepare: async () => { throw new Error('FILE_CHANGED'); }, remember: patch => { saved = { ...saved, ...patch }; },
    send: async () => { sends++; return { accepted: true }; }, retry: async () => ({ accepted: true }),
  }), /FILE_CHANGED/);
  assert.equal(saved.text, 'What changed?'); assert.deepEqual(saved.context, context); assert.equal(sends, 0);
});

test('an unconfirmed send retries its exact request with its prepared snapshot rather than re-reading a changed file', async () => {
  let saved = draft(); let prepares = 0; let sends = 0; const retried: string[] = [];
  const makeInput = () => ({ draft: saved, text: saved.text, attachments: [], busy: () => false, current: () => true,
    prepare: async () => { prepares++; return attachment; }, remember: (patch: Partial<MobileDraft>) => { saved = { ...saved, ...patch }; },
    send: async (_text: string, files: unknown[]) => { sends++; assert.deepEqual(files, [attachment]); return { accepted: false, failedMessageId: 'failed-exact' }; },
    retry: async (id: string) => { retried.push(id); return { accepted: true }; },
  });
  await assert.rejects(submitFileDraft(makeInput()), /not confirmed/);
  assert.equal(saved.text, 'What changed?'); assert.deepEqual(saved.context, context);
  assert.equal(await submitFileDraft(makeInput()), true);
  assert.equal(prepares, 1); assert.equal(sends, 1); assert.deepEqual(retried, ['failed-exact']); assert.equal(saved.context, null);
});

test('changed requests cannot bypass an uncertain send; explicit discard is required', async () => {
  const saved = { ...draft(), prepared: { key: fileContextKey(context), attachment }, failed: { messageId: 'failed', text: 'Original', attachmentIds: [attachment.id] } };
  let calls = 0;
  await assert.rejects(submitFileDraft({ draft: saved, text: 'Edited request', attachments: [], busy: () => false, current: () => true,
    prepare: async () => attachment, remember: () => {}, send: async () => { calls++; return { accepted: true }; }, retry: async () => { calls++; return { accepted: true }; },
  }), /Retry it or discard/);
  assert.equal(calls, 0);
});

test('a fresh admission revalidates the original revision after preparation lost a busy race', async () => {
  let saved = draft(); let busy = false; let prepares = 0; let sends = 0;
  const attempt = () => submitFileDraft({ draft: saved, text: saved.text, attachments: [], busy: () => busy, current: () => true,
    prepare: async () => { prepares++; if (prepares === 1) { busy = true; return attachment; } throw new Error('FILE_CHANGED'); },
    remember: patch => { saved = { ...saved, ...patch }; }, send: async () => { sends++; return { accepted: true }; }, retry: async () => ({ accepted: true }),
  });
  await assert.rejects(attempt(), /started working/);
  assert.equal(saved.prepared?.attachment.id, attachment.id);
  assert.equal(saved.failed, undefined);
  busy = false;
  await assert.rejects(attempt(), /FILE_CHANGED/);
  assert.equal(prepares, 2); assert.equal(sends, 0);
  assert.deepEqual(saved.context, context); assert.equal(saved.text, 'What changed?');
});

test('navigation or a new selected context during agent/project preparation blocks result application and send', async () => {
  let current = true; let finish!: (value: string) => void; let sends = 0; let applied = '';
  const work = (async () => {
    const result = await currentDraftStep(() => current, () => new Promise<string>(resolve => { finish = resolve; }));
    applied = result; sends++;
  })();
  current = false;
  finish('late project');
  await assert.rejects(work, /conversation or selected file changed/);
  assert.equal(applied, ''); assert.equal(sends, 0);
});

test('a proven busy refusal removes its local echo and revalidates the selected revision before the next admission', async () => {
  assert.equal(fileSendWasNotAdmitted({ status: 409, body: { error: 'ATTACHMENTS_REQUIRE_IDLE_CHAT' } }), true);
  assert.equal(fileSendWasNotAdmitted({ status: 409, body: { error: 'OTHER_CONFLICT' } }), false);
  assert.equal(fileSendWasNotAdmitted({ status: 503, body: { error: 'ATTACHMENTS_REQUIRE_IDLE_CHAT' } }), false);
  let saved = draft(); let prepares = 0; let sends = 0; let retries = 0; const discarded: string[] = [];
  const attempt = () => submitFileDraft({ draft: saved, text: saved.text, attachments: [], busy: () => false, current: () => true,
    prepare: async () => { prepares++; if (prepares > 1) throw new Error('FILE_CHANGED'); return attachment; },
    remember: patch => { saved = { ...saved, ...patch }; },
    send: async () => { sends++; return { accepted: false, failedMessageId: 'refused-busy', notAdmitted: true }; },
    retry: async () => { retries++; return { accepted: true }; }, discard: id => { discarded.push(id); },
  });
  await assert.rejects(attempt(), /before this message was accepted/);
  assert.equal(saved.failed, undefined);
  assert.deepEqual(discarded, ['refused-busy']);
  assert.equal(saved.prepared?.attachment.id, attachment.id);
  await assert.rejects(attempt(), /FILE_CHANGED/);
  assert.equal(prepares, 2); assert.equal(sends, 1); assert.equal(retries, 0);
  assert.deepEqual(saved.context, context); assert.equal(saved.text, 'What changed?');
});

test('settling an older file request preserves a newer context and its draft, even when the words match', () => {
  const request = { messageId: 'failed-a', text: 'What changed?', attachmentIds: [attachment.id], context, contextAttachment: attachment };
  const other = { ref: { ...context.ref, fileId: 'sf_other', name: 'New plan.md' }, revision: context.revision };
  const newer = { text: request.text, context: other, failed: request, prepared: { key: fileContextKey(other), attachment: { ...attachment, id: 'new-attachment' } } };
  const settled = { ...newer, ...settledFileRequest(newer, request) };
  assert.deepEqual(settled.context, other);
  assert.equal(settled.prepared?.attachment.id, 'new-attachment');
  assert.equal(settled.text, request.text);
  assert.equal(settled.failed, undefined);
  const original = { text: request.text, context, failed: request, prepared: { key: fileContextKey(context), attachment } };
  assert.deepEqual(settledFileRequest(original, request), { failed: undefined, context: null, prepared: undefined, text: '' });
  assert.deepEqual(settledFileRequest({ ...newer, failed: { ...request, messageId: 'another-request' } }, request), {});
});

test('busy steering, a newly busy turn, and navigation during preparation never lose the file by sending only text', async () => {
  for (const scenario of ['already-busy', 'newly-busy', 'navigated']) {
    let busy = scenario === 'already-busy'; let current = true; let sends = 0; let prepared = 0;
    const promise = submitFileDraft({ draft: draft(), text: 'Review this', attachments: [], busy: () => busy, current: () => current,
      prepare: async () => { prepared++; if (scenario === 'newly-busy') busy = true; if (scenario === 'navigated') current = false; return attachment; },
      remember: () => {}, send: async () => { sends++; return { accepted: true }; }, retry: async () => ({ accepted: true }),
    });
    if (scenario === 'navigated') assert.equal(await promise, false); else await assert.rejects(promise, /finishes|prepared/);
    assert.equal(sends, 0); if (scenario === 'already-busy') assert.equal(prepared, 0);
  }
});

test('changed-version error explains recovery without silently replacing selected context', () => {
  const failure = Object.assign(new Error('HTTP 409'), { status: 409, body: { error: 'FILE_CHANGED' } }) as ApiError;
  assert.match(fileContextProblem(failure), /changed after you opened it/);
  assert.match(fileContextProblem(failure), /Remove this context and reopen/);
});
