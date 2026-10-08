import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';

const text = readFileSync(new URL('../.github/workflows/windows-private-beta.yml', import.meta.url), 'utf8');
const workflow = load(text);
const release = load(readFileSync(new URL('../.github/workflows/release-desktop.yml', import.meta.url), 'utf8'));
const job = workflow.jobs['windows-beta'];
const steps = job.steps;

test('unpublished Windows beta cannot publish, spend on Mac, or obtain signing/provider secrets', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['workflow_call', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['windows-beta']);
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(job.env.CSC_LINK, '');
  assert.equal(job.env.CSC_KEY_PASSWORD, '');
  assert.equal(job.env.CLEMMY_TEST_DISABLE_LIVE_MODELS, '1');
  assert.doesNotMatch(text, /secrets\.|gh release|contents: write|package:mac|macos-/);
  assert.equal(steps.find(step => step.uses === 'actions/checkout@v5').with.ref, '${{ github.sha }}');
  assert.equal(steps.find(step => step.uses === 'actions/checkout@v5').with['persist-credentials'], false);
  assert.match(text, /repository and its Actions artifacts are\s+# public/);
  assert.doesNotMatch(text, /access-private|qualified private Windows|clementine-windows-private-/);
});

test('registered release workflow delegates only explicit manual beta requests with no inherited secrets', () => {
  const input = release.on.workflow_dispatch.inputs.windows_beta_only;
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
  assert.equal(input.required, false);
  const bridge = release.jobs['windows-private-beta'];
  assert.equal(bridge.if, "${{ github.event_name == 'workflow_dispatch' && inputs.windows_beta_only == true }}");
  assert.equal(bridge.uses, './.github/workflows/windows-private-beta.yml');
  assert.equal(bridge.with.candidate_version, '${{ inputs.candidate_version }}');
  assert.equal(bridge.secrets, undefined);
  for (const name of ['preflight', 'release-mac']) {
    assert.equal(release.jobs[name].if,
      "${{ github.event_name != 'workflow_dispatch' || inputs.windows_beta_only != true }}");
  }
  assert.match(release.jobs['release-windows'].if,
    /github\.event_name == 'workflow_dispatch' && inputs\.windows_beta_only != true/);
  // Setting the input on a tag cannot select the beta path or remove production
  // preflight/Mac/signature gates: all beta exclusions explicitly test the event.
  assert.match(release.jobs['release-windows'].if,
    /github\.event_name == 'push' && needs\.preflight\.outputs\.mac_only != 'true'/);
  const production = release.jobs['release-windows'].steps;
  assert.equal(production.find(step => step.name === 'Verify production Windows signatures').if,
    "${{ github.event_name == 'push' }}");
  assert.match(release.jobs['publish-release'].if, /github\.event_name == 'push'/);
  assert.deepEqual(release.jobs['publish-release'].needs, ['preflight', 'release-mac', 'release-windows']);
});

test('actual bridge conditions preserve tags and default manual builds while selecting only explicit Windows beta', () => {
  const evaluate = (formula, event, beta) => {
    const expression = formula.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');
    // These four workflow conditions use only JavaScript-compatible equality
    // and Boolean expressions; execute their actual text rather than duplicating
    // the routing policy in a test-only predicate.
    return Function('github', 'inputs', 'needs', `return (${expression});`)(
      { event_name: event }, { windows_beta_only: beta }, { preflight: { outputs: { mac_only: 'false' } } },
    );
  };
  const names = ['windows-private-beta', 'preflight', 'release-mac', 'release-windows'];
  for (const [event, beta, expected] of [
    ['push', true, [false, true, true, true]],
    ['push', undefined, [false, true, true, true]],
    ['workflow_dispatch', undefined, [false, true, true, true]],
    ['workflow_dispatch', false, [false, true, true, true]],
    ['workflow_dispatch', true, [true, false, false, false]],
  ]) {
    assert.deepEqual(names.map(name => evaluate(release.jobs[name].if, event, beta)), expected);
  }
});

