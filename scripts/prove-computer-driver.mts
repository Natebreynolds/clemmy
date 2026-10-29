/**
 * Proves Clem's computer driver on the machine this runs on, through the
 * same code the Connect, Your computer tap uses: the verified download into
 * Clem's tools folder, the server record she registers, the private daemon
 * she supervises (macOS and Linux), and an MCP handshake that lists the
 * driver's tools. Every tool is then classified with Clem's own taxonomy, so
 * a vendor tool she would misread (an unexpected write, an unknown name)
 * shows here before it reaches an owner.
 *
 * Usage: node --import tsx scripts/prove-computer-driver.mts [--json]
 * Runs against a disposable home; never the live one.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-driver-proof-'));
process.env.CLEMENTINE_HOME = home;

const { installToolDownload } = await import('../src/runtime/clem-tools.js');
const driver = await import('../src/integrations/computer-driver.js');
const { computerDriverToolKind, computerDriverBehaviorHints } = await import('../src/agents/tool-taxonomy.js');

const json = process.argv.includes('--json');
const say = (line: string) => { if (!json) console.log(line); };
const HANDSHAKE_MS = 90_000;

interface Rpc { id?: number; result?: unknown; error?: { message?: string } }

async function handshake(command: string, args: string[], env: Record<string, string>): Promise<{ serverInfo: unknown; tools: Array<{ name: string }> }> {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4_000); });
  const pending = new Map<number, (value: Rpc) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.startsWith('{')) continue;
      try {
        const message = JSON.parse(line) as Rpc;
        if (typeof message.id === 'number') pending.get(message.id)?.(message);
      } catch { /* a log line, not a message */ }
    }
  });
  const exited = new Promise<never>((_, reject) => child.once('exit', (code, signal) => reject(new Error(`driver exited (${code ?? signal}) before answering: ${stderr.trim().slice(-600)}`))));
  const request = (id: number, method: string, params: unknown): Promise<Rpc> => {
    const answered = new Promise<Rpc>((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return Promise.race([answered, exited]);
  };
  const timer = setTimeout(() => child.kill(), HANDSHAKE_MS);
  try {
    const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'clem-driver-proof', version: '1' } });
    if (init.error) throw new Error(`initialize refused: ${init.error.message ?? 'unknown'}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await request(2, 'tools/list', {});
    if (listed.error) throw new Error(`tools/list refused: ${listed.error.message ?? 'unknown'}`);
    const tools = ((listed.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []);
    return { serverInfo: (init.result as { serverInfo?: unknown } | undefined)?.serverInfo ?? null, tools };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    child.kill();
  }
}

let ok = false;
const report: Record<string, unknown> = { platform: `${process.platform}-${process.arch}` };
try {
  const installed = await installToolDownload({ id: 'cua-driver', recipe: driver.COMPUTER_DRIVER_DOWNLOAD, log: (line: string) => say(`  install: ${line}`) });
  const binary = installed.links[0];
  report.binary = path.relative(home, binary);
  const server = driver.computerDriverServer(binary);
  report.server = { command: path.basename(server.command ?? ''), args: (server.args ?? []).map((arg) => arg.startsWith(home) ? '<home>/…' : arg) };
  if (process.platform !== 'win32') {
    const started = driver.startComputerDriverHost({ binary, servers: [server] });
    report.host = started;
    if (started !== 'started' && started !== 'already') throw new Error(`the driver daemon did not start (${started})`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const { serverInfo, tools } = await handshake(server.command!, server.args ?? [], (server.env ?? {}) as Record<string, string>);
  const names = tools.map((tool) => tool.name).sort();
  const reads = names.filter((name) => computerDriverToolKind(`cua-driver__${name}`) === 'read');
  const ordinary = names.filter((name) => computerDriverBehaviorHints(`cua-driver__${name}`)?.destructive === false && computerDriverToolKind(`cua-driver__${name}`) === 'write');
  const vendorWord = names.filter((name) => !reads.includes(name) && !ordinary.includes(name));
  Object.assign(report, { serverInfo, tools: names.length, reads: reads.length, ordinaryActions: ordinary.length, vendorDecides: vendorWord });
  if (names.length === 0) throw new Error('the driver listed no tools');
  if (!names.includes('click')) throw new Error('the driver listed no click action');
  if (reads.length === 0) throw new Error('Clem classifies none of the driver tools as a read');
  ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (process.platform !== 'win32') await driver.stopComputerDriverHost().catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
}
report.ok = ok;
if (json) console.log(JSON.stringify(report));
else console.log(`COMPUTER_DRIVER_PROOF ${JSON.stringify(report)}`);
process.exit(ok ? 0 : 1);
