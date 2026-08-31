/**
 * Install host-reviewed catalog CLI reads into the closed descriptor registry.
 *
 * PATH discovery never calls this. A catalog `reviewedRead` contract is the
 * human review; this module copies that contract onto a currently connected
 * catalog row whose executable still resolves. Forgotten or disconnected
 * catalog rows are removed. Operator-provisioned non-catalog descriptors are
 * left untouched.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import {
  CLI_CATALOG,
  readConnectedClis,
  readForgottenCliIds,
  type CatalogReviewedReadV1,
  type CliCatalogEntry,
} from '../../integrations/cli-catalog/catalog.js';
import { findSafeCliCommand } from '../cli-discovery.js';
import { getSavedClis } from '../saved-clis.js';
import { recordCapabilityOperations } from '../../memory/capability-index.js';
import {
  currentReviewedCliDescriptor,
  REVIEWED_CLI_READ_ACCOUNT,
  REVIEWED_CLI_READ_CARRIER,
  listReviewedCliReadDescriptors,
  provisionReviewedCliReadDescriptor,
  removeReviewedCliReadDescriptor,
  type ReviewedCliReadDescriptorV1,
} from './reviewed-cli-read-config.js';

const logger = pino({ name: 'clementine-next.catalog-reviewed-cli' });

export interface ReconcileCatalogReviewedCliReadsResult {
  provisioned: string[];
  removed: string[];
  skipped: string[];
}

function catalogReviewedReads(): readonly (CliCatalogEntry & { reviewedRead: CatalogReviewedReadV1 })[] {
  return CLI_CATALOG.filter((entry): entry is CliCatalogEntry & { reviewedRead: CatalogReviewedReadV1 } => (
    entry.reviewedRead !== undefined
  ));
}

/**
 * The user has two ways to say "use this CLI", and both must count.
 *
 * `readConnectedClis()` records a catalog connect. But the desktop app also
 * lets the user SAVE a CLI by name, and that list is the older and more
 * deliberate signal — saved-clis.ts exists precisely because tools like `sf`
 * EPERM under the daemon (macOS TCC) and can never be PATH-scanned, so saving
 * is the ONLY way they become known at all. Keying eligibility on the connect
 * registry alone meant a user could save a CLI, see it offered by
 * local_cli_list, and still have every plan citing it refused as undisclosed —
 * measured live 2026-08-28 with `sf` in CLEMMY_SAVED_CLIS and no catalog
 * connect state on disk at all.
 *
 * Matching is on the catalog `command`, because that is what the user types
 * into the save box; the catalog `id` is an internal key they never see.
 */
function userConfirmedCliCommands(): ReadonlySet<string> {
  return new Set(
    getSavedClis()
      .map((command) => command.trim().toLowerCase())
      .filter((command) => command.length > 0),
  );
}

function entryIsUserConfirmed(
  entry: CliCatalogEntry,
  connected: Readonly<Record<string, unknown>>,
  saved: ReadonlySet<string>,
): boolean {
  return Boolean(connected[entry.id]) || saved.has(entry.command.trim().toLowerCase());
}

function sameClosedContract(
  existing: ReviewedCliReadDescriptorV1,
  contract: CatalogReviewedReadV1,
  executableRealpath: string,
): boolean {
  return existing.descriptorId === contract.descriptorId
    && existing.operationId === contract.operationId
    && existing.displayName === contract.displayName
    && existing.description === contract.description
    && existing.executableRealpath === executableRealpath
    && existing.argvPrefix.length === contract.argvPrefix.length
    && existing.argvPrefix.every((token, index) => token === contract.argvPrefix[index])
    && existing.arguments.length === contract.arguments.length
    && existing.arguments.every((argument, index) => {
      const expected = contract.arguments[index];
      return expected !== undefined
        && argument.name === expected.name
        && argument.kind === expected.kind
        && argument.token === expected.token
        && argument.valueType === expected.valueType
        && argument.required === expected.required;
    })
    && existing.limits.timeoutMs === contract.limits.timeoutMs
    && existing.limits.maxStdoutBytes === contract.limits.maxStdoutBytes
    && existing.limits.maxStderrBytes === contract.limits.maxStderrBytes
    && existing.limits.maxArgumentBytes === contract.limits.maxArgumentBytes;
}

