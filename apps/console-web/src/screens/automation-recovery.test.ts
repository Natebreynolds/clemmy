import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-automation-recovery-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter, Routes, Route } from 'react-router-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { Triggers } from './src/screens/Triggers';
    import { Automate, RunWorkspaceDrawer, RunWorkspaceContentBoundary } from './src/screens/Automate';
    import { CheckInOpenItems, Heartbeats } from './src/screens/Heartbeats';
    import { DetailsForm, WorkflowPage } from './src/screens/WorkflowPage';
    import { MadeArchive } from './src/screens/Made';
    export function runContentIdentity(runId, historyError = false) {
      const body = RunWorkspaceContentBoundary({workflow:'controlled-workflow', selectedRunId:runId, selectedRun:null, historyPending:false, historyError});
      return {key:body.key, type:body.type.name, runId:body.props.selectedRunId};
    }
    export function render(kind, records = [], props = {}) {
      const client = new QueryClient({defaultOptions:{queries:{retry:false, retryOnMount:false, staleTime:Infinity}}});
      for (const record of records) {
        const query = client.getQueryCache().build(client, {queryKey:record.key});
        if (record.data !== undefined) client.setQueryData(record.key, record.data);
        if (record.error) query.setState({status:'error', error:new Error('Controlled source unavailable'), fetchStatus:'idle'});
      }
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => {throw new Error('A render must not execute or acknowledge work');};
      const child = kind === 'triggers' ? <Triggers/> : kind === 'items' ? <CheckInOpenItems {...props}/>
        : kind === 'checkins' ? <Heartbeats/>
        : kind === 'list' ? <Automate/> : kind === 'workflow' ? <Routes><Route path="/automate/:name" element={<WorkflowPage/>}/></Routes>
        : kind === 'archive' ? <MadeArchive/>
        : kind === 'details' ? <DetailsForm {...props} onSaved={()=>{throw new Error('No write during render')}}/>
        : <RunWorkspaceDrawer workflow="controlled-workflow" initialRunId="exact-old-run" onClose={()=>{}} onSelectRun={()=>{}}/>;
      try {return renderToStaticMarkup(<MemoryRouter initialEntries={[props.route ?? '/automate/controlled-workflow']}><QueryClientProvider client={client}>{child}</QueryClientProvider></MemoryRouter>);}
      finally {globalThis.fetch = originalFetch; client.clear();}
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'automation-recovery-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false, platform: 'node',
  format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent', loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' },
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_CLEM_TOKEN': '""' },
  // PDF canvas workers are unrelated to these automation surfaces and require a
  // browser. Keep the shipped automation components and query behavior intact.
  plugins: [{ name: 'no-pdf-worker-in-server-fixture', setup(builder) {
    builder.onLoad({ filter: /\/components\/chat\/PdfPreview\.tsx$/ }, () => ({ contents: 'export default function PdfPreview(){throw new Error("Unexpected PDF preview in automation test")}', loader: 'js' }));
  } }],
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
const { render, runContentIdentity } = createRequire(import.meta.url)(fixtureFile) as {
  render: (kind: string, records?: Array<{ key: unknown[]; data?: unknown; error?: boolean }>, props?: Record<string, unknown>) => string;
  runContentIdentity: (runId: string, historyError?: boolean) => { key: string; type: string; runId: string };
};
const triggers = { generatedAt: '2026-10-30T12:00:00Z', workflows: [], upcoming: [], watches: [], reminders: [], webhookBase: 'https://fixture.invalid' };
const historyKey = ['wf-runs', 'controlled-workflow'];
const workspaceKey = ['run-workspace', 'controlled-workflow', 'exact-old-run'];

test('empty schedule screen has one purposeful empty state and an actionable setup link', () => {
  const html = render('triggers', [{ key: ['triggers'], data: triggers }]);
  assert.match(html, /Let Clem handle the timing/);
  assert.match(html, /href="\/chat\?prompt=[^"]+"/);
  assert.doesNotMatch(html, /No schedules yet|No webhooks yet|Nothing event-driven yet|No reminders pending/);
});

test('failed trigger reads say unavailable rather than inviting a duplicate setup', () => {
  const html = render('triggers', [{ key: ['triggers'], error: true }]);
  assert.match(html, /Triggers are unavailable/);
  assert.match(html, /Retry<\/button>/);
  assert.doesNotMatch(html, /Let Clem handle the timing/);
});

