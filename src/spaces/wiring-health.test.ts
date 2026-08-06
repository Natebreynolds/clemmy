import test from 'node:test';
import assert from 'node:assert/strict';
import { appendWiringHealthBanner, spaceWiringHealth, wiringHealthBannerSnippet } from './wiring-health.js';

test('a runner action with no data source attached is a finding — the live refresh-theater incident', () => {
  // REGRESSION PIN (2026-08-06): "Refresh from Salesforce" executed for real
  // (approval → runner → exit 0 → "ran ✓") and the output went nowhere —
  // dataSources was empty, so the view stayed a static snapshot while the
  // button reported success. The surface must say so where the user looks.
  const findings = spaceWiringHealth({
    title: "Team Performance Improvement — Nate's Team",
    dataSources: [],
    actions: [{ id: 'refresh_sf', label: 'Refresh from Salesforce', runner: 'refresh.mjs' } as never],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'refresh_without_data_source');
  assert.match(findings[0].summary, /static snapshot/);
  assert.match(findings[0].summary, /Refresh from Salesforce/);
  assert.match(findings[0].askClem, /attach its refresh runner as a live data source/);
  assert.deepEqual(findings[0].actionIds, ['refresh_sf']);
});

test('healthy wirings produce no findings — advisories never nag', () => {
  // A space with a real data source (the james-english-pipeline pattern).
  assert.deepEqual(spaceWiringHealth({
    title: 'Pipeline',
    dataSources: [{ id: 'transcripts' } as never],
    actions: [{ id: 'refresh', runner: 'r.mjs' } as never],
  }), []);
  // No runner actions → nothing promises data, nothing to warn about.
  assert.deepEqual(spaceWiringHealth({
    title: 'Static brief',
    dataSources: [],
    actions: [{ id: 'send_email', composioSlug: 'GMAIL_SEND' } as never],
  }), []);
  assert.deepEqual(spaceWiringHealth({ title: 'Empty', dataSources: [], actions: [] }), []);
});

test('banner injects before </body>, escapes HTML, and disappears with no findings', () => {
  const findings = spaceWiringHealth({
    title: '<b>Sneaky</b> & Co',
    dataSources: [],
    actions: [{ id: 'r', label: '<script>x</script>', runner: 'r.mjs' } as never],
  });
  const html = '<html><head></head><body><h1>view</h1></body></html>';
  const out = appendWiringHealthBanner(html, findings);
  assert.ok(out.indexOf('clem-wiring-health') < out.indexOf('</body>'), 'banner sits inside body');
  assert.ok(out.indexOf('<h1>view</h1>') < out.indexOf('clem-wiring-health'), 'banner is appended after authored content');
  assert.doesNotMatch(out, /<script>x<\/script>/, 'authored labels are escaped, never executable');
  assert.equal(appendWiringHealthBanner(html, []), html, 'no findings → byte-identical view');
  assert.equal(wiringHealthBannerSnippet([]), '');
  // A body-less document still gets the banner (append fallback).
  assert.match(appendWiringHealthBanner('<div>bare</div>', findings), /clem-wiring-health/);
});
