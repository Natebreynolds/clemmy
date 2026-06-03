/**
 * Auto-generated MEMORY.md builder.
 *
 * Background: MEMORY.md sits at ~/.clementine-next/vault/00-System/MEMORY.md
 * and is one of the files the agent reads on every turn (loadMemoryContext
 * in vault.ts). On a fresh install it's just "# Memory\n\n" and stays
 * that way forever unless the USER manually edits it — the agent writes
 * durable signals to the consolidated_facts SQLite table instead, which
 * is fine for retrieval but means the human-readable file looks broken.
 *
 * This module fixes that asymmetry: on a schedule (every ~30 minutes via
 * the memory maintenance tick) we regenerate the AUTO-GENERATED section
 * of MEMORY.md by reading the top active facts from the database and
 * formatting them as Markdown grouped by kind.
 *
 * Two-section design preserves anything the user wrote:
 *
 *   # Memory
 *
 *   <user-curated content here — anything you write is preserved>
 *
 *   <!-- AUTO-GENERATED — do not edit below this line, will be overwritten. -->
 *
 *   ## Learned facts
 *   ...
 *
 * On every regeneration we split at the marker, keep everything above
 * verbatim, replace everything below. If the marker is missing (fresh
 * install or human deleted it), we treat the file as "user wrote
 * everything except auto" and APPEND the auto section. If the user
 * wants to remove the auto section entirely, they can delete the marker
 * + everything below and we'll re-append on next tick (which is the
 * point — we want the file alive).
 *
 * Safety: atomic write via tmp + rename. No-op if the rendered auto
 * section is identical to what's already in the file (avoids endless
 * mtime churn that would trigger the vault reindexer for no reason).
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pino from 'pino';
import { MEMORY_FILE, MEMORY_PROMPT_READ_CHARS } from './vault.js';
import { listActiveFacts, countActiveFacts, type ConsolidatedFact } from './facts.js';

const logger = pino({ name: 'clementine-next.memory.md-builder' });

/**
 * Marker comment that separates user-curated content (above) from the
 * auto-generated section (below). Stable across versions so existing
 * files keep splitting correctly after upgrades.
 */
const AUTO_MARKER = '<!-- AUTO-GENERATED · do not edit below this line — overwritten on next refresh -->';

/** Maximum facts to include in each kind's section. The file is read
 *  into the agent's instructions on every turn — a 200-fact dump
 *  would blow the prompt window. 10/kind = 40 max, well under budget. */
const MAX_FACTS_PER_KIND = 10;

/** Hard cap on the auto section's length in characters. Belt-and-
 *  suspenders alongside MAX_FACTS_PER_KIND — if individual fact
 *  contents are unusually long, we still bound the total. */
const MAX_AUTO_SECTION_CHARS = 6000;

interface FactSection {
  kind: ConsolidatedFact['kind'];
  heading: string;
  description: string;
}

const SECTIONS: FactSection[] = [
  { kind: 'user',      heading: '## User', description: 'Who Nate is, role, preferences, working style.' },
  { kind: 'project',   heading: '## Projects', description: 'Active work, requirements, decisions in flight.' },
  { kind: 'feedback',  heading: '## Feedback', description: 'Standing direction on how to behave or what to avoid.' },
  { kind: 'reference', heading: '## References', description: 'External resources, URLs, docs to consult.' },
];

/**
 * Split the existing file into (userPart, autoPart). If the marker is
 * absent, treats the whole file as user content and returns empty
 * autoPart. The user part KEEPS the marker — that way the next write
 * re-emits the same separator without us needing to inject it.
 */
function splitAtMarker(existing: string): { userPart: string; hadMarker: boolean } {
  const idx = existing.indexOf(AUTO_MARKER);
  if (idx === -1) {
    // No marker — preserve everything, the writer will append the marker
    // + auto section below.
    return { userPart: existing.replace(/\s+$/, ''), hadMarker: false };
  }
  // Everything up to (and including) the marker — STRIP the marker so
  // the writer's render places it once. We keep just the user content
  // and a trailing newline.
  return { userPart: existing.slice(0, idx).replace(/\s+$/, ''), hadMarker: true };
}

function formatFact(fact: ConsolidatedFact): string {
  // Single-line, leading bullet. Strip newlines from content because
  // multi-line bullets break Markdown rendering and the agent's
  // instructions string. Score is appended in muted parens so the
  // user can see relative confidence without scanning a separate
  // column.
  const content = fact.content.replace(/\s+/g, ' ').trim();
  const score = fact.score >= 1.05 ? ` _(score ${fact.score.toFixed(2)})_` : '';
  return `- ${content}${score}`;
}

/**
 * Render the auto-generated section body. Returns the section text
 * WITHOUT the marker comment itself — the caller adds the marker.
 */
