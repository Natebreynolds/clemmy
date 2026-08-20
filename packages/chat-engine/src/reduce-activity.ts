import type { ActivityItem, HarnessEvent } from './types.js';
import { describeExternalWrite, humanToolLabel, salientArgDetail } from './tool-labels.js';
import { workPlanActivityItem } from './work-plan-presentation.js';

// Contract-grammar negotiation: the harness teaching the model its call
// contract — work_contract_required, effect mismatches, already-satisfied —
// is internal alignment, not failed user work. A live turn that SUCCEEDED
// showed three red ✗ rows from these, reading as chaos. They render as
// neutral settled rows; real tool failures keep the ✗.
const CONTRACT_NEGOTIATION_RE = /"error":"(?:work_contract_required|work_contract_conflict|work_effect_mismatch|work_already_satisfied|work_requirement_unknown|work_binding_required|work_attempt_budget_exhausted)"/;
function isContractNegotiationReturn(d: Record<string, unknown>): boolean {
  if (d.ok !== false) return false;
  const preview = typeof d.preview === 'string' ? d.preview : '';
  return CONTRACT_NEGOTIATION_RE.test(preview);
}

function providerFromModel(model: string): ActivityItem['provider'] {
  const id = model.toLowerCase();
  if (/claude|sonnet|opus|haiku|fable|anthropic/.test(id)) return 'claude';
  if (/glm|zhipu|zai/.test(id)) return 'glm';
  if (/gpt|^o[134]|codex|openai/.test(id)) return 'codex';
  return 'unknown';
}

/** Prefer an explicit provider string carried on the event before falling back
 *  to regexing the model id — model ids miss (a BYO/renamed model reads as
 *  'unknown' but its provider is known). */
function providerFor(d: Record<string, unknown>, model: string): ActivityItem['provider'] {
  const explicit = typeof d.provider === 'string' ? d.provider.toLowerCase() : '';
  if (explicit) {
    if (explicit === 'byo') return 'byo';
    if (/claude|anthropic/.test(explicit)) return 'claude';
    if (/glm|zhipu|zai/.test(explicit)) return 'glm';
    if (/codex|openai|gpt/.test(explicit)) return 'codex';
    // Unrecognized custom provider id: fall through to the model regex.
  }
  return providerFromModel(model);
}

export const REUSED_RESULT_LABEL = 'Reused earlier result';

/** Fold one harness event into the turn's activity list. Returns the SAME array
 *  reference when nothing changed (so the caller can skip a re-render). Tools are
 *  correlated called→returned by callId when available, falling back to name for
 *  older events; agents (run_worker) are keyed by item; run_batch renders as ONE
 *  live meter row driven by authoritative batch_progress counts. */
