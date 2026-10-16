import { z } from 'zod';

/** Evidence describes what was observed, never permission to run an action. */
export const WORKSPACE_EVIDENCE_KINDS = [
  'saved_content', 'configuration', 'data_readback', 'render_readback',
  'operation_readback', 'deployment_relationship',
] as const;
export type WorkspaceEvidenceKind = typeof WORKSPACE_EVIDENCE_KINDS[number];

/** The host owns the binding; the reader must return it unchanged. This is an
 * advisory about this saved snapshot, not the task's completion attestation. */
export const WorkspaceDeliverablesV2Schema = z.object({
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  assessmentComplete: z.boolean(),
  assessedCriteriaIds: z.array(z.string().min(1).max(80)).max(256),
  deliverables: z.array(z.object({
    deliverable: z.string().min(1).max(500),
    status: z.enum(['covered', 'missing', 'unverified']),
    requiredEvidence: z.enum(WORKSPACE_EVIDENCE_KINDS),
    evidenceIds: z.array(z.string().min(1).max(160)).max(32),
    gap: z.string().max(700),
  }).strict()).min(1).max(32),
}).strict();

export type WorkspaceDeliverable = z.infer<typeof WorkspaceDeliverablesV2Schema>['deliverables'][number];
