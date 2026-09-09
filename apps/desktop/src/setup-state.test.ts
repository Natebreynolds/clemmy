/**
 * Run: npx tsx --test apps/desktop/src/setup-state.test.ts
 *
 * The first-run wizard used to be seven fixed steps, and the setup-complete
 * marker was the ONLY gate: delete or corrupt that one file and a fully
 * configured install replayed all seven, asking again for an API key it
 * already had. These two functions are the fix — detectExistingConfiguration
 * reads what is on disk, planSetupSteps decides what is left to ask — so this
 * is where that regression gets caught.
 *
 * Everything here runs against a temp HOME. Nothing reads the developer's own
 * ~/.clementine-next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  detectExistingConfiguration,
  initialAuthChoice,
  planSetupSteps,
  type ExistingConfiguration,
} from './setup-state.js';

interface FakeHome {
  dir: string;
  vault(entries: Record<string, string>): void;
  env(body: string): void;
  profile(json: Record<string, unknown>): void;
  codex(json: Record<string, unknown>): void;
}

const homes: string[] = [];

function fakeHome(): FakeHome {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'clem-setup-state-'));
  homes.push(dir);
  const stateDir = path.join(dir, '.clementine-next', 'state');
  mkdirSync(stateDir, { recursive: true });
  return {
    dir,
    vault(entries) {
      writeFileSync(path.join(stateDir, 'secrets-vault.json'), JSON.stringify({ entries }), 'utf-8');
    },
    env(body) {
      writeFileSync(path.join(dir, '.clementine-next', '.env'), body, 'utf-8');
    },
    profile(json) {
      writeFileSync(path.join(stateDir, 'user-profile.json'), JSON.stringify(json), 'utf-8');
    },
    codex(json) {
      mkdirSync(path.join(dir, '.codex'), { recursive: true });
      writeFileSync(path.join(dir, '.codex', 'auth.json'), JSON.stringify(json), 'utf-8');
    },
  };
}

process.on('exit', () => {
  for (const dir of homes) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Detection with a guaranteed-empty env, so a developer's own exported
 *  OPENAI_API_KEY cannot make a test pass or fail. */
function detect(home: FakeHome, env: NodeJS.ProcessEnv = {}) {
  return detectExistingConfiguration({ homeDir: home.dir, env });
}

const nothingConfigured: ExistingConfiguration = {
  auth: 'none',
  embeddingKey: false,
  workspaces: [],
  profile: { preferredName: '', role: '', timezone: '', communicationTone: 'balanced' },
  discord: false,
  composio: false,
};

// ── detection ───────────────────────────────────────────────────────────────

test('an empty home reports nothing configured', () => {
  assert.deepEqual(detect(fakeHome()), nothingConfigured);
});

test('a vault OpenAI key is auth + an embedding key', () => {
  const home = fakeHome();
  home.vault({ openai_api_key: 'sk-live' });
  const found = detect(home);
  assert.equal(found.auth, 'openai');
  assert.equal(found.embeddingKey, true);
});

test('an empty vault entry is not a credential', () => {
  const home = fakeHome();
  home.vault({ openai_api_key: '' });
  assert.equal(detect(home).auth, 'none');
});

test('a Codex login on the machine counts as auth but not as an embedding key', () => {
  const home = fakeHome();
  home.codex({ tokens: { access_token: 'a', refresh_token: 'r' } });
  const found = detect(home);
  assert.equal(found.auth, 'codex');
  assert.equal(found.embeddingKey, false, 'Codex OAuth does not cover embeddings or voice');
});

test('a half-written Codex auth file is not a login', () => {
  const home = fakeHome();
  home.codex({ tokens: { access_token: 'a' } });
  assert.equal(detect(home).auth, 'none');
});

test('an explicit OpenAI key outranks an inherited Codex login', () => {
  const home = fakeHome();
  home.vault({ openai_api_key: 'sk-live' });
  home.codex({ tokens: { access_token: 'a', refresh_token: 'r' } });
  assert.equal(detect(home).auth, 'openai');
});

test('the home .env supplies workspaces, Discord and Composio', () => {
  const home = fakeHome();
  home.env([
    '# a comment line',
    'WORKSPACE_DIRS=/a/one, /a/two ,,/a/three',
    'DISCORD_BOT_TOKEN=tok',
    'COMPOSIO_API_KEY=key',
    '',
  ].join('\n'));
  const found = detect(home);
  assert.deepEqual(found.workspaces, ['/a/one', '/a/two', '/a/three']);
  assert.equal(found.discord, true);
  assert.equal(found.composio, true);
});

