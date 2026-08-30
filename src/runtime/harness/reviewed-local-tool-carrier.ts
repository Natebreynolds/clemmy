/**
 * Host-facing compatibility surface for the reviewed local tool carrier.
 *
 * The implementation intentionally lives in the storage-free transport leaf
 * so the host and shipped crossing cannot drift while the durable manifest and
 * lifecycle owners remain above this module.
 */
export * from './reviewed-local-tool-transport.js';
