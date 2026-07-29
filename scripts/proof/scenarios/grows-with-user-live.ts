/**
 * Catalog scenario — grows-with-user-live: "always growing with her users",
 * as a lived loop instead of a slogan.
 *
 * The product's growth contract (identity-md-builder): a stated fact becomes
 * DURABLE when it is actually used — recall auto-credit marks it useful — and
 * durable facts grow the AUTO "Learned about you" section of IDENTITY.md,
 * which feeds later turns' instructions. The user-owned curated half above
 * the marker is never touched by growth.
 *
 * So the loop this proves, end to end on a live brain:
 *   state facts → a FRESH session recalls them (use = durability) →
 *   the durable identity artifact grows on disk → the curated half survives.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { narrationCheck, stormCheck } from '../score.js';
import type { Check, DaemonHandle, ScenarioDef } from '../types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from '../timeouts.js';

const COMPANY = 'Harborline Coffee Systems';
const FORMAT_TOKEN = 'exactly three bullets';

export const growsWithUserLive: ScenarioDef = {
  name: 'grows-with-user-live',
  summary: 'stated facts → used in a fresh session → durable identity artifact grows, curated half untouched',
  async run(daemon: DaemonHandle) {
    const identityPath = path.join(daemon.home, 'vault', '00-System', 'IDENTITY.md');
    const before = existsSync(identityPath) ? readFileSync(identityPath, 'utf-8') : '';
    const markerIdx = before.indexOf('<!--');
    const curatedBefore = markerIdx >= 0 ? before.slice(0, markerIdx) : before;

    // 1. The user tells Clementine who they are and how they work.
    const tell = await daemon.chat(
      `Remember this about me: I run sales at ${COMPANY}, and I want my morning updates formatted as ${FORMAT_TOKEN}.`,
      `proof-grow-a-${Date.now().toString(36)}`,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );

    // 2. A FRESH session uses those facts — use is what makes them durable.
    const recall = await daemon.chat(
      'Quick check: where do I run sales, and how do I want my morning updates formatted?',
      `proof-grow-b-${Date.now().toString(36)}`,
      PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
    );

    // 3. Regenerate the identity artifact on demand (same route the console
    //    uses); growth must now be durable on disk.
    const regen = await daemon.request('POST', '/api/console/memory/identity/regenerate');
    const after = existsSync(identityPath) ? readFileSync(identityPath, 'utf-8') : '';
    const markerIdxAfter = after.indexOf('<!--');
    const curatedAfter = markerIdxAfter >= 0 ? after.slice(0, markerIdxAfter) : after;
    const autoAfter = markerIdxAfter >= 0 ? after.slice(markerIdxAfter) : '';

    const checks: Check[] = [];
    checks.push(stormCheck(daemon.log()));
    checks.push({ name: 'facts stated (HTTP 200)', pass: tell.httpStatus === 200, detail: `status ${tell.httpStatus}` });
    checks.push(narrationCheck(recall.text));
    checks.push({
      name: 'a fresh session recalls where the user works',
      pass: recall.text.includes(COMPANY) || recall.text.toLowerCase().includes('harborline'),
      detail: recall.text.slice(0, 200),
    });
    checks.push({
      name: 'a fresh session recalls how the user wants updates',
      pass: /three bullets?/i.test(recall.text),
      detail: recall.text.slice(0, 200),
    });
    checks.push({
      name: 'identity regeneration succeeded',
      pass: regen.status === 200,
      detail: `status ${regen.status}; ${JSON.stringify(regen.json).slice(0, 120)}`,
    });
    checks.push({
      name: 'the durable identity artifact grew from the interaction',
      pass: /harborline/i.test(autoAfter),
      detail: autoAfter ? autoAfter.slice(0, 240) : 'no AUTO section content',
    });
    // Whitespace-insensitive on the boundary: on the FIRST regeneration the
    // marker is inserted into a file that had none, and the composer's
    // newline joining around it is formatting, not content. The invariant is
    // "curated CONTENT preserved verbatim" — live forensics confirmed the
    // composer honors it while a byte-compare false-failed on the trailing
    // newline delta (both brains, identically).
    const curatedPreserved = curatedAfter.trimEnd() === curatedBefore.trimEnd();
    checks.push({
      name: 'growth never touches the user-owned curated half',
      pass: curatedPreserved,
      detail: curatedPreserved ? 'curated content preserved verbatim' : 'CURATED CONTENT CHANGED',
    });

    return {
      checks,
      latency: [
        { wallMs: tell.wallMs, ttftMs: null },
        { wallMs: recall.wallMs, ttftMs: null },
      ],
      sessionId: recall.sessionId,
      metrics: { turns: 2, identityGrewBytes: Math.max(0, after.length - before.length) },
    };
  },
};
