import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-brain-backups-'));
process.env.CLEMENTINE_HOME = HOME;

import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
const backups = await import('./brain-backups.js');
const { withModelFallback, __test__: fallbackTest, reviveDeadBrains } = await import('./fallback-model.js');

const OUTAGE_FILE = path.join(HOME, 'brain-outage.json');
fallbackTest.setDeadBrainsFileForTests(path.join(HOME, 'brain-auth-dead.json'));
fallbackTest.setSilentBrainsFileForTests(path.join(HOME, 'brain-silent-cooldown.json'));

const OPTIONS = ['chosen-brain', 'backup-one', 'backup-two', 'backup-three', 'backup-four'].map((modelId) => ({
  id: 'api_key' as const, value: `api_key:${modelId}`, label: modelId, available: true, modelId,
}));

function setList(ids: string[]): void {
  process.env[backups.BRAIN_BACKUPS_ENV] = JSON.stringify(ids);
}

beforeEach(() => {
  rmSync(OUTAGE_FILE, { force: true });
  backups.__brainBackupsTest__.reset(OUTAGE_FILE);
  backups.__brainBackupsTest__.setOptions(() => OPTIONS);
  delete process.env[backups.BRAIN_BACKUPS_ENV];
  reviveDeadBrains();
});

after(() => {
  backups.__brainBackupsTest__.reset();
  fallbackTest.setDeadBrainsFileForTests(null);
  fallbackTest.setSilentBrainsFileForTests(null);
  rmSync(HOME, { recursive: true, force: true });
});

const req = (): ModelRequest => ({ input: 'hi', modelSettings: {}, tools: [], handoffs: [] }) as unknown as ModelRequest;
const resp = (text: string): ModelResponse => ({ output: [{ type: 'message', content: text }], usage: {} }) as unknown as ModelResponse;
const serverError = () => Object.assign(new Error('upstream 503'), { statusCode: 503 });

function counting(label: string, fail: boolean): { model: Model; calls: () => number } {
  let calls = 0;
  const model = {
    getResponse: async () => { calls += 1; if (fail) throw serverError(); return resp(label); },
    getStreamedResponse: async function* () { calls += 1; throw serverError(); },
  } as unknown as Model;
  return { model, calls: () => calls };
}

test('only connected models the owner lists are kept, in order, at most three', () => {
  assert.deepEqual(backups.readBrainBackups(), []);
  assert.equal(backups.brainBackupsConfigured(), false);
  assert.throws(() => backups.persistBrainBackups({ modelIds: ['backup-one', 'not-connected'] }), /not a model a connected account serves/);
  assert.throws(() => backups.persistBrainBackups({ modelIds: ['backup-one', 'backup-two', 'backup-three', 'backup-four'] }), /at most 3/);
  assert.throws(() => backups.persistBrainBackups({ modelIds: 'backup-one' }), /list of model ids/);
  const saved = backups.persistBrainBackups({ modelIds: ['backup-two', 'backup-one', 'backup-two'] });
  assert.deepEqual(saved.modelIds, ['backup-two', 'backup-one']);
  assert.deepEqual(backups.brainBackupModelIds('backup-two'), ['backup-one'], 'the serving model is never its own backup');
  backups.persistBrainBackups({ modelIds: [] });
  assert.equal(backups.brainBackupsConfigured(), false, 'an empty list turns backups off');
});

test('two no-answer failures open one outage; a pace wall, a rate limit or an answer in between do not', () => {
  setList(['backup-one', 'backup-two']);
  const changes: string[] = [];
  backups.onBrainOutageChange((change) => changes.push(change.kind));
  backups.noteBrainNoAnswer('chosen-brain', 'pre-actionable-timeout');
  backups.noteBrainNoAnswer('chosen-brain', 'model.rate_limited');
  assert.equal(backups.currentBrainOutage(), null);
  backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
  backups.noteBrainAnswered('chosen-brain');
  backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
  assert.equal(backups.currentBrainOutage(), null, 'an answer starts the count over');
  backups.noteBrainNoAnswer('chosen-brain', 'first-content-timeout');
  const outage = backups.currentBrainOutage();
  assert.equal(outage?.downModelId, 'chosen-brain');
  assert.equal(outage?.standInModelId, 'backup-one');
  assert.equal(outage?.status, 'open');
  assert.deepEqual(changes, ['opened']);
  assert.equal(backups.brainOutageSkips('chosen-brain'), true);
  assert.equal(backups.brainOutageSkips('backup-one'), false);
  assert.ok(existsSync(OUTAGE_FILE), 'the outage survives a restart');
  assert.equal(JSON.parse(readFileSync(OUTAGE_FILE, 'utf-8')).id, outage?.id);
});

