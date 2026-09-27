/**
 * The section headings the harness memory context renders (harness-context.ts
 * `section(title, …)` blocks, each `## <title>` at the start of a block).
 *
 * The prompt meter splits a rendered memory context into these sections so a
 * cut to one of them is measured, not estimated by hand. Only these exact
 * headings open a section: memory bodies carry their own `##` lines, and those
 * belong to the section that contains them. A pin keeps this list in step
 * with the renderer.
 */
export const MEMORY_CONTEXT_SECTION_TITLES: readonly string[] = [
  'Now',
  'Offer Being Discussed',
  'Autonomy',
  'Relevant To Your Request',
  'Completed Actions This Conversation',
  'User Preferences',
  'Standing Policies',
  'Persistent Facts',
  'Recently Learned (last 24h)',
  'Data Landscape',
  'Remembered Tool Choices',
  'Proven Run Strategies',
  'Established Deploy Targets',
  'Working Memory',
  'Identity',
  'Core Personality',
  'Long-Term Memory',
  'Active Goals',
  'Held For Later',
  'Current Focus',
  'Skill Discovery',
  'Relevant Skills',
  'Right Now',
];
