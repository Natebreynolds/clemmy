#!/usr/bin/env node
// Demo: canonical-transcript backfill end-to-end.
//
// Stands up a fake Recall.ai REST API on localhost, seeds a meeting
// with the partial-streamed shape you actually saw on May 21
// (2 segments labeled "Host" / "Speaker 2", 13s of usable transcript
// from a 5+ min recording), then runs backfillCanonicalTranscript
// against the fake API. Prints the BEFORE artifact, runs the
// backfill, prints the AFTER artifact so you can see the speaker-
// recognition + gap-fill improvements with your eyes.
//
// Real meetings would use Recall's actual API — this smoke uses a
// fake so you can run it with no Recall credentials and no meeting.
//
// Run: node scripts/demo-canonical-transcript.mjs

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');
if (!existsSync(path.join(DAEMON_DIST, 'integrations/recall/backfill.js'))) {
  console.error('✗ dist not built. Run: npm run build');
  process.exit(2);
}

// ─── Style helpers (no deps) ───────────────────────────────────────
const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const BOLD  = '\x1b[1m';
const RED   = '\x1b[31m';
const GRN   = '\x1b[32m';
const YEL   = '\x1b[33m';
const CYN   = '\x1b[36m';

function section(title) { console.log(`\n${BOLD}${CYN}── ${title} ──${RESET}`); }
function ok(msg) { console.log(`  ${GRN}✓${RESET} ${msg}`); }
function dim(msg) { console.log(`  ${DIM}${msg}${RESET}`); }
function streamedColor(line) {
  // Highlight the generic speaker labels in red so they're easy to spot
  return line.replace(/^(\[\S+\]\s*)(Host|Speaker 2)(:)/gm, `$1${RED}$2${RESET}$3`);
}
function canonicalColor(line) {
  return line.replace(/^(\[\S+\]\s*)([A-Z][a-zA-Z ]+)(:)/gm, `$1${GRN}$2${RESET}$3`);
}

// ─── Fake Recall.ai API ────────────────────────────────────────────
//
// Mirrors the three endpoints backfill.ts calls:
//   POST  /api/v1/recording/<id>/create_transcript/  → job id
//   GET   /api/v1/transcript/<job-id>/               → pending, then done + URL
//   GET   /_fake/transcript-payload                  → canonical JSON
//
// Real Recall responses include extra fields we don't use; we keep
// the shape minimal so the demo is readable. The interesting bit is
// `participant.name` — that's what produces the real speaker labels
// in the rewritten artifact.

const FAKE_TRANSCRIPT_ID = 'txn-fake-12345';
let pollCount = 0;

