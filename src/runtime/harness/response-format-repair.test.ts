import test from 'node:test';
import assert from 'node:assert/strict';
import { responseFormatRepairPacket } from './response-format-repair.js';
test('format repair retains the complete objective and draft and excludes work/Plan/failed reviews', () => {
  const input = { done: false, repairScope: 'reply_format' as const, plan: false,
    objective: 'Return only the count.', reply: 'In one batch: 4', reason: 'Remove preamble.' };
  const packet = responseFormatRepairPacket(input)!;
  assert.deepEqual(JSON.parse(packet.text), { objective: input.objective, draft: input.reply, correction: input.reason });
  for (const extra of [{done:true},{failedOpen:true},{awaitingUser:true},{blocked:true},{plan:true},{repairScope:undefined}]) {
    assert.equal(responseFormatRepairPacket({...input,...extra}), null);
  }
  assert.equal(responseFormatRepairPacket({...input,reply:'x'.repeat(24_001)}), null);
});
