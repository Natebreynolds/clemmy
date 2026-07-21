/**
 * extract_structured tool (2026-07-21) — schema-guided extraction
 * (capability audit missing-primitive #3, the last big one: CRM data entry,
 * form fill, template-variable population were the model free-forming JSON
 * from prose with no target schema and no validation).
 *
 * Shape: TARGET schema (inline JSON Schema, or the cached Composio action
 * schema via tool_slug — the exact args the create/update call will need) +
 * SOURCE text (inline / file with markitdown auto-convert / a prior call's
 * parked full output) → one boundary-judge model call (the same fast-model
 * routing every gate uses; extraction is not self-grading, so family rules
 * don't apply) → DETERMINISTIC validation: parse-repair, required-field
 * presence, no-invention instruction — with ONE corrective retry carrying
 * the exact validation failure. Oversized sources are pre-filtered through
 * the file-query retrieval core using the schema's own field names as the
 * query, so a 200-page document extracts from its relevant passages.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Agent, Runner } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getToolOutput } from '../runtime/harness/eventlog.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { resolveBoundaryJudge } from '../runtime/harness/debate-model.js';
import { repairToParseableJson } from '../runtime/harness/json-repair.js';
import { convertToMarkdown, isConvertibleExtension } from '../runtime/markitdown.js';
import { getCachedToolSchema } from './composio-schema-cache.js';
import { validateArgsAgainstSchema } from './composio-batch-validator.js';
import { chunkText, scoreChunks } from './file-query-core.js';
import { textResult } from './shared.js';

const MAX_SOURCE_CHARS = 24_000;
const MODEL_TIMEOUT_MS = 45_000;

interface SchemaShape {
  properties?: Record<string, { description?: unknown; type?: unknown }>;
  required?: unknown;
}

function schemaFieldSummary(schema: SchemaShape): string {
  const properties = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties)
    .slice(0, 60)
    .map(([name, def]) => {
      const type = typeof def?.type === 'string' ? def.type : 'any';
      const desc = typeof def?.description === 'string' ? ` — ${def.description.slice(0, 140)}` : '';
      return `- ${name} (${type}${required.has(name) ? ', REQUIRED' : ''})${desc}`;
    })
    .join('\n');
}

/** Oversized source → the passages most relevant to the schema's fields. */
export function focusSource(text: string, schema: SchemaShape): string {
  if (text.length <= MAX_SOURCE_CHARS) return text;
  const fieldQuery = Object.entries(schema.properties ?? {})
    .map(([name, def]) => `${name.replace(/_/g, ' ')} ${typeof def?.description === 'string' ? def.description : ''}`)
    .join(' ')
    .slice(0, 2000);
  const chunks = chunkText(text);
  const hits = scoreChunks(chunks, fieldQuery || 'name email date amount', Math.ceil(MAX_SOURCE_CHARS / 1400));
  const chosen = (hits.length > 0 ? hits.sort((a, b) => a.index - b.index) : chunks.slice(0, 10));
  let out = '';
  for (const chunk of chosen) {
    if (out.length + chunk.text.length > MAX_SOURCE_CHARS) break;
    out += `${chunk.heading ? `[${chunk.heading}]\n` : ''}${chunk.text}\n\n`;
  }
  return out || text.slice(0, MAX_SOURCE_CHARS);
}

async function callExtractor(schemaJson: string, fieldSummary: string, source: string, priorFailure?: string): Promise<string> {
  const routing = resolveBoundaryJudge();
  const agent = new Agent({
    name: 'StructuredExtractor',
    instructions: [
      'Extract the requested fields from the SOURCE text into a single JSON object matching the schema.',
      'Reply with ONLY the JSON object — no prose, no fences.',
      'NEVER invent a value: a field the source does not state is omitted (or null). Copy identifiers (emails, ids, amounts, dates) EXACTLY as written.',
      'Dates convert to ISO (YYYY-MM-DD) only when the source is unambiguous; otherwise keep the source text.',
    ].join(' '),
    model: routing.model ?? routing.modelId,
    modelSettings: { reasoning: { effort: 'low' } },
    tools: [],
  });
  const prompt = [
    `Target schema (JSON Schema):\n${schemaJson}`,
    `Fields:\n${fieldSummary}`,
    priorFailure ? `Your previous attempt FAILED validation: ${priorFailure}. Fix exactly that — do not change correctly-extracted fields.` : '',
    `SOURCE:\n${source}`,
  ].filter(Boolean).join('\n\n');
  const runner = new Runner({ workflowName: 'clementine-structured-extractor' });
  const result = await Promise.race([
    runner.run(agent, prompt, { maxTurns: 1 }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`extractor model timed out after ${MODEL_TIMEOUT_MS / 1000}s`)), MODEL_TIMEOUT_MS).unref?.()),
  ]);
  return String((result as { finalOutput?: unknown }).finalOutput ?? '').trim();
}

export type ExtractorCall = typeof callExtractor;

