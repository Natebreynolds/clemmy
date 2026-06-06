import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, PKG_DIR } from '../config.js';
import { findSafeCliCommand } from './cli-discovery.js';

/**
 * markitdown integration — turns binary/Office files (PDF, Word, Excel,
 * PowerPoint, EPub, images, audio, …) into Markdown the agent can read.
 *
 * Backed by Microsoft's `markitdown`, run through the `uv` Python runtime.
 * We VENDOR uv binaries for every supported platform into the published
 * npm package (see scripts/vendor-uv.mjs + the `files` array), so there is
 * no "install Python first" prerequisite. markitdown itself (plus a managed
 * CPython) is fetched by `uvx` on the FIRST conversion and cached forever
 * under BASE_DIR/runtime — that one call needs network; everything after is
 * local.
 *
 * Spawning rule: always run from BASE_DIR. On macOS, child processes spawned
 * under TCC-protected dirs (~/Desktop, ~/Documents, iCloud) throw EPERM on
 * getcwd; BASE_DIR is a directory the daemon already has access to. This is
 * the same mitigation run_shell_command documents.
 */

/**
 * Pinned uv release we vendor. Bump deliberately, then re-run
 * `npm run vendor:uv -- --force` so the package ships the new binaries.
 */
export const UV_VERSION = '0.11.19';

const DEFAULT_CONVERT_TIMEOUT_MS = 180_000;
/** Hard cap on captured stdout so a pathological file can't balloon memory. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Cap concurrent uv/markitdown child processes so a burst of attachments
 * can't fork-bomb the daemon. Extra calls queue and run as slots free. */
const MAX_CONCURRENT_CONVERSIONS = 2;

let activeConversions = 0;
const conversionQueue: Array<() => void> = [];

function acquireConversionSlot(): Promise<void> {
  if (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
    activeConversions += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => conversionQueue.push(resolve));
}

function releaseConversionSlot(): void {
  const next = conversionQueue.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter (count stays the same)
    return;
  }
  activeConversions = Math.max(0, activeConversions - 1);
}

export type UvTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'aarch64-unknown-linux-gnu'
  | 'x86_64-unknown-linux-gnu'
  | 'x86_64-pc-windows-msvc';

/** Every target we vendor a uv binary for. Keep in sync with vendor-uv.mjs. */
export const UV_TARGETS: UvTarget[] = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu',
  'x86_64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
];

/**
 * Map the running host to its vendored uv target triple. Returns null on a
 * platform/arch we don't ship a binary for (caller surfaces a clear error).
 */
export function uvTargetForHost(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): UvTarget | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux') {
    if (arch === 'arm64') return 'aarch64-unknown-linux-gnu';
    if (arch === 'x64') return 'x86_64-unknown-linux-gnu';
    return null;
  }
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  return null;
}

/** Absolute path to the vendored uv binary for a target, or null if unsupported. */
export function vendoredUvPath(
  target: UvTarget | null = uvTargetForHost(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!target) return null;
  const bin = platform === 'win32' ? 'uv.exe' : 'uv';
  return path.join(PKG_DIR, 'vendor', 'uv', target, bin);
}

/**
 * Binary / non-UTF8 formats markitdown handles that read_file should
 * transparently route through conversion. Deliberately EXCLUDES text formats
 * (.txt .md .json .csv .html .xml) — those stay raw via plain UTF-8 read so
 * the agent sees source, not a lossy markdown render.
 */
export const CONVERTIBLE_EXTENSIONS = new Set<string>([
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.xlsx',
  '.xls',
  '.epub',
  '.odt',
  '.rtf',
  '.msg',
  // images — EXIF metadata + OCR
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.tiff',
  '.webp',
  // audio — requires MARKITDOWN_EXTRAS=all
  '.wav',
  '.mp3',
  '.m4a',
  '.flac',
  // archives — markitdown unpacks + converts contents
  '.zip',
]);

