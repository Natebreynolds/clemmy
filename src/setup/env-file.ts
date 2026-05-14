import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    result[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return result;
}

export function stringifyEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

export function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, 'utf-8'));
}

export function writeEnvFile(filePath: string, values: Record<string, string>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, stringifyEnv(values), { encoding: 'utf-8', mode: 0o600 });
}