export function registerExtractStructuredTools(server: McpServer, extractorOverride?: ExtractorCall): void {
  server.tool(
    'extract_structured',
    [
      'Extract VALIDATED structured data from unstructured text — the schema-guided bridge from an email/document to a CRM record, form payload, or template variables.',
      'Target shape: pass `schema` (a JSON Schema object string) OR `tool_slug` (uses the cached input schema of that Composio action — search/list the tool first to populate it, then extract EXACTLY the args the create call needs).',
      'Source (exactly one): `text`, `file` (PDF/DOCX auto-convert), or `call_id` (a prior tool call\'s full parked output). Oversized sources are auto-focused to the passages relevant to the schema fields.',
      'The result is deterministically validated (required fields present; parse-repaired) with one corrective retry; missing required fields come back as an explicit list, never silently invented.',
    ].join(' '),
    {
      schema: z.string().optional().describe('JSON Schema object string for the target shape.'),
      tool_slug: z.string().optional().describe('Composio action slug whose cached input schema is the target shape.'),
      text: z.string().optional(),
      file: z.string().optional(),
      call_id: z.string().optional(),
      instructions: z.string().optional().describe('Extra extraction guidance (e.g. "the sender is the client").'),
    },
    async (args) => {
      try {
        // Resolve the target schema.
        let schema: SchemaShape;
        let schemaJson: string;
        if (args.schema?.trim() && args.tool_slug?.trim()) return textResult('ERROR: pass exactly ONE of schema / tool_slug.');
        if (args.schema?.trim()) {
          try { schema = JSON.parse(args.schema) as SchemaShape; } catch { return textResult('ERROR: `schema` must be a valid JSON Schema object string.'); }
          schemaJson = args.schema.trim();
        } else if (args.tool_slug?.trim()) {
          const cached = getCachedToolSchema(args.tool_slug.trim());
          if (!cached) {
            return textResult(`ERROR: no cached schema for "${args.tool_slug}" — run composio_search_tools / composio_list_tools for that action first (that populates the schema cache), then retry.`);
          }
          schema = cached as SchemaShape;
          schemaJson = JSON.stringify(cached);
        } else {
          return textResult('ERROR: provide `schema` (JSON Schema string) or `tool_slug` (cached Composio action).');
        }

        // Resolve the source text.
        const sources = [args.text, args.file, args.call_id].filter((v) => v && v.trim());
        if (sources.length !== 1) return textResult('ERROR: pass exactly ONE source: text / file / call_id.');
        let sourceText: string;
        if (args.text?.trim()) sourceText = args.text;
        else if (args.file?.trim()) {
          const filePath = path.resolve(args.file.trim());
          if (statSync(filePath).size > 50 * 1024 * 1024) return textResult('ERROR: file exceeds the 50MB cap.');
          if (isConvertibleExtension(filePath)) {
            const converted = await convertToMarkdown(filePath);
            if (!converted.ok) return textResult(`ERROR: could not extract text from ${path.basename(filePath)}: ${converted.error}`);
            sourceText = converted.markdown;
          } else sourceText = readFileSync(filePath, 'utf-8');
        } else {
          const sessionId = getToolOutputContext()?.sessionId;
          if (!sessionId) return textResult('ERROR: call_id needs a live session context — pass text or file instead.');
          const stored = getToolOutput(sessionId, args.call_id!.trim());
          if (!stored) return textResult(`ERROR: no stored output for call id "${args.call_id}" in this session.`);
          sourceText = stored.output;
        }
        const focused = focusSource(sourceText, schema);
        const fieldSummary = schemaFieldSummary(schema) + (args.instructions ? `\nGuidance: ${args.instructions.slice(0, 500)}` : '');
        const extractor = extractorOverride ?? callExtractor;

        // Extract → validate → one corrective retry.
        let lastFailure = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          const raw = await extractor(schemaJson, fieldSummary, focused, lastFailure || undefined);
          const repaired = repairToParseableJson(raw);
          let extracted: Record<string, unknown>;
          try {
            const parsed = JSON.parse(repaired.text);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
            extracted = parsed as Record<string, unknown>;
          } catch {
            lastFailure = 'the reply was not a parseable JSON object';
            continue;
          }
          // Drop null/empty-string fields so presence validation is honest.
          const compact = Object.fromEntries(Object.entries(extracted).filter(([, v]) => v !== null && v !== undefined && v !== ''));
          const validation = validateArgsAgainstSchema('extract_structured', compact, schema as Record<string, unknown>);
          if (!validation) {
            return textResult(JSON.stringify({ extracted: compact, validated: true, ...(repaired.repaired ? { note: 'model output needed JSON repair' } : {}) }, null, 1));
          }
          lastFailure = `missing required field(s): ${validation.field}`;
        }
        return textResult(
          `ERROR: extraction could not satisfy the schema after a corrective retry — ${lastFailure}. `
          + 'The source may genuinely not contain those fields: read it (file_query) and either supply the values yourself or ask the user. NEVER invent them.',
        );
      } catch (err) {
        return textResult(`ERROR: extract_structured failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