test('an empty WORKSPACE_DIRS is no workspaces', () => {
  const home = fakeHome();
  home.env('WORKSPACE_DIRS=\n');
  assert.deepEqual(detect(home).workspaces, []);
});

test('the profile is read back, displayName standing in for preferredName', () => {
  const home = fakeHome();
  home.profile({ displayName: '  Alex  ', timezone: 'Europe/Berlin', communicationTone: 'terse' });
  const found = detect(home);
  assert.equal(found.profile.preferredName, 'Alex');
  assert.equal(found.profile.timezone, 'Europe/Berlin');
  assert.equal(found.profile.communicationTone, 'terse');
});

test('corrupt JSON is treated as absent, never thrown', () => {
  const home = fakeHome();
  writeFileSync(path.join(home.dir, '.clementine-next', 'state', 'user-profile.json'), '{not json', 'utf-8');
  writeFileSync(path.join(home.dir, '.clementine-next', 'state', 'secrets-vault.json'), 'nope', 'utf-8');
  assert.deepEqual(detect(home), nothingConfigured);
});

test('process env is a credential source of last resort', () => {
  const home = fakeHome();
  assert.equal(detect(home, { OPENAI_API_KEY: 'sk-env' }).auth, 'openai');
});

// ── planning ────────────────────────────────────────────────────────────────

test('a brand-new machine answers four questions, not seven', () => {
  assert.deepEqual(planSetupSteps(nothingConfigured), ['welcome', 'auth', 'profile', 'workspace', 'launch']);
});

test('no plan ever contains a channel step', () => {
  const everyShape: ExistingConfiguration[] = [
    nothingConfigured,
    { ...nothingConfigured, auth: 'codex' },
    { ...nothingConfigured, workspaces: ['/w'] },
    { ...nothingConfigured, discord: true, composio: true },
  ];
  for (const shape of everyShape) {
    const plan = planSetupSteps(shape) as string[];
    assert.ok(!plan.includes('discord'), 'Discord is not a first-run step');
    assert.ok(!plan.includes('composio'), 'Composio is not a first-run step');
  }
});

test('an answered question is not asked again', () => {
  assert.deepEqual(
    planSetupSteps({ ...nothingConfigured, auth: 'codex' }),
    ['welcome', 'profile', 'workspace', 'launch'],
  );
  assert.deepEqual(
    planSetupSteps({ ...nothingConfigured, workspaces: ['/Users/a/Projects'] }),
    ['welcome', 'auth', 'profile', 'launch'],
  );
});

test('a name without a timezone still gets asked — half an answer is not one', () => {
  const half = { ...nothingConfigured, profile: { ...nothingConfigured.profile, preferredName: 'Alex' } };
  assert.ok(planSetupSteps(half).includes('profile'));
});

test('the deleted-marker replay is two screens, neither of them a question', () => {
  const fullyConfigured: ExistingConfiguration = {
    auth: 'openai',
    embeddingKey: true,
    workspaces: ['/Users/a/Projects'],
    profile: { preferredName: 'Alex', role: 'VP of sales', timezone: 'America/Denver', communicationTone: 'terse' },
    discord: true,
    composio: true,
  };
  assert.deepEqual(planSetupSteps(fullyConfigured), ['welcome', 'launch']);
});

test('the plan always opens on welcome and ends on launch', () => {
  for (const auth of ['none', 'openai', 'codex'] as const) {
    for (const workspaces of [[], ['/w']]) {
      const plan = planSetupSteps({ ...nothingConfigured, auth, workspaces });
      assert.equal(plan[0], 'welcome');
      assert.equal(plan[plan.length - 1], 'launch');
    }
  }
});

// ─── The answer the wizard submits when it never asks ──────────────────────
//
// planSetupSteps() dropping the auth step is the feature; it is also what made
// the seeded literal dangerous. `authChoice` is what rides in
// clemmy:setup-complete, and main.ts turns it into AUTH_MODE — so a returning
// user's mode is now decided by the same detection that decided not to ask.

test('a returning user submits the credential they actually have', () => {
  assert.equal(initialAuthChoice({ ...nothingConfigured, auth: 'openai' }), 'openai');
  assert.equal(initialAuthChoice({ ...nothingConfigured, auth: 'codex' }), 'codex');
});

