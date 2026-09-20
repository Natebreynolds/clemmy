import assert from 'node:assert/strict';
import test from 'node:test';
import { pageArchivedTaskMessage } from './archived-task-message.js';

test('typed historical content pages losslessly without exposing neighboring policy or tool frames', () => {
  const content = [{ type: 'input_text', text: 'original requirement 🍊\n'.repeat(25) }, { type: 'input_image', image: 'retained-reference' }];
  const taskLayer = JSON.stringify({ input: [{ role: 'system', content: 'policy' }, { role: 'user', content }, { type: 'function_call', arguments: 'private call' }] });
  let offset = 0, text = '', digest: string | undefined;
  for (;;) {
    const page = pageArchivedTaskMessage({ taskLayer, itemIndex: 1, offset, maxChars: 17 });
    digest ??= page.sha256;
    assert.equal(page.sha256, digest);
    text += page.contentJsonPage;
    if (page.nextOffsetChars === null) break;
    assert.ok(page.nextOffsetChars > offset);
    offset = page.nextOffsetChars;
  }
  assert.deepEqual(JSON.parse(text), { role: 'user', content });
  for (const itemIndex of [0, 2, 3, -1, 0.5]) assert.throws(() => pageArchivedTaskMessage({ taskLayer, itemIndex }));
});

test('invalid offsets and budgets cannot return a misleading archive page', () => {
  const taskLayer = JSON.stringify({ input: [{ role: 'user', content: 'hello' }] });
  for (const offset of [-1, 999, 0.5, NaN]) assert.throws(() => pageArchivedTaskMessage({ taskLayer, itemIndex: 0, offset }));
  for (const maxChars of [0, 1, 16001, Infinity]) assert.throws(() => pageArchivedTaskMessage({ taskLayer, itemIndex: 0, maxChars }));
});
