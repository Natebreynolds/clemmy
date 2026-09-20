import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  claudeProjectsDir, clementineUsageDir, codexSessionsDir, coworkRootDir, todayStamp,
} from './paths.js';
import { emptyTail, parseJsonLine, primeToEnd, readNewLines, type TailState } from './tail.js';
import {
  claudeRootSessionId, isSdkSession, parseClaudeAssistantUsage, updateClaudeMeta, type ClaudeFileMeta,
} from './parse-claude.js';
import { parseCodexTokenUsage, updateCodexMeta, type CodexFileMeta } from './parse-codex.js';
import { parseClementineUsage } from './parse-clementine.js';
import {
  acceptCall, armTrial, bindLane, createTrial, dedupeCalls, emptyLane, rollupLane, sealLane, verdictFor,
} from './trial.js';
import { buildLiveSnapshot, type LiveSnapshot } from './live.js';
import type {
  CanonicalCall, Lane, NativeSource, Pairing, SessionCandidate, Trial, TrialSnapshot,
} from './types.js';

const MAX_CALLS = 20_000;

function walkFiles(root: string, match: (name: string, full: string) => boolean, acc: string[] = []): string[] {
  if (!existsSync(root)) return acc;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = path.join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, match, acc);
    else if (match(name, full)) acc.push(full);
  }
  return acc;
}

function coworkMeta(auditPath: string): { title?: string; model?: string; createdAt?: string; id: string } {
  const id = claudeRootSessionId(auditPath);
  const jsonPath = path.join(path.dirname(auditPath), '..', `local_${id}.json`);
  const sibling = path.join(path.dirname(auditPath), `../local_${id}.json`);
  const candidates = [
    path.join(path.dirname(path.dirname(auditPath)), `local_${id}.json`),
    jsonPath,
    sibling,
  ];
  const dir = path.dirname(auditPath);
  const localJson = path.join(path.dirname(dir), path.basename(dir) + '.json');
  candidates.push(localJson);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const created = typeof raw.createdAt === 'number' ? new Date(raw.createdAt).toISOString() : undefined;
      return {
        id,
        title: typeof raw.title === 'string' ? raw.title : undefined,
        model: typeof raw.model === 'string' ? raw.model : undefined,
        createdAt: created,
      };
    } catch {
      /* skip */
    }
  }
  return { id };
}

export class MeterEngine {
  trial: Trial | null = null;
  watchingSince = new Date().toISOString();
  private calls: CanonicalCall[] = [];
  private tails = new Map<string, TailState>();
  private claudeMeta = new Map<string, ClaudeFileMeta>();
  private codexMeta = new Map<string, CodexFileMeta>();
  private watchers: FSWatcher[] = [];
  private poll: ReturnType<typeof setInterval> | null = null;
  private discoverPoll: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(snap: LiveSnapshot) => void>();
  private knownFiles = new Set<string>();
  private lastEmitCount = -1;

