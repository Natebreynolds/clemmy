import { openEventLog } from '../runtime/harness/eventlog.js';

/**
 * The owner's standing instructions exactly as a workflow run's workers had
 * them: the User Preferences and Standing Policies sections of each step's
 * retained model-memory context. The goal reviewer reads the same text the
 * work applied, so an owner rule the work followed is judged as the owner's
 * own, and a preference found in none of the owner's words is still caught.
 *
 * Read-only, bounded, deduplicated across steps; null when no step recorded
 * its context (nothing is reconstructed from memory afterwards).
 */
const SECTION_HEADERS = ['## User Preferences', '## Standing Policies'] as const;
const DEFAULT_MAX_CHARS = 4_000;

function sectionText(fragment: string, header: string): string | null {
  const lines = fragment.split('\n');
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    body.push(line);
  }
  const text = body.join('\n').trim();
  return text ? `${header}\n${text}` : null;
}

export function workerStandingInstructions(runId: string, maxChars = DEFAULT_MAX_CHARS): string | null {
  const id = runId.trim();
  if (!id || /[*?[\]]/.test(id)) return null;
  try {
    const rows = openEventLog().prepare(`
      SELECT data_json AS dataJson FROM events
       WHERE session_id GLOB ? AND type = 'guardrail_tripped'
         AND json_extract(data_json, '$.kind') = 'model_memory_context'
       ORDER BY seq
    `).all(`workflow:${id}:*`) as Array<{ dataJson: string }>;
    const sections: string[] = [];
    for (const row of rows) {
      let fragments: unknown;
      try { fragments = (JSON.parse(row.dataJson) as { fragments?: unknown }).fragments; } catch { continue; }
      if (!Array.isArray(fragments)) continue;
      for (const fragment of fragments) {
        if (typeof fragment !== 'string') continue;
        for (const header of SECTION_HEADERS) {
          const text = sectionText(fragment, header);
          if (text && !sections.includes(text)) sections.push(text);
        }
      }
    }
    if (sections.length === 0) return null;
    const joined = sections.join('\n\n');
    return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
  } catch {
    return null;
  }
}
