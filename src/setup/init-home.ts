import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR, VAULT_DIR } from '../config.js';
import { CRON_FILE, ensureTodayNote, ensureVaultScaffold, WORKFLOWS_DIR } from '../memory/vault.js';
import { ensureTasksFile, ensureToolDirectories, replaceFile } from '../tools/shared.js';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureFile(filePath: string, content: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, content);
  }
}

async function main(): Promise<void> {
  const systemDir = path.join(VAULT_DIR, '00-System');
  const inboxDir = path.join(VAULT_DIR, '07-Inbox');
  const stateDir = path.join(BASE_DIR, 'state');
  const goalsDir = path.join(BASE_DIR, 'goals');
  const pluginsDir = path.join(BASE_DIR, 'plugins');
  const logsDir = path.join(BASE_DIR, 'logs');

  ensureVaultScaffold();
  ensureToolDirectories();
  ensureDir(systemDir);
  ensureDir(inboxDir);
  ensureDir(stateDir);
  ensureDir(goalsDir);
  ensureDir(pluginsDir);
  ensureDir(logsDir);

  ensureFile(
    path.join(systemDir, 'SOUL.md'),
    [
      '# Soul',
      '',
      'Clementine is a sharp, proactive executive assistant.',
      'She is practical, concise, and biased toward action.',
      'She tracks commitments, advances goals, and surfaces what matters.',
      'She does not wait to be asked — she notices and acts.',
      '',
    ].join('\n'),
  );
  ensureFile(path.join(systemDir, 'MEMORY.md'), '# Memory\n\n');
  ensureFile(path.join(systemDir, 'IDENTITY.md'), '# Identity\n\n');
  ensureFile(path.join(BASE_DIR, 'working-memory.md'), '# Working Memory\n\n');

  // Pre-configured cron jobs that make the agent proactive by default
  ensureFile(
    CRON_FILE,
    [
      '---',
      'jobs:',
      '  - name: morning-briefing',
      '    schedule: "0 8 * * 1-5"',
      '    enabled: true',
      '    prompt: |',
      '      Good morning. Give a concise briefing for today:',
      '      1. List any overdue or high-priority tasks',
      '      2. Summarize the top 1-3 active goals and their next actions',
      '      3. Note anything from working memory worth acting on today',
      '      4. End with a single sentence: the most important thing to do right now.',
      '      Keep the whole briefing under 200 words.',
      '  - name: end-of-day',
      '    schedule: "0 17 * * 1-5"',
      '    enabled: true',
      '    prompt: |',
      '      End-of-day wrap-up. Do the following:',
      '      1. Review any tasks completed or updated today and note them',
      '      2. Flag anything urgent or overdue that still needs attention',
      '      3. Write a one-sentence intention for tomorrow into the daily note',
      '      4. Update working memory with anything worth remembering.',
      '      Be brief and action-oriented.',
      '  - name: weekly-review',
      '    schedule: "0 9 * * 1"',
      '    enabled: true',
      '    prompt: |',
      '      Weekly review. Check the state of all active goals:',
      '      1. For each active goal, assess progress and update its status/next actions',
      '      2. Identify any goals that are blocked or stale (no recent progress)',
      '      3. Suggest the single highest-leverage thing to work on this week',
      '      4. Write a brief weekly summary to the daily note.',
      '---',
      '',
      '# Cron Jobs',
      '',
      'Edit the jobs list above to add, remove, or disable scheduled jobs.',
      'Schedule format: minute hour day-of-month month day-of-week (standard cron)',
      '',
    ].join('\n'),
  );

  ensureFile(
    path.join(WORKFLOWS_DIR, 'daily-summary.md'),
    [
      '---',
      'name: daily-summary',
      'description: On-demand daily summary workflow.',
      'enabled: true',
      'trigger:',
      '  manual: true',
      'steps:',
      '  - id: summarize',
      '    prompt: |',
      '      Summarize the most important open work for today.',
      '      Include: top tasks, active goals, working memory highlights.',
      '      Be concise — this is a quick situational brief, not an essay.',
      '---',
      '',
      '# Daily Summary',
      '',
      'Run manually via: clementine workflow run daily-summary',
      '',
    ].join('\n'),
  );

  // Example goal to show the format
  const exampleGoalPath = path.join(goalsDir, 'example.json');
  ensureFile(
    exampleGoalPath,
    JSON.stringify({
      id: 'example',
      title: 'Example: Replace this with your first real goal',
      description: 'This is a placeholder goal. Edit or delete this file and create your own goals using the goal_create tool or by adding JSON files to ~/.clementine-next/goals/.',
      owner: 'clementine',
      priority: 'low',
      status: 'paused',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reviewFrequency: 'on-demand',
      progressNotes: [],
      nextActions: ['Delete this file and create a real goal'],
      blockers: [],
      linkedCronJobs: [],
    }, null, 2) + '\n',
  );

  ensureTasksFile();
  ensureTodayNote();

  const envExamplePath = path.join(path.resolve(BASE_DIR, '..', '..') === path.resolve('/') ? BASE_DIR : path.resolve(process.cwd()), '.env.example');
  const envPath = path.join(path.resolve(process.cwd()), '.env');
  if (!existsSync(envPath) && existsSync(envExamplePath)) {
    const example = `OPENAI_API_KEY=\nAUTH_MODE=api_key\nCODEX_AUTH_SOURCE_FILE=~/.codex/auth.json\nOPENAI_MODEL_PRIMARY=gpt-5.4\nOPENAI_MODEL_FAST=gpt-5.4-mini\nOPENAI_MODEL_DEEP=gpt-5.4\nCLEMENTINE_HOME=${BASE_DIR}\nASSISTANT_NAME=Clementine\nOWNER_NAME=\nWEBHOOK_ENABLED=true\nWEBHOOK_PORT=8420\nWEBHOOK_SECRET=change-me-local-secret\nDISCORD_ENABLED=false\nDISCORD_BOT_TOKEN=\nDISCORD_REQUIRE_MENTION=true\nDISCORD_ALLOWED_CHANNELS=\nLOCAL_MCP_ENABLED=true\nAUTONOMY_V2_AGENTS=clementine\nAUTONOMY_ORCHESTRATOR_SLUGS=\nCOMPOSIO_API_KEY=\nCOMPOSIO_USER_ID=default\nWORKSPACE_DIRS=\n`;
    replaceFile(envPath, example);
  }

  console.log(`Initialized Clementine home at ${BASE_DIR}`);
}

export async function initHome(): Promise<void> {
  await main();
}
