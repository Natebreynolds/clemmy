/**
 * produce_document tool (2026-07-21) — render markdown/HTML into a real
 * PDF / DOCX / HTML file, with {{var}} template merge. The impure half of
 * document-produce-core.ts: PDF via headless Chrome --print-to-pdf, DOCX via
 * macOS textutil — both already installed, zero new dependencies. Output
 * lands in the file-pipeline staging dir, so it chains straight into an
 * upload (Drive) or an email attachment param.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BASE_DIR } from '../config.js';
import { textResult } from './shared.js';
import { htmlDocument, mergeTemplate, renderMarkdown } from './document-produce-core.js';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** Exported for tests (injectable). */
export function findChromeBinary(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function documentsDir(): string {
  const dir = path.join(BASE_DIR, 'files', 'documents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? '').trim().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9 _-]+/g, '').trim().slice(0, 80);
  return cleaned || fallback;
}

export interface RenderBackends {
  chromePdf?: (htmlPath: string, pdfPath: string) => { ok: boolean; error?: string };
  textutilDocx?: (htmlPath: string, docxPath: string) => { ok: boolean; error?: string };
}

function defaultChromePdf(htmlPath: string, pdfPath: string): { ok: boolean; error?: string } {
  const chrome = findChromeBinary();
  if (!chrome) return { ok: false, error: 'no Chromium-family browser found (Chrome/Chromium/Brave/Edge) — produce HTML instead, or install Chrome for PDF output.' };
  const run = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--print-to-pdf=${pdfPath}`, '--no-pdf-header-footer', `file://${htmlPath}`,
  ], { timeout: 45_000, encoding: 'utf-8' });
  if (run.error) return { ok: false, error: run.error.message };
  if (!existsSync(pdfPath)) return { ok: false, error: (run.stderr || 'Chrome produced no PDF').slice(0, 400) };
  return { ok: true };
}

function defaultTextutilDocx(htmlPath: string, docxPath: string): { ok: boolean; error?: string } {
  if (process.platform !== 'darwin') return { ok: false, error: 'DOCX conversion uses macOS textutil — produce HTML or PDF on this platform.' };
  const run = spawnSync('/usr/bin/textutil', ['-convert', 'docx', htmlPath, '-output', docxPath], { timeout: 30_000, encoding: 'utf-8' });
  if (run.error) return { ok: false, error: run.error.message };
  if (!existsSync(docxPath)) return { ok: false, error: (run.stderr || 'textutil produced no DOCX').slice(0, 400) };
  return { ok: true };
}

export function registerDocumentProduceTools(server: McpServer, backends: RenderBackends = {}): void {
  server.tool(
    'produce_document',
    [
      'Produce a real document FILE (pdf, docx, or html) from markdown or HTML content — letters, reports, proposals, outlines. Returns the local filePath, which chains directly into uploads (Drive) or email-attachment params via the file pipeline.',
      'Template merge: {{placeholders}} in the content are filled from template_vars (JSON object). Any placeholder WITHOUT a value fails the call by default — a letter must never go out with {{client_name}} still in it (set allow_missing_vars true only for deliberate partial fills).',
      'content_file may point at a staged template file instead of inline content. Markdown supports headings, lists, tables, bold/italic, links, code, quotes.',
    ].join(' '),
    {
      content: z.string().optional().describe('Markdown (default) or HTML content/template.'),
      content_file: z.string().optional().describe('Path to a template/content file (alternative to inline content).'),
      format: z.enum(['pdf', 'docx', 'html']),
      content_type: z.enum(['markdown', 'html']).optional().describe('Default markdown; pass html when the content is already HTML.'),
      template_vars: z.string().optional().describe('JSON object of {{placeholder}} values.'),
      allow_missing_vars: z.boolean().optional(),
      title: z.string().optional(),
      output_name: z.string().optional().describe('Base file name (no extension).'),
    },
    async (args) => {
      try {
        const inline = args.content?.trim();
        const fromFile = args.content_file?.trim();
        if (!inline && !fromFile) return textResult('ERROR: provide `content` (markdown/HTML) or `content_file` (a template file path).');
        if (inline && fromFile) return textResult('ERROR: pass exactly ONE of content / content_file.');
        let raw = inline ?? readFileSync(path.resolve(fromFile!), 'utf-8');

        if (args.template_vars) {
          let vars: unknown;
          try { vars = JSON.parse(args.template_vars); } catch { return textResult('ERROR: template_vars must be a JSON object.'); }
          if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return textResult('ERROR: template_vars must be a JSON object.');
          const merged = mergeTemplate(raw, vars as Record<string, unknown>);
          if (merged.missing.length > 0 && !args.allow_missing_vars) {
            return textResult(
              `ERROR: unfilled template placeholder${merged.missing.length === 1 ? '' : 's'}: ${merged.missing.map((m) => `{{${m}}}`).join(', ')}. `
              + 'Supply values in template_vars (or set allow_missing_vars true ONLY if a partial fill is genuinely intended).',
            );
          }
          raw = merged.content;
        } else {
          // No vars supplied at all — still refuse to ship visible placeholders.
          const merged = mergeTemplate(raw, {});
          if (merged.missing.length > 0 && !args.allow_missing_vars) {
            return textResult(
              `ERROR: the content contains template placeholder${merged.missing.length === 1 ? '' : 's'} (${merged.missing.map((m) => `{{${m}}}`).join(', ')}) but no template_vars were provided.`,
            );
          }
        }

        const body = (args.content_type ?? 'markdown') === 'html' ? raw : renderMarkdown(raw);
        const fullHtml = htmlDocument(body, { title: args.title });
        const base = `${Date.now()}-${safeName(args.output_name, args.format === 'html' ? 'document' : 'document')}`;
        const dir = documentsDir();
        const htmlPath = path.join(dir, `${base}.html`);
        writeFileSync(htmlPath, fullHtml, 'utf-8');

        if (args.format === 'html') {
          return textResult(JSON.stringify({ filePath: htmlPath, format: 'html', note: 'Chain this filePath into an upload or attachment param.' }));
        }
        const outPath = path.join(dir, `${base}.${args.format}`);
        const result = args.format === 'pdf'
          ? (backends.chromePdf ?? defaultChromePdf)(htmlPath, outPath)
          : (backends.textutilDocx ?? defaultTextutilDocx)(htmlPath, outPath);
        if (!result.ok) {
          return textResult(`ERROR: ${args.format.toUpperCase()} conversion failed: ${result.error}. The rendered HTML is at ${htmlPath} — usable as a fallback.`);
        }
        try { rmSync(htmlPath, { force: true }); } catch { /* the artifact is the output file */ }
        return textResult(JSON.stringify({
          filePath: outPath,
          format: args.format,
          note: 'Chain this filePath into an upload (Drive) or an email-attachment param — the file pipeline accepts local paths.',
        }));
      } catch (err) {
        return textResult(`ERROR: produce_document failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
