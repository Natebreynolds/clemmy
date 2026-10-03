import { z } from 'zod';
import { BROWSER_HTTP_URL } from './browser-operation-contract.js';

const resource = z.string().min(1).max(128).describe('Exact task-owned cloud browser resource id. Never a provider URL or a local browser id.');
const version = z.number().int().min(0).describe('Current controlVersion from a fresh receipt. Old versions cannot act after a human handoff.');
const target = z.string().min(1).max(128).describe('Exact targetId from this resource\'s current pages or tabs receipt.');
export const CLOUD_BROWSER_PARAMETERS = {
  // Recording is an explicit owner choice in the authenticated UI, never a
  // model-selected option on a routine browsing request.
  cloud_browser_start: {},
  cloud_browser_resources: {},
  cloud_browser_status: { resource_id: resource },
  cloud_browser_tabs: { resource_id: resource, expected_version: version },
  cloud_browser_read: { resource_id: resource, expected_version: version, target_id: target,
    max_chars: z.number().int().min(100).max(16000).nullable().optional() },
  cloud_browser_open: { resource_id: resource, expected_version: version },
  cloud_browser_navigate: { resource_id: resource, expected_version: version, target_id: target, url: BROWSER_HTTP_URL },
} as const;
export type CloudBrowserOperationName = keyof typeof CLOUD_BROWSER_PARAMETERS;
export function cloudBrowserOperationName(value: string): value is CloudBrowserOperationName {
  return Object.hasOwn(CLOUD_BROWSER_PARAMETERS, value);
}
export function parseCloudBrowserArguments(name: CloudBrowserOperationName, args: unknown): Record<string, unknown> {
  const parsed: Record<string, unknown> = z.strictObject(CLOUD_BROWSER_PARAMETERS[name]).parse(args);
  if (name === 'cloud_browser_navigate') parsed.url = BROWSER_HTTP_URL.parse(new URL(String(parsed.url)).href);
  return parsed;
}
