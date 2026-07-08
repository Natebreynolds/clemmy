import { deriveCatalogNames } from './tool-registry.js';

/**
 * The CLI / workflow-architect allowlist of built-in tool names.
 *
 * DERIVED from the single tool registry (TOOL-REGISTRY-PLAN-2026-07-07.md, step 2):
 * the hand-maintained array was deleted; membership now comes from
 * `deriveCatalogNames()` (every registry tool whose lanes include 'cli'). This is
 * the ONE place the CLI surface is declared — add a tool once in tool-registry.ts.
 *
 * Frozen at module load. tool-registry.ts imports nothing (a leaf), so this can't
 * form an import cycle. Order is the registry's deterministic declaration order
 * (alphabetical); every consumer treats this as a membership set (or re-sorts), so
 * order is not a behavioral contract — a conformance test still pins the SET.
 */
export const LOCAL_MCP_TOOL_NAMES: readonly string[] = Object.freeze([...deriveCatalogNames()]);
