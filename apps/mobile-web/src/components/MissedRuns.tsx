import './missed-runs.css';
import { useEffect, useState } from 'preact/hooks';
import { runWorkflow } from '../lib/api';
import { haptic } from '../lib/native-bridge';
import { mobileWorkflowPath, WORKFLOW_WIDGET_SLUG } from '../lib/workflow-widget';
import {
  decideMissedRun, dismissMissedRuns, dueWords, getMissedRuns, missedRunInMotion, missedRunState, type MissedNotice,
} from '../lib/missed-runs';

/** Scheduled runs that came due while Clementine was closed: tick the ones to
 *  run now (each counts from now), or skip them, then watch them go. The same
 *  card Today shows on the desktop. */
export function MissedRuns({ onEmptyChange }: { onEmptyChange?: (empty: boolean) => void } = {}) {
  const [notices, setNotices] = useState<MissedNotice[]>([]);
  const [tick, setTick] = useState(0);
  const moving = notices.some((notice) => notice.items.some(missedRunInMotion));
  useEffect(() => {
    let live = true;
    const read = () => { getMissedRuns().then((result) => {
      if (live) { setNotices(result.notices); onEmptyChange?.(result.notices.length === 0); }
    }).catch(() => { if (live) onEmptyChange?.(false); /* the last reading stands */ }); };
    read();
    const timer = window.setInterval(read, moving ? 3_000 : 30_000);
    return () => { live = false; onEmptyChange?.(false); window.clearInterval(timer); };
  }, [moving, tick, onEmptyChange]);
  if (notices.length === 0) return null;
  return <>{notices.map((notice) => <MissedNoticeCard key={notice.id} notice={notice} onChanged={() => setTick((n) => n + 1)} />)}</>;
}

function MissedNoticeCard({ notice, onChanged }: { notice: MissedNotice; onChanged: () => void }) {
  const open = notice.items.filter((item) => !item.decision);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const checked = open.filter((item) => !unchecked.has(item.workflow));
  const moving = notice.items.some(missedRunInMotion);

  const runChecked = async () => {
    haptic('light'); setBusy(true); setErrors({});
    for (const item of checked) {
      try {
        const receipt = await runWorkflow(item.workflow);
        const runId = receipt.id ?? receipt.runId;
        if (!runId) throw new Error('It could not start right now.');
        await decideMissedRun(notice.id, item.workflow, 'run', runId);
      } catch (error) {
        setErrors((all) => ({ ...all, [item.workflow]: error instanceof Error ? error.message : String(error) }));
      }
    }
    setBusy(false); onChanged();
  };
  const skipOpen = async () => {
    haptic('light'); setBusy(true);
    for (const item of open) { try { await decideMissedRun(notice.id, item.workflow, 'skip'); } catch { /* stays open */ } }
    setBusy(false); onChanged();
  };
  const dismiss = async () => {
    setBusy(true);
    try { await dismissMissedRuns(notice.id); } finally { setBusy(false); onChanged(); }
  };

  return (
    <section class="missed-runs" aria-label="Runs missed while Clementine was closed">
      <h3 class="missed-runs-title">{open.length > 0 ? 'While you were away, these didn’t run' : 'Missed while you were away'}</h3>
      {open.length > 0 && <p class="missed-runs-note">Pick what to run now. A run started now counts from now.</p>}
      <ul class="missed-runs-list">
        {notice.items.map((item) => {
          const state = missedRunState(item);
          return (
            <li key={item.workflow} class="missed-runs-row">
              {item.decision ? (
                <span class={`missed-runs-mark tone-${state?.tone ?? 'muted'}`} aria-hidden="true">{state?.tone === 'done' ? '✓' : state?.tone === 'working' ? '•' : ''}</span>
              ) : (
                <input type="checkbox" checked={!unchecked.has(item.workflow)} disabled={busy} aria-label={`Run ${item.name} now`}
                  onChange={() => setUnchecked((all) => { const next = new Set(all); if (next.has(item.workflow)) next.delete(item.workflow); else next.add(item.workflow); return next; })} />
              )}
              <span class="missed-runs-name">
                {item.name}
                <span class="missed-runs-due"> · due {dueWords(item.dueAt)}{item.times > 1 ? ` · missed ${item.times} times` : ''}</span>
                {errors[item.workflow] && <span class="missed-runs-error">{errors[item.workflow]}</span>}
              </span>
              {state && <span class={`missed-runs-state tone-${state.tone}`}>{state.text}</span>}
              {item.decision?.action === 'run' && WORKFLOW_WIDGET_SLUG.test(item.workflow) && (
                <a class="missed-runs-open" href={mobileWorkflowPath(item.workflow)}>Open</a>
              )}
            </li>
          );
        })}
      </ul>
      <div class="missed-runs-actions">
        {open.length > 0 ? (
          <>
            <button type="button" class="home-btn home-btn-primary" disabled={busy || checked.length === 0} onClick={() => { void runChecked(); }}>
              {checked.length === open.length ? 'Run now' : `Run ${checked.length} now`}
            </button>
            <button type="button" class="home-btn" disabled={busy} onClick={() => { void skipOpen(); }}>{open.length === notice.items.length ? 'Skip' : 'Skip the rest'}</button>
          </>
        ) : !moving && <button type="button" class="home-btn" disabled={busy} onClick={() => { void dismiss(); }}>Done</button>}
      </div>
    </section>
  );
}