test('candidate artifact is withheld until the actual Windows installer/native/clean-launch gates pass', () => {
  const index = name => steps.findIndex(step => step.name === name);
  const build = index('Build unsigned installer and verify packaged native runtime');
  const assets = index('Verify exact installer assets and updater hashes');
  const installed = index('Qualify actual installed clean launch and restart');
  const upload = steps.find(step => step.name === 'Upload qualified unpublished Windows installer');
  assert.ok(build >= 0 && assets > build && installed > assets);
  assert.equal(upload.if, 'success()');
  assert.ok(index(upload.name) > installed);
  assert.match(upload.with.path, /windows-native-core-qualification\.json/);
  assert.match(upload.with.path, /installed-smoke\.json/);
  assert.equal(steps.find(step => step.name === 'Upload qualification diagnostics').if, 'always()');
  assert.match(steps.find(step => step.name === 'Validate exact source and unpublished candidate version').run,
    /release-candidate-version\.mjs validate/);
  // A release tag build is the same qualification at the tag's exact version,
  // dispatched on the tag; it still publishes nothing itself.
  const validate = steps.find(step => step.name === 'Validate exact source and unpublished candidate version').run;
  assert.match(validate, /GITHUB_REF -ne "refs\/tags\/\$env:RELEASE_TAG"/);
  assert.match(validate, /CANDIDATE_VERSION -ne \$current/);
  assert.equal(job.env.RELEASE_TAG, '${{ inputs.release_tag }}');
  assert.match(steps.find(step => step.name === 'Offline Windows and package qualification tests').run,
    /run-tests-isolated\.mjs/);
});

