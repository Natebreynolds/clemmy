import type Database from 'better-sqlite3';

/** Future-only SDK authority. This module owns storage guards, not permission
 * issuance or provider execution, and has no runtime/tool/client imports. */
export function installApprovedActionProviderBindingSchema(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='approved_action_provider_bindings_v1'").get()) {
    throw new Error('schema v97 refuses preexisting unsanctioned table approved_action_provider_bindings_v1');
  }
  const protocol = 'approved_composio_sdk_v1';
  const supportedCard = `SELECT 1 FROM pending_approvals card
    WHERE card.approval_id=json_extract(NEW.intent_json,'$.approvalId')
      AND card.session_id=NEW.session_id AND card.status='resolved' AND card.resolution='approved'
      AND json_extract(NEW.intent_json,'$.version')=1 AND json_extract(NEW.intent_json,'$.scope')='exact_approved_call'
      AND json_extract(NEW.intent_json,'$.effect') IN ('external_write','admin')
      AND json_extract(card.args_json,'$.pendingActionId')=json_extract(NEW.intent_json,'$.pendingActionId')
      AND json_extract(card.args_json,'$.pendingAction.id')=json_extract(NEW.intent_json,'$.pendingActionId')
      AND json_extract(card.args_json,'$.pendingAction.toolName')='composio_execute_tool'
      AND json_type(card.args_json,'$.pendingAction.payload.connected_account_id')='text'
      AND length(trim(json_extract(card.args_json,'$.pendingAction.payload.connected_account_id')))>0
      AND json_extract(card.args_json,'$.pendingAction.payload.connected_account_id')=trim(json_extract(card.args_json,'$.pendingAction.payload.connected_account_id'))
      AND lower(json_extract(card.args_json,'$.pendingAction.payload.connected_account_id')) NOT IN ('null','undefined','none')
      AND json_type(card.args_json,'$.pendingAction.executionAuthority')='null'`;
  db.exec(`CREATE TABLE approved_action_provider_bindings_v1 (
    binding_id TEXT PRIMARY KEY NOT NULL,
    intent_id TEXT NOT NULL UNIQUE REFERENCES approved_action_completion_intents_v1(intent_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    source_user_seq INTEGER NOT NULL CHECK(source_user_seq>0),
    logical_tool_call_id TEXT NOT NULL,
    physical_dispatch_id TEXT NOT NULL,
    binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND json_type(binding_json)='object' AND length(binding_json)<=32768),
    binding_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,
    prepared_at TEXT NOT NULL,
    UNIQUE(session_id,source_user_seq,logical_tool_call_id),
    UNIQUE(session_id,source_user_seq,physical_dispatch_id),
    FOREIGN KEY(session_id,source_user_seq,logical_tool_call_id,physical_dispatch_id)
      REFERENCES physical_dispatches(session_id,source_user_seq,logical_tool_call_id,physical_dispatch_id) ON DELETE CASCADE
  );
  CREATE TRIGGER approved_action_provider_bindings_v1_immutable_update BEFORE UPDATE ON approved_action_provider_bindings_v1
    BEGIN SELECT RAISE(ABORT,'approved action provider binding is immutable'); END;
  CREATE TRIGGER approved_action_provider_bindings_v1_immutable_delete BEFORE DELETE ON approved_action_provider_bindings_v1
    WHEN EXISTS(SELECT 1 FROM sessions WHERE id=OLD.session_id)
    BEGIN SELECT RAISE(ABORT,'approved action provider binding is immutable'); END;
  CREATE TRIGGER approved_action_provider_intent_protocol_v97 BEFORE INSERT ON approved_action_completion_intents_v1
    WHEN (
      (json_type(NEW.intent_json,'$.providerDispatchProtocol') IS NULL AND NOT EXISTS(${supportedCard}))
      OR (json_type(NEW.intent_json,'$.providerDispatchProtocol')='text'
        AND json_extract(NEW.intent_json,'$.providerDispatchProtocol')='${protocol}' AND EXISTS(${supportedCard}))
    ) IS NOT 1
    BEGIN SELECT RAISE(ABORT,'approved SDK intent requires its exact declared provider protocol'); END;`);

  const fields = [
    'version','protocol','intentId','sessionId','sourceUserSeq','acceptedTaskId','originalSourceUserSeq','approvalId',
    'pendingActionId','payloadHash','approvalSnapshotDigest','claimHash','logicalToolCallId','attemptId','toolName',
    'rawArgumentDigest','effectiveArgumentDigest','refinementEventId','providerOperationId','providerOperationVersion',
    'providerArgumentDigest','providerInputSchemaDigest','schemaFingerprint','connectedAccountId','accountIdentityDigest',
    'providerOwnerIdentityDigest','invokePortId','effect','physicalDispatchId','leaseScopeId','leaseId',
  ];
  const b = (key: string): string => `json_extract(NEW.binding_json,'$.${key}')`;
  const textFields = fields.filter(key => !['version','sourceUserSeq','originalSourceUserSeq','refinementEventId'].includes(key));
  const hashes = ['approvalSnapshotDigest','claimHash','rawArgumentDigest','effectiveArgumentDigest','providerArgumentDigest',
    'providerInputSchemaDigest','accountIdentityDigest','providerOwnerIdentityDigest'];
  const shape = [
    `(SELECT count(*) FROM json_each(NEW.binding_json))=${fields.length}`,
    `NOT EXISTS(SELECT 1 FROM json_each(NEW.binding_json) WHERE key NOT IN (${fields.map(key => `'${key}'`).join(',')}))`,
    ...textFields.map(key => `json_type(NEW.binding_json,'$.${key}')='text' AND length(${b(key)})>0 AND ${b(key)}=trim(${b(key)})`),
    ...hashes.map(key => `length(${b(key)})=64 AND ${b(key)} NOT GLOB '*[^0-9a-f]*'`),
    `length(${b('schemaFingerprint')})=32 AND ${b('schemaFingerprint')} NOT GLOB '*[^0-9a-f]*'`,
    `json_type(NEW.binding_json,'$.version')='integer' AND ${b('version')}=1`,
    `${b('protocol')}='${protocol}'`,
    `json_type(NEW.binding_json,'$.sourceUserSeq')='integer' AND ${b('sourceUserSeq')}=NEW.source_user_seq`,
    `json_type(NEW.binding_json,'$.originalSourceUserSeq')='integer' AND ${b('originalSourceUserSeq')}>0`,
    `json_type(NEW.binding_json,'$.refinementEventId') IN ('text','null')`,
    `(${b('refinementEventId')} IS NULL OR length(trim(${b('refinementEventId')}))>0)`,
    `${b('invokePortId')}='composio_sdk_v3_execute'`,
    `${b('effect')} IN ('external_write','admin')`,
    `${b('sessionId')}=NEW.session_id AND ${b('intentId')}=NEW.intent_id`,
    `${b('logicalToolCallId')}=NEW.logical_tool_call_id AND ${b('physicalDispatchId')}=NEW.physical_dispatch_id`,
    `length(NEW.binding_id)=length('approved-composio-binding:v1:')+64`,
    `substr(NEW.binding_id,1,length('approved-composio-binding:v1:'))='approved-composio-binding:v1:'`,
    `substr(NEW.binding_id,length('approved-composio-binding:v1:')+1) NOT GLOB '*[^0-9a-f]*'`,
  ].join('\n      AND ');
  const intentFields = ['sessionId','sourceUserSeq','acceptedTaskId','originalSourceUserSeq','approvalId','pendingActionId',
    'payloadHash','approvalSnapshotDigest','claimHash','logicalToolCallId','attemptId','toolName','effect'];
  db.exec(`CREATE TRIGGER approved_action_provider_binding_exact_v97 BEFORE INSERT ON approved_action_provider_bindings_v1
    WHEN NOT EXISTS(
      SELECT 1 FROM approved_action_completion_intents_v1 intent
      JOIN events source ON source.id=json_extract(intent.intent_json,'$.sourceEventId')
      JOIN events original ON original.session_id=NEW.session_id AND original.seq=${b('originalSourceUserSeq')}
      JOIN pending_approvals card ON card.approval_id=${b('approvalId')}
      JOIN accepted_task_authority authority ON authority.session_id=NEW.session_id AND authority.source_user_seq=NEW.source_user_seq
      JOIN accepted_turn_call_authorities call_root ON call_root.session_id=NEW.session_id AND call_root.source_user_seq=NEW.source_user_seq
      JOIN run_attempts attempt ON attempt.attempt_id=${b('attemptId')}
      JOIN logical_tool_calls logical ON logical.session_id=NEW.session_id AND logical.source_user_seq=NEW.source_user_seq
        AND logical.logical_tool_call_id=NEW.logical_tool_call_id
      JOIN physical_dispatches physical ON physical.session_id=NEW.session_id AND physical.source_user_seq=NEW.source_user_seq
        AND physical.logical_tool_call_id=NEW.logical_tool_call_id AND physical.physical_dispatch_id=NEW.physical_dispatch_id
      JOIN run_dispatch_leases lease ON lease.session_id=NEW.session_id AND lease.scope_id=${b('leaseScopeId')} AND lease.lease_id=${b('leaseId')}
      JOIN events started ON started.id=physical.start_event_id
      JOIN events mirror ON mirror.id=NEW.binding_event_id
      WHERE ${shape}
      AND intent.intent_id=NEW.intent_id AND intent.session_id=NEW.session_id AND intent.source_user_seq=NEW.source_user_seq
      AND json_extract(intent.intent_json,'$.version')=1 AND json_extract(intent.intent_json,'$.scope')='exact_approved_call'
      AND json_extract(intent.intent_json,'$.providerDispatchProtocol')='${protocol}'
      AND ${intentFields.map(key => `${b(key)}=json_extract(intent.intent_json,'$.${key}')`).join('\n      AND ')}
      AND ${b('rawArgumentDigest')}=json_extract(intent.intent_json,'$.argumentDigest')
      AND source.session_id=NEW.session_id AND source.seq=NEW.source_user_seq AND source.type='user_input_received' AND source.role='user'
      AND source.turn=json_extract(intent.intent_json,'$.turn')
      AND json_type(source.data_json,'$.synthetic')='true' AND json_extract(source.data_json,'$.source')='approval_resume'
      AND json_extract(source.data_json,'$.approvalId')=${b('approvalId')} AND json_extract(source.data_json,'$.decision')='approve'
      AND original.type='user_input_received' AND original.role='user' AND COALESCE(json_extract(original.data_json,'$.synthetic'),0)=0
      AND original.seq<source.seq
      AND card.session_id=NEW.session_id AND card.tool='request_approval' AND card.status='resolved' AND card.resolution='approved'
      AND json_extract(card.args_json,'$.pendingActionId')=${b('pendingActionId')}
      AND json_extract(card.args_json,'$.pendingAction.id')=${b('pendingActionId')}
      AND json_extract(card.args_json,'$.pendingAction.payloadHash')=${b('payloadHash')}
      AND json_extract(card.args_json,'$.pendingAction.toolName')='composio_execute_tool'
      AND json_type(card.args_json,'$.pendingAction.executionAuthority')='null'
      AND json_extract(card.args_json,'$.pendingAction.payload.connected_account_id')=${b('connectedAccountId')}
      AND json_extract(card.args_json,'$.pendingAction.payload.tool_slug')=${b('providerOperationId')}
      AND lower(${b('providerOperationId')})=${b('toolName')}
      AND authority.accepted_task_id=${b('acceptedTaskId')} AND authority.state='armed' AND authority.work_contract_id IS NULL
      AND authority.expected_work_required=1 AND authority.terminal_event_id IS NULL
      AND authority.graph_event_id=json_extract(intent.intent_json,'$.graphEventId')
      AND authority.graph_id=json_extract(intent.intent_json,'$.graphId') AND authority.graph_hash=json_extract(intent.intent_json,'$.graphHash')
      AND call_root.authority_kind='turn_graph' AND call_root.state='open' AND call_root.accepted_task_id=${b('acceptedTaskId')}
      AND call_root.source_event_id=source.id AND call_root.source_turn=source.turn
      AND call_root.graph_event_id=authority.graph_event_id AND call_root.graph_hash=authority.graph_hash
      AND attempt.session_id=NEW.session_id AND attempt.source_user_seq=NEW.source_user_seq AND attempt.status='active' AND attempt.finished_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM kill_switches stopped WHERE stopped.session_id=NEW.session_id)
      AND NOT EXISTS(SELECT 1 FROM run_kill_requests stopped WHERE stopped.session_id=NEW.session_id
        AND (stopped.scope_key='session:*' OR stopped.attempt_id=attempt.attempt_id
          OR (stopped.attempt_id IS NULL AND stopped.run_id=attempt.run_id)))
      AND lease.revoked_at IS NULL AND lease.run_attempt_id=attempt.attempt_id AND lease.source_user_seq=NEW.source_user_seq
      AND lease.accepted_task_id=${b('acceptedTaskId')} AND lease.logical_tool_call_id=NEW.logical_tool_call_id
      AND logical.accepted_task_id=${b('acceptedTaskId')} AND logical.tool_name=${b('toolName')} AND logical.state='open'
      AND logical.raw_argument_digest=${b('rawArgumentDigest')} AND logical.argument_digest=${b('effectiveArgumentDigest')}
      AND logical.refinement_event_id IS ${b('refinementEventId')}
      AND ((logical.argument_digest=logical.raw_argument_digest AND logical.refinement_event_id IS NULL AND logical.effective_argument_digest IS NULL)
        OR (logical.argument_digest<>logical.raw_argument_digest AND logical.effective_argument_digest=logical.argument_digest AND EXISTS(
          SELECT 1 FROM events refinement WHERE refinement.id=logical.refinement_event_id AND refinement.session_id=NEW.session_id
            AND refinement.type='logical_call_contract_refined' AND refinement.role='system' AND refinement.turn=source.turn
            AND json_extract(refinement.data_json,'$.sourceUserSeq')=NEW.source_user_seq
            AND json_extract(refinement.data_json,'$.acceptedTaskId')=${b('acceptedTaskId')}
            AND json_extract(refinement.data_json,'$.logicalToolCallId')=NEW.logical_tool_call_id
            AND json_extract(refinement.data_json,'$.tool')=${b('toolName')}
            AND json_extract(refinement.data_json,'$.rawArgumentDigest')=${b('rawArgumentDigest')}
            AND json_extract(refinement.data_json,'$.effectiveArgumentDigest')=${b('effectiveArgumentDigest')}
            AND refinement.seq<started.seq)))
      AND physical.accepted_task_id=${b('acceptedTaskId')} AND physical.tool_name=${b('toolName')}
      AND physical.argument_digest=${b('effectiveArgumentDigest')} AND physical.provider_argument_digest=${b('providerArgumentDigest')}
      AND physical.state='started' AND physical.io_claimed_at IS NULL
      AND physical.ordinal=1 AND physical.relation='primary' AND physical.retry_of IS NULL
      AND physical.lease_scope_id=${b('leaseScopeId')} AND physical.lease_id=${b('leaseId')}
      AND started.session_id=NEW.session_id AND started.type='provider_dispatch_started' AND started.seq>source.seq
      AND mirror.session_id=NEW.session_id AND mirror.type='approved_action_provider_bound' AND mirror.role='system' AND mirror.turn=source.turn
      AND mirror.seq>started.seq AND mirror.created_at=NEW.prepared_at
      AND json_extract(mirror.data_json,'$.sourceUserSeq')=NEW.source_user_seq
      AND json_extract(mirror.data_json,'$.bindingId')=NEW.binding_id
      AND json(json_extract(mirror.data_json,'$.binding'))=json(NEW.binding_json)
    ) BEGIN SELECT RAISE(ABORT,'approved SDK provider binding is not exact unclaimed owned execution'); END;
    CREATE TRIGGER approved_action_provider_receipt_exact_v97 BEFORE INSERT ON approved_action_completion_receipts_v1
    WHEN EXISTS(SELECT 1 FROM approved_action_completion_intents_v1 intent WHERE intent.intent_id=NEW.intent_id
      AND json_extract(intent.intent_json,'$.providerDispatchProtocol')='${protocol}')
      AND NOT EXISTS(SELECT 1 FROM approved_action_provider_bindings_v1 binding
        WHERE binding.intent_id=NEW.intent_id AND binding.session_id=NEW.session_id AND binding.source_user_seq=NEW.source_user_seq
          AND json_extract(NEW.receipt_json,'$.intentId')=NEW.intent_id
          AND json_extract(NEW.receipt_json,'$.sessionId')=NEW.session_id AND json_extract(NEW.receipt_json,'$.sourceUserSeq')=NEW.source_user_seq
          AND json_extract(NEW.receipt_json,'$.logicalToolCallId')=binding.logical_tool_call_id
          AND json_extract(NEW.receipt_json,'$.physicalDispatchId')=binding.physical_dispatch_id
          AND json_extract(NEW.receipt_json,'$.providerBindingId')=binding.binding_id
          AND json_extract(NEW.receipt_json,'$.providerBindingDigest')=substr(binding.binding_id,length('approved-composio-binding:v1:')+1))
    BEGIN SELECT RAISE(ABORT,'approved SDK receipt requires its exact provider binding'); END;`);
}
