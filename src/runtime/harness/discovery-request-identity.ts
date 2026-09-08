import { createHash } from 'node:crypto';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';

/** Exact read-request identity, never semantic intent or effect authority. */
export function discoveryRequestDigest(toolName: string, args: unknown): string {
  return createHash('sha256').update(closedCanonicalJson({
    version: 1, toolName, args,
  })).digest('hex');
}

export const DISCOVERY_REQUEST_CALLS_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS discovery_governor_request_calls (
    session_id TEXT NOT NULL,
    source_user_seq INTEGER NOT NULL,
    call_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('broad_discovery', 'exact_schema_refresh')),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
    admitted_at TEXT NOT NULL,
    PRIMARY KEY (session_id, source_user_seq, call_id),
    FOREIGN KEY (session_id, source_user_seq)
      REFERENCES discovery_governor_tasks(session_id, source_user_seq) ON DELETE CASCADE
  );
`;
