/**
 * Workspace "compose" — the LLM step a view can call to turn data into text
 * (e.g. a personalized outreach email grounded in an account row). One cheap
 * fast-model call, no tools, FAIL-OPEN. Mirrors voice-rewrite.ts / objective-
 * judge.ts. The view POSTs instructions + the row's data; gets back a draft to
 * show the user for review before an Outlook send action fires.
 */
import { Agent, Runner } from '@openai/agents';
import { MODELS, ASSISTANT_NAME } from '../config.js';

const MAX_CONTEXT = 12000;

export interface ComposeOk { ok: true; text: string }
export interface ComposeErr { ok: false; error: string }

export async function composeForSpace(
  instructions: string,
  context?: unknown,
  maxChars = 4000,
): Promise<ComposeOk | ComposeErr> {
  const instr = (instructions ?? '').trim();
  if (!instr) return { ok: false, error: 'instructions required' };
  try {
    let ctx = '';
    if (context !== undefined && context !== null) {
      const json = typeof context === 'string' ? context : JSON.stringify(context);
      ctx = `\n\nData to ground the output in (use ONLY these facts — never invent names, emails, numbers, or links):\n${json.slice(0, MAX_CONTEXT)}`;
    }
    const agent = new Agent({
      name: 'ClementineWorkspaceCompose',
      instructions: [
        `You are ${ASSISTANT_NAME}, drafting content inside an interactive workspace for the user.`,
        'Follow the instructions exactly. Output ONLY the drafted text — no preamble, no "here is your draft", no markdown code fences, no sign-off unless asked.',
        'Ground every concrete fact (names, companies, figures, links) strictly in the provided data; if a needed detail is missing, write a neutral placeholder in [brackets] rather than inventing it.',
      ].join('\n'),
      model: MODELS.fast,
      tools: [],
    });
    const result = await new Runner({ workflowName: 'clementine-space-compose' }).run(
      agent, `${instr}${ctx}`, { maxTurns: 1 },
    );
    const text = (typeof result.finalOutput === 'string'
      ? result.finalOutput
      : String(result.finalOutput ?? '')).trim();
    if (!text) return { ok: false, error: 'the model returned an empty draft' };
    return { ok: true, text: text.slice(0, maxChars) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
