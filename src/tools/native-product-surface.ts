/** Product-owned authoring and lifecycle entry points. This is a stable API surface, not an
 * intent classifier. The host still validates each operation and exact args. */
export const NATIVE_PRODUCT_AUTHORING_TOOLS: ReadonlySet<string> = new Set([
  'space_save',
  'workflow_create',
  'workflow_update',
  'workflow_set_enabled',
]);
