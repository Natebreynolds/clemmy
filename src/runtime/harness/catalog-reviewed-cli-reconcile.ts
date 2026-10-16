/**
 * Install host-reviewed catalog CLI reads into the closed descriptor registry.
 *
 * PATH discovery never calls this. A catalog `reviewedRead` contract is the
 * human review; this module copies that contract onto a currently connected
 * catalog row whose executable still resolves. Forgotten or disconnected
 * catalog rows are removed. Operator-provisioned non-catalog descriptors are
 * left untouched.
 */
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import {
  CLI_CATALOG,
  catalogReviewedReadsOf,
  readConnectedClis,
  type CatalogReviewedReadV1,
  type CliCatalogEntry,
} from '../../integrations/cli-catalog/catalog.js';
import { readConnectedCliExecutableSelection, reviewedCliExecutablePathIsSupported, reviewedCliExecutableFileIsSupported }
  from '../../integrations/cli-catalog/connected-cli-executable-selection.js';
import { findSafeCliCommand, resolveSafeCliProbe } from '../cli-discovery.js';
import { getSavedClis } from '../saved-clis.js';
import { deactivateCapabilityOperation, listCapabilityOperationsForCarrier, recordCapabilityOperations }
  from '../../memory/capability-index.js';
import {
  currentReviewedCliDescriptor,
  REVIEWED_CLI_READ_ACCOUNT,
  REVIEWED_CLI_READ_CARRIER,
  listReviewedCliReadDescriptors,
  provisionReviewedCliReadDescriptor,
  reviewedCliDescriptorDigest,
  removeReviewedCliReadDescriptor,
  type ReviewedCliReadDescriptorV1,
} from './reviewed-cli-read-config.js';

const logger = pino({ name: 'clementine-next.catalog-reviewed-cli' });

export interface ReconcileCatalogReviewedCliReadsResult {
  provisioned: string[];
  removed: string[];
  skipped: string[];
}

/** One row per declared reviewed read. A CLI may declare several — its query
 *  and its own diagnosis — and each is provisioned on the same terms. */
