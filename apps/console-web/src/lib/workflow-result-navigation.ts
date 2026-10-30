import { workflowDisplayName } from '@clem/chat-engine';

/** Workspace manifests contain step/tool output, not verified deliverable IDs.
 * A scoped archive search is useful without pretending that a path can open. */
export function workflowResultArchiveHref(workflow: string, artifactPath?: string): string {
  const path = artifactPath?.trim() ?? '';
  const internal = /^(?:artifacts|steps|step-results|step-outputs|digests|upstream)[/\\]/i.test(path);
  const filename = path.split(/[/\\]/).at(-1) ?? '';
  const search = !internal && /\.(?:pdf|docx?|xlsx?|pptx?|csv|md|txt|html?)$/i.test(filename)
    ? filename : workflowDisplayName(workflow);
  return `/made?${new URLSearchParams({ q: search })}`;
}
