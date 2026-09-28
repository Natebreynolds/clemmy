import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';
import { MEETINGS_DIR } from '../memory/vault.js';
import {
  fileMeetingFromAnalysis,
  loadRecallMeetingAnalysis,
  loadRecallMeetingById,
  patchMeetingRecord,
  saveRecallMeetingAnalysis,
} from '../integrations/recall/meeting-capture.js';

export const MEETING_ANALYSIS_INPUT = z.object({
  meeting_id: z.string().min(1),
  analysis: z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    decisions: z.array(z.string()),
    actionItems: z.array(z.object({
      text: z.string().min(1),
      owner: z.string().nullable().optional(),
      dueDate: z.string().nullable().optional(),
    }).strict()),
    topics: z.array(z.string()),
    participants: z.array(z.string()),
  }).strict(),
}).strict();

/** Only the host chooses the destination. General file writes must continue
 * to refuse the protected state directory, including meeting analysis. */
export function persistMeetingAnalysis(input: unknown): { meetingId: string; meetingNotePath: string; meetingsDirectory: string; noteUpdated: boolean } {
  const { meeting_id: meetingId, analysis } = MEETING_ANALYSIS_INPUT.parse(input);
  const record = loadRecallMeetingById(meetingId);
  if (!record) throw new Error('Meeting not found. No analysis was saved.');
  if (record.status !== 'completed' || !record.artifactPath) {
    throw new Error('Meeting transcript is not finalized. No analysis was saved.');
  }
  const normalized = {
    ...analysis,
    actionItems: analysis.actionItems.map(({ text, owner, dueDate }) => ({
      text,
      ...(owner ? { owner } : {}),
      ...(dueDate ? { dueDate } : {}),
    })),
  };
  const existing = loadRecallMeetingAnalysis(meetingId);
  const { generatedAt: previousGeneratedAt, source: _previousSource, ...previousContent } = existing ?? {};
  const unchanged = JSON.stringify(previousContent) === JSON.stringify(normalized);
  saveRecallMeetingAnalysis(meetingId, {
    ...normalized,
    generatedAt: unchanged && previousGeneratedAt ? previousGeneratedAt : new Date().toISOString(),
    source: 'agent',
  });
  // Keep filing recoverable: a retry can re-file already persisted analysis.
  const filed = fileMeetingFromAnalysis(meetingId);
  patchMeetingRecord(meetingId, { analysisError: undefined, analysisUpdatedAt: new Date().toISOString() });
  return { meetingId, meetingNotePath: record.artifactPath, meetingsDirectory: MEETINGS_DIR, noteUpdated: filed };
}

export function registerMeetingAnalysisTools(server: McpServer): void {
  server.tool(
    'meeting_analysis_save',
    'Save structured analysis for an existing finalized meeting and update its meeting note. '
      + 'Use the meeting id and analysis object; the host owns the internal destination. '
      + `Returns the meeting note path in ${MEETINGS_DIR}. Supporting notes and follow-up drafts can be written in that folder with write_file. `
      + 'Use this tool for structured analysis shown in Meetings; it does not schedule work or execute action items.',
    MEETING_ANALYSIS_INPUT.shape,
    async (input) => {
      const result = persistMeetingAnalysis(input);
      return textResult(JSON.stringify({ ok: true, ...result }));
    },
  );
}
