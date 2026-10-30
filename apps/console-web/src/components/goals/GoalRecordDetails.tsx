import type { GoalSummary } from '../../lib/goals';

/** The compact card is a preview; every loaded validation record remains readable. */
export function GoalRecordDetails({ goal }: { goal: GoalSummary }) {
  return <details className="mt-4 rounded-md border border-border">
    <summary className="cursor-pointer px-3 py-2 text-small font-semibold text-primary">All criteria, progress & evidence</summary>
    <div className="max-h-96 space-y-4 overflow-y-auto border-t border-border px-3 py-3 text-small text-muted">
      <section><h4 className="font-semibold text-fg">Full objective</h4><p className="mt-1 whitespace-pre-wrap break-words">{goal.objective}</p></section>
      <section><h4 className="font-semibold text-fg">Criteria ({goal.successCriteria.length})</h4><ul className="mt-1 list-disc space-y-1 pl-4">{goal.successCriteria.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}</ul>{goal.successCriteria.length === 0 && <p>No criteria pinned.</p>}</section>
      <section><h4 className="font-semibold text-fg">Progress ({goal.progressLedger.length})</h4><ol className="mt-1 list-decimal space-y-1 pl-4">{goal.progressLedger.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}</ol>{goal.progressLedger.length === 0 && <p>No progress entries yet.</p>}</section>
      <section><h4 className="font-semibold text-fg">Evidence ({goal.evidenceSummary.latest.length} loaded{goal.evidenceSummary.total > goal.evidenceSummary.latest.length ? ` of ${goal.evidenceSummary.total}` : ''})</h4><ul className="mt-1 space-y-3">{goal.evidenceSummary.latest.map((item, index) => <li key={index} className="break-words"><p className={item.pass ? 'text-success' : 'text-warning'}>{item.pass ? 'Pass' : 'Open'}: {item.criterion}</p>{item.detail && <p className="mt-1 whitespace-pre-wrap">{item.detail}</p>}<p className="mt-1 text-caption text-faint">Attempt {item.attempt}{item.method ? ` · ${item.method}` : ''}{item.at ? ` · ${new Date(item.at).toLocaleString()}` : ''}</p></li>)}</ul>{goal.evidenceSummary.latest.length === 0 && <p>No evidence details were included in this response.</p>}</section>
      {goal.steps.length > 0 && <section><h4 className="font-semibold text-fg">Next steps</h4><ul className="mt-1 space-y-1">{goal.steps.map((step, index) => <li key={index} className="whitespace-pre-wrap break-words">{step.n}. {step.action}{step.rationale ? ` — ${step.rationale}` : ''}{step.verification ? ` · Check: ${step.verification}` : ''}</li>)}</ul></section>}
      {goal.risks.length > 0 && <section><h4 className="font-semibold text-fg">Risks</h4><ul className="mt-1 list-disc space-y-1 pl-4">{goal.risks.map((risk, index) => <li key={index} className="whitespace-pre-wrap break-words">{risk}</li>)}</ul></section>}
      {goal.stages.length > 0 && <section><h4 className="font-semibold text-fg">Stages</h4><ul className="mt-1 space-y-3">{goal.stages.map(stage => <li key={stage.id}><p className="font-medium">{stage.title} · {stage.status === 'done' ? 'Done' : 'Pending'}</p><ul className="list-disc pl-4">{stage.criteria.map((criterion, index) => <li key={index} className="whitespace-pre-wrap break-words">{criterion}</li>)}</ul></li>)}</ul></section>}
    </div>
  </details>;
}