test('the OpenAI-key user with a stale ~/.codex/auth.json is not flipped to codex', () => {
  // detectExistingConfiguration ranks the typed key ABOVE an inherited Codex
  // login on purpose. The seed has to honour that ranking, because main.ts's
  // codex branch sees hasPersistedCodexGrant() === true from the stale file
  // and would write AUTH_MODE=codex_oauth against a key user.
  const home = fakeHome();
  home.vault({ openai_api_key: 'sk-live' });
  home.codex({ tokens: { access_token: 'stale', refresh_token: 'stale' } });
  const existing = detectExistingConfiguration({ homeDir: home.dir, env: {} });
  assert.equal(existing.auth, 'openai');
  assert.ok(!planSetupSteps(existing).includes('auth'), 'the auth step is skipped, so nothing else can correct this');
  assert.equal(initialAuthChoice(existing), 'openai');
});

test('with nothing on disk the seed is only a pre-selection on a step that runs', () => {
  assert.equal(initialAuthChoice(nothingConfigured), 'codex');
  assert.ok(planSetupSteps(nothingConfigured).includes('auth'));
});

// ─── The wiring, not just the function ─────────────────────────────────────
//
// setup-window.ts cannot be imported here (it imports 'electron' at module
// load), and its wizard body is a renderer script, so these read the source.
// A correct helper nothing calls is the failure mode this whole review round
// exists to stop.

const setupWindowSource = readFileSync(path.join(import.meta.dirname, 'setup-window.ts'), 'utf-8');

test('renderSetupHtml sends the computed auth choice into the renderer', () => {
  assert.match(
    setupWindowSource,
    /JSON\.stringify\(\{\s*plan,\s*existing,\s*authChoice: initialAuthChoice\(existing\),/,
    'the bootstrap must carry initialAuthChoice(existing); the renderer cannot import it',
  );
});

test('the renderer seeds authChoice from the bootstrap, never from a bare literal', () => {
  assert.match(setupWindowSource, /authChoice: boot\.authChoice \|\| 'codex',/);
  assert.doesNotMatch(
    setupWindowSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1 '),
    /^\s*authChoice: '(?:codex|openai|skipped)',/m,
    'a hardcoded authChoice is the defect: the auth step may never run to correct it',
  );
});

// ─── The compiled-in token copy ────────────────────────────────────────────
//
// In a checkout the wizard reads packages/design-tokens/tokens.css. In a
// packaged app that file is not inside the asar, so FALLBACK_TOKENS_CSS is
// what the window actually paints with — and nothing checked it against the
// source. A tokens.css edit (the duration retune moved --clem-dur-fast
// 150 → 120 mid-session) would repaint the packaged wizard in stale values
// with a green build and a clean tsc. It is a copy, so the test is that it is
// still a copy.

const TOKENS_CSS = path.resolve(import.meta.dirname, '..', '..', '..', 'packages', 'design-tokens', 'tokens.css');

function declarations(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/(--clem-[\w-]+):\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

const fallbackCss = (/const FALLBACK_TOKENS_CSS = `([\s\S]*?)`;/.exec(setupWindowSource) ?? [])[1];

test('the packaged wizard\'s token copy has not drifted from tokens.css', () => {
  assert.ok(fallbackCss, 'FALLBACK_TOKENS_CSS not found in setup-window.ts');
  const real = declarations(readFileSync(TOKENS_CSS, 'utf-8').split('\n}')[0]);
  const drifted: string[] = [];
  for (const [name, value] of Object.entries(declarations(fallbackCss))) {
    if (!(name in real)) drifted.push(`${name} is not in tokens.css at all`);
    else if (real[name] !== value) drifted.push(`${name}: wizard has ${value}, tokens.css has ${real[name]}`);
  }
  assert.deepEqual(drifted, [], `the compiled-in copy is stale:\n${drifted.join('\n')}`);
});

test('every token the wizard reads is in the copy, so nothing is undefined in an asar', () => {
  const defined = new Set(Object.keys(declarations(fallbackCss ?? '')));
  const missing = [...new Set([...setupWindowSource.matchAll(/var\((--clem-[\w-]+)/g)].map((m) => m[1]))]
    .filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `these resolve to nothing in a packaged app: ${missing.join(', ')}`);
});
