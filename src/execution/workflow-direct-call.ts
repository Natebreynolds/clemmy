import { LOCAL_MCP_TOOL_NAMES } from '../tools/catalog.js';

const LOCAL_TOOL_NAMES = new Set<string>(LOCAL_MCP_TOOL_NAMES as readonly string[]);
const EXTRA_NON_DIRECT_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'browser_read',
  'browser_click',
  'browser_fill',
  'browser_screenshot',
  'computer_use',
]);

/**
 * Structured workflow `call` nodes execute through executeComposioTool today.
 * That means the value must be a real Composio action slug, not a Clementine
 * broker/local/MCP/CLI tool name that only exists inside the model harness.
 */
export function isDirectComposioActionSlug(tool: string | undefined | null): tool is string {
  const raw = tool?.trim();
  if (!raw) return false;
  if (raw.includes('*')) return false;
  if (raw.includes('__')) return false;
  if (!/^[A-Za-z0-9_]+$/.test(raw)) return false;
  if (!raw.includes('_')) return false;
  if (raw.toLowerCase().startsWith('cx_')) return false;
  if (/^(?:mcp|cli|tool|skill)$/i.test(raw)) return false;
  if (/^(?:mcp__|cli[:_]|tool[:_]|skill[:_])/i.test(raw)) return false;
  if (LOCAL_TOOL_NAMES.has(raw) || EXTRA_NON_DIRECT_TOOLS.has(raw)) return false;
  if (/^composio_(?:execute_tool|search_tools|list_tools|status)$/i.test(raw)) return false;
  return true;
}
