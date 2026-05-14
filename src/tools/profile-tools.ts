import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadUserProfile, saveUserProfile } from '../runtime/user-profile.js';
import { textResult } from './shared.js';

/**
 * User-profile MCP tools. The agent uses these to adapt to the user
 * over time. Examples of legitimate use:
 *
 *   - User says "call me Nathan, not Mr. Reynolds" → `user_profile_update({ preferredName: 'Nathan' })`
 *   - User says "skip the recap, just answer" → `user_profile_update({ communicationTone: 'terse' })`
 *   - User says "I'm in Pacific time, working 9–6 weekdays" → set timezone + working hours
 *
 * Reads are cheap (file read on every call) so the agent can pull the
 * current state any time it's unsure. Writes are idempotent — same
 * patch can be applied twice without effect.
 *
 * This is the customization layer for the goal piece "customizable
 * based on the user who installed this".
 */

export function registerProfileTools(server: McpServer): void {
  server.tool(
    'user_profile_read',
    'Read the user\'s current profile (name, role, timezone, working hours, communication preferences, notes). Use to remind yourself how to address them and tune your tone.',
    {},
    async () => {
      const profile = loadUserProfile();
      const lines = [
        `Display name: ${profile.displayName}`,
        profile.preferredName ? `Preferred name: ${profile.preferredName}` : '',
        profile.role ? `Role: ${profile.role}` : '',
        profile.timezone ? `Timezone: ${profile.timezone}` : '',
        profile.workingHoursStart && profile.workingHoursEnd
          ? `Working hours: ${profile.workingHoursStart}–${profile.workingHoursEnd} (${(profile.workingDays ?? []).join(', ')})`
          : '',
        `Tone: ${profile.communicationTone} | Formality: ${profile.formality} | Urgency tolerance: ${profile.urgencyTolerance}`,
        profile.preferredChannels && profile.preferredChannels.length > 0
          ? `Preferred channels: ${profile.preferredChannels.join(', ')}`
          : '',
        profile.notes ? `Notes: ${profile.notes}` : '',
      ].filter(Boolean);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'user_profile_update',
    'Update the user profile. Only set fields the user has explicitly told you about — do NOT guess values. The profile is read on every conversation; changes take effect on the next turn.',
    {
      displayName: z.string().min(1).max(120).optional(),
      preferredName: z.string().min(1).max(80).optional(),
      role: z.string().min(2).max(200).optional(),
      timezone: z.string().min(2).max(80).optional(),
      workingHoursStart: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
      workingHoursEnd: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
      workingDays: z.array(z.string()).max(7).optional(),
      communicationTone: z.enum(['terse', 'balanced', 'verbose']).optional(),
      formality: z.enum(['casual', 'professional', 'formal']).optional(),
      urgencyTolerance: z.enum(['low', 'normal', 'high']).optional(),
      preferredChannels: z.array(z.string()).max(8).optional(),
      notes: z.string().max(1200).optional(),
    },
    async (patch) => {
      const updated = saveUserProfile(patch);
      return textResult(`Profile updated. Address: ${updated.preferredName ?? updated.displayName} | tone: ${updated.communicationTone} | formality: ${updated.formality}`);
    },
  );
}
