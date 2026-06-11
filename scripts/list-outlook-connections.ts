import { listConnectedToolkits, executeComposioTool } from '../src/integrations/composio/client.js';

const connections = await listConnectedToolkits();
const outlook = connections.filter((c) => c.slug.toLowerCase() === 'outlook');
console.log(`outlook connections: ${outlook.length}`);
for (const conn of outlook) {
  let mailbox = '?';
  try {
    const profile = await executeComposioTool('OUTLOOK_GET_PROFILE', { user_id: 'me' }, conn.connectionId);
    const data = (profile as { data?: { mail?: string; userPrincipalName?: string } }).data;
    mailbox = data?.mail ?? data?.userPrincipalName ?? JSON.stringify(data).slice(0, 120);
  } catch (err) {
    mailbox = `profile failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(`- ${conn.connectionId}  →  ${mailbox}`);
}
