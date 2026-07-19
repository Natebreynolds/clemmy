#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLACEHOLDER_ACCOUNT = /^(?:\.\.\.|ci|demo|dev(?:eloper)?|example|me|nobody|placeholder|public|runner\w*|sample|shared|test(?:er)?|ubuntu|user(?:name)?|you)$/i;
const RESERVED_HOST = /^(?:localhost|(?:127(?:\.\d{1,3}){3})|::1|(?:.+\.)?(?:example|invalid|localhost|test)|example\.(?:com|net|org))$/i;
const CREDENTIAL_QUERY_KEY = /^(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|password|passwd|refresh[-_]?token|secret|token)$/i;
const ARCHIVE_EXTENSION = /\.(?:7z|bz2|dmg|gz|pkg|rar|tar|tgz|xz|zip)$/i;
const SIGNING_EXTENSION = /\.(?:cer|crt|jks|key|keystore|mobileprovision|p12|p8|pem|pfx|provisionprofile)$/i;
const STORE_EXTENSION = /\.(?:db|db-shm|db-wal|jsonl|ndjson|sqlite|sqlite3|sqlite-shm|sqlite-wal)$/i;
const GENERATED_ROOT = /^(?:\.nyc_output|\.playwright-mcp|artifacts?|coverage|output|playwright-report|run-artifacts?|run-archives?|runs|test-results)(?:\/|$)/i;
const LOCAL_AGENT_STATE = /^(?:\.codex|\.firecrawl|\.private|private)(?:\/|$)|^\.claude\/(?:agent-memory-local|agent-registry\.json|assistant-daemon-state\.json|checkpoints|first-run|mailbox|scheduled_tasks(?:\.|$)|settings\.local\.json|worktrees)(?:\/|$)/i;
const MEMORY_SNAPSHOT = /(?:^|\/)(?:facts|identity|memory|profile)(?:[._-][^/]*)?[._-](?:backup|dump|export|snapshot)(?:[._-][^/]*)?\.(?:json|jsonl|md|ndjson|txt)$/i;
const ROOT_MEDIA_EXTENSION = /\.(?:avif|avi|bmp|gif|heic|ico|jpe?g|m4v|mkv|mov|mp4|png|tiff?|webm|webp)$/i;
const ROOT_PRIVATE_WORK_PRODUCT = /^(?:(?:client|outreach|prospecting|seo)-[^/]+|[^/]+-(?:drafts|evidence|send-confirmations)-[^/]+|[^/]+-20[0-9]{2}-[0-9]{2}-[0-9]{2}\.(?:csv|json|md)|(?:lunar-audits|one-pagers|workspaces)(?:\/|$))/i;
const LIVE_SESSION_IDENTIFIER = /\bsess-m(?=[a-z0-9]{7,}(?:-[a-z0-9]{4,})?\b)(?=[a-z0-9]*\d)[a-z0-9]{7,}(?:-[a-z0-9]{4,})?\b/i;
const AIRTABLE_RESOURCE_ID = /\b(?:app|rec|tbl|viw)[A-Za-z0-9]{14}\b/g;
const SALESFORCE_RESOURCE_ID = /\b(?:001|003|005|006|00Q|500|701|a0[A-Za-z0-9])[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/g;
const GOOGLE_RESOURCE_URL = /https?:\/\/(?:docs|drive)\.google\.com\/(?:document|spreadsheets|file)\/d\/([A-Za-z0-9_-]{10,})/g;

function isPlaceholder(value) {
  return /(?:\$\{|\{\{|<[^>]+>|%[A-Z][A-Z0-9_]*%)/.test(value)
    || /\$[A-Za-z_][A-Za-z0-9_]*/.test(value)
    || /\b(?:example|placeholder|sample|synthetic|test fixture)\b/i.test(value);
}

export function classifyTrackedPath(filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized);
  const lowerBasename = basename.toLowerCase();
  const categories = new Set();

  if (/^\.env(?:\.|$)/i.test(basename) && lowerBasename !== '.env.example') {
    categories.add('environment-file');
  }
  if (SIGNING_EXTENSION.test(basename)
    || /^(?:\.netrc|\.npmrc|\.pypirc|credentials\.json|secrets\.json|service-account[^/]*\.json)$/i.test(basename)
    || /^(?:id_ed25519|id_rsa|id_ecdsa)$/i.test(basename)) {
    categories.add('credential-or-signing-file');
  }
  if (STORE_EXTENSION.test(basename)) categories.add('database-or-event-store');
  if (MEMORY_SNAPSHOT.test(normalized) || /(?:^|\/)\.clementine-next(?:\/|$)/i.test(normalized)) {
    categories.add('memory-snapshot');
  }
  if (GENERATED_ROOT.test(normalized) || ARCHIVE_EXTENSION.test(basename) || /\.(?:har|log)$/i.test(basename)) {
    categories.add('run-or-generated-artifact');
  }
  if (LOCAL_AGENT_STATE.test(normalized)) categories.add('local-agent-state');
  if (ROOT_PRIVATE_WORK_PRODUCT.test(normalized)) categories.add('private-work-product');
  if (!normalized.includes('/') && ROOT_MEDIA_EXTENSION.test(basename)) {
    categories.add('root-media-capture');
  }

  return categories;
}

function concreteCredential(value) {
  return value.length > 0 && !isPlaceholder(value);
}

function hasCredentialUrl(text) {
  const candidates = text.match(/\b(?:amqps?|ftp|https?|mongodb(?:\+srv)?|mysql|postgres(?:ql)?|redis):\/\/[^\s<>"'`]+/gi) ?? [];
  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.replace(/[),.;\]}]+$/, '');
    if (isPlaceholder(candidate)) continue;
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (RESERVED_HOST.test(url.hostname)) continue;
    if (url.password && concreteCredential(decodeURIComponent(url.password))) return true;
    for (const [key, value] of url.searchParams) {
      if (CREDENTIAL_QUERY_KEY.test(key) && concreteCredential(value)) return true;
    }
  }
  return false;
}

function isFixtureResourceId(value) {
  return isPlaceholder(value)
    || /(?:^|[-_])(?:demo|fixture|legacy|mock|preview|sample|stale|synthetic|test)(?:[-_]|$)/i.test(value)
    || /^(?:doc|sheet)[-_]/i.test(value);
}

function hasProviderResourceId(text) {
  for (const match of text.matchAll(AIRTABLE_RESOURCE_ID)) {
    const value = match[0];
    if (/\d/.test(value) && !isFixtureResourceId(value)) return true;
  }
  for (const match of text.matchAll(SALESFORCE_RESOURCE_ID)) {
    if (!isFixtureResourceId(match[0])) return true;
  }
  for (const match of text.matchAll(GOOGLE_RESOURCE_URL)) {
    if (!isFixtureResourceId(match[1])) return true;
  }
  return false;
}

export function classifyText(text) {
  const categories = new Set();

  const homePatterns = [
    /\/Users\/([A-Za-z0-9._-]+)(?:\/|(?=$|[\s"'`),.;:]))/g,
    /(?<![A-Za-z0-9._/-])\/home\/([A-Za-z0-9._-]+)\//g,
    /[A-Za-z]:[\\/]Users[\\/]([A-Za-z0-9._-]+)(?:[\\/]|(?=$|[\s"'`),.;:]))/g,
  ];
  for (const pattern of homePatterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1].length > 1 && !PLACEHOLDER_ACCOUNT.test(match[1])) categories.add('personal-home-path');
    }
  }

  for (const match of text.matchAll(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/g)) {
    const nearbyBlock = text.slice(match.index, match.index + 1024);
    if (!nearbyBlock.includes('...')) categories.add('private-key-material');
  }
  if (hasCredentialUrl(text)) categories.add('credential-bearing-url');
  if (LIVE_SESSION_IDENTIFIER.test(text)) categories.add('live-session-identifier');
  if (hasProviderResourceId(text)) categories.add('provider-resource-id');

  const signingIdentities = text.match(/\b(?:Apple Development|Apple Distribution|Developer ID Application|Developer ID Installer):[^\r\n]+/g) ?? [];
  if (signingIdentities.some((identity) => !isPlaceholder(identity))) {
    categories.add('apple-signing-identity');
  }
  const appleAssignments = text.match(/\b(?:APPLE_ID|APPLE_TEAM_ID|CSC_NAME)\s*[:=]\s*["'][^"']+["']/g) ?? [];
  if (appleAssignments.some((assignment) => !isPlaceholder(assignment))) {
    categories.add('apple-signing-identity');
  }
  if (/\b(?:APPLE_TEAM_ID|APNS_TEAM_ID)\s*[:=]\s*["']?[A-Z0-9]{10}\b/.test(text)
    || /\b--team-id(?:=|\s+)["']?[A-Z0-9]{10}\b/.test(text)) {
    categories.add('apple-signing-identity');
  }

  return categories;
}

export function scanExistingTrackedFiles(repoRoot = process.cwd()) {
  const output = execFileSync('git', ['ls-files', '--cached', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const findings = [];

  for (const filePath of output.split('\0').filter(Boolean).sort()) {
    const absolutePath = path.resolve(repoRoot, filePath);
    let stat;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;

    const categories = classifyTrackedPath(filePath);
    const content = stat.isSymbolicLink()
      ? readlinkSync(absolutePath, 'utf8')
      : readFileSync(absolutePath);
    if (typeof content === 'string' || !content.includes(0)) {
      const text = typeof content === 'string' ? content : content.toString('utf8');
      for (const category of classifyText(text)) categories.add(category);
    }
    for (const category of [...categories].sort()) findings.push({ category, filePath });
  }

  return findings;
}

export function formatFindings(findings) {
  return findings.map(({ category, filePath }) => `- ${category}: ${filePath}`).join('\n');
}

function main() {
  const findings = scanExistingTrackedFiles();
  if (findings.length === 0) {
    console.log('Public-repository hygiene check passed.');
    return;
  }
  console.error(`Public-repository hygiene check failed:\n${formatFindings(findings)}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
