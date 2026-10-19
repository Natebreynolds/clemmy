import { MeetingModelPinSchema, type MeetingModelPin } from './meeting-assistant-policy.js';
import { connectedBrainModelCapability, validateRoleModelBinding } from '../../runtime/harness/model-role-options.js';
import { modelProviderLive } from '../../runtime/harness/model-roles.js';

/** Host-owned saved choice, not a route inferred from task/model text. Recheck
 * connectivity at dispatch without replacing a disconnected choice. Account
 * identity remains the provider transport's own receipt, never this pin. */
export function validateMeetingModelPin(value: unknown, role: MeetingModelPin['role']): MeetingModelPin {
  const pin = MeetingModelPinSchema.parse(value);
  // Brain bindings are intentionally forbidden by the global role-binding API.
  // This is a trusted saved task pin, so validate its actual connected route.
  const current = role === 'brain' ? connectedBrainModelCapability(pin.modelId)
    : validateRoleModelBinding(role, pin.modelId);
  if (pin.role !== role || !current.ok || current.provider !== pin.provider || !modelProviderLive(pin.modelId, pin.provider)) {
    throw new Error('The selected meeting model is unavailable. No substitute was started.');
  }
  return Object.freeze({ ...pin });
}
