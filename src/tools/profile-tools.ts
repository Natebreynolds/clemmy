import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadUserProfile } from '../runtime/user-profile.js';
import { textResult } from './shared.js';

/**
 * User-profile MCP tool (read). The agent reads the profile to adapt how
 * it addresses the user and tunes its tone. Communication preferences the
 * user states in chat ("call me Alex", "skip the recap", "I'm in Pacific
 * time") are now persisted via memory_remember rather than a dedicated
 * profile-write tool.
 *
 * Reads are cheap (file read on every call) so the agent can pull the
 * current state any time it's unsure.
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
}