function catalogReviewedReads(): readonly { entry: CliCatalogEntry; contract: CatalogReviewedReadV1 }[] {
  return CLI_CATALOG.flatMap((entry) => catalogReviewedReadsOf(entry).map((contract) => ({ entry, contract })));
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
  connected: unknown,
  saved: ReadonlySet<string>,
): boolean {
  const hasConnectedRecord = connected !== null && typeof connected === 'object' && !Array.isArray(connected)
    && Object.hasOwn(connected, entry.id);
  return hasConnectedRecord || saved.has(entry.command.trim().toLowerCase());
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
let reconciliationTail: Promise<void> = Promise.resolve();

export function reconcileCatalogReviewedCliReads(
  options: { rehash?: boolean } = {},
): Promise<ReconcileCatalogReviewedCliReadsResult> {
  const rehash = options.rehash === true;
  const pending = reconciliationTail.then(() => reconcileCatalogReviewedCliReadsOnce({ rehash }));
  reconciliationTail = pending.then(() => undefined, () => undefined);
  return pending;
}

async function reconcileCatalogReviewedCliReadsOnce(
  options: { rehash: boolean },
): Promise<ReconcileCatalogReviewedCliReadsResult> {
  const rehash = options.rehash === true;
  const provisioned: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  const catalogByDescriptor = new Map(
    catalogReviewedReads().map((row) => [row.contract.descriptorId, row.entry] as const),
  );
  const selectionFor = (entry: CliCatalogEntry) => readConnectedCliExecutableSelection(entry);
  const entryIsConfirmedNow = (entry: CliCatalogEntry) => entryIsUserConfirmed(entry, readConnectedClis(), userConfirmedCliCommands());
  const removeCatalogDescriptor = async (descriptorId: string, operationId: string, expectedDigest?: string): Promise<void> => {
    // Avoid rewriting a missing descriptor on every poll; the exact index
    // retirement also repairs a crash between descriptor removal and indexing.
    const existing = listReviewedCliReadDescriptors().find(row => row.descriptorId === descriptorId);
    if (existing) {
      const digest = reviewedCliDescriptorDigest(existing);
      if (expectedDigest !== undefined && digest !== expectedDigest) return;
      const dropped = await removeReviewedCliReadDescriptor(descriptorId, { expectedDescriptorDigest: digest });
      if (!dropped) return; // Another process's newer descriptor is not ours to retire.
      removed.push(descriptorId);
    } else if (expectedDigest !== undefined) {
      return;
    }
    // A different process can publish its replacement after our CAS removal.
    // Its descriptor/index identity must not be retired by this older cleanup.
    if (listReviewedCliReadDescriptors().some(row => row.descriptorId === descriptorId)) return;
    deactivateCapabilityOperation({ identifier: operationId, accountIdentity: REVIEWED_CLI_READ_ACCOUNT,
      carrierKind: 'cli', carrier: REVIEWED_CLI_READ_CARRIER, parentIdentifier: descriptorId });
  };

  for (const existing of listReviewedCliReadDescriptors()) {
    const catalog = catalogByDescriptor.get(existing.descriptorId);
    if (!catalog) continue;
    if (!entryIsConfirmedNow(catalog) || selectionFor(catalog).status === 'blocked') {
      await removeCatalogDescriptor(existing.descriptorId, existing.operationId, reviewedCliDescriptorDigest(existing));
    }
  }

  for (const { entry, contract } of catalogReviewedReads()) {
    const selection = selectionFor(entry);
    if (!entryIsConfirmedNow(entry) || selection.status === 'blocked') {
      await removeCatalogDescriptor(contract.descriptorId, contract.operationId);
      skipped.push(entry.id);
      continue;
    }
    // A known executable observation selects that exact path even when its
    // sign-in is unknown/stale. The catalog contract, not auth health, supplies
    // the read effect. Only missing observations use bootstrap PATH discovery.
    const safe = selection.status === 'selected'
      ? resolveSafeCliProbe(entry.command, selection.executablePath)
      : findSafeCliCommand(entry.command);
    if (!safe || safe.skipped || !path.isAbsolute(safe.path)) {
      await removeCatalogDescriptor(contract.descriptorId, contract.operationId);
      skipped.push(entry.id);
      continue;
    }
    let executableRealpath: string;
    let provisionedDigest: string | undefined;
    try {
      executableRealpath = realpathSync(safe.path);
      if (selection.status === 'selected') {
        const file = statSync(executableRealpath);
        if (!reviewedCliExecutableFileIsSupported({ executablePath: executableRealpath, isFile: file.isFile(), mode: file.mode })) {
          throw new Error('selected CLI is not executable');
        }
      }
    } catch {
      await removeCatalogDescriptor(contract.descriptorId, contract.operationId);
      skipped.push(entry.id);
      continue;
    }
    if (!reviewedCliExecutablePathIsSupported(executableRealpath)) {
      await removeCatalogDescriptor(contract.descriptorId, contract.operationId);
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
      // An unchanged contract still has to be FINDABLE. Anything else that
      // reconciles the `cli` space can retire this row, and a reviewed read
      // the model cannot discover is a capability the machine holds and never
      // offers. Restore it only when it is missing or retired, so an ordinary
      // rehash still changes nothing.
      const findable = listCapabilityOperationsForCarrier('cli', REVIEWED_CLI_READ_CARRIER, 200)
        .some((row) => row.identifier === existing.operationId
          && row.accountIdentity === existing.accountId
          && row.parentIdentifier === existing.descriptorId);
      if (!findable) indexReviewedRead(existing);
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
      const digest = reviewedCliDescriptorDigest(descriptor);
      provisionedDigest = digest;
      if (!entryIsConfirmedNow(entry) || JSON.stringify(selectionFor(entry)) !== JSON.stringify(selection)) {
        await removeCatalogDescriptor(descriptor.descriptorId, descriptor.operationId, digest);
        skipped.push(entry.id);
        continue;
      }
      const retained = listReviewedCliReadDescriptors().find(row => row.descriptorId === descriptor.descriptorId);
      if (!retained || reviewedCliDescriptorDigest(retained) !== digest) {
        skipped.push(entry.id);
        continue;
      }
      indexReviewedRead(descriptor);
      provisioned.push(entry.id);
    } catch (error) {
      if (provisionedDigest !== undefined || existing) {
        await removeCatalogDescriptor(contract.descriptorId, contract.operationId,
          provisionedDigest ?? reviewedCliDescriptorDigest(existing!));
      }
      skipped.push(entry.id);
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), cli: entry.id },
        'catalog reviewed CLI read was not provisioned',
      );
    }
  }

  return { provisioned, removed, skipped };
}
