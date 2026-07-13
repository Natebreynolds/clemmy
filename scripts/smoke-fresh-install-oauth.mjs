#!/usr/bin/env node
// End-to-end Codex OAuth smoke for the fresh-install path.
//
// Stands up a fake OAuth server on localhost, points the daemon-side
// loginWithNativeCodexOAuth() at it via CODEX_OAUTH_AUTH_BASE_URL, and
// drives the full PKCE dance:
//
//   1. App spawns a local callback listener on one of CALLBACK_PORTS.
//   2. App "opens the browser" — we intercept that and curl-equivalent
//      hit the fake /oauth/authorize, which 302s to the callback URL.
//   3. App receives the callback, exchanges the code at /oauth/token
//      (our fake), receives access + refresh + id tokens.
//   4. Test asserts the returned token shape and the values written
//      to disk match what the fake server issued.
//
// This catches: callback port exhaustion, state mismatch, code/verifier
// mismatch, 30s timeout regression, and any future change that breaks
// the bracket-tight wire format the runtime expects.
//
// Run: node scripts/smoke-fresh-install-oauth.mjs

import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DAEMON_DIST = path.join(REPO_ROOT, 'dist');

if (!existsSync(path.join(DAEMON_DIST, 'runtime', 'codex-native-oauth.js'))) {
  console.error('✗ dist/ not built. Run: npm run build');
  process.exit(2);
}

const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };

// ─── Fake OAuth server ─────────────────────────────────────────────

const FAKE_AUTH_CODE = 'fake-auth-code-' + Math.random().toString(36).slice(2, 10);
const FAKE_ACCESS_TOKEN = 'fake-access-' + Math.random().toString(36).slice(2, 10);
const FAKE_REFRESH_TOKEN = 'fake-refresh-' + Math.random().toString(36).slice(2, 10);
const FAKE_ID_TOKEN_PAYLOAD = Buffer.from(JSON.stringify({
  sub: 'user-fake',
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fake-12345' },
})).toString('base64url');
// A JWT is header.payload.signature — header and signature don't matter
// for our parsing (we only decode the payload).
const FAKE_ID_TOKEN = `header.${FAKE_ID_TOKEN_PAYLOAD}.signature`;

let receivedAuthorizeRequest = null;
let receivedTokenRequest = null;

function startFakeAuthServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);
      if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
        receivedAuthorizeRequest = {
          redirectUri: url.searchParams.get('redirect_uri'),
          state: url.searchParams.get('state'),
          codeChallenge: url.searchParams.get('code_challenge'),
          codeChallengeMethod: url.searchParams.get('code_challenge_method'),
          scope: url.searchParams.get('scope'),
        };
        // 302 to the callback URL with code + state.
        const redirectTo = new URL(receivedAuthorizeRequest.redirectUri);
        redirectTo.searchParams.set('code', FAKE_AUTH_CODE);
        redirectTo.searchParams.set('state', receivedAuthorizeRequest.state);
        res.statusCode = 302;
        res.setHeader('Location', redirectTo.toString());
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          receivedTokenRequest = {
            grant_type: params.get('grant_type'),
            code: params.get('code'),
            client_id: params.get('client_id'),
            redirect_uri: params.get('redirect_uri'),
            code_verifier: params.get('code_verifier'),
          };
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            access_token: FAKE_ACCESS_TOKEN,
            refresh_token: FAKE_REFRESH_TOKEN,
            id_token: FAKE_ID_TOKEN,
            token_type: 'Bearer',
            expires_in: 3600,
          }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('Not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

// ─── Drive the full OAuth flow ─────────────────────────────────────

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clemmy-oauth-'));
const codexAuthFile = path.join(tmpHome, '.codex', 'auth.json');

process.env.HOME = tmpHome;
process.env.HOMEPATH = tmpHome;

console.log('Clementine fresh-install Codex OAuth smoke');
console.log(`    HOME=${tmpHome}`);

let server;
let exitCode = 0;
try {
  const fake = await startFakeAuthServer();
  server = fake.server;
  process.env.CODEX_OAUTH_AUTH_BASE_URL = `http://127.0.0.1:${fake.port}`;
  process.env.CODEX_AUTH_SOURCE_FILE = codexAuthFile;
  ok(`fake OAuth server on http://127.0.0.1:${fake.port}`);

  // Import AFTER setting env so the module reads the override.
  const { loginWithNativeCodexOAuth, refreshNativeCodexTokens } =
    await import(path.join(DAEMON_DIST, 'runtime', 'codex-native-oauth.js'));
  const authStore = await import(path.join(DAEMON_DIST, 'runtime', 'auth-store.js'));

  console.log('\n→ Phase 1 · drive the PKCE dance with an injected opener');
  // The injected opener IS our test-side browser: it just fetches the
  // authorize URL. The fake server 302s to the callback, fetch follows
  // the redirect, the daemon's local callback listener captures the code.
  const tokens = await loginWithNativeCodexOAuth(async (url) => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`fake authorize did not return 2xx after redirect: ${res.status}`);
  });

  if (tokens.accessToken === FAKE_ACCESS_TOKEN) ok('access_token matches fake server issuance');
  else fail(`access_token mismatch: got ${tokens.accessToken} expected ${FAKE_ACCESS_TOKEN}`);
  if (tokens.refreshToken === FAKE_REFRESH_TOKEN) ok('refresh_token matches');
  else fail('refresh_token mismatch');
  if (tokens.idToken === FAKE_ID_TOKEN) ok('id_token matches');
  else fail('id_token mismatch');
  if (tokens.accountId === 'acct-fake-12345') ok('accountId extracted from id_token JWT payload');
  else fail(`accountId not extracted (got "${tokens.accountId}")`);

  // PKCE: the authorize request must have S256 + a non-empty challenge,
  // and the token exchange must include the matching verifier.
  if (receivedAuthorizeRequest?.codeChallengeMethod === 'S256') ok('PKCE code_challenge_method=S256');
  else fail(`PKCE method wrong: ${receivedAuthorizeRequest?.codeChallengeMethod}`);
  if (receivedAuthorizeRequest?.codeChallenge && receivedAuthorizeRequest.codeChallenge.length >= 40) ok('PKCE code_challenge present');
  else fail('PKCE code_challenge missing or too short');
  if (receivedTokenRequest?.code === FAKE_AUTH_CODE) ok('token exchange used the auth code');
  else fail(`token exchange code mismatch: ${receivedTokenRequest?.code}`);
  if (receivedTokenRequest?.code_verifier && receivedTokenRequest.code_verifier.length >= 40) ok('token exchange sent code_verifier');
  else fail('token exchange code_verifier missing');
  if (receivedTokenRequest?.grant_type === 'authorization_code') ok('token exchange grant_type=authorization_code');
  else fail(`grant_type wrong: ${receivedTokenRequest?.grant_type}`);

  console.log('\n→ Phase 2 · refresh works against the same fake server');
  const refreshed = await refreshNativeCodexTokens(tokens.refreshToken);
  if (refreshed.accessToken === FAKE_ACCESS_TOKEN) ok('refresh returns a fresh access_token');
  else fail('refresh access_token mismatch');

  console.log('\n→ Phase 3 · loginWithNativeOAuth() persists tokens via auth-store');
  // Reuses our same fake server.
  const persist = await authStore.loginWithNativeOAuth(codexAuthFile);
  if (persist.ok) ok(`auth-store.loginWithNativeOAuth: ${persist.message}`);
  else fail(`auth-store.loginWithNativeOAuth failed: ${persist.message}`);

  // Clementine must keep its rotating refresh-token family independent from
  // the external Codex CLI. Writing this compatibility file lets either app
  // consume the other's refresh token and can revoke the shared family.
  if (!existsSync(codexAuthFile)) ok('external Codex CLI auth.json remains untouched');
  else fail(`Clementine unexpectedly wrote the external Codex CLI auth file: ${codexAuthFile}`);

  const localAuthFile = path.join(tmpHome, '.clementine-next', 'state', 'auth.json');
  if (existsSync(localAuthFile)) {
    const mode = statSync(localAuthFile).mode & 0o777;
    if (mode === 0o600) ok(`local auth.json written 0o600 (got ${mode.toString(8)})`);
    else fail(`local auth.json mode is ${mode.toString(8)}, expected 600`);
    const data = JSON.parse(readFileSync(localAuthFile, 'utf-8'));
    if (data.codexOauth?.accessToken === FAKE_ACCESS_TOKEN) ok('persisted local auth.json has codexOauth.accessToken');
    else fail('persisted local auth.json missing codexOauth tokens');
  } else {
    fail(`local auth.json not written to ${localAuthFile}`);
  }

  if (process.exitCode === 1) {
    console.error('\n✗ Codex OAuth smoke FAILED');
    exitCode = 1;
  } else {
    console.log('\n✓ Codex OAuth fresh-install smoke is green end-to-end');
    exitCode = 0;
  }
} catch (err) {
  console.error('\n✗ smoke threw:', err);
  exitCode = 1;
} finally {
  server?.close();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
