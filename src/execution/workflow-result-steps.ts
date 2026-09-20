/** A dependency graph's terminal outputs are its delivered results. Keep all
 * available outputs when a terminal result is missing so partial work remains
 * visible; independent branches each retain their own terminal result. */
export function workflowResultSteps<T extends { id: string; dependsOn?: readonly string[] }>(
  steps: readonly T[], outputs: Record<string, unknown>,
): T[] {
  const available = steps.filter(step => outputs[step.id] !== undefined);
  const consumed = new Set(steps.flatMap(step => step.dependsOn ?? []));
  const terminal = steps.filter(step => !consumed.has(step.id));
  if (terminal.length === 0 || terminal.some(step => outputs[step.id] === undefined)) return available;
  return terminal;
}