export function reduceActivity(prev: ActivityItem[], ev: HarnessEvent, now: () => number = Date.now): ActivityItem[] {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const tool = typeof d.tool === 'string' ? d.tool : typeof d.toolName === 'string' ? d.toolName : '';
  const callId = typeof d.callId === 'string' ? d.callId : typeof d.call_id === 'string' ? d.call_id : '';
  const item = typeof d.item === 'string' ? d.item : '';
  const model = typeof d.model === 'string' ? d.model : '';
  const toolLabel = humanToolLabel(tool, d.args, d.publicSlug, d.innerTool);
  switch (ev.type) {
    // The compiled graph is internal topology. Pinning "Planned: plan · N
    // steps" is generic noise, not work.
    case 'turn_graph_compiled':
      return prev;
    case 'step_started': {
      const stepId = typeof d.stepId === 'string' ? d.stepId.trim() : '';
      const title = typeof d.title === 'string' && d.title.trim()
        ? d.title.trim()
        : stepId.replace(/[_-]+/g, ' ').trim();
      if (!title) return prev;
      const row: ActivityItem = {
        id: `step-${stepId || title}`,
        kind: 'event',
        variant: 'lifecycle',
        tone: 'live',
        label: title,
        status: 'running',
      };
      const index = prev.findIndex((it) => it.id === row.id);
      return index >= 0 ? prev.map((it, i) => (i === index ? { ...it, ...row } : it)) : [...prev, row];
    }
    case 'async_work_dispatched': {
      const runIds = Array.isArray(d.runIds)
        ? d.runIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        : [];
      if (runIds.length === 0) return prev;
      const key = typeof d.dispatchKey === 'string' && d.dispatchKey.trim()
        ? d.dispatchKey.trim()
        : runIds.join(',');
      const label = runIds.length > 1
        ? `Started ${runIds.length} workflows in the background`
        : 'Started the workflow in the background';
      const row: ActivityItem = {
        id: `dispatch-${key}`,
        kind: 'event',
        variant: 'lifecycle',
        tone: 'live',
        label,
        detail: 'I’ll post the result here when it’s ready.',
        status: 'running',
      };
      const index = prev.findIndex((it) => it.id === row.id);
      return index >= 0 ? prev.map((it, i) => (i === index ? row : it)) : [...prev, row];
    }
    case 'expected_work_progress': {
      // Host plan: show the work that is happening. A later write waiting on
      // the read is sequencing, not a user-facing "blocked" row.
      const rawLines = Array.isArray(d.lines) ? d.lines : [];
      if (rawLines.length === 0) return prev;
      const next = [...prev];
      for (const raw of rawLines) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const line = raw as Record<string, unknown>;
        const id = typeof line.id === 'string' ? line.id.trim() : '';
        if (!id) continue;
        const rowId = `ew-${id}`;
        const row = workPlanActivityItem({
          id,
          effect: line.effect,
          state: line.state,
          dependsOn: line.dependsOn,
        });
        const index = next.findIndex((it) => it.id === rowId);
        if (!row) {
          if (index >= 0) next.splice(index, 1);
          continue;
        }
        if (index >= 0) next[index] = row;
        else next.push(row);
      }
      return next;
    }
    case 'batch_started': {
      const batchId = typeof d.batchId === 'string' ? d.batchId : `${prev.length}`;
      const total = typeof d.items === 'number' ? d.items : 0;
      const slugRaw = typeof d.slug === 'string' && d.slug ? d.slug : typeof d.tool === 'string' ? d.tool : 'items';
      const verb = d.sideEffect === 'send' ? 'Sending' : d.sideEffect === 'write' ? 'Writing' : 'Fetching';
      const label = `${verb} ${total} × ${slugRaw.replace(/^mcp__.+?__/, '').replace(/_/g, ' ').toLowerCase()}`;
      return [...prev, { id: `b-${batchId}`, kind: 'batch', label, status: 'running', startedAt: now(), batch: { done: 0, total, failed: 0 } }];
    }
    case 'batch_progress': {
      const id = `b-${typeof d.batchId === 'string' ? d.batchId : ''}`;
      if (!prev.some((a) => a.kind === 'batch' && a.id === id)) return prev;
      const done = typeof d.done === 'number' ? d.done : 0;
      const total = typeof d.total === 'number' ? d.total : 0;
      const failed = typeof d.failed === 'number' ? d.failed : 0;
      const itemId = typeof d.itemId === 'string' ? d.itemId : '';
      // A throttled event is a batch-level back-off pause (no per-item advance) —
      // keep the counts, flip the meter into "throttled" until the next real
      // item update clears it.
      const throttled = d.throttled === true;
      return prev.map((a) => (a.kind === 'batch' && a.id === id
        ? { ...a, batch: { done, total, failed, ...(throttled ? { throttled: true } : {}) }, ...(itemId ? { detail: itemId } : {}) }
        : a));
    }
    case 'batch_completed': {
      const id = `b-${typeof d.batchId === 'string' ? d.batchId : ''}`;
      const failed = typeof d.failed === 'number' ? d.failed : 0;
      const halted = d.halted === true;
      return prev.map((a) => (a.kind === 'batch' && a.id === id
        ? {
            ...a,
            status: failed > 0 || halted ? 'failed' : 'done',
            detail: undefined,
            batch: a.batch ? { ...a.batch, done: typeof d.succeeded === 'number' ? (d.succeeded as number) + failed : a.batch.done, failed } : a.batch,
          }
        : a));
    }
    case 'deliverable_saved': {
      // Files landing, live: ONE rolling row that keeps counting — "Saved 3
      // files · latest client-brief.md" — so results visibly accumulate
      // instead of vanishing into a folder.
      const name = typeof d.name === 'string' ? d.name : '';
      if (!name) return prev;
      const dir = typeof d.dir === 'string' && d.dir ? d.dir : '';
      const existing = prev.find((a) => a.id === 'deliverables');
      const count = (existing?.count ?? 0) + 1;
      const label = count === 1
        ? `Saved ${name}${dir ? ` in ${dir}` : ''}`
        : `Saved ${count} files · latest ${name}`;
      const excerpt = typeof d.excerpt === 'string' && d.excerpt.trim() ? d.excerpt : undefined;
      const row: ActivityItem = {
        id: 'deliverables',
        kind: 'event',
        variant: 'write',
        tone: 'success',
        label,
        ...(dir && count > 1 ? { detail: `in ${dir}` } : {}),
        status: 'done',
        count,
        // The latest file's opening rides along, so the peek pane always
        // shows what was JUST produced.
        ...(excerpt ? { excerpt } : (existing?.excerpt ? { excerpt: existing.excerpt } : {})),
      };
      return existing
        ? prev.map((a) => (a.id === 'deliverables' ? row : a))
        : [...prev, row];
    }
    case 'capability_resolution': {
      // Inventory, not work.
      return prev;
    }
    case 'tool_called': {
      if (!tool || tool === 'run_worker' || /run_worker/.test(tool)) return prev; // agents render as agents, not a tool row
      if (d.batchMode === true) return prev; // batch items render as ONE live meter row, not N tool rows
      const reused = d.reused === true;
      const detail = reused ? toolLabel : salientArgDetail(d.args);
      return [...prev, {
        id: callId ? `t-${callId}` : `t${prev.length}-${tool}`,
        kind: 'tool',
        label: reused ? REUSED_RESULT_LABEL : toolLabel,
        ...(detail ? { detail } : {}),
        startedAt: now(),
        status: 'running',
      }];
    }
    case 'tool_returned': {
      if (d.batchMode === true) return prev; // counted via batch_progress
      const status: ActivityItem['status'] = d.ok === false && !isContractNegotiationReturn(d) ? 'failed' : 'done';
      const reused = d.reused === true;
      // The read-result glimpse: "12 records · name, website, phone — Acme
      // Roofing". Runtime-derived structure, so scraped data visibly ARRIVES
      // instead of disappearing into a digest.
      const g = d.glimpse as { count?: number; key?: string; fields?: string[]; sample?: string } | undefined;
      const glimpseDetail = g && typeof g.count === 'number'
        ? [
            `${g.count} ${typeof g.key === 'string' && g.key ? g.key : 'items'}`,
            Array.isArray(g.fields) && g.fields.length ? g.fields.join(', ') : '',
            typeof g.sample === 'string' && g.sample ? `“${g.sample}”` : '',
          ].filter(Boolean).join(' · ')
        : '';
      const settle = (a: ActivityItem): ActivityItem => {
        const reusedDetail = a.label === REUSED_RESULT_LABEL
          ? (a.detail || toolLabel)
          : a.label;
        return {
          ...a,
          status,
          ...(reused ? { label: REUSED_RESULT_LABEL } : {}),
          ...(glimpseDetail
            ? { detail: glimpseDetail }
            : reused
              ? { detail: reusedDetail }
              : {}),
        };
      };
      if (callId) {
        const id = `t-${callId}`;
        if (prev.some((a) => a.kind === 'tool' && a.id === id)) {
          return prev.map((a) => (a.kind === 'tool' && a.id === id ? settle(a) : a));
        }
      }
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === 'tool' && prev[i].status === 'running' && prev[i].label === toolLabel) {
          return prev.map((a, j) => (j === i ? settle(a) : a));
        }
      }
      return prev;
    }
    case 'worker_started': {
      if (!item) return prev;
      const role = typeof d.role === 'string' ? d.role : '';
      return [...prev, { id: `a-${item}`, kind: 'agent', label: role ? `${role}: ${item}` : item, detail: model || undefined, provider: providerFor(d, model), status: 'running' }];
    }
    case 'worker_result': {
      // UPSERT: on lanes where worker_started historically wasn't emitted
      // there's no `a-${item}` row to update — append one with the final
      // status so the agent still appears in the strip.
      if (!item) return prev;
      const id = `a-${item}`;
      const status: ActivityItem['status'] = d.ok === false && !isContractNegotiationReturn(d) ? 'failed' : 'done';
      const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
      if (prev.some((a) => a.kind === 'agent' && a.id === id)) {
        return prev.map((a) => (a.kind === 'agent' && a.id === id
          ? {
              ...a,
              status,
              // Keep the worker_started label (it carries the role); on failure
              // append the short reason so "<item> ✗ <reason>" reads by default.
              ...(status === 'failed' && reason ? { label: `${a.label} — ${reason.slice(0, 80)}` } : {}),
              ...(model ? { detail: model, provider: providerFor(d, model) } : {}),
            }
          : a));
      }
      const role = typeof d.role === 'string' ? d.role : '';
      const base = role ? `${role}: ${item}` : item;
      const label = status === 'failed' && reason ? `${base} — ${reason.slice(0, 80)}` : base;
      return [...prev, { id, kind: 'agent', label, detail: model || undefined, provider: providerFor(d, model), status }];
    }
    case 'worker_capped':
      return prev.map((a) => (a.kind === 'agent' && a.id === `a-${item}` ? { ...a, status: 'failed' } : a));
    // Trust cockpit: judge verdicts + watcher steers appear as 'check' rows so
    // the strip shows not only what the agent DID but what verified it.
    case 'verdict_recorded': {
      const door = typeof d.door === 'string' ? d.door.replace(/_/g, ' ') : 'judge';
      const pass = d.pass === true;
      const failedOpen = d.failedOpen === true;
      const scorecard = typeof d.criteriaMet === 'number' && typeof d.criteriaTotal === 'number' ? ` ${d.criteriaMet}/${d.criteriaTotal}` : '';
      const reason = typeof d.reason === 'string' ? d.reason : '';
      return [...prev, {
        id: `v${prev.length}-${door}`,
        kind: 'check',
        label: failedOpen ? `Verdict · ${door}: accepted (judge unavailable)` : `Verdict · ${door}${scorecard}: ${pass ? 'passed' : 'not passed'}`,
        ...(reason ? { detail: reason } : {}),
        status: pass && !failedOpen ? 'done' : 'failed',
      }];
    }
    case 'heartbeat': {
      if (d.kind !== 'watcher_steer') return prev;
      const miss = typeof d.miss === 'string' ? d.miss : '';
      const steer = typeof d.steer === 'string' ? d.steer : '';
      const detail = [miss, steer && steer !== miss ? steer : ''].filter(Boolean).join(' → ');
      return [...prev, { id: `w${prev.length}`, kind: 'check', label: 'Watcher steered', ...(detail ? { detail } : {}), status: 'done' }];
    }
    // Real effects on the outside world — the plain-human "Sent a message to …",
    // "Created a record", "Saved a file" rows. Phrasing mirrors the server's
    // describeExternalWrite (work-report.ts) so every surface speaks ONE
    // vocabulary. A failed/orphaned write is the same line with an honest tail.
    case 'external_write':
    case 'external_write_failed':
    case 'external_write_orphaned': {
      const shapeKey = typeof d.shapeKey === 'string' ? d.shapeKey : '';
      const writeTool = typeof d.toolName === 'string' ? d.toolName : tool;
      const targets = Array.isArray(d.targets) ? d.targets.filter((t): t is string => typeof t === 'string') : [];
      // The recorded irreversibility bit rides through so a reversible write
      // (draft/update) can never render as delivery in the live feed either.
      const base = describeExternalWrite(shapeKey, writeTool, targets, {
        ...(typeof d.irreversible === 'boolean' ? { irreversible: d.irreversible } : {}),
        ...(typeof d.actionKey === 'string' ? { actionKey: d.actionKey } : {}),
      });
      const failed = ev.type === 'external_write_failed';
      const orphaned = ev.type === 'external_write_orphaned';
      const key = callId || shapeKey || writeTool || `${prev.length}`;
      return [...prev, {
        id: `x-${ev.type}-${key}`,
        kind: 'event',
        variant: 'write',
        label: failed ? `${base} — failed` : orphaned ? `${base} — timed out, may have landed` : base,
        status: failed ? 'failed' : 'done',
        tone: failed ? 'danger' : orphaned ? 'warning' : 'success',
      }];
    }
    case 'conversation_completed':
      return prev.map((it) => (
        it.id.startsWith('dispatch-') && it.status === 'running'
          ? { ...it, status: 'done', tone: 'success' }
          : it
      ));
    // ONE row per code-mode program: the user sees the outcome, not the machinery.
    case 'codemode_program_summary': {
      const rpc = typeof d.rpcCalls === 'number' ? d.rpcCalls : 0;
      const ok = d.ok !== false;
      const label = `Ran a batch program (${rpc} tool call${rpc === 1 ? '' : 's'})`;
      return [...prev, {
        id: `cm-${prev.length}`,
        kind: 'event',
        variant: 'program',
        label: ok ? label : `${label} — didn't finish`,
        status: ok ? 'done' : 'failed',
        tone: ok ? 'muted' : 'danger',
      }];
    }
    default:
      return prev;
  }
}
