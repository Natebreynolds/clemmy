#!/usr/bin/env node
// Manual smoke: end-to-end markitdown conversion through the vendored uv
// runtime. NOT run in CI (it downloads markitdown + a managed Python on the
// first run and needs network). Run on a real machine before releasing:
//
//   npm run build && npm run smoke:markitdown
//
// Generates a tiny PDF, converts it, and asserts the text round-trips.
// Validates the macOS Gatekeeper/TCC path on the vendored uv binary too —
// if uv were quarantined or blocked, the spawn would fail here.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertToMarkdown, resolveUv } from '../dist/runtime/markitdown.js';

const MARKER = 'Clementine markitdown smoke OK';

// Minimal one-page PDF containing MARKER as visible text. The content
// stream's /Length must match its byte length exactly or pdfminer fails to
// parse the text operator and yields empty output.
function tinyPdf(text) {
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET\n`;
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) {
    offsets.push(body.length);
    body += o;
  }
  const xrefPos = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

async function main() {
  const uv = resolveUv();
  if ('error' in uv) {
    console.error(`✗ uv runtime not available: ${uv.error}`);
    console.error('  Run `npm run vendor:uv` first (or install uv on PATH).');
    process.exit(1);
  }
  console.log(`uv: ${uv.command}`);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-md-smoke-'));
  const pdf = path.join(dir, 'smoke.pdf');
  writeFileSync(pdf, tinyPdf(MARKER));
  console.log(`Converting ${pdf} (first run downloads markitdown + Python — be patient)…`);

  try {
    const result = await convertToMarkdown(pdf, { timeoutMs: 240_000 });
    if (!result.ok) {
      console.error(`✗ conversion failed: ${result.error}`);
      process.exit(1);
    }
    if (!result.markdown.includes(MARKER)) {
      console.error('✗ converted output did not contain the expected marker text:');
      console.error(result.markdown.slice(0, 400));
      process.exit(1);
    }
    console.log('✓ markitdown converted the PDF and the text round-tripped.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`smoke-markitdown error: ${err.message}`);
  process.exit(1);
});
