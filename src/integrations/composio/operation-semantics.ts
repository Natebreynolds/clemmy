/**
 * Documented semantics for provider operations whose public action names do
 * not carry enough verb evidence to classify themselves.
 *
 * This is intentionally a small, pure registry. Most actions stay governed by
 * the structural classifier in slug-effect.ts; an entry belongs here only when
 * provider documentation gives the noun-shaped operation a stable effect that
 * every runtime consumer must share. Keeping the descriptor here prevents an
 * artifact recognizer, approval gate, and settlement projection from inventing
 * different meanings for the same canonical action.
 *
 * Entries describe an ACTION, never a particular request. Anything that would
 * only match one caller's arguments — an actor id, a column layout, a row
 * count — is a fact about a single run, so it has to be learned at runtime
 * rather than frozen here.
 */

export type DocumentedComposioEffect = 'read' | 'write';
export type DocumentedComposioReversibility = 'read_only' | 'reversible' | 'irreversible';
export type DocumentedComposioConsequence = 'read' | 'create' | 'update' | 'delete' | 'send' | 'other';

export interface DocumentedComposioOperationSemantic {
  effect: DocumentedComposioEffect;
  reversibility: DocumentedComposioReversibility;
  consequence: DocumentedComposioConsequence;
  /** Present only when the operation creates the root deliverable itself. */
  rootArtifact?: {
    kind: 'resource' | 'google_doc';
    provider: string;
  };
  /**
   * The provider documents this exact operation as one atomic
   * input-to-created-content commit. This is deliberately narrower than
   * `consequence: create`: most creates still owe an independent readback.
   */
  atomicInputContentCommit?: {
    kind: 'googlesheets_sheet_from_json_content_v1';
    evidence: readonly ['receipt', 'content_commit'];
  };
}

const SLACK_CONVERSATIONS_HISTORY = Object.freeze({
  effect: 'read',
  reversibility: 'read_only',
  consequence: 'read',
} satisfies DocumentedComposioOperationSemantic);

const TWITTER_USER_TIMELINE = Object.freeze({
  effect: 'read',
  reversibility: 'read_only',
  consequence: 'read',
} satisfies DocumentedComposioOperationSemantic);

const GOOGLE_DRIVE_DOWNLOAD_FILE = Object.freeze({
  effect: 'read',
  reversibility: 'read_only',
  consequence: 'read',
} satisfies DocumentedComposioOperationSemantic);

const GOOGLE_SHEETS_SHEET_FROM_JSON = Object.freeze({
  effect: 'write',
  reversibility: 'reversible',
  consequence: 'create',
  rootArtifact: Object.freeze({
    kind: 'resource',
    provider: 'googlesheets',
  }),
  atomicInputContentCommit: Object.freeze({
    kind: 'googlesheets_sheet_from_json_content_v1',
    evidence: Object.freeze(['receipt', 'content_commit'] as const),
  }),
} satisfies DocumentedComposioOperationSemantic);

const GOOGLE_DOCS_CREATE_DOCUMENT_MARKDOWN = Object.freeze({
  effect: 'write',
  reversibility: 'reversible',
  consequence: 'create',
  rootArtifact: Object.freeze({
    kind: 'google_doc',
    provider: 'Google Docs',
  }),
} satisfies DocumentedComposioOperationSemantic);

const DOCUMENTED_OPERATION_SEMANTICS: ReadonlyMap<string, DocumentedComposioOperationSemantic> = new Map<string, DocumentedComposioOperationSemantic>([
  ['SLACKCONVERSATIONSHISTORY', SLACK_CONVERSATIONS_HISTORY],
  ['TWITTERUSERTIMELINE', TWITTER_USER_TIMELINE],
  ['GOOGLEDRIVEDOWNLOADFILE', GOOGLE_DRIVE_DOWNLOAD_FILE],
  // Composio has exposed both GOOGLE_SHEET and GOOGLE_SHEETS toolkit spellings.
  ['GOOGLESHEETSHEETFROMJSON', GOOGLE_SHEETS_SHEET_FROM_JSON],
  ['GOOGLESHEETSSHEETFROMJSON', GOOGLE_SHEETS_SHEET_FROM_JSON],
  ['GOOGLEDOCSCREATEDOCUMENTMARKDOWN', GOOGLE_DOCS_CREATE_DOCUMENT_MARKDOWN],
]);

function documentedOperationKey(action: string): string {
  const tokens = action
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  // Dynamic Composio wrappers expose cx_<slug>; CX is transport, not part of
  // the provider action. Other leading tokens remain untouched.
  if (tokens[0] === 'CX') tokens.shift();
  return tokens.join('');
}

export function documentedComposioOperationSemantic(
  action: string | null | undefined,
): DocumentedComposioOperationSemantic | null {
  const key = documentedOperationKey(String(action ?? '').trim());
  return key ? DOCUMENTED_OPERATION_SEMANTICS.get(key) ?? null : null;
}

/**
 * Exact opt-in for the one reviewed atomic-input create. Unlike the broader
 * documented-operation lookup, this function intentionally accepts neither
 * aliases nor suffix/name-shape inference: an adjacent create/update cannot
 * borrow the content-commit contract.
 */
export function documentedAtomicInputContentCommit(
  action: string | null | undefined,
): NonNullable<DocumentedComposioOperationSemantic['atomicInputContentCommit']> | null {
  // Durable call identity is case-normalized by the call kernel. Accept that
  // byte-equivalent canonical spelling, but no toolkit alias, transport
  // prefix, suffix, or token-shape approximation.
  if (String(action ?? '').trim().toUpperCase() !== 'GOOGLESHEETS_SHEET_FROM_JSON') return null;
  return GOOGLE_SHEETS_SHEET_FROM_JSON.atomicInputContentCommit;
}
