/**
 * Workspace authoring gap test — the Space mirror of workflow-gap-test.ts.
 *
 * checkSpaceForWrite (space-enforce.ts) BLOCKS the Workspace-killers (a source
 * with no backend, a missing runner file, a bad cron). This is the softer half:
 * a deterministic, no-LLM/no-API pass over a freshly-saved Workspace that
 * surfaces the gaps which won't fail validation but WILL produce a wrong/empty
 * surface — and turns each into a plain clarifying QUESTION for Clem to ask the
 * user before the Workspace is relied on.
 *
 * Conservative (the owner's "don't make simple workflows hard"): each heuristic
 * fires only on a clear signal and the whole report is capped, so a thin, well-
 * formed Workspace saves with zero questions.
 */
import type { SpaceRecord } from './store.js';
import { workspaceActionExpectsRecipient } from './space-action-semantics.js';

export interface SpaceGap {
  severity: 'clarify';
  /** Mechanical/code gaps are Clementine's job to fix; only clarify gaps need the user. */
  resolution: 'fix' | 'clarify';
  sourceId?: string;
  actionId?: string;
  question: string;
  why: string;
}

const MAX_GAPS = 5;

const RECIPIENT_KEY_RE = /\b(to|to_email|toemail|recipient|recipients|email|address|toaddress|to_address)\b/i;

function templateHasRecipient(a: SpaceRecord['actions'][number]): boolean {
  const tpl = a.argsTemplate ?? {};
  return Object.keys(tpl).some((k) => RECIPIENT_KEY_RE.test(k.replace(/_/g, ' ')));
}

/**
 * Compile (NEVER execute) each inline classic <script> to catch a JS SYNTAX
 * error — the cheapest, safest slice of "does the view actually run". A genuine
 * syntax error means the page renders blank or half-built; valid JS always
 * compiles, so this can't false-flag a good view. External/JSON scripts and ES
 * modules are skipped (import/export can't compile via Function without a
 * parser). Top-level await/return is tolerated via an async-wrapper retry.
 * Returns the first error message found, if any.
 */