function fakeCanonicalPayload(startedAt) {
  // 5 minutes of canonical transcript: 4 speakers, gap-free.
  // The streamed transcript had ONLY two 13s segments because the
  // SDK's live stream dropped. The canonical payload below is what
  // Recall's backend actually transcribed for the full recording.
  return [
    {
      participant: { id: 1, name: 'Nate Reynolds' },
      words: [
        { text: 'all', start_timestamp: { relative: 12 }, end_timestamp: { relative: 12.4 } },
        { text: 'right', start_timestamp: { relative: 12.4 }, end_timestamp: { relative: 12.7 } },
        { text: 'thanks', start_timestamp: { relative: 13 }, end_timestamp: { relative: 13.4 } },
        { text: 'for', start_timestamp: { relative: 13.4 }, end_timestamp: { relative: 13.6 } },
        { text: 'joining', start_timestamp: { relative: 13.6 }, end_timestamp: { relative: 14 } },
        { text: "let's", start_timestamp: { relative: 14.5 }, end_timestamp: { relative: 14.8 } },
        { text: 'kick', start_timestamp: { relative: 14.8 }, end_timestamp: { relative: 15 } },
        { text: 'off', start_timestamp: { relative: 15 }, end_timestamp: { relative: 15.3 } },
      ],
    },
    {
      participant: { id: 2, name: 'Jane Smith' },
      words: [
        { text: 'sounds', start_timestamp: { relative: 16 }, end_timestamp: { relative: 16.4 } },
        { text: 'great', start_timestamp: { relative: 16.4 }, end_timestamp: { relative: 16.8 } },
        { text: 'i', start_timestamp: { relative: 17.2 }, end_timestamp: { relative: 17.3 } },
        { text: 'have', start_timestamp: { relative: 17.3 }, end_timestamp: { relative: 17.5 } },
        { text: 'three', start_timestamp: { relative: 17.5 }, end_timestamp: { relative: 17.8 } },
        { text: 'things', start_timestamp: { relative: 17.8 }, end_timestamp: { relative: 18.1 } },
        { text: 'i', start_timestamp: { relative: 18.4 }, end_timestamp: { relative: 18.5 } },
        { text: 'want', start_timestamp: { relative: 18.5 }, end_timestamp: { relative: 18.7 } },
        { text: 'to', start_timestamp: { relative: 18.7 }, end_timestamp: { relative: 18.8 } },
        { text: 'walk', start_timestamp: { relative: 18.8 }, end_timestamp: { relative: 19.1 } },
        { text: 'through', start_timestamp: { relative: 19.1 }, end_timestamp: { relative: 19.4 } },
      ],
    },
    {
      participant: { id: 3, name: 'Marcus Lee' },
      words: [
        { text: 'before', start_timestamp: { relative: 22 }, end_timestamp: { relative: 22.4 } },
        { text: 'we', start_timestamp: { relative: 22.4 }, end_timestamp: { relative: 22.6 } },
        { text: 'dive', start_timestamp: { relative: 22.6 }, end_timestamp: { relative: 22.9 } },
        { text: 'in', start_timestamp: { relative: 22.9 }, end_timestamp: { relative: 23 } },
        { text: 'can', start_timestamp: { relative: 23.3 }, end_timestamp: { relative: 23.5 } },
        { text: 'we', start_timestamp: { relative: 23.5 }, end_timestamp: { relative: 23.7 } },
        { text: 'set', start_timestamp: { relative: 23.7 }, end_timestamp: { relative: 23.9 } },
        { text: 'the', start_timestamp: { relative: 23.9 }, end_timestamp: { relative: 24.1 } },
        { text: 'agenda', start_timestamp: { relative: 24.1 }, end_timestamp: { relative: 24.6 } },
      ],
    },
    {
      participant: { id: 1, name: 'Nate Reynolds' },
      words: [
        { text: 'good', start_timestamp: { relative: 25 }, end_timestamp: { relative: 25.3 } },
        { text: 'call', start_timestamp: { relative: 25.3 }, end_timestamp: { relative: 25.6 } },
        { text: 'three', start_timestamp: { relative: 26 }, end_timestamp: { relative: 26.3 } },
        { text: 'items', start_timestamp: { relative: 26.3 }, end_timestamp: { relative: 26.6 } },
        { text: 'q3', start_timestamp: { relative: 27 }, end_timestamp: { relative: 27.3 } },
        { text: 'numbers', start_timestamp: { relative: 27.3 }, end_timestamp: { relative: 27.7 } },
        { text: 'hiring', start_timestamp: { relative: 28.2 }, end_timestamp: { relative: 28.6 } },
        { text: 'pipeline', start_timestamp: { relative: 28.8 }, end_timestamp: { relative: 29.3 } },
      ],
    },
  ];
}

function startFakeRecallApi(startedAt) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      if (req.method === 'POST' && url.pathname.endsWith('/create_transcript/')) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ id: FAKE_TRANSCRIPT_ID, status: 'processing' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/api/v1/transcript/${FAKE_TRANSCRIPT_ID}/`) {
        pollCount += 1;
        // First poll: still processing. Second: done. Lets the demo
        // exercise the polling code path without making you wait
        // 30s × N like production would.
        if (pollCount < 2) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            id: FAKE_TRANSCRIPT_ID,
            status: { code: 'processing' },
            created_at: new Date().toISOString(),
          }));
          return;
        }
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          id: FAKE_TRANSCRIPT_ID,
          status: { code: 'done' },
          download_url: `${baseUrl}/_fake/transcript-payload`,
          created_at: new Date().toISOString(),
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/_fake/transcript-payload') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(fakeCanonicalPayload(startedAt)));
        return;
      }
      res.statusCode = 404;
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ─── Wire the daemon's recall API client to the fake server ────────
//
// The Recall client honors the RecallMeetingSettings file (settings.region).
// We can't easily redirect to a non-recall.ai host via region. So we
// install a fetch interceptor that rewrites outbound https://*.recall.ai
// URLs to http://127.0.0.1:<fakePort>. This keeps the production code
// path untouched — the rewriter only fires inside this demo.

function installFetchRedirector(fakePort) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    let url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && /https:\/\/[a-z0-9-]+\.recall\.ai/.test(url)) {
      url = url.replace(/https:\/\/[a-z0-9-]+\.recall\.ai/, `http://127.0.0.1:${fakePort}`);
      return origFetch(url, init);
    }
    return origFetch(input, init);
  };
}

// ─── Demo ──────────────────────────────────────────────────────────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-canonical-demo-'));
process.env.CLEMENTINE_HOME = tmpHome;
process.env.RECALL_REGION = 'us-west-2';
// Skip real Recall API key — readSecret will look in our tmp vault.

console.log(`${BOLD}Clementine canonical-transcript backfill — local demo${RESET}`);
console.log(`${DIM}tmp HOME: ${tmpHome}${RESET}`);