test('Next up exposes a readable workflow link and keeps cron only in its technical title', () => {
  const scheduled = { name:'weekly-sales-brief', slug:'weekly-sales-brief', enabled:true, description:'Prepare the weekly sales brief', schedule:'0 9 * * 1-5', timezone:'America/Los_Angeles', onceAt:null, interval:null, webhookPath:null, events:[], lastRun:null };
  const html = render('triggers', [{key:['triggers'], data:{...triggers, workflows:[scheduled], upcoming:[{workflowName:scheduled.name, at:new Date(Date.now()+3_600_000).toISOString(), schedule:scheduled.schedule}]}}]);
  const timeline = html.split('On a schedule')[0];
  assert.match(timeline, /href="\/automate\/weekly-sales-brief"/);
  assert.match(timeline, /Weekly Sales Brief/);
  assert.match(timeline, /Every weekday at 9:00 AM/);
  assert.match(timeline, /title="0 9 \* \* 1-5"/);
  assert.doesNotMatch(timeline.replace(/<[^>]+>/g, ''), /weekly-sales-brief|0 9 \* \* 1-5/);
});

test('run history failure never claims there are no runs and provides Retry', () => {
  const html = render('drawer', [{ key: historyKey, error: true }, { key: workspaceKey, error: true }]);
  assert.match(html, /Run history is unavailable/);
  assert.match(html, /This run’s workspace is unavailable/);
  assert.match(html, /Retry<\/button>/);
  assert.doesNotMatch(html, /No runs yet|No work products/);
  assert.match(html, /<dialog[^>]*aria-labelledby="workflow-run-title"/);
  assert.match(html, /aria-label="Close run"/);
});

test('an older linked run shows its exact workspace without borrowing a newer status', () => {
  const html = render('drawer', [
    { key: historyKey, data: { runs: [{ id: 'newest-different-run', status: 'failed' }] } },
    { key: workspaceKey, data: { runId: 'exact-old-run', goal: 'Exact old run goal', artifacts: [], totalBytes: 0, checker: null } },
  ]);
  assert.match(html, /Exact old run goal/);
  assert.match(html, /outside the recent history/);
  assert.match(html, /exact-old-run/);
  assert.doesNotMatch(html, /aria-pressed="true"/);
  assert.match(html, /current status could not be confirmed/);
});

test('cached run switches replace the payload owner while history refreshes keep that owner stable', () => {
  const a = runContentIdentity('exact-run-a');
  const refreshedA = runContentIdentity('exact-run-a', true);
  const b = runContentIdentity('exact-run-b');
  assert.equal(a.type, b.type);
  assert.equal(a.key, refreshedA.key, 'a poll must not reset the selected run’s local state');
  assert.notEqual(a.key, b.key, 'changing exact run identity remounts activity, events and pending action state');
  assert.equal(b.runId, 'exact-run-b');
  const html = render('drawer', [{key:workspaceKey, data:{runId:'exact-old-run', goal:'Exact body', artifacts:[], totalBytes:0, checker:null}}]);
  assert.equal((html.match(/<dialog\b/g) ?? []).length, 1, 'one stable modal owns keyboard focus');
  assert.match(html, /data-workflow-run="exact-old-run"/);
});

test('failed refresh retains the last loaded exact workspace with an explicit warning', () => {
  const html = render('drawer', [
    { key: historyKey, data: { runs: [{ id: 'exact-old-run', status: 'completed' }] }, error: true },
    { key: workspaceKey, data: { runId: 'exact-old-run', goal: 'Retained controlled result', artifacts: [], totalBytes: 0, checker: null }, error: true },
  ]);
  assert.match(html, /Showing last loaded runs/);
  assert.match(html, /Showing last loaded results/);
  assert.match(html, /Retained controlled result/);
  assert.match(html, /aria-pressed="true"/);
});

test('check-in remainder is accessible by disclosure and keeps exact conversation links', () => {
  const items = Array.from({ length: 11 }, (_, index) => ({ key: 'controlled-'+index, kind:'run_waiting', subject:'Controlled work '+index,
    createdAt:'2026-10-30T12:00:00Z', detail:'Full detail '+index, handoff: {state:'needs_attention', sessionId:'exact session '+index} }));
  const html = render('items', [], {items});
  assert.match(html, /<details[^>]*>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[\s=>])/);
  assert.match(html, /Show 3 more items/);
  assert.match(html, /Controlled work 10/);
  assert.match(html, /Full detail 10/);
  assert.match(html, /href="\/chat\/exact%20session%2010"/);
  const short = render('items', [], {items:items.slice(0, 8)});
  assert.doesNotMatch(short, /<details/);
});

