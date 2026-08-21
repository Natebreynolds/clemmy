/** Isolated full-service bootstrap: configureHarnessRuntime, no fixture imports. */
const HOME = process.argv[2];
if (!HOME) {
  process.stderr.write('missing home\n');
  process.exit(2);
}
process.env.CLEMENTINE_HOME = HOME;

const { configureHarnessRuntime } = await import('../harness/codex-client.js');
const { peekHostCapabilityCatalogFactory } = await import('../harness/host-capability-catalog-factory.js');
const { peekCapabilityManifestStore } = await import('../harness/capability-manifest-store.js');
const { listProductionCapabilityPorts } = await import('../harness/production-capability-ports.js');
const { PRODUCTION_CAPABILITY_IDS } = await import('../harness/production-capability-catalog.js');

await configureHarnessRuntime();
const factory = peekHostCapabilityCatalogFactory();
const store = peekCapabilityManifestStore();
const ports = listProductionCapabilityPorts();
const catalog = factory?.snapshot() ?? [];
const dest = catalog.find((entry) => entry.capabilityId === PRODUCTION_CAPABILITY_IDS.create);
const payload = {
  catalogIds: catalog.map((entry) => entry.capabilityId).sort(),
  manifestIds: (store?.list() ?? []).map((entry) => entry.manifest.manifestId).sort(),
  portCount: ports.length,
  destinationHasReconcile: Boolean(dest?.reconcile),
  everyManifestBacked: catalog.every((entry) => Boolean(entry.manifestDigest)),
};
process.stdout.write(`\nBOOTSTRAP_RESULT ${JSON.stringify(payload)}\n`);
