import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

const PREFS_FILE = path.join(BASE_DIR, 'state', 'tool-preferences.json');

export type ToolSource = 'composio' | 'mcp' | 'off';

export interface ServiceDefinition {
  id: string;
  label: string;
  composioSlug?: string;
  mcpServerNames?: string[];
}

export const KNOWN_SERVICES: ServiceDefinition[] = [
  { id: 'outlook', label: 'Outlook / Microsoft 365', composioSlug: 'outlook', mcpServerNames: ['Microsoft_365', 'microsoft-365', 'outlook'] },
  { id: 'gmail', label: 'Gmail', composioSlug: 'gmail', mcpServerNames: ['Gmail', 'gmail'] },
  { id: 'googledrive', label: 'Google Drive', composioSlug: 'googledrive', mcpServerNames: ['Google_Drive', 'google-drive', 'googledrive'] },
  { id: 'googlecalendar', label: 'Google Calendar', composioSlug: 'googlecalendar', mcpServerNames: ['Google_Calendar', 'google-calendar', 'googlecalendar'] },
  { id: 'googlesheets', label: 'Google Sheets', composioSlug: 'googlesheets', mcpServerNames: ['Google_Workspace', 'google-workspace', 'googlesheets'] },
  { id: 'slack', label: 'Slack', composioSlug: 'slack', mcpServerNames: ['Slack', 'slack'] },
  { id: 'notion', label: 'Notion', composioSlug: 'notion', mcpServerNames: ['Notion', 'notion'] },
  { id: 'github', label: 'GitHub', composioSlug: 'github', mcpServerNames: ['GitHub', 'github'] },
  { id: 'linear', label: 'Linear', composioSlug: 'linear', mcpServerNames: ['Linear', 'linear'] },
];

export interface ToolPreferences {
  version: 1;
  preferences: Record<string, ToolSource>;
  updatedAt?: string;
}

export interface ServiceAvailability {
  service: ServiceDefinition;
  composioAvailable: boolean;
  mcpAvailable: boolean;
  hasConflict: boolean;
  effective: ToolSource | null;
}

const EMPTY_PREFS: ToolPreferences = { version: 1, preferences: {} };

export function loadToolPreferences(): ToolPreferences {
  try {
    if (!existsSync(PREFS_FILE)) return { ...EMPTY_PREFS, preferences: {} };
    const parsed = JSON.parse(readFileSync(PREFS_FILE, 'utf-8')) as ToolPreferences;
    if (parsed.version !== 1 || typeof parsed.preferences !== 'object') {
      return { ...EMPTY_PREFS, preferences: {} };
    }
    return parsed;
  } catch {
    return { ...EMPTY_PREFS, preferences: {} };
  }
}

export function saveToolPreferences(prefs: Omit<ToolPreferences, 'version' | 'updatedAt'>): void {
  mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  const clean: Record<string, ToolSource> = {};
  const knownIds = new Set(KNOWN_SERVICES.map((service) => service.id));
  for (const [id, source] of Object.entries(prefs.preferences)) {
    if (!knownIds.has(id)) continue;
    if (source === 'composio' || source === 'mcp' || source === 'off') clean[id] = source;
  }
  writeFileSync(PREFS_FILE, JSON.stringify({
    version: 1,
    preferences: clean,
    updatedAt: new Date().toISOString(),
  }, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

export function computeAvailability(
  composioConnectedSlugs: Set<string>,
  activeMcpServerNames: Set<string>,
  preferences: Record<string, ToolSource>,
): ServiceAvailability[] {
  return KNOWN_SERVICES.map((service) => {
    const composioAvailable = Boolean(service.composioSlug && composioConnectedSlugs.has(service.composioSlug));
    const mcpAvailable = Boolean(service.mcpServerNames?.some((name) => activeMcpServerNames.has(name)));
    const hasConflict = composioAvailable && mcpAvailable;
    const userPref = preferences[service.id];

    let effective: ToolSource | null = null;
    if (userPref === 'off') {
      effective = 'off';
    } else if (hasConflict) {
      effective = userPref ?? 'composio';
    } else if (composioAvailable) {
      effective = 'composio';
    } else if (mcpAvailable) {
      effective = 'mcp';
    }

    return { service, composioAvailable, mcpAvailable, hasConflict, effective };
  });
}

export function buildToolPreferencePromptBlock(availability: ServiceAvailability[], preferences: Record<string, ToolSource>): string {
  const lines: string[] = [];
  for (const item of availability) {
    if (!item.hasConflict) continue;
    const effective = preferences[item.service.id] ?? 'composio';
    if (effective === 'off') {
      lines.push(`- ${item.service.label}: do not use tools for this service; user disabled it.`);
    } else if (effective === 'composio') {
      lines.push(`- ${item.service.label}: prefer Composio. Use composio_search_tools for toolkit ${item.service.composioSlug}, then composio_execute_tool with the selected action.`);
    } else {
      lines.push(`- ${item.service.label}: prefer the configured MCP server instead of Composio.`);
    }
  }
  if (lines.length === 0) return '';
  return `## Tool Source Preferences\nThese dashboard preferences override older memory about connector choices.\n\n${lines.join('\n')}`;
}

export function buildComposioPromptBlock(connectedSlugs: string[]): string {
  if (connectedSlugs.length === 0) {
    return 'Composio external app connections are available through the tools composio_status, composio_search_tools, composio_list_tools, and composio_execute_tool when COMPOSIO_API_KEY is configured.';
  }
  const sorted = [...connectedSlugs].sort();
  return `Composio is configured. Active connected toolkits: ${sorted.join(', ')}. Use composio_search_tools to find the smallest relevant action set for the task, composio_list_tools only when a full toolkit schema is needed, and composio_execute_tool to call the chosen action. Pass composio_execute_tool arguments as a JSON object string. External mutations require approval.`;
}
