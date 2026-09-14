import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-watcher-portions-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1';
mkdirSync(path.join(home, 'state'), { recursive: true });
const { Usage } = await import('@openai/agents');
const { ClaudeModelProvider } = await import('./claude-model.js');
const { CodexModelProvider } = await import('./codex-model.js');
const { runWatcherJudge, WATCHER_JUDGE_SYSTEM_PROMPT } = await import('./watcher-judge.js');
const { captureBoundaryJudgeSelection } = await import('./debate-model.js');
const { completionJudgeContextAdmission } = await import('./objective-judge.js');
const { recordCatalogWindow } = await import('./model-window-observations.js');
const { resolveModelCapability } = await import('./model-wire-registry.js');
const { closeEventLog } = await import('./eventlog.js');
const modelId = 'claude-sonnet-5';
const source = 'FIRST_SOURCE\n\n' + 'retained evidence α 🦊\n'.repeat(30_000) + '\nDECISIVE_TAIL';
const prompts: string[] = [];
let failAt = 0;

function inputText(request: ModelRequest): string {
  if (typeof request.input === 'string') return request.input;
  return request.input.map(item => {
    if (!('content' in item)) return '';
    const content = item.content;
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.map(part => 'text' in part ? part.text : '').join('\n') : '';
  }).join('\n');
}

beforeEach(() => {
  mock.restoreAll(); prompts.length = 0; failAt = 0;
  Object.assign(process.env, { AUTH_MODE: 'codex_oauth', MODEL_ROUTING_MODE: 'off', OPENAI_MODEL_PRIMARY: 'gpt-5.6-terra',
    CLEMMY_JUDGE_CROSS_FAMILY: 'on', CLEMMY_JUDGE_HEDGE: 'on', CLEMMY_COMPLETION_REVIEW: 'on',
    CLEMMY_CLAUDE_TRANSPORT: 'raw_messages', CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off',
    CLEMMY_MODEL_ROLES: JSON.stringify([{ role: 'judge', modelId, scope: 'durable', source: 'settings' }]),
    CLEMMY_DEBATE_JUDGE: '', BYO_PROVIDERS: '', BYO_MODEL_ID: '', BYO_MODEL_API_KEY: '', BYO_MODEL_BASE_URL: '' });
  writeFileSync(path.join(home, 'state', 'auth.json'), JSON.stringify({ codexOauth: { accessToken: 'fixture', refreshToken: 'fixture' } }));
  writeFileSync(path.join(home, 'state', 'claude-auth.json'), JSON.stringify({ accessToken: 'sk-ant-oat01-fixture', expiresAt: Date.now() + 3_600_000 }));
  recordCatalogWindow(modelId, resolveModelCapability(modelId).maxOutput + 32_000, 'fixture provider window');
  mock.method(CodexModelProvider.prototype, 'getModel', () => { throw new Error('the owner-selected judge must not fall back to the brain'); });
  mock.method(ClaudeModelProvider.prototype, 'getModel', (id?: string) => {
    assert.equal(id, modelId);
    return {
      async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const prompt = inputText(request); prompts.push(prompt);
        assert.ok(completionJudgeContextAdmission(modelId, WATCHER_JUDGE_SYSTEM_PROMPT, prompt).fits);
        if (prompts.length === failAt) throw new Error('fixture reviewer unavailable on one portion');
        const text = prompt.includes('DECISIVE_TAIL')
          ? 'DRIFT: the final source contradicts the stated method | STEER: revise the method using the final source.'
          : 'ON-TRACK: preparation remains relevant';
        return { output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, providerData: {} }] }], usage: new Usage(), responseId: `portion-${prompts.length}` };
      },
      async *getStreamedResponse() { throw new Error('review must use the ordinary model request'); },
    } as Model;
  });
});

after(() => { mock.restoreAll(); closeEventLog(); rmSync(home, { recursive: true, force: true }); });
const review = (onUnavailable?: (reason: string) => void) => runWatcherJudge({ objective: 'Prepare the research plan.',
  toolCallSummary: 'Read sources; no business writes.', latestAssistantNote: 'Comparing the sources.', toolCallCount: 12,
  sourceEvidence: source, boundaryJudgeSelection: captureBoundaryJudgeSelection(), onUnavailable });

test('the actual reviewer sees every evidence portion, retains the final negative, and keeps the selected model', async () => {
  const result = await review();
  assert.ok(prompts.length > 1);
  assert.equal(result?.onTrack, false);
  assert.match(result?.miss ?? '', /final source/);
  assert.equal(result?.coverage?.complete, true);
  assert.equal(result?.coverage?.portions, prompts.length);
  assert.equal(result?.coverage?.chars, source.length);
  assert.equal(result?.review?.modelId, modelId);
  const marker = 'This is advisory, never completion certification.\n\n';
  const parts = prompts.map(prompt => prompt.slice(prompt.indexOf(marker) + marker.length,
    prompt.lastIndexOf('\n\nAgent\'s latest public note:')));
  assert.equal(parts.join(''), source, 'actual provider prompts reconstruct the full original evidence');
});

test('one unavailable portion cannot become an on-track verdict or completed coverage', async () => {
  failAt = 2;
  let unavailable = '';
  assert.equal(await review(reason => { unavailable = reason; }), null);
  assert.match(unavailable, /reviewer.*unavailable|fixture reviewer unavailable/i);
  assert.equal(prompts.length, 2);
});
