/**
 * Slice 2 — approval CONTENT preview. Run:
 *   npx tsx --test src/runtime/approval-summary.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractApprovalContentPreview } from './approval-summary.js';

test('extractApprovalContentPreview: pulls caption + image from a social-post tool call', () => {
  const p = extractApprovalContentPreview('composio_execute_tool', {
    tool_slug: 'INSTAGRAM_CREATE_POST',
    arguments: { caption: 'Coaching tip: rest is part of the work.\n\n#coaching', image_url: 'https://cdn.example.com/post-3.jpg' },
  });
  assert.ok(p);
  assert.match(p!.body!, /Coaching tip/);
  assert.match(p!.body!, /#coaching/);   // line structure preserved
  assert.equal(p!.imageUrl, 'https://cdn.example.com/post-3.jpg');
});

test('extractApprovalContentPreview: works on a flat (non-composio) post + an image array', () => {
  const p = extractApprovalContentPreview('instagram_publish', {
    caption: 'Behind the scenes',
    media_urls: ['not-an-image', 'https://img.example.com/a.png'],
  });
  assert.equal(p!.body, 'Behind the scenes');
  assert.equal(p!.imageUrl, 'https://img.example.com/a.png');
});

test('extractApprovalContentPreview: an email body (no image) still previews', () => {
  const p = extractApprovalContentPreview('outlook_send_email', { to: 'x@y.com', subject: 'Hi', body: 'Longer email body here.' });
  assert.equal(p!.body, 'Longer email body here.');
  assert.equal(p!.imageUrl, undefined);
});

test('extractApprovalContentPreview: a non-content tool (shell) yields no preview', () => {
  assert.equal(extractApprovalContentPreview('run_shell_command', { command: 'ls -la' }), undefined);
  assert.equal(extractApprovalContentPreview('x', null), undefined);
  assert.equal(extractApprovalContentPreview('x', undefined), undefined);
});

test('extractApprovalContentPreview: picks the LONGEST content string (the real body, not a short field)', () => {
  const p = extractApprovalContentPreview('post', {
    text: 'short',
    content: 'This is the actual long-form post content that should win as the body.',
  });
  assert.match(p!.body!, /actual long-form/);
});