export function findScriptSyntaxError(html: string): string | undefined {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // external script — nothing inline to compile
    if (/\btype\s*=/i.test(attrs)
      && !/\btype\s*=\s*["']?(text\/javascript|application\/javascript|module)\b/i.test(attrs)) continue; // json/template/etc
    if (/\btype\s*=\s*["']?module/i.test(attrs)) continue; // ESM — import/export needs a real parser
    if (!body.trim()) continue;
    try {
      // eslint-disable-next-line no-new-func
      new Function(body); // compiles, does NOT run
    } catch (e1) {
      if (!(e1 instanceof SyntaxError)) continue;
      try {
        // eslint-disable-next-line no-new-func
        new Function(`return (async () => {\n${body}\n});`); // tolerate top-level await/return
        continue;
      } catch (e2) {
        if (e2 instanceof SyntaxError) return e1.message;
      }
    }
  }
  return undefined;
}

/**
 * Run the gap test over a saved Workspace + its installed view HTML. Returns
 * clarifying questions (possibly empty). Deterministic, side-effect free.
 * `zeroRowSourceIds` is fed from the creation smoke (space-smoke.ts) so a source
 * that returned nothing becomes a question too.
 */
export function analyzeSpaceGaps(
  record: SpaceRecord,
  viewHtml: string,
  zeroRowSourceIds: string[] = [],
): SpaceGap[] {
  const gaps: SpaceGap[] = [];
  const html = viewHtml ?? '';
  const sources = record.dataSources ?? [];

  // 0: the view's JS doesn't even parse (pushed FIRST so the cap never drops it).
  const syntaxErr = findScriptSyntaxError(html);
  if (syntaxErr) {
    gaps.push({
      severity: 'clarify',
      resolution: 'fix',
      question: `The view has a JavaScript syntax error (${syntaxErr}) — fix it before relying on the Workspace, or the surface renders blank/half-built.`,
      why: 'A script that does not parse means the page never runs its logic.',
    });
  }

  // 1: a DYNAMIC view must use the scoped bridge we inject into every served
  // Workspace. Prefer the direct helper:
  //
  //   const data = await clem.data()
  //
  // clem.refresh() and the legacy absolute Workspace route are also backed by
  // the same parent-owned RPC boundary and remain valid for existing authored
  // views. Embedded seeds and {{source}} placeholders are not live bindings.
  // Keeping those distinctions prevents the GLM proof failure without making
  // one coding style a persistence requirement.
  const usesScopedDataBridge = /\bclem\s*\.\s*(?:data|refresh)\s*\(/.test(html)
    || /\bfetch\s*\(\s*['"`]\/api\/console\/spaces\/[^'"`?#]+\/(?:data|refresh)(?:['"`?#])/i.test(html);
  if (sources.length > 0 && !usesScopedDataBridge) {
    const hasLegacyBinding = /\{\{\s*[^{}\r\n]+\s*\}\}/.test(html);
    const sourceExample = sources[0]?.id ?? '<sourceId>';
    gaps.push({
      severity: 'clarify',
      resolution: 'fix',
      question: hasLegacyBinding
        ? `The dynamic view uses a legacy {{source}} binding, but Workspace placeholders are not expanded. Replace it with \`const data = await clem.data()\` and render the declared source from \`data["${sourceExample}"]\`.`
        : `The view declares ${sources.length} data source${sources.length === 1 ? '' : 's'} but never reads them through the scoped Workspace bridge. Add \`const data = await clem.data()\` and render each declared source from \`data["<sourceId>"]\`; an embedded seed is not a live binding.`,
      why: 'A dynamic view needs the injected helper (or its scoped compatibility route) to reach the Workspace data plane.',
    });
  }

  // 1b: a relative fetch such as fetch("./data/tasks") resolves below the
  // served /view URL and is NOT a Workspace data API. This exact shape slipped
  // through the first live workspace proof because "/data" was treated as
  // sufficient even though the browser would get a 404.
  if (sources.length > 0 && /\bfetch\s*\(\s*['"`](?:\.{1,2}\/)?data(?:\/|['"`?#])/i.test(html)) {
    gaps.push({
      severity: 'clarify',
      resolution: 'fix',
      question: 'The view uses a relative fetch("…data/…") URL, which resolves under the served /view path and cannot reach Workspace data. Replace it with `const data = await clem.data()` and read the exact declared source id.',
      why: 'The HTML can look complete while every browser load gets a 404 and renders no rows.',
    });
  }

  // 2: the view never references a declared source by id (so it can't be reading
  // its rows). NB: the data is nested at data["<id>"] — a view that reads the
  // wrong key renders 0 rows (the exact bug from the first real build).
  for (const s of sources) {
    if (html && !html.includes(s.id)) {
      gaps.push({
        severity: 'clarify',
        resolution: 'fix',
        sourceId: s.id,
        question: `The view never references source "${s.id}" — confirm it reads the rows from data["${s.id}"] (the /refresh route nests each source's output under its id, so the array is at data["${s.id}"].<yourKey>).`,
        why: 'Reading the wrong key renders an empty table even though the data is there — the most common Workspace bug.',
      });
    }
  }

  // 2b/2c: a declared action the view never wires can never run (closes the
  // "action-id verification" gap). 2b = the view fires NO action at all; 2c =
  // it fires actions but never references THIS id. The bridge's canonical shape
  // is clem.action('<id>', …); a hand-rolled view POSTs …/action directly.
  const actions = record.actions ?? [];
  const firesActions = /clem\.action\b/.test(html) || /\/action\b/.test(html);
  if (html && actions.length > 0 && !firesActions) {
    gaps.push({
      severity: 'clarify',
      resolution: 'fix',
      question: `The view declares ${actions.length} action${actions.length === 1 ? '' : 's'} but never fires one — add a control that calls clem.action('<id>', {…}).`,
      why: 'A declared action with no control is dead weight — the user can never trigger it.',
    });
  } else if (html && firesActions) {
    for (const a of actions) {
      if (!html.includes(a.id)) {
        gaps.push({
          severity: 'clarify',
          resolution: 'fix',
          actionId: a.id,
          question: `The view fires actions but never references "${a.id}" — confirm a control calls clem.action('${a.id}', {…}).`,
          why: 'A declared action the view never wires can never run.',
        });
      }
    }
  }

  // 3: a send-like action whose args template carries no recipient — confirm the
  // view supplies it, so it can't go to the wrong person (or nobody).
  for (const a of record.actions ?? []) {
    if (!workspaceActionExpectsRecipient(a)) continue;
    if (templateHasRecipient(a)) continue;
    gaps.push({
      severity: 'clarify',
      resolution: 'clarify',
      actionId: a.id,
      question: `Action "${a.id}" sends to the outside world but its argsTemplate has no recipient — does the view supply the recipient (to/to_email) at click time, and is it always the right person?`,
      why: 'A send to nobody — or the wrong person — is the costliest thing to get wrong.',
    });
  }

  // 4: a source that returned ZERO rows in the creation smoke.
  for (const id of zeroRowSourceIds) {
    if (sources.find((source) => source.id === id)?.allowEmpty === true) continue;
    gaps.push({
      severity: 'clarify',
      resolution: 'clarify',
      sourceId: id,
      question: `Source "${id}" returned 0 rows when I ran it — is that expected right now, or is the query/filter wrong?`,
      why: 'An empty data source ships a working-looking but useless Workspace.',
    });
  }

  return gaps.slice(0, MAX_GAPS);
}

/**
 * Render gap questions for the space_save tool result so the AUTHORING agent
 * asks the user before the Workspace is relied on. Empty string when there are
 * no gaps (a clean save stays byte-identical).
 */
export function renderSpaceGapQuestions(gaps: SpaceGap[]): string {
  if (gaps.length === 0) return '';
  const fixes = gaps.filter((g) => g.resolution === 'fix');
  const clarifications = gaps.filter((g) => g.resolution === 'clarify');
  const out = ['', ''];
  if (fixes.length > 0) {
    out.push(
      'Gap test — fix these implementation issues now (do not ask the user to debug your Workspace):',
      ...fixes.map((g) => `- ${g.question}\n  (why: ${g.why})`),
    );
  }
  if (clarifications.length > 0) {
    if (fixes.length > 0) out.push('');
    out.push(
      "Gap test — get the user's answer on these genuine product/data choices:",
      ...clarifications.map((g) => `- ${g.question}\n  (why: ${g.why})`),
    );
  }
  out.push(
    '',
    fixes.length > 0
      ? 'Refine the implementation, then call space_save with the same slug. Do not present it as ready while a fix remains.'
      : 'Ask these now, then refine with space_save (same slug). Do not present it as ready until they\'re resolved.',
  );
  return out.join('\n');
}