export function isConvertibleExtension(filePath: string): boolean {
  return CONVERTIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * markitdown package spec handed to `uvx --from`. markitdown's BASE install
 * ships almost no converters — each format is an opt-in extra (`[pdf]`,
 * `[docx]`, …). We default to a documents bundle covering PDF + all Office +
 * Outlook, which makes read_file's transparent auto-convert work out of the
 * box. Images convert on base (EXIF/metadata). Audio/YouTube need the heavier
 * full set.
 *
 * Override via MARKITDOWN_EXTRAS:
 *   all   → markitdown[all]   (adds audio transcription, YouTube, az-doc-intel)
 *   none  → markitdown        (bare; rarely useful)
 *   <csv> → markitdown[<csv>] (custom, e.g. "pdf,docx")
 */
// Audio is handled by Whisper (see transcribe.ts), so the heavy
// audio-transcription extra (speechrecognition + pydub, ~30MB) is intentionally
// dropped here to slim every first-run install.
export const DEFAULT_MARKITDOWN_EXTRAS = 'pdf,docx,pptx,xlsx,xls,outlook,youtube-transcription';

function markitdownSpec(): string {
  const extras = (process.env.MARKITDOWN_EXTRAS || '').trim().toLowerCase();
  if (extras === 'all') return 'markitdown[all]';
  if (extras === 'none') return 'markitdown';
  if (extras) return `markitdown[${extras}]`;
  return `markitdown[${DEFAULT_MARKITDOWN_EXTRAS}]`;
}

let cachedUvCommand: string | null = null;

export interface UvResolved {
  command: string;
}
export interface UvUnavailable {
  error: string;
}

/**
 * Resolve a runnable uv: (1) the binary we vendored into the package,
 * (2) a uv already on $PATH (dev machines / user installs), else a clear
 * structured error. Never throws.
 */
export function resolveUv(): UvResolved | UvUnavailable {
  if (cachedUvCommand && existsSync(cachedUvCommand)) return { command: cachedUvCommand };

  const vendored = vendoredUvPath();
  if (vendored && existsSync(vendored)) {
    if (process.platform !== 'win32') {
      try {
        chmodSync(vendored, 0o755);
      } catch {
        // best-effort; npm preserves the +x bit through pack/extract
      }
    }
    cachedUvCommand = vendored;
    return { command: vendored };
  }

  const onPath = findSafeCliCommand('uv');
  if (onPath && !onPath.skipped) {
    cachedUvCommand = onPath.command;
    return { command: onPath.command };
  }

  const target = uvTargetForHost();
  if (!target) {
    return {
      error: `File conversion needs the uv runtime, but this platform (${process.platform}/${process.arch}) is not supported. Install uv (https://docs.astral.sh/uv/) to enable conversion.`,
    };
  }
  return {
    error: `The bundled uv runtime for ${target} is missing. Reinstall Clementine, or install uv (https://docs.astral.sh/uv/) to enable file conversion.`,
  };
}

/** Reset memoized uv resolution — test seam. */
export function resetUvCache(): void {
  cachedUvCommand = null;
}

export interface ConvertOk {
  ok: true;
  markdown: string;
}
export interface ConvertError {
  ok: false;
  error: string;
}
export type ConvertResult = ConvertOk | ConvertError;

/**
 * Convert a local file to Markdown via `uvx markitdown <file>`. Returns a
 * structured result — callers must surface `error` as a blocked/failed
 * outcome, never a hollow success. The first call warms the runtime
 * (downloads a managed Python + markitdown) and can take ~30-60s.
 */
export async function convertToMarkdown(
  filePath: string,
  opts: { timeoutMs?: number } = {},
): Promise<ConvertResult> {
  if (!existsSync(filePath)) return { ok: false, error: `File does not exist: ${filePath}` };
  return runMarkitdown(filePath, path.basename(filePath), opts);
}

/**
 * Convert a URL to Markdown. markitdown fetches it directly — used for
 * YouTube links (title + metadata + transcript) and web pages. Binary files
 * hosted at a URL (e.g. Discord CDN) should be fetched to bytes and run
 * through convertToMarkdown instead, so the file extension drives the
 * converter.
 */
export async function convertUrlToMarkdown(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<ConvertResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: `Not an http(s) URL: ${url}` };
  return runMarkitdown(url, url, opts);
}

async function runMarkitdown(
  source: string,
  label: string,
  opts: { timeoutMs?: number } = {},
): Promise<ConvertResult> {
  const uv = resolveUv();
  if ('error' in uv) return { ok: false, error: uv.error };

  const cacheDir = path.join(BASE_DIR, 'runtime', 'uv-cache');
  const pythonDir = path.join(BASE_DIR, 'runtime', 'uv-python');
  try {
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(pythonDir, { recursive: true });
  } catch {
    // mkdir failures surface below via spawn errors
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS;
  const args = ['tool', 'run', '--from', markitdownSpec(), 'markitdown', source];

  await acquireConversionSlot();
  try {
    return await new Promise<ConvertResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let outBytes = 0;
      let truncated = false;
      let settled = false;
      const done = (result: ConvertResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(uv.command, args, {
          cwd: BASE_DIR, // TCC-safe: daemon has access here
          env: {
            ...process.env,
            UV_CACHE_DIR: cacheDir,
            UV_PYTHON_INSTALL_DIR: pythonDir,
            UV_PYTHON_PREFERENCE: 'managed',
            NO_COLOR: '1',
          },
        });
      } catch (err) {
        // spawn can throw synchronously (e.g. EACCES on the binary).
        done({ ok: false, error: `Could not run the uv runtime: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }

      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        done({
          ok: false,
          error: `markitdown timed out after ${Math.round(timeoutMs / 1000)}s on ${label}. The first conversion downloads Python + markitdown; retry once it has warmed.`,
        });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (outBytes >= MAX_OUTPUT_BYTES) { truncated = true; return; }
        outBytes += chunk.length;
        // Keep at most MAX_OUTPUT_BYTES; drop the tail of an oversized doc.
        stdout += outBytes > MAX_OUTPUT_BYTES
          ? (truncated = true, chunk.toString('utf-8', 0, chunk.length - (outBytes - MAX_OUTPUT_BYTES)))
          : chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        done({ ok: false, error: `Could not run the uv runtime: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) {
          done({ ok: true, markdown: truncated ? `${stdout}\n\n…[output truncated — file too large to extract fully]` : stdout });
          return;
        }
        const detail = stderr.trim().slice(0, 500) || stdout.trim().slice(0, 500) || 'no output';
        done({ ok: false, error: `markitdown failed (exit ${code}) on ${label}: ${detail}` });
      });
    });
  } finally {
    releaseConversionSlot();
  }
}