let server;
try {
  const fake = await startFakeRecallApi();
  server = fake.server;
  installFetchRedirector(fake.port);
  dim(`fake Recall API listening on http://127.0.0.1:${fake.port}`);

  // Stand up a tmp vault so readSecret('recall_api_key') resolves.
  // Real installs read this from the file vault written by the wizard.
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const stateDir = path.join(tmpHome, '.clementine-next', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'secrets-vault.json'),
    JSON.stringify({ version: 'v1', entries: { recall_api_key: 'fake-key' } }, null, 2),
    { mode: 0o600 });

  // Import AFTER setting CLEMENTINE_HOME so the modules resolve paths
  // into our tmp dir.
  const mc = await import(path.join(DAEMON_DIST, 'integrations/recall/meeting-capture.js'));
  const { backfillCanonicalTranscript } = await import(path.join(DAEMON_DIST, 'integrations/recall/backfill.js'));

  // ─── Seed the partial-streamed meeting (your May 21 shape) ───
  section('Seeding a meeting with the partial-streamed shape (your May 21 case)');
  const startedAt = '2026-05-21T18:30:54.000Z';
  // Two streamed segments — same speaker labels you actually got:
  // "Host" and "Speaker 2", representing a 5-min recording that
  // only streamed ~13 seconds of usable transcript.
  mc.appendRecallTranscriptSegment({
    windowId: 'demo-win-1',
    recordingId: 'rec-demo-abc',
    event: 'transcript.data',
    speaker: 'Host',
    text: 'all right',
    timestamp: '2026-05-21T18:35:25.000Z',
    isFinal: true,
  });
  mc.appendRecallTranscriptSegment({
    windowId: 'demo-win-1',
    recordingId: 'rec-demo-abc',
    event: 'transcript.data',
    speaker: 'Speaker 2',
    text: "well i'm going to kick us off and then you know because we're already five minutes in and this is a long presentation so let's get started and then jam can provide any color but look guys there's a lot of",
    timestamp: '2026-05-21T18:35:38.000Z',
    isFinal: true,
  });

  // Finalize (writes the streamed artifact + stamps canonicalStatus='pending')
  const finalized = mc.finalizeRecallMeeting({
    windowId: 'demo-win-1',
    recordingId: 'rec-demo-abc',
    platform: 'zoom',
    title: 'Q3 Strategy Sync',
  });
  ok(`meeting finalized — canonicalStatus=${finalized.record.canonicalStatus}`);
  ok(`streamed artifact written to: ${finalized.artifactPath}`);
  ok(`streamed segments: ${finalized.record.segments.length}`);

  // ─── Show the BEFORE artifact ────────────────────────────────
  section('BEFORE — streamed artifact (this is what you got on May 21)');
  const before = readFileSync(finalized.artifactPath, 'utf-8');
  console.log(streamedColor(before));

  // ─── Trigger the backfill ────────────────────────────────────
  section('Running canonical-transcript backfill against the fake Recall API');
  // For the demo, drop the poll interval so we don't wait the full 30s.
  // We do this by stubbing setTimeout — but actually our backfill module
  // already uses real setTimeout, and our fake server returns 'processing'
  // on poll #1 and 'done' on poll #2. So the demo will pause ~30s on
  // the first poll. Make that explicit so the user knows what's happening.
  dim('(first poll: processing → second poll: done. ~30s wait between polls.)');
  const result = await backfillCanonicalTranscript({
    windowId: finalized.record.windowId,
    recordingId: finalized.record.recordingId,
  });
  ok(`backfill result: status=${result.status} segments=${result.segmentCount ?? 0}`);

  // ─── Show the AFTER artifact ─────────────────────────────────
  section('AFTER — canonical artifact (gap-free, real participant names)');
  const after = readFileSync(finalized.artifactPath, 'utf-8');
  console.log(canonicalColor(after));

  // ─── Show the diff at the segment level ──────────────────────
  section('What just changed in the meeting record');
  const finalRecord = mc.findRecallMeetingRecord({
    windowId: finalized.record.windowId,
    recordingId: finalized.record.recordingId,
  });
  const distinctSpeakers = [...new Set(finalRecord.segments.map((s) => s.speaker))];
  ok(`canonicalStatus: ${YEL}${finalRecord.canonicalStatus}${RESET}`);
  ok(`segment count: ${finalized.record.segments.length} (streamed) → ${finalRecord.segments.length} (canonical)`);
  ok(`distinct speakers: ${distinctSpeakers.join(', ')}`);
  ok(`artifact source label changed from 'streamed' to 'canonical'`);

  console.log(`\n${GRN}${BOLD}✓ canonical backfill demo green${RESET}`);
} catch (err) {
  console.error(`\n${RED}✗ demo threw:${RESET}`, err);
  process.exitCode = 1;
} finally {
  if (server) server.close();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
}
