import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitLocalReadPreviewBudget, formatRecallableToolText } from './tool-output-format.js';

test('outer local read rendering preserves the explicitly requested larger preview', () => {
  const raw = 'OPENING\n' + 'sample text\n'.repeat(2400) + 'CLOSING';
  const inner = formatRecallableToolText(raw, { maxChars: 40000 });
  const outer = formatRecallableToolText(inner, { maxChars: explicitLocalReadPreviewBudget('read_file', { max_chars: 40000 }) });
  assert.equal(outer, raw);
  assert.notEqual(formatRecallableToolText(inner), raw, 'old default demonstrably clipped the reader output');
});

test('only valid larger local-read previews override the generic default', () => {
  assert.equal(explicitLocalReadPreviewBudget('convert_to_markdown', { max_chars: 40000 }), 40000);
  for (const value of [undefined, null, 0, -1, 1000, 20000, '40000', Infinity, 40000.5]) {
    assert.equal(explicitLocalReadPreviewBudget('read_file', { max_chars: value }), undefined);
  }
  for (const tool of ['work_call', 'call_tool', 'external_api', 'recall_tool_result']) {
    assert.equal(explicitLocalReadPreviewBudget(tool, { max_chars: 40000 }), undefined);
  }
});
