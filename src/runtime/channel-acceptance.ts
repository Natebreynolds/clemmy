import type { NotificationDestination } from './notifications.js';

export type ChannelAcceptanceSurface = 'slack' | 'discord';
export type ChannelAcceptanceStatus = 'passed' | 'failed' | 'skipped';

export interface ChannelAcceptanceResult {
  id: string;
  name: string;
  type: NotificationDestination['type'];
  surface: ChannelAcceptanceSurface;
  status: ChannelAcceptanceStatus;
  message: string;
  startedAt: string;
  completedAt: string;
}

export interface ChannelAcceptanceReport {
  generatedAt: string;
  live: boolean;
  status: ChannelAcceptanceStatus;
  passed: number;
  failed: number;
  skipped: number;
  results: ChannelAcceptanceResult[];
}

export interface RunChannelAcceptanceInput {
  destinations: NotificationDestination[];
  live?: boolean;
  now?: () => string;
  deliver: (destination: NotificationDestination) => Promise<void>;
}

function surfaceForDestination(type: NotificationDestination['type']): ChannelAcceptanceSurface | null {
  if (type.startsWith('slack_')) return 'slack';
  if (type.startsWith('discord_')) return 'discord';
  return null;
}

function overallStatus(results: ChannelAcceptanceResult[]): ChannelAcceptanceStatus {
  if (results.some((result) => result.status === 'failed')) return 'failed';
  if (results.some((result) => result.status === 'passed')) return 'passed';
  return 'skipped';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runChannelAcceptance(input: RunChannelAcceptanceInput): Promise<ChannelAcceptanceReport> {
  const now = input.now ?? (() => new Date().toISOString());
  const live = input.live !== false;
  const candidates = input.destinations
    .map((destination) => ({ destination, surface: surfaceForDestination(destination.type) }))
    .filter((entry): entry is { destination: NotificationDestination; surface: ChannelAcceptanceSurface } => Boolean(entry.surface));
  const results: ChannelAcceptanceResult[] = [];

  for (const { destination, surface } of candidates) {
    const startedAt = now();
    if (!destination.enabled) {
      results.push({
        id: destination.id,
        name: destination.name,
        type: destination.type,
        surface,
        status: 'skipped',
        message: 'Route is disabled.',
        startedAt,
        completedAt: now(),
      });
      continue;
    }

    if (!live) {
      results.push({
        id: destination.id,
        name: destination.name,
        type: destination.type,
        surface,
        status: 'skipped',
        message: 'Dry run only; no message was sent.',
        startedAt,
        completedAt: now(),
      });
      continue;
    }

    try {
      await input.deliver(destination);
      results.push({
        id: destination.id,
        name: destination.name,
        type: destination.type,
        surface,
        status: 'passed',
        message: 'Live test message delivered.',
        startedAt,
        completedAt: now(),
      });
    } catch (err) {
      results.push({
        id: destination.id,
        name: destination.name,
        type: destination.type,
        surface,
        status: 'failed',
        message: errorMessage(err),
        startedAt,
        completedAt: now(),
      });
    }
  }

  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const skipped = results.filter((result) => result.status === 'skipped').length;
  return {
    generatedAt: now(),
    live,
    status: overallStatus(results),
    passed,
    failed,
    skipped,
    results,
  };
}