test('no backup listed, no outage: the chosen brain keeps being asked', () => {
  backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
  backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
  assert.equal(backups.currentBrainOutage(), null);
});

test('the check marks a down brain recovered, and the owner\'s answer closes the outage', async () => {
  setList(['backup-one']);
  const changes: string[] = [];
  backups.onBrainOutageChange((change) => changes.push(change.kind));
  backups.noteBrainNoAnswer('chosen-brain', 'model.overloaded');
  backups.noteBrainNoAnswer('chosen-brain', 'model.overloaded');
  const asked: string[] = [];
  let up = false;
  backups.setBrainOutageProber(async (modelId) => { asked.push(modelId); if (!up) throw new Error('still 503'); });
  assert.equal(await backups.runBrainOutageProbe(), 'still_down');
  assert.equal(backups.currentBrainOutage()?.probe.attempts, 1);
  assert.match(backups.currentBrainOutage()?.probe.lastReason ?? '', /503/);
  up = true;
  assert.equal(await backups.runBrainOutageProbe(), 'recovered');
  assert.deepEqual(asked, ['chosen-brain', 'chosen-brain'], 'only the down model is asked');
  assert.equal(backups.currentBrainOutage()?.status, 'recovered');
  assert.equal(backups.brainOutageSkips('chosen-brain'), true, 'the backup keeps answering until the owner decides');
  backups.closeBrainOutage('switch_back');
  assert.equal(backups.currentBrainOutage(), null);
  assert.equal(existsSync(OUTAGE_FILE), false);
  assert.deepEqual(changes, ['opened', 'recovered', 'closed']);
});

test('removing the backups ends an outage they were covering', () => {
  setList(['backup-one']);
  backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
  backups.noteBrainNoAnswer('chosen-brain', 'model.http_5xx');
  assert.ok(backups.currentBrainOutage());
  backups.persistBrainBackups({ modelIds: [] });
  assert.equal(backups.currentBrainOutage(), null);
});

test('the chain feeds the outage from the chosen brain only, then starts on the backups', async () => {
  setList(['backup-one']);
  const chosen = counting('chosen-brain', true);
  const backup = counting('backup-one', false);
  const chain = () => withModelFallback([
    { label: 'chosen-brain', getModel: () => chosen.model },
    { label: 'backup-one', getModel: () => backup.model },
  ], { brainLabel: 'chosen-brain' });
  for (let turn = 0; turn < 2; turn += 1) {
    const answer = await chain().getResponse(req());
    assert.equal((answer.output[0] as { content?: string }).content, 'backup-one', 'the backup answers each failed turn');
  }
  assert.equal(chosen.calls(), 2);
  assert.equal(backups.currentBrainOutage()?.downModelId, 'chosen-brain');
  const third = await chain().getResponse(req());
  assert.equal((third.output[0] as { content?: string }).content, 'backup-one');
  assert.equal(chosen.calls(), 2, 'an open outage skips the down brain instead of waiting on it again');
});

test('a chain that is not the brain\'s never opens an outage', async () => {
  setList(['backup-one']);
  const memory = counting('chosen-brain', true);
  for (let turn = 0; turn < 3; turn += 1) {
    await assert.rejects(withModelFallback([{ label: 'chosen-brain', getModel: () => memory.model }]).getResponse(req()));
  }
  assert.equal(backups.currentBrainOutage(), null);
  assert.equal(memory.calls(), 3, 'a job on the same model keeps waiting for it');
});

test('a model is named the way an owner reads it: the picker\'s name, or the model\'s own name when the picker only repeats its id', () => {
  backups.__brainBackupsTest__.setOptions(() => [
    { id: 'api_key' as const, value: 'api_key:grok-4.7', label: 'xAI (Grok) — grok-4.7', available: true, modelId: 'grok-4.7' },
    { id: 'api_key' as const, value: 'api_key:vendor/Pinned-Model-V4.1-Flash', label: 'Hosted — vendor/Pinned-Model-V4.1-Flash', available: true, modelId: 'vendor/Pinned-Model-V4.1-Flash' },
    { id: 'claude_oauth' as const, value: 'claude_oauth:model-x', label: 'Claude account — Fable 5.1', available: true, modelId: 'model-x' },
  ]);
  assert.equal(backups.brainModelLabel('grok-4.7'), 'Grok 4.7');
  assert.equal(backups.brainModelLabel('vendor/Pinned-Model-V4.1-Flash'), 'Pinned Model V4.1 Flash');
  assert.equal(backups.brainModelLabel('model-x'), 'Fable 5.1', 'a picker name that is a name wins');
  assert.equal(backups.brainModelLabel('not-listed-model'), 'Not Listed Model');
});