test('Check-ins label matches the actual Inbox destination', () => {
  const html = render('checkins', [{key:['heartbeats'], data:{heartbeats:[]}}]);
  assert.match(html, /href="\/inbox\?tab=needs"[^>]*>Open Inbox<\/a>/);
  assert.doesNotMatch(html, /Open From Clem/);
});

test('failed model-choice loading preserves the actual saved model selections', () => {
  const html = render('details', [{ key: ['settings'], error: true }], {detail: {name:'controlled-workflow', trigger:{schedule:'0 9 * * *', timezone:'America/Los_Angeles'}, models:{brain:'saved-brain', worker:'saved-worker'}}});
  assert.match(html, /Model choices could not be refreshed/);
  assert.match(html, /value="saved-brain" selected=""/);
  assert.match(html, /value="saved-worker" selected=""/);
  assert.match(html, /Retry choices/);
});

test('a failed list refresh retains workflow controls alongside a compact recovery notice', () => {
  const html = render('list', [
    { key: ['workflows'], data: { workflows: [{name:'controlled-workflow', description:'Retained workflow description', enabled:true}] }, error:true },
    { key: ['workflows-home'], data: { activeRuns:[], upcoming:[] } },
  ]);
  assert.match(html, /Showing last loaded workflows/);
  assert.match(html, /Retained workflow description/);
  assert.match(html, /Enable Controlled Workflow/);
  assert.match(html, /type="search"[^>]*aria-label="Search workflows"/);
  assert.match(html, /1 of 1 workflows/);
  assert.doesNotMatch(html, /Let&#x27;s automate something|Workflows are unavailable/);
});

test('a failed detail refresh preserves the workflow editor and its saved settings', () => {
  const html = render('workflow', [
    { key: ['workflow','controlled-workflow'], data: {name:'controlled-workflow', slug:'controlled-workflow', description:'Kept workflow editor', enabled:false, steps:[], models:{brain:'kept-brain'}}, error:true },
  ]);
  assert.match(html, /Showing the last loaded workflow/);
  assert.match(html, /Kept workflow editor/);
  assert.match(html, /value="kept-brain" selected=""/);
  assert.doesNotMatch(html, /This workflow is unavailable/);
});

test('a not-ready automation offers guided setup and preserves the manual setup path', () => {
  const certification = {state:'needs_creation_inputs', label:'Needs setup', summary:'Choose a sample customer', canRun:false, nextActions:['provide_test_inputs'], missingTestInputs:['sample_customer']};
  const html = render('workflow', [{key:['workflow','controlled-workflow'], data:{name:'controlled-workflow', slug:'exact-workflow-slug', enabled:false, steps:[], certification}}], {route:'/automate/controlled-workflow?setup=1'});
  assert.match(html, /Finish setup with Clem/);
  assert.match(html, /Manual setup/);
  assert.match(html, /Advanced/);
  assert.doesNotMatch(html, />Provide test inputs<\/button>/);
});

test('step outputs expose a truthful scoped result search without claiming a downloadable file', () => {
  const html = render('drawer', [{key:workspaceKey, data:{runId:'exact-old-run', goal:null, artifacts:[{path:'artifacts/provider-payload.json', agent:'summarize-customers', tool:'provider_action', bytes:120, summary:'Full customer summary and the next business action.', producedAt:'2026-10-30T12:00:00Z'}], totalBytes:120, checker:null}}]);
  assert.match(html, /Saved step results/);
  assert.match(html, /Full customer summary and the next business action/);
  assert.match(html, /Find in Files &amp; results/);
  assert.match(html, /href="\/made\?q=Controlled\+Workflow"/);
  assert.match(html, /<summary[^>]*>Saved details/);
  assert.doesNotMatch(html, /download=|\/files\/open|>Open file<|120 files/);
});

test('Files & results honors the scoped query and shows matching saved work', () => {
  const html = render('archive', [{key:['delivered-archive'], data:[{id:81, title:'Customer brief', why:'Controlled business result', createdAt:'2026-10-30T12:00:00Z', sessionId:null, artifactCount:1, rerunnable:false, artifacts:[{kind:'file', title:'Customer brief', target:'reports/customer-brief.pdf', createdAt:'2026-10-30T12:00:00Z', openable:false}]}]}], {route:'/made?q=customer-brief.pdf'});
  assert.match(html, /value="customer-brief.pdf"/);
  assert.match(html, /Customer brief/);
  assert.match(html, /href="\/made\/81"/);
  assert.doesNotMatch(html, /No recent loaded work matches/);
});
