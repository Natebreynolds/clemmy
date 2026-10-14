import { steerReceiptLabel, type ChatMessage } from '@clem/chat-engine';

/** Acknowledgement and handling only; neither says the task is fulfilled. */
export function SteerReceiptStatus({ message }: { message: ChatMessage }) {
  const label = steerReceiptLabel(message);
  return label ? <div class="pending-status" role="status">{label}</div> : null;
}
