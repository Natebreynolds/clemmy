import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMemoryHealthSummary } from './facts.js';
import { readHygieneAudit } from './hygiene-audit.js';
import { readFactRecallTrace } from './recall-trace.js';
import { detectMemoryHealCandidates, listProposedMemoryFixes } from './self-heal.js';
import { listSkills } from './skill-store.js';
import { listToolChoices, computeChoiceScore } from './tool-choice-store.js';
import { listWorkflows } from './workflow-store.js';

export interface CuratorFinding {
  severity: 'info' | 'warn';
  area: 'memory' | 'skills' | 'tools' | 'workflows';
  message: string;
  count?: number;
  names?: string[];
}

export interface CuratorReport {
  id: string;
  generatedAt: string;
  mode: 'report-only';
  mutationApplied: false;
  counts: {
    activeFacts: number;
    pinnedFacts: number;
    skills: number;
    draftSkills: number;
    quarantinedSkills: number;
    workflows: number;
    disabledWorkflows: number;
    toolChoices: number;
    weakToolChoices: number;
    recentHygieneEvents: number;
    memorySelfHealProposals: number;
    pendingMemorySelfHealProposals: number;
    currentMemorySelfHealCandidates: number;
    recentFactRecallTraceEntries: number;
    recentFactRecallDistinctFacts: number;
  };
  findings: CuratorFinding[];
  recommendations: string[];
}

const CURATOR_DIR = path.join(BASE_DIR, 'state', 'curator');