function indexReviewedRead(descriptor: ReviewedCliReadDescriptorV1): void {
  recordCapabilityOperations([{
    identifier: descriptor.operationId,
    carrierKind: 'cli',
    carrier: REVIEWED_CLI_READ_CARRIER,
    displayName: descriptor.displayName,
    description: descriptor.description,
    effectClass: 'read',
    effectProvenance: 'curated',
    accountIdentity: REVIEWED_CLI_READ_ACCOUNT,
    parentIdentifier: descriptor.descriptorId,
  }]);
}

/**
 * @param rehash When true (daemon boot), replace a same-path descriptor whose
 * executable bytes changed. Dashboard polls skip that hash.
 */
export async function reconcileCatalogReviewedCliReads(
  options: { rehash?: boolean } = {},
): Promise<ReconcileCatalogReviewedCliReadsResult> {
  const rehash = options.rehash === true;
  const connected = readConnectedClis();
  const saved = userConfirmedCliCommands();
  const forgotten = new Set(readForgottenCliIds());
  const provisioned: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const catalogByDescriptor = new Map(
    catalogReviewedReads().map((entry) => [entry.reviewedRead.descriptorId, entry] as const),
  );

  for (const existing of listReviewedCliReadDescriptors()) {
    const catalog = catalogByDescriptor.get(existing.descriptorId);
    if (!catalog) continue;
    if (!entryIsUserConfirmed(catalog, connected, saved) || forgotten.has(catalog.id)) {
      const dropped = await removeReviewedCliReadDescriptor(existing.descriptorId);
      if (dropped) removed.push(existing.descriptorId);
    }
  }

  for (const entry of catalogReviewedReads()) {
    const contract = entry.reviewedRead;
    if (!entryIsUserConfirmed(entry, connected, saved) || forgotten.has(entry.id)) {
      skipped.push(entry.id);
      continue;
    }
    const safe = findSafeCliCommand(entry.command);
    if (!safe || safe.skipped || !path.isAbsolute(safe.path)) {
      skipped.push(entry.id);
      continue;
    }
    let executableRealpath: string;
    try {
      executableRealpath = realpathSync(safe.path);
    } catch {
      skipped.push(entry.id);
      continue;
    }
    const existing = listReviewedCliReadDescriptors()
      .find((row) => row.descriptorId === contract.descriptorId);
    if (
      existing
      && sameClosedContract(existing, contract, executableRealpath)
      && (!rehash || currentReviewedCliDescriptor(existing) !== null)
    ) {
      skipped.push(entry.id);
      continue;
    }
    try {
      const descriptor = await provisionReviewedCliReadDescriptor({
        version: 1,
        descriptorId: contract.descriptorId,
        operationId: contract.operationId,
        displayName: contract.displayName,
        description: contract.description,
        effect: 'read',
        accountId: REVIEWED_CLI_READ_ACCOUNT,
        executablePath: executableRealpath,
        argvPrefix: [...contract.argvPrefix],
        arguments: contract.arguments.map((argument) => ({
          name: argument.name,
          kind: argument.kind,
          token: argument.token,
          valueType: argument.valueType,
          required: argument.required,
        })),
        limits: { ...contract.limits },
      });
      indexReviewedRead(descriptor);
      provisioned.push(entry.id);
    } catch (error) {
      skipped.push(entry.id);
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), cli: entry.id },
        'catalog reviewed CLI read was not provisioned',
      );
    }
  }

  return { provisioned, removed, skipped };
}
