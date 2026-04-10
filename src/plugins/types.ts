/**
 * Clementine Plugin API
 *
 * A plugin is a plain JS/TS module that exports a `ClementinePlugin` object
 * (or a default export containing one). Drop it in ~/.clementine-next/plugins/<name>/index.js
 * and it will be auto-loaded into the MCP tool server.
 *
 * Example minimal plugin:
 *
 *   export default {
 *     name: 'my-tools',
 *     version: '1.0.0',
 *     tools: [{
 *       name: 'fetch_weather',
 *       description: 'Get current weather for a city.',
 *       inputSchema: {
 *         type: 'object',
 *         properties: { city: { type: 'string' } },
 *         required: ['city'],
 *       },
 *       handler: async ({ city }) => ({
 *         content: [{ type: 'text', text: `Weather in ${city}: sunny and 72°F` }]
 *       }),
 *     }],
 *   };
 */

export interface PluginToolResult {
  content: Array<{ type: 'text'; text: string }>;
  [key: string]: unknown;
}

export type PluginToolHandler = (
  input: Record<string, unknown>
) => Promise<PluginToolResult>;

export interface PluginTool {
  /** Unique tool name — becomes the MCP tool name */
  name: string;
  /** One-line description shown to the model */
  description: string;
  /**
   * JSON Schema for the tool's input object.
   * Keep it simple: { type: 'object', properties: {...}, required: [...] }
   */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Async function that receives validated input and returns a result */
  handler: PluginToolHandler;
}

export interface ClementinePlugin {
  /** Human-readable plugin name */
  name: string;
  version?: string;
  description?: string;
  /** MCP tools this plugin contributes */
  tools?: PluginTool[];
  /** Optional async hook called when the plugin is first loaded */
  onLoad?: () => Promise<void>;
}
