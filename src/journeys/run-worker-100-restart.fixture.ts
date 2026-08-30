import assert from 'node:assert/strict';

const encoded = process.env.CLEM_RUN_WORKER_100_RESTART_INPUT;
if (!encoded) throw new Error('missing CLEM_RUN_WORKER_100_RESTART_INPUT');
const request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  objective: string;
  items: string[];
  manifestId: string;
  contractVersion: string;
  phase: string;
};

const { registerWorkerTools } = await import('../tools/worker-tools.js');
const { setClaudeAgentSdkWorkerRunForTest } = await import('../runtime/harness/claude-agent-worker.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { ToolCallsCounter, withHarnessRunContext } = await import('../runtime/harness/brackets.js');
const { summarizeWorkManifest } = await import('../runtime/harness/work-manifest.js');
const { closeEventLog } = await import('../runtime/harness/eventlog.js');

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
let runWorker: ((input: unknown) => Promise<ToolResult>) | undefined;
registerWorkerTools({
  tool(name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<ToolResult>) {
    if (name === 'run_worker') runWorker = handler;
  },
} as never);
assert.ok(runWorker);

function packetFromPrompt(prompt: string): Record<string, unknown> {
  const marker = '\nPacket JSON:\n';
  const offset = prompt.lastIndexOf(marker);
  assert.ok(offset >= 0, 'worker restart fixture received the canonical packet');
  return JSON.parse(prompt.slice(offset + marker.length)) as Record<string, unknown>;
}

let crossings = 0;
const crossedItems: string[] = [];
setClaudeAgentSdkWorkerRunForTest(async (options) => {
  const item = String(packetFromPrompt(String((options as { prompt?: unknown }).prompt ?? '')).item ?? '');
  assert.ok(request.items.includes(item), item);
  crossings += 1;
  crossedItems.push(item);
  return { text: `OK::${item}`, toolUses: [] };
});

const call = {
  objective: request.objective,
  item: null,
  items: request.items,
  resolvedTools: 'none needed',
  externalMcpToolNames: null,
  context: 'Each generated item is a complete closed fixture input.',
  instructions: 'Restart recovery: reuse settled evidence and execute only unfinished items.',
  expectedOutput: 'OK::<exact item id>, or ERROR: <reason>.',
  intent: null,
  model: null,
  workManifest: {
    id: request.manifestId,
    contractVersion: request.contractVersion,
    phase: request.phase,
    mode: 'reconcile',
    phases: [{ id: request.phase, label: 'generated item analysis', dependsOn: null }],
    aliases: null,
  },
  expectedWork: null,
};

const result = await withHarnessRunContext({
  sessionId: request.sessionId,
  sourceUserSeq: request.sourceUserSeq,
  counter: new ToolCallsCounter(2_000),
  behaviorScopeId: `${request.sessionId}::${request.callId}`,
}, () => withToolOutputContext({
  sessionId: request.sessionId,
  sourceUserSeq: request.sourceUserSeq,
  callId: request.callId,
  toolName: 'run_worker',
}, () => runWorker!(call)));

const text = result.content[0]?.text ?? '';
const manifest = summarizeWorkManifest(request.sessionId, request.manifestId);
const phaseRows = manifest?.items.map((item) => ({
  id: item.id,
  status: item.phases[request.phase]?.status ?? null,
})) ?? [];
process.stdout.write(`${JSON.stringify({
  pid: process.pid,
  crossings,
  crossedItems,
  complete: /Batch complete: 100\/100 items succeeded/.test(text),
  reused: /reused from durable evidence/.test(text),
  succeeded: phaseRows.filter((row) => row.status === 'succeeded').length,
  failed: phaseRows.filter((row) => row.status === 'failed').length,
})}\n`);

setClaudeAgentSdkWorkerRunForTest(null);
closeEventLog();