function renderAutoSection(facts: ConsolidatedFact[], now: Date): string {
  if (facts.length === 0) {
    return [
      '',
      `_Auto-regenerated ${now.toISOString()} · 0 active facts. The agent will populate this as it learns durable signals (preferences, project context, standing feedback)._`,
      '',
    ].join('\n');
  }

  const byKind = new Map<ConsolidatedFact['kind'], ConsolidatedFact[]>();
  for (const fact of facts) {
    const bucket = byKind.get(fact.kind) ?? [];
    bucket.push(fact);
    byKind.set(fact.kind, bucket);
  }
  // Sort each bucket by score desc, then most-recent first.
  for (const bucket of byKind.values()) {
    bucket.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
  }

  const lines: string[] = [
    '',
    `_Auto-regenerated ${now.toISOString()} from \`consolidated_facts\` · ${facts.length} active facts._`,
    '_Edit the user section above; this section is overwritten on every refresh tick._',
    '',
  ];

  for (const section of SECTIONS) {
    const bucket = byKind.get(section.kind) ?? [];
    if (bucket.length === 0) continue;
    lines.push(section.heading);
    lines.push(`_${section.description}_`);
    lines.push('');
    const limited = bucket.slice(0, MAX_FACTS_PER_KIND);
    for (const fact of limited) lines.push(formatFact(fact));
    if (bucket.length > limited.length) {
      lines.push(`- _… and ${bucket.length - limited.length} more (truncated; raise MAX_FACTS_PER_KIND if you need them all)._`);
    }
    lines.push('');
  }

  const rendered = lines.join('\n');
  if (rendered.length <= MAX_AUTO_SECTION_CHARS) return rendered;
  // Hard cap — keep the first MAX_AUTO_SECTION_CHARS and add an
  // elided-tail notice so the agent's instructions stay bounded.
  return rendered.slice(0, MAX_AUTO_SECTION_CHARS) + '\n\n_… (truncated to fit prompt budget; raise MAX_AUTO_SECTION_CHARS if you need the full list)._\n';
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, filePath);
}

export interface RegenerateMemoryMdResult {
  written: boolean;
  reason?: 'unchanged' | 'no-facts' | 'first-write' | 'updated';
  factCount: number;
  autoSectionChars: number;
  hadMarker: boolean;
  /** Tier C1: total assembled file length in chars. */
  totalChars: number;
  /** Tier C1: true when the assembled file exceeds the prompt read budget
   *  (MEMORY_PROMPT_READ_CHARS), so its tail is clipped from the per-turn
   *  injection. NOT data loss — facts are independently injected via
   *  renderFactsForInstructions (the SQLite stream) — but the human-readable
   *  MEMORY.md view in the prompt is truncated. Surfaced so the owner/doctor
   *  can see it instead of silent clipping. */
  promptTruncated: boolean;
}

/**
 * Regenerate the auto section of MEMORY.md. Safe to call on every
 * maintenance tick — no-op when the rendered auto section matches
 * what's already on disk.
 *
 * Returns metadata so the caller (maintenance.ts) can decide whether
 * to log. Convention: log only when content changed.
 */
export function regenerateMemoryMd(): RegenerateMemoryMdResult {
  const factCount = countActiveFacts();
  // Pull more than we'll render so the per-kind sort has enough
  // headroom. MAX_FACTS_PER_KIND * SECTIONS.length is the rendered
  // ceiling; we ask for 4x that to give the sort some slack across
  // kinds even when one kind dominates the active list.
  const facts = listActiveFacts({ limit: MAX_FACTS_PER_KIND * SECTIONS.length * 4 });

  const existing = existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, 'utf-8') : '# Memory\n\n';
  const { userPart, hadMarker } = splitAtMarker(existing);

  const autoBody = renderAutoSection(facts, new Date());
  // Assemble final file: user-section + marker + auto-body.
  // If the user section is just "# Memory" (the init seed), keep it as
  // the title; otherwise preserve verbatim.
  const userTrimmed = userPart.trim();
  const userBlock = userTrimmed.length > 0 ? userTrimmed + '\n\n' : '# Memory\n\n';
  const next = `${userBlock}${AUTO_MARKER}\n${autoBody}`;

  // The auto-section header includes a regen timestamp for the user's
  // benefit. Strip it from BOTH sides before comparing so a no-op call
  // (same facts, same content, fresh timestamp) is detected as
  // unchanged. Without this, every tick writes — the test suite
  // happened to pass because consecutive calls fired in the same
  // millisecond, but the maintenance loop has 30-min gaps.
  const totalChars = next.length;
  const promptTruncated = totalChars > MEMORY_PROMPT_READ_CHARS;

  const normalizeForDiff = (s: string) => s.replace(/_Auto-regenerated [^_]+_/g, '_Auto-regenerated <ts>_');
  if (normalizeForDiff(next) === normalizeForDiff(existing)) {
    return { written: false, reason: 'unchanged', factCount, autoSectionChars: autoBody.length, hadMarker, totalChars, promptTruncated };
  }
  atomicWrite(MEMORY_FILE, next);
  return {
    written: true,
    reason: hadMarker ? (factCount === 0 ? 'no-facts' : 'updated') : 'first-write',
    factCount,
    autoSectionChars: autoBody.length,
    hadMarker,
    totalChars,
    promptTruncated,
  };
}

/** Force-regen + log. Convenience entry point for the maintenance tick
 *  and any future "Regenerate MEMORY.md now" dashboard button. */
export function tickMemoryMdRefresh(): void {
  try {
    const result = regenerateMemoryMd();
    if (result.written) {
      logger.info({ result }, 'MEMORY.md refreshed');
    }
    // Tier C1: warn (not silent) when the assembled file is larger than the
    // per-turn prompt budget so its tail is clipped from the injected view.
    // Facts are still injected via renderFactsForInstructions, so this is a
    // visibility signal, not data loss. Fires at most once per ~30-min tick
    // and only while overflowing.
    if (result.promptTruncated) {
      logger.warn(
        { totalChars: result.totalChars, readBudget: MEMORY_PROMPT_READ_CHARS, factCount: result.factCount },
        'MEMORY.md exceeds the prompt read budget — its tail is clipped from the injected view (facts still injected via the SQLite stream)',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'MEMORY.md refresh failed');
  }
}
