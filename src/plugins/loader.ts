import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import type { ClementinePlugin } from './types.js';

const logger = pino({ name: 'clementine-next.plugins' });

const PLUGINS_DIR = path.join(BASE_DIR, 'plugins');

interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
}

function readManifest(pluginDir: string): PluginManifest {
  const pkgPath = path.join(pluginDir, 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as PluginManifest;
  } catch {
    return {};
  }
}

function resolvePluginEntry(pluginDir: string): string | null {
  const manifest = readManifest(pluginDir);
  const candidates = [
    manifest.main,
    'index.js',
    'index.cjs',
    'dist/index.js',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const full = path.join(pluginDir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function normalizePlugin(raw: unknown, fallbackName: string): ClementinePlugin | null {
  // Support both `export default { ... }` and `module.exports = { ... }`
  const obj = raw && typeof raw === 'object'
    ? ('default' in raw ? (raw as Record<string, unknown>).default : raw)
    : null;

  if (!obj || typeof obj !== 'object') return null;
  const candidate = obj as Partial<ClementinePlugin>;
  if (!candidate.name && !candidate.tools) return null;

  return {
    name: candidate.name ?? fallbackName,
    version: candidate.version,
    description: candidate.description,
    tools: Array.isArray(candidate.tools) ? candidate.tools : [],
    onLoad: typeof candidate.onLoad === 'function' ? candidate.onLoad : undefined,
  };
}

async function loadPluginFromDir(pluginDir: string, dirName: string): Promise<ClementinePlugin | null> {
  const entryPath = resolvePluginEntry(pluginDir);
  if (!entryPath) {
    logger.warn({ pluginDir }, 'Plugin has no entry point (index.js or package.json main)');
    return null;
  }

  try {
    const fileUrl = pathToFileURL(entryPath).href;
    const raw = await import(fileUrl) as unknown;
    const plugin = normalizePlugin(raw, dirName);
    if (!plugin) {
      logger.warn({ entryPath }, 'Plugin entry did not export a valid ClementinePlugin object');
      return null;
    }
    if (plugin.onLoad) {
      await plugin.onLoad();
    }
    return plugin;
  } catch (err) {
    logger.error({ err, entryPath }, 'Failed to load plugin');
    return null;
  }
}

/**
 * Loads all plugins from ~/.clementine-next/plugins/<name>/index.js
 * Each subdirectory is treated as a plugin package.
 */
export async function loadPlugins(): Promise<ClementinePlugin[]> {
  if (!existsSync(PLUGINS_DIR)) return [];

  const plugins: ClementinePlugin[] = [];
  let dirs: string[] = [];

  try {
    dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  for (const dirName of dirs) {
    const pluginDir = path.join(PLUGINS_DIR, dirName);
    const plugin = await loadPluginFromDir(pluginDir, dirName);
    if (plugin) {
      plugins.push(plugin);
      logger.info({ name: plugin.name, version: plugin.version, tools: plugin.tools?.length ?? 0 }, 'Plugin loaded');
    }
  }

  return plugins;
}

export { PLUGINS_DIR };
