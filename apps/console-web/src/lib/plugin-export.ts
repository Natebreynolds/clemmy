import { apiGet, apiPost } from './api';

export interface ShareInventory {
  workflows: Array<{ name: string; description: string }>;
  skills: string[];
  mcpServers: string[];
  workspaces: Array<{ slug: string; title: string }>;
}
export interface ShareRequest {
  id: string; name: string; version?: string; description?: string;
  workflows: string[]; skills: string[]; mcpServers: string[]; workspaces: string[];
}
export interface ShareResult {
  fileName: string; bytes: number; downloadPath: string; leftOut: string[];
  contents: { workflows: string[]; skills: string[]; mcpServers: string[]; workspaces: string[] };
}
export const getShareInventory = () => apiGet<ShareInventory>('/api/console/plugins/export/inventory');
export const exportCartridge = (body: ShareRequest) => apiPost<ShareResult>('/api/console/plugins/export', body);

/** A cartridge id from the name the owner typed: reverse-dot, lowercase. */
export function cartridgeIdFor(name: string, publisher = 'me'): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cartridge';
  const owner = publisher.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'me';
  return `${owner}.${slug}`;
}
