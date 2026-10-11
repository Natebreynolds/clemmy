import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDictationSession, type DictationPhase, type SpeechRecognitionLike } from './browser-dictation';
import { appendDictationText, microphoneProblem, microphoneUnavailableReason } from './dictation-support';

class Recognition implements SpeechRecognitionLike {
  lang = ''; interimResults = false; continuous = false;
  onstart: SpeechRecognitionLike['onstart'] = null;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  started = 0; stopped = 0; aborted = 0;
  start() { this.started++; }
  stop() { this.stopped++; }
  abort() { this.aborted++; }
}

test('browser fallback keeps all recognition segments and appends to the latest typed draft once', () => {
  const recognition = new Recognition();
  const states: DictationPhase[] = [];
  let draft = 'First draft';
  let writes = 0;
  const session = new BrowserDictationSession(recognition, {
    state: state => states.push(state), words: words => { draft = appendDictationText(draft, words); writes++; },
    error: error => assert.fail(error), end: () => {},
  });
  session.start('en-US');
  recognition.onstart?.();
  recognition.onresult?.({ results: [[{ transcript: 'First spoken' }]], resultIndex: 0 });
  draft = 'New typing while speaking';
  recognition.onresult?.({ results: [[{ transcript: 'First spoken' }], [{ transcript: 'second segment' }]], resultIndex: 1 });
  session.stop();
  recognition.onend?.();
  assert.equal(draft, 'New typing while speaking First spoken second segment');
  assert.equal(writes, 1);
  assert.deepEqual(states, ['starting', 'recording', 'transcribing', 'idle']);
  assert.equal(recognition.started, 1);
  assert.equal(recognition.stopped, 1);
});

test('browser failure is actionable and late callbacks after cancellation cannot write', () => {
  const recognition = new Recognition();
  const errors: string[] = [];
  let writes = 0;
  const session = new BrowserDictationSession(recognition, { state: () => {}, words: () => { writes++; }, error: error => errors.push(error), end: () => {} });
  session.start('en-US');
  const lateResult = recognition.onresult;
  const lateEnd = recognition.onend;
  recognition.onerror?.({ error: 'not-allowed' });
  assert.match(errors[0], /settings/);
  assert.equal(recognition.aborted, 1);
  lateResult?.({ results: [[{ transcript: 'Late words' }]], resultIndex: 0 });
  lateEnd?.();
  assert.equal(writes, 0);
  assert.equal(errors.length, 1);
});

test('empty speech, synchronous start failure, and explicit cancel each finish honestly', () => {
  for (const kind of ['empty', 'throws', 'cancel']) {
    const recognition = new Recognition();
    const errors: string[] = [];
    const states: DictationPhase[] = [];
    if (kind === 'throws') recognition.start = () => { throw new Error('Speech service unavailable'); };
    const session = new BrowserDictationSession(recognition, { state: state => states.push(state), words: () => assert.fail('No words expected'), error: error => errors.push(error), end: () => {} });
    session.start('en-US');
    if (kind === 'empty') recognition.onend?.();
    if (kind === 'cancel') session.cancel();
    assert.equal(errors.length, kind === 'cancel' ? 0 : 1);
    if (kind === 'empty') assert.match(errors[0], /No speech/);
    if (kind === 'throws') assert.match(errors[0], /service unavailable/);
    if (kind !== 'cancel') assert.equal(states.at(-1), 'idle');
    assert.equal(recognition.onresult, null);
  }
});

test('secure-context, permission, and device errors give recovery steps without changing providers', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'isSecureContext', original); else Reflect.deleteProperty(globalThis, 'isSecureContext'); });
  assert.match(microphoneUnavailableReason(), /HTTPS/);
  assert.match(microphoneProblem({ name: 'NotAllowedError' }), /HTTPS/);
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
  assert.match(microphoneProblem({ name: 'NotAllowedError' }), /settings/);
  assert.match(microphoneProblem({ name: 'NotReadableError' }), /other app/);
  assert.match(microphoneProblem({ error: 'network' }), /speech service/);
  assert.equal(appendDictationText('Keep this text', '   '), 'Keep this text');
});
