import { scheduleUserMcpCapabilityIndex } from './src/runtime/mcp-config.js';
import { capabilityIndexStats, searchCapabilityOperations } from './src/memory/capability-index.js';
scheduleUserMcpCapabilityIndex();
await new Promise((r) => setTimeout(r, 30_000));
console.log('stats:', JSON.stringify(capabilityIndexStats()));
const hits = searchCapabilityOperations('serp keyword ranking', { carrierKind: 'mcp', limit: 4 });
console.log('mcp hits:', hits.map((h) => `${h.identifier}(${h.effectClass}/${h.effectProvenance})`).join(', ') || '(none)');