function dayStamp(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

function safeNames(names: string[], max = 8): string[] {
  return names.filter(Boolean).slice(0, max);
}

export function buildReportOnlyCuratorReport(now = new Date()): CuratorReport {
  const generatedAt = now.toISOString();
  const memory = getMemoryHealthSummary();
  const skills = listSkills();
  const workflows = listWorkflows();
  const choices = listToolChoices();
  const hygiene = readHygieneAudit(20);
  const healProposals = listProposedMemoryFixes();
  const currentHealCandidates = detectMemoryHealCandidates({
    maxCandidates: 20,
    nowIso: generatedAt,
    persistProposals: false,
  });
  const recallTrace = readFactRecallTrace(200);

  const draftSkills = skills.filter((skill) => skill.frontmatter.tier === 'draft');
  const quarantinedSkills = skills.filter((skill) => skill.frontmatter.quarantined === true);
  const disabledWorkflows = workflows.filter((workflow) => workflow.data.enabled === false);
  const weakChoices = choices.filter((record) => computeChoiceScore(record.choice) < 0.4);
  const pendingHealProposals = healProposals.filter((proposal) => (proposal.status ?? 'pending') === 'pending');
  const pendingHealIds = new Set(pendingHealProposals.map((proposal) => proposal.id));
  const newCurrentHealCandidates = currentHealCandidates.filter((candidate) => !pendingHealIds.has(candidate.id));
  const recalledFactIds = new Set<number>();
  for (const entry of recallTrace) {
    for (const fact of entry.facts) recalledFactIds.add(fact.id);
  }
  const findings: CuratorFinding[] = [];

  if (memory.recallHitRate !== null && memory.recallHitRate < 0.25) {
    findings.push({
      severity: 'warn',
      area: 'memory',
      message: 'Memory recall hit-rate is low; inspect whether facts are too broad, stale, or missing embeddings.',
    });
  }
  if (memory.pinned > 24) {
    findings.push({
      severity: 'warn',
      area: 'memory',
      message: 'Pinned facts are high enough to pressure the prompt budget.',
      count: memory.pinned,
    });
  }
  if (pendingHealProposals.length > 0) {
    findings.push({
      severity: 'info',
      area: 'memory',
      message: 'Memory self-heal has pending reversible proposals to review or apply.',
      count: pendingHealProposals.length,
      names: safeNames(pendingHealProposals.map((proposal) => `${proposal.kind}:${proposal.id}`)),
    });
  }
  if (newCurrentHealCandidates.length > 0) {
    findings.push({
      severity: 'info',
      area: 'memory',
      message: 'Memory self-heal has current reversible candidates available to preview.',
      count: newCurrentHealCandidates.length,
      names: safeNames(newCurrentHealCandidates.map((candidate) => `${candidate.kind}:${candidate.id}`)),
    });
  }
  if (recallTrace.length > 0 && recalledFactIds.size <= Math.max(2, Math.floor(recallTrace.length / 20))) {
    findings.push({
      severity: 'info',
      area: 'memory',
      message: 'Recent fact recall is concentrated on a small set of facts; inspect for overexposure or missing scoped recall.',
      count: recalledFactIds.size,
    });
  }
  if (draftSkills.length > 0) {
    findings.push({
      severity: 'info',
      area: 'skills',
      message: 'Draft skills are present and should be reviewed for approval, merge, or quarantine.',
      count: draftSkills.length,
      names: safeNames(draftSkills.map((skill) => skill.name)),
    });
  }
  if (quarantinedSkills.length > 0) {
    findings.push({
      severity: 'warn',
      area: 'skills',
      message: 'Quarantined skills remain installed; keep, repair, or archive them deliberately.',
      count: quarantinedSkills.length,
      names: safeNames(quarantinedSkills.map((skill) => skill.name)),
    });
  }
  if (weakChoices.length > 0) {
    findings.push({
      severity: 'warn',
      area: 'tools',
      message: 'Remembered tool choices have weak outcome confidence.',
      count: weakChoices.length,
      names: safeNames(weakChoices.map((choice) => choice.intent)),
    });
  }
  if (disabledWorkflows.length > 0) {
    findings.push({
      severity: 'info',
      area: 'workflows',
      message: 'Disabled workflows remain in the library; review whether they should stay parked.',
      count: disabledWorkflows.length,
      names: safeNames(disabledWorkflows.map((workflow) => workflow.name)),
    });
  }

  const recommendations = findings.length === 0
    ? ['No curator action recommended. Keep report-only mode enabled to watch drift.']
    : findings.map((finding) => `${finding.area}: ${finding.message}`);

  return {
    id: `curator-${dayStamp(now)}`,
    generatedAt,
    mode: 'report-only',
    mutationApplied: false,
    counts: {
      activeFacts: memory.activeFacts,
      pinnedFacts: memory.pinned,
      skills: skills.length,
      draftSkills: draftSkills.length,
      quarantinedSkills: quarantinedSkills.length,
      workflows: workflows.length,
      disabledWorkflows: disabledWorkflows.length,
      toolChoices: choices.length,
      weakToolChoices: weakChoices.length,
      recentHygieneEvents: hygiene.length,
      memorySelfHealProposals: healProposals.length,
      pendingMemorySelfHealProposals: pendingHealProposals.length,
      currentMemorySelfHealCandidates: currentHealCandidates.length,
      recentFactRecallTraceEntries: recallTrace.length,
      recentFactRecallDistinctFacts: recalledFactIds.size,
    },
    findings,
    recommendations,
  };
}

export function curatorReportPath(report: Pick<CuratorReport, 'id'>): string {
  return path.join(CURATOR_DIR, `${report.id}.json`);
}

export function writeCuratorReport(report: CuratorReport): string {
  if (!existsSync(CURATOR_DIR)) mkdirSync(CURATOR_DIR, { recursive: true });
  const filePath = curatorReportPath(report);
  writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
  writeFileSync(path.join(CURATOR_DIR, 'latest.json'), JSON.stringify(report, null, 2), 'utf-8');
  return filePath;
}

export function runReportOnlyCurator(now = new Date()): { report: CuratorReport; path: string } {
  const report = buildReportOnlyCuratorReport(now);
  return { report, path: writeCuratorReport(report) };
}
