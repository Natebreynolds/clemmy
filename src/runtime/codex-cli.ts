import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pino from 'pino';
import { CODEX_EXECUTABLE, CODEX_SANDBOX_MODE, CODEX_USE_FULL_AUTO } from '../config.js';
import type { ApprovalResolutionResult, PendingApproval, RunRequest, RunResult } from '../types.js';
import { AgentRuntimeCancelledError, ASSISTANT_PAUSED_PLACEHOLDER, type AgentRuntime, type AgentRuntimeCallbacks } from './provider.js';

const logger = pino({ name: 'clementine-next.codex-cli' });

function runCodexExec(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_EXECUTABLE, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `codex exec exited with code ${code ?? 1}`));
    });
  });
}

export class CodexCliRuntime implements AgentRuntime {
  listPendingApprovals(): PendingApproval[] {
    return [];
  }

  async resolveApproval(_approvalId: string, _approved: boolean): Promise<ApprovalResolutionResult> {
    throw new Error('Approval resolution is not supported in codex_oauth mode. Codex CLI handles its own execution flow.');
  }

	  async run(request: RunRequest, callbacks?: AgentRuntimeCallbacks): Promise<RunResult> {
	    if (await callbacks?.shouldCancel?.()) {
	      throw new AgentRuntimeCancelledError();
	    }
	    const sessionId = request.sessionId ?? randomUUID();
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'clementine-codex-'));
    const outputPath = path.join(tempDir, 'last-message.txt');

    const prompt = [
      request.instructions ? `System instructions:\n${request.instructions}` : '',
      request.channel ? `Channel: ${request.channel}` : '',
      request.userId ? `User: ${request.userId}` : '',
      request.prompt,
    ].filter(Boolean).join('\n\n');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      CODEX_SANDBOX_MODE,
      '-o',
      outputPath,
    ];

    if (CODEX_USE_FULL_AUTO) {
      args.push('--full-auto');
    }
    // Don't pass -m when using ChatGPT/Codex OAuth — the account enforces its own model.
    // Only pass model when AUTH_MODE=api_key and a model is explicitly configured.
    args.push(prompt);

    try {
      await runCodexExec(args, process.cwd());
	      if (await callbacks?.shouldCancel?.()) {
	        throw new AgentRuntimeCancelledError();
	      }
	      const text = existsSync(outputPath)
        ? readFileSync(outputPath, 'utf-8').trim()
        : '';
      const finalText = text || ASSISTANT_PAUSED_PLACEHOLDER;
      if (callbacks?.onText) {
        await callbacks.onText(finalText);
      }
      return {
        text: finalText,
        sessionId,
      };
    } catch (error) {
      logger.error({ err: error, sessionId }, 'Codex exec failed');
      throw error;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