test('Windows CI runs the exact frozen feature and privacy suites before packaging without POSIX-only fixtures', () => {
  const step = steps.find(step => step.name === 'Offline Windows and package qualification tests');
  assert.equal(step.shell, 'pwsh');
  assert.match(step.run, /\$LASTEXITCODE -ne 0/);
  const expected = [
    'src/runtime/windows-readiness.test.ts',
    'src/runtime/windows-private-filesystem.test.ts',
    'src/runtime/credential-private-filesystem.test.ts',
    'src/runtime/windows-credential-privacy.test.ts',
    'src/runtime/claude-credential-privacy.test.ts',
    'src/runtime/sync-directory.test.ts',
    'src/runtime/host-execution-context.test.ts',
    'src/runtime/windows-process-tree.test.ts',
    'src/runtime/windows-powershell.test.ts',
    'src/runtime/terminal-handoff.test.ts',
    'src/runtime/managed-cli-jobs.test.ts',
    'src/runtime/cli-spawn.test.ts',
    'src/runtime/cli-probe-process.test.ts',
    'src/runtime/cli-probe-windows.test.ts',
    'src/runtime/codex-native-oauth-loopback.test.ts',
    'src/runtime/sandboxed-script.test.ts',
    'src/runtime/mobile-tls.test.ts',
    'src/runtime/mobile-ingress.test.ts',
    'src/runtime/mobile-relay.test.ts',
    'src/runtime/mobile-relay-health.test.ts',
    'src/channels/transcription-stop-routes.test.ts',
    'src/runtime/harness/claude-cli-launch.test.ts',
    'src/runtime/harness/claude-headless-model.test.ts',
    'src/projects/local-project-discovery.test.ts',
    'src/projects/project-routes.test.ts',
    'apps/desktop/src/diagnostics-bundle.test.ts',
    'apps/desktop/src/windows-app-identity.test.ts',
    'src/runtime/harness/claude-agent-sdk.test.ts',
    'src/execution/coding-agent-claude.test.ts',
    'src/execution/coding-run-env.test.ts',
    'src/execution/coding-run-git.test.ts',
    'src/execution/coding-run-receipt.test.ts',
    'src/execution/workflow-deterministic-runner.test.ts',
    'src/integrations/browser-python.test.ts',
    'src/integrations/browser-operation.test.ts',
    'src/integrations/browser-harness-windows-setup.test.ts',
    'src/integrations/windows-browser-paths.test.ts',
    'src/integrations/browser-harness-install-command.test.ts',
    'src/integrations/cli-catalog/platform-install.test.ts',
    'src/integrations/cli-catalog/auth-health.test.ts',
    'src/integrations/local-meetings/whisper-runtime-windows-process.test.ts',
    'src/agents/capabilities-windows.test.ts',
    'src/agents/capabilities.test.ts',
    'src/runtime/harness/result-payload-storage.test.ts',
    'src/runtime/harness/authority-encrypted-payload-store.test.ts',
    'src/runtime/harness/model-request-provenance-blocking.test.ts',
    'src/runtime/harness/staged-source-download-authority.test.ts',
    'src/runtime/harness/attempt-settlement.test.ts',
    'src/tools/artifact-bundle-core.test.ts',
    'src/tools/computer-tools-windows-process.test.ts',
    'src/tools/document-docx.test.ts',
    'src/tools/attachment-tools.test.ts',
    'src/runtime/markitdown-process.test.ts',
    'src/runtime/markitdown.test.ts',
    'src/runtime/attachments.test.ts',
    'src/dashboard/console-files-open.test.ts',
    'src/spaces/static-document-update.test.ts',
    'src/spaces/space-preview-windows.test.ts',
    'src/integrations/composio/staged-file-blob-store.test.ts',
    'apps/desktop/src/codex-token-response.test.ts',
    'apps/desktop/src/auth-grant.test.ts',
    'apps/desktop/src/credentials-bridge.test.ts',
    'apps/desktop/scripts/windows-package-runtime.test.mjs',
    'apps/desktop/scripts/build-windows-private-filesystem-probe.test.mjs',
    'apps/desktop/scripts/build-credential-policy.test.mjs',
    'apps/desktop/scripts/windows-private-filesystem-packaging.test.mjs',
    'scripts/windows-private-beta-workflow.test.mjs',
    'scripts/windows-packaged-launch-smoke.test.mjs',
    'scripts/run-tests-isolated.test.mjs',
    'scripts/release-workflow.test.mjs',
  ];
  const selected = [...step.run.matchAll(/'([^']+\.test\.(?:ts|mjs))'/g)].map(match => match[1]);
  assert.equal(new Set(selected).size, selected.length, 'Each Windows suite runs exactly once');
  assert.deepEqual([...selected].sort(), [...expected].sort());
  for (const file of selected) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `Missing actual Windows test path: ${file}`);
  assert.ok(!selected.includes('src/runtime/cli-discovery.test.ts'), 'POSIX CLI shebang fixtures are not Windows acceptance');
  assert.ok(!selected.includes('src/integrations/local-meetings/whisper-runtime.test.ts'), 'POSIX Whisper overrides are not Windows process-tree acceptance');
  assert.ok(!selected.includes('src/runtime/secrets/secrets.test.ts'), 'Fixed /tmp and POSIX permission fixtures are not the Windows credential gate');
  assert.ok(steps.indexOf(step) < steps.findIndex(item => item.name === 'Build unsigned installer and verify packaged native runtime'));
});

test('actual Windows permission suites use canonical compiled policy prepared before their first execution', () => {
  const prepare = steps.find(step => step.name === 'Compile canonical credential policy and Windows ACL native probe');
  const offline = steps.find(step => step.name === 'Offline Windows and package qualification tests');
  assert.ok(prepare && steps.indexOf(prepare) < steps.indexOf(offline));
  assert.match(prepare.run, /npm --prefix apps\/desktop run build:credential-policy/);
  assert.match(prepare.run, /npm --prefix apps\/desktop run build:windows-private-filesystem/);
  assert.match(prepare.run, /\$LASTEXITCODE -ne 0/);
  assert.ok(offline.run.includes("'apps/desktop/scripts/build-windows-private-filesystem-probe.test.mjs'"));
  assert.ok(offline.run.includes("'apps/desktop/scripts/build-credential-policy.test.mjs'"));
  assert.ok(offline.run.includes("'apps/desktop/scripts/windows-private-filesystem-packaging.test.mjs'"));
});
