/**
 * Run: npx tsx --test src/runtime/harness/destination-gate.test.ts
 *
 * The destination gate flags an irreversible publish (deploy/publish/
 * release/promote/ship or --prod) whose target is AMBIENT — not named in
 * the command — so it can't silently clobber an unrelated linked site.
 * Born from the 2026-06-13 wrong-site incident (`netlify deploy --prod`
 * followed a stale `.netlify` link to a different live site).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyShellCommand,
  evaluateShellDestination,
  destinationCardSuffix,
  isDestinationGateEnabled,
  wasDestinationNudged,
  markDestinationNudged,
  ImplicitDestinationError,
  classifyShellNetworkMutation,
  evaluateDestinationProvenance,
  extractExplicitPublishTargets,
  destinationIdentityForms,
  UnverifiedDestinationError,
  _resetDestinationStateForTests,
} from './destination-gate.js';

test('the INCIDENT command flags + HARD-blocks: netlify deploy --prod (no explicit site)', () => {
  const r = evaluateShellDestination('netlify deploy --dir "/x/site" --prod --json --message "Deploy"');
  assert.equal(r.action, 'flag');
  assert.equal(r.verb, 'deploy');
  assert.equal(r.shapeKey, 'netlify:deploy');
  assert.equal(r.hardBlock, true, 'a --prod ambient publish is a HARD block (every attempt, not one-shot)');
});

test('hardBlock distinguishes PROD from non-prod ambient publishes (Test-5 fix)', () => {
  // PROD ambient → hard block (a retry must not clobber the linked site).
  assert.equal(evaluateShellDestination('netlify deploy --prod').hardBlock, true);
  assert.equal(evaluateShellDestination('vercel --production').hardBlock, true);
  // A non-prod (draft) ambient publish → soft one-shot nudge.
  const draft = evaluateShellDestination('netlify deploy --dir ./site');
  assert.equal(draft.action, 'flag');
  assert.notEqual(draft.hardBlock, true, 'a draft ambient publish stays a one-shot nudge');
  // --create-site is NOT treated as an explicit destination (netlify ignores it
  // when the cwd is already linked — exactly what clobbered aldous in Test 5).
  assert.equal(evaluateShellDestination('netlify deploy --prod --create-site meridian').hardBlock, true);
  // Hardening (review 2026-06-14): a QUOTED --prod must still hard-block (the
  // verb-scan is quote-stripped, so this used to downgrade to a draft).
  assert.equal(evaluateShellDestination('netlify deploy "--prod" --dir ./site').hardBlock, true);
  // …but --prod inside an unrelated quoted string on a NON-publish command does
  // not trip the gate (no publish verb → not flagged).
  assert.equal(evaluateShellDestination('git commit -m "ship the --prod build"').action, 'allow');
});

test('an EXPLICIT --site makes it allow (the recovery the model eventually did)', () => {
  const r = evaluateShellDestination('netlify deploy --dir "/x/site" --prod --site 6c97fed4-6043-4841 --json');
  assert.equal(r.action, 'allow');
});

test('--prod with no project flags even without a verb (vercel --prod)', () => {
  const r = evaluateShellDestination('vercel --prod');
  assert.equal(r.action, 'flag');
  assert.equal(r.verb, '--prod');
});

test('vercel deploy --scope <team> is explicit → allow', () => {
  assert.equal(evaluateShellDestination('vercel deploy --prod --scope my-team').action, 'allow');
});

test('npm publish (ambient registry) flags; with --registry URL it allows', () => {
  assert.equal(evaluateShellDestination('npm publish').action, 'flag');
  assert.equal(evaluateShellDestination('npm publish --registry https://r.example.com').action, 'allow');
});

test('gcloud app deploy (verb is the 3rd token) still flags', () => {
  const r = evaluateShellDestination('gcloud app deploy');
  assert.equal(r.action, 'flag');
  assert.equal(r.verb, 'deploy');
  assert.equal(r.shapeKey, 'gcloud:deploy');
});

test('compound command: cd x && netlify deploy --prod flags on the publish segment', () => {
  const r = evaluateShellDestination('cd /tmp/site && netlify deploy --prod');
  assert.equal(r.action, 'flag');
  assert.equal(r.shapeKey, 'netlify:deploy');
});

test('multiline npx netlify-cli deploy is read as the Netlify publish command', () => {
  const command = [
    'set -e',
    'cd /tmp/site',
    'npx netlify-cli deploy --dir . --prod --json',
  ].join('\n');
  const r = evaluateShellDestination(command);
  assert.equal(r.action, 'flag');
  assert.equal(r.verb, 'deploy');
  assert.equal(r.shapeKey, 'netlify:deploy');
  assert.equal(r.hardBlock, true);
});

// ---- false-positive guards (precision matters: this nudges on every shell publish) ----

test('NO false positive: a verb inside a quoted commit message', () => {
  assert.equal(evaluateShellDestination('git commit -m "deploy the new release"').action, 'allow');
});

test('NO false positive: echo with a quoted publish word', () => {
  assert.equal(evaluateShellDestination('echo "ready to publish"').action, 'allow');
});

test('NO false positive: git push (push is not a tracked publish verb)', () => {
  assert.equal(evaluateShellDestination('git push origin main').action, 'allow');
});

test('NO false positive: a plain read command', () => {
  assert.equal(evaluateShellDestination('ls -la /tmp/site').action, 'allow');
  assert.equal(evaluateShellDestination('netlify status --json').action, 'allow');
});

test('a publish verb only after a FLAG does not count (not a sub-command)', () => {
  // "deploy" appears, but after a flag — not the leading sub-command run.
  assert.equal(classifyShellCommand('mytool --note deploy').isPublish, false);
});

test('classify: an explicit https remote URI pins the destination', () => {
  assert.equal(evaluateShellDestination('wrangler publish https://my.workers.dev/app').action, 'allow');
});

test('destinationCardSuffix: present only for an ambient publish', () => {
  assert.match(destinationCardSuffix('netlify deploy --prod'), /implicit target/);
  assert.equal(destinationCardSuffix('netlify deploy --prod --site abc'), '');
  assert.equal(destinationCardSuffix('ls -la'), '');
});

test('the gate is enabled by default', () => {
  assert.equal(isDestinationGateEnabled(), true);
});

test('one-shot ledger: nudged once per (session, shape), then remembered', () => {
  _resetDestinationStateForTests();
  const sid = 'sess-x';
  assert.equal(wasDestinationNudged(sid, 'netlify:deploy'), false);
  markDestinationNudged(sid, 'netlify:deploy');
  assert.equal(wasDestinationNudged(sid, 'netlify:deploy'), true);
  // distinct shape / session is independent
  assert.equal(wasDestinationNudged(sid, 'npm:publish'), false);
  assert.equal(wasDestinationNudged('sess-y', 'netlify:deploy'), false);
});

// ---- shell NETWORK-MUTATION classifier (audit #2) ----

test('classifyShellNetworkMutation: catches the clear send shapes', () => {
  const sends = [
    'curl -X POST https://api.x.com/send -d \'{"to":"a@b.com"}\'',
    'curl --json \'{"to":"a@b.com"}\' https://api.x.com/send',
    'curl -F file=@x.json https://api.x.com/upload',
    'gh api --method POST /repos/o/r/dispatches',
    'gh api -X DELETE /repos/o/r/issues/1',
    'gh pr create --title x --body y',
    'gh release create v1 ./dist',
    'sf data update --sobject Account --record-id 001 --values "Name=X"',
    'sendmail a@b.com < msg.txt',
    'echo body | mail -s subj a@b.com',
    'aws s3 cp ./out.html s3://my-bucket/index.html',
    'twilio api:core:messages:create --to +15555550100 --body hi',
    'scp ./secret.txt user@host:/tmp/',
  ];
  for (const cmd of sends) {
    assert.equal(classifyShellNetworkMutation(cmd).isNetworkMutation, true, `should flag: ${cmd}`);
  }
  // shape key is per-binary (stable for the duplicate ledger)
  assert.equal(classifyShellNetworkMutation('curl -X POST https://x -d @b').shapeKey, 'shell:curl');
});

test('classifyShellNetworkMutation: NO false positives on reads / benign commands', () => {
  const benign = [
    'curl https://api.x.com/status',          // GET = read, no method/body
    'curl -s https://example.com',            // plain fetch
    'gh pr list',                             // read
    'gh api /repos/o/r',                      // GET
    'sf data query --query "SELECT Id FROM Account"', // read
    'ls -la /tmp',
    'git status',
    'echo "deploy the curl post to mail later"', // words inside a quoted string
    'cat notes-about-sendmail.txt',           // sendmail as part of a filename
    'netlify deploy --prod',                  // a publish (different gate), not a network-mutation send
  ];
  for (const cmd of benign) {
    assert.equal(classifyShellNetworkMutation(cmd).isNetworkMutation, false, `should NOT flag: ${cmd}`);
  }
});

test('ImplicitDestinationError carries a recoverable, explicit message', () => {
  const e = new ImplicitDestinationError({ command: 'netlify deploy --prod', verb: 'deploy', shapeKey: 'netlify:deploy' });
  assert.match(e.message, /IMPLICIT_DESTINATION/);
  assert.match(e.message, /--site/);          // tells the model how to make it explicit
  assert.match(e.message, /netlify status/);  // or how to confirm the current link
  assert.match(e.message, /conscious second attempt/i); // one-shot: a retry passes
  assert.equal(e.verb, 'deploy');
});

// ─── Destination PROVENANCE (2026-06-15 clobber: coffee shop onto a law firm) ───

test('extractExplicitPublishTargets pulls --site/--project values, ignores vars', () => {
  assert.deepEqual(extractExplicitPublishTargets('netlify deploy --prod --dir . --site 6c97fed4-abc'), ['6c97fed4-abc']);
  assert.deepEqual(extractExplicitPublishTargets('netlify deploy --site=harbor-coffee'), ['harbor-coffee']);
  assert.deepEqual(extractExplicitPublishTargets('vercel --prod --project my-app'), ['my-app']);
  assert.deepEqual(extractExplicitPublishTargets('netlify deploy --site "$SITE_ID"'), []); // shell var → implicit gate owns it
  assert.deepEqual(extractExplicitPublishTargets('netlify deploy --prod'), []);            // no explicit target
});

test('provenance gate HARD-BLOCKS a deploy to an explicit target never created/named this session (the clobber)', () => {
  // Session created/named only "harbor-coffee-cafe"; the deploy targets an
  // UNRELATED existing site id grabbed from `netlify status` → must refuse.
  const provenance = (t: string) => new Set(['harbor-coffee-cafe']).has(t);
  const v = evaluateDestinationProvenance('cd /x && netlify deploy --prod --dir . --site 6c97fed4-6043-4841-975c-b8f99b2e274c', provenance);
  assert.equal(v.action, 'flag');
  assert.equal(v.hardBlock, true);
  assert.match(v.reason, /no session provenance/i);
});

test('provenance gate reports multiline npx netlify-cli deploys as netlify deploys', () => {
  const v = evaluateDestinationProvenance(
    ['set -e', 'cd /x', 'npx netlify-cli deploy --prod --dir . --site 6c97fed4-6043-4841-975c-b8f99b2e274c'].join('\n'),
    () => false,
  );
  assert.equal(v.action, 'flag');
  assert.equal(v.verb, 'deploy');
  assert.equal(v.shapeKey, 'netlify:deploy:unverified');
});

test('provenance gate ALLOWS a deploy to a site created this session', () => {
  // create produced both the slug and the resolved id; deploy targets the id.
  const provenance = (t: string) => new Set(['harbor-coffee-cafe', 'abc-123-id']).has(t);
  const v = evaluateDestinationProvenance('netlify deploy --prod --dir . --site abc-123-id', provenance);
  assert.equal(v.action, 'allow');
});

test('provenance gate ALLOWS a deploy to a site the user explicitly named', () => {
  const userNamed = (t: string) => 'deploy harbor coffee to my existing site harbor-coffee'.includes(t);
  const v = evaluateDestinationProvenance('netlify deploy --prod --site harbor-coffee', userNamed);
  assert.equal(v.action, 'allow');
});

test('provenance gate DEFERS (allow) when there is no explicit target — implicit gate owns it', () => {
  const v = evaluateDestinationProvenance('netlify deploy --prod', () => false);
  assert.equal(v.action, 'allow');
  assert.match(v.reason, /implicit-destination gate/i);
});

test('provenance gate ignores non-publish commands', () => {
  const v = evaluateDestinationProvenance('netlify sites:list --json', () => false);
  assert.equal(v.action, 'allow');
});

test('UnverifiedDestinationError is recoverable and directs discover-then-retry, not surrender', () => {
  const e = new UnverifiedDestinationError({ command: 'netlify deploy --site x', verb: 'deploy', shapeKey: 'netlify:deploy:unverified', targets: ['6c97fed4'] });
  assert.match(e.message, /UNVERIFIED_DESTINATION/);
  assert.match(e.message, /sites:create/);            // how to make a real dedicated target
  assert.match(e.message, /--account-slug/);          // non-interactively (the root trigger)
  // Self-recovery (2026-06-15): on a create failure it must DISCOVER the right
  // value and retry — only stop AFTER a genuine attempt, never surrender first.
  assert.match(e.message, /DISCOVERABLE/i);
  assert.match(e.message, /listAccountsForUser/);     // names the discovery command
  assert.match(e.message, /only STOP and report the blocker AFTER/i);
  assert.match(e.message, /do not give up before you have actually tried/i);
  assert.equal(e.hardBlock, true);
});

// ─── Defect A: identity-aware provenance (slug vs subdomain vs url), no vendor list ───

test('destinationIdentityForms: a host yields both the full host and its first DNS label', () => {
  assert.deepEqual(destinationIdentityForms('clementine-agent-v2.netlify.app'), ['clementine-agent-v2.netlify.app', 'clementine-agent-v2']);
  // general across providers — no domain list
  assert.deepEqual(destinationIdentityForms('Foo-Bar.vercel.app'), ['foo-bar.vercel.app', 'foo-bar']);
  assert.deepEqual(destinationIdentityForms('https://my-site.pages.dev/'), ['my-site.pages.dev', 'my-site']);
  // a bare slug or UUID has a single form
  assert.deepEqual(destinationIdentityForms('clementine-agent-v2'), ['clementine-agent-v2']);
  assert.deepEqual(destinationIdentityForms('48efadea-de48-42e3-894b-0da7deb3c6f6'), ['48efadea-de48-42e3-894b-0da7deb3c6f6']);
});

test('THE 2026-06-21 RECURRENCE: a site created in-session is provenanced when deployed by its subdomain', () => {
  // Provenance set holds the BARE slug (from `sites:create --name clementine-agent-v2`).
  const created = new Set(['clementine-agent-v2']);
  const hasProvenance = (target: string): boolean =>
    destinationIdentityForms(target).some((f) => created.has(f));
  // Deploying to the FULL subdomain must now resolve to the same resource (was a hard block).
  const cmd = 'cd site && netlify deploy --prod --dir . --site clementine-agent-v2.netlify.app --message "x"';
  const prov = evaluateDestinationProvenance(cmd, hasProvenance);
  assert.equal(prov.action, 'allow', 'a site created this session must be provenanced even via its .netlify.app subdomain');
});

test('cross-project clobber STILL blocked: an unrelated site is not provenanced by a different project', () => {
  const created = new Set(['my-coffee-shop']); // created for the coffee project
  const hasProvenance = (target: string): boolean =>
    destinationIdentityForms(target).some((f) => created.has(f));
  // A deploy to an UNRELATED law-firm site must still be refused (the original incident).
  const cmd = 'netlify deploy --prod --dir . --site revill-law-firm.netlify.app';
  const prov = evaluateDestinationProvenance(cmd, hasProvenance);
  assert.equal(prov.action, 'flag');
  assert.equal(prov.hardBlock, true);
});