  onSnapshot(fn: (snap: LiveSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): LiveSnapshot {
    return buildLiveSnapshot(this.calls, this.watchingSince);
  }

  trialSnapshot(): TrialSnapshot {
    const blank = emptyLane();
    if (!this.trial) {
      return {
        trial: { id: '', name: '', pairing: 'codex', nativeSource: 'codex', createdAt: '' },
        native: blank,
        clementine: blank,
        verdict: {
          kind: 'unsealed', ratio: null, sentence: '',
          nativeModel: null, clementineModel: null, modelsMatch: false,
        },
        nativeCalls: [],
        clementineCalls: [],
        candidates: [],
      };
    }
    const nativeCalls = dedupeCalls(this.calls.filter((c) => acceptCall(this.trial!, c) && c.lane === 'native'));
    const clemCalls = dedupeCalls(this.calls.filter((c) => acceptCall(this.trial!, c) && c.lane === 'clementine'));
    return {
      trial: this.trial,
      native: rollupLane(nativeCalls),
      clementine: rollupLane(clemCalls),
      verdict: verdictFor(this.trial, rollupLane(nativeCalls), rollupLane(clemCalls)),
      nativeCalls: nativeCalls.slice(-80),
      clementineCalls: clemCalls.slice(-80),
      candidates: this.candidates(),
    };
  }

  clear(): void {
    this.calls = [];
    this.watchingSince = new Date().toISOString();
    this.lastEmitCount = -1;
    this.primeExisting();
    this.emit(true);
  }

  reset(): void {
    this.trial = null;
    this.clear();
  }

  private emit(force = false): void {
    if (!force && this.calls.length === this.lastEmitCount) return;
    this.lastEmitCount = this.calls.length;
    const snap = this.snapshot();
    for (const fn of this.listeners) fn(snap);
  }

  create(input: { name: string; pairing: Pairing; nativeSource: NativeSource; promptNote?: string }): Trial {
    this.trial = createTrial(input);
    this.calls = [];
    this.emit();
    return this.trial;
  }

  arm(): Trial {
    if (!this.trial) throw new Error('create a trial first');
    this.trial = armTrial(this.trial);
    this.calls = [];
    this.primeExisting();
    this.scanAll();
    this.emit();
    return this.trial;
  }

  bind(lane: Lane, sessionId: string): Trial {
    if (!this.trial) throw new Error('create a trial first');
    this.trial = bindLane(this.trial, lane, sessionId);
    this.emit();
    return this.trial;
  }

  autoBind(): void {
    if (!this.trial?.armedAt) return;
    const cands = this.candidates();
    if (!this.trial.nativeSessionId) {
      const native = cands.filter((c) => c.source === this.trial!.nativeSource);
      native.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (native[0]) this.trial = bindLane(this.trial, 'native', native[0].id);
    }
    if (!this.trial.clementineSessionId) {
      const clem = cands.filter((c) => c.source === 'clementine');
      clem.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (clem[0]) this.trial = bindLane(this.trial, 'clementine', clem[0].id);
    }
  }

  seal(lane: Lane): Trial {
    if (!this.trial) throw new Error('create a trial first');
    this.trial = sealLane(this.trial, lane);
    this.emit();
    return this.trial;
  }

  start(): void {
    this.primeExisting();
    this.watchDir(claudeProjectsDir());
    this.watchDir(coworkRootDir());
    this.watchDir(codexSessionsDir());
    this.watchDir(clementineUsageDir());
    this.discoverPoll = setInterval(() => this.discoverNew(), 2000);
    this.heartbeat = setInterval(() => this.emit(true), 5000);
  }

  stop(): void {
    if (this.discoverPoll) clearInterval(this.discoverPoll);
    this.discoverPoll = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
  }

  private watchDir(dir: string): void {
    if (!existsSync(dir)) return;
    try {
      const w = watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        this.ingestPath(path.join(dir, filename));
        this.autoBind();
        this.emit();
      });
      this.watchers.push(w);
    } catch {
      /* recursive watch not available — poll covers it */
    }
  }

  private ingestPath(file: string): void {
    if (!file) return;
    if (file.endsWith('.ndjson')) this.ingestClementine(file);
    else if (file.endsWith(`${path.sep}audit.jsonl`) || file.endsWith('audit.jsonl')) {
      this.ingestClaude(file, 'cowork', false);
    } else if (file.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`) && file.endsWith('.jsonl')) {
      this.ingestCodex(file);
    } else if (file.endsWith('.jsonl')) this.ingestClaude(file, 'claude-code', true);
  }

  private scanKnown(): void {
    for (const file of this.knownFiles) this.ingestPath(file);
    this.autoBind();
    this.emit();
  }

  private discoverNew(): void {
    this.scanAll();
  }

  private allWatchedFiles(): string[] {
    return [
      ...walkFiles(claudeProjectsDir(), (name) => name.endsWith('.jsonl')),
      ...walkFiles(coworkRootDir(), (name) => name === 'audit.jsonl'),
      ...walkFiles(codexSessionsDir(), (name) => name.endsWith('.jsonl')),
      ...walkFiles(clementineUsageDir(), (name) => name.endsWith('.ndjson')),
    ];
  }

  private primeExisting(): void {
    this.tails.clear();
    this.knownFiles.clear();
    for (const file of this.allWatchedFiles()) {
      this.tails.set(file, primeToEnd(file));
      this.knownFiles.add(file);
    }
  }

  private scanAll(): void {
    for (const file of walkFiles(claudeProjectsDir(), (name) => name.endsWith('.jsonl'))) {
      this.ingestClaude(file, 'claude-code', true);
    }
    for (const file of walkFiles(coworkRootDir(), (name) => name === 'audit.jsonl')) {
      this.ingestClaude(file, 'cowork', false);
    }
    for (const file of walkFiles(codexSessionsDir(), (name) => name.endsWith('.jsonl'))) {
      this.ingestCodex(file);
    }
    const usage = path.join(clementineUsageDir(), `${todayStamp()}.ndjson`);
    if (existsSync(usage)) this.ingestClementine(usage);
    this.autoBind();
    this.emit();
  }

  private ingestClaude(file: string, source: 'claude-code' | 'cowork', skipSdk: boolean): void {
    if (!this.tails.has(file)) this.tails.set(file, emptyTail());
    this.knownFiles.add(file);
    const { lines, state } = readNewLines(file, this.tails.get(file) ?? emptyTail());
    this.tails.set(file, state);
    let meta = this.claudeMeta.get(file) ?? {};
    const root = claudeRootSessionId(file);
    const fromSubagentPath = file.includes(`${path.sep}subagents${path.sep}`);
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (parsed == null) continue;
      meta = updateClaudeMeta(parsed, meta);
      const call = parseClaudeAssistantUsage(parsed, meta, {
        source, rootSessionId: root, skipSdk, fromSubagentPath,
      });
      if (call) this.pushCall(call);
    }
    this.claudeMeta.set(file, meta);
  }

  private ingestCodex(file: string): void {
    if (!this.tails.has(file)) this.tails.set(file, emptyTail());
    this.knownFiles.add(file);
    const { lines, state } = readNewLines(file, this.tails.get(file) ?? emptyTail());
    this.tails.set(file, state);
    const root = path.basename(file).replace(/\.jsonl$/, '');
    let meta = this.codexMeta.get(file) ?? {};
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (parsed == null) continue;
      meta = updateCodexMeta(parsed, meta);
      const call = parseCodexTokenUsage(parsed, meta, root);
      if (call) this.pushCall(call);
    }
    this.codexMeta.set(file, meta);
  }

  private ingestClementine(file: string): void {
    if (!this.tails.has(file)) this.tails.set(file, emptyTail());
    this.knownFiles.add(file);
    const { lines, state } = readNewLines(file, this.tails.get(file) ?? emptyTail());
    this.tails.set(file, state);
    for (const line of lines) {
      const parsed = parseJsonLine(line);
      if (parsed == null) continue;
      const call = parseClementineUsage(parsed);
      if (call) this.pushCall(call);
    }
  }

  private pushCall(call: CanonicalCall): void {
    this.calls.push(call);
    if (this.calls.length > MAX_CALLS) this.calls.splice(0, this.calls.length - MAX_CALLS);
    this.emit();
  }

  private candidates(): SessionCandidate[] {
    if (!this.trial?.armedAt) return [];
    const armed = this.trial.armedAt;
    const byRoot = new Map<string, SessionCandidate>();
    for (const call of this.calls) {
      if (call.at < armed) continue;
      const source = call.lane === 'clementine' ? 'clementine' : call.source;
      if (call.lane === 'clementine') {
        if (call.brain !== this.trial.pairing) continue;
        if (call.kind !== 'chat') continue;
      } else if (call.source !== this.trial.nativeSource) {
        continue;
      }
      if (source === 'claude-code') {
        const meta = [...this.claudeMeta.values()].find((m) => m.sessionId === call.sessionId);
        if (meta && isSdkSession(meta)) continue;
      }
      const key = `${source}:${call.rootSessionId}`;
      const prev = byRoot.get(key);
      if (!prev) {
        byRoot.set(key, {
          id: call.rootSessionId,
          source,
          startedAt: call.at,
          model: call.model,
          cwd: call.cwd,
          brain: call.brain,
          path: call.rootSessionId,
        });
      } else if (call.at < prev.startedAt) {
        prev.startedAt = call.at;
      }
    }
    for (const file of walkFiles(coworkRootDir(), (name) => name === 'audit.jsonl')) {
      if (this.trial.nativeSource !== 'cowork') break;
      const meta = coworkMeta(file);
      if (meta.createdAt && meta.createdAt >= armed && !byRoot.has(`cowork:${meta.id}`)) {
        byRoot.set(`cowork:${meta.id}`, {
          id: meta.id,
          source: 'cowork',
          startedAt: meta.createdAt,
          model: meta.model,
          title: meta.title,
          path: file,
        });
      }
    }
    return [...byRoot.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
