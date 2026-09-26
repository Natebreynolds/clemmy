/**
 * Can an item marked "reach my phone" actually reach a phone?
 *
 * The heartbeat page offers push delivery; offering it while nothing could
 * ever arrive is the silence-as-success failure this product cannot afford.
 * So the page is told, in one of three states, what is true right now.
 */
export type PhonePushReason = 'no_phone_registered' | 'apns_key_missing';

export interface PhonePushReadiness {
  ready: boolean;
  reason?: PhonePushReason;
  /** How many phone destinations exist, by kind. */
  phones: { webPush: number; apns: number };
}

export function phonePushReadiness(
  destinations: Array<{ type: string; enabled: boolean }>,
  apnsConfigured: boolean,
): PhonePushReadiness {
  const webPush = destinations.filter((d) => d.enabled && d.type === 'web_push').length;
  const apns = destinations.filter((d) => d.enabled && d.type === 'apns').length;
  const phones = { webPush, apns };
  if (webPush === 0 && apns === 0) return { ready: false, reason: 'no_phone_registered', phones };
  if (webPush === 0 && !apnsConfigured) return { ready: false, reason: 'apns_key_missing', phones };
  return { ready: true, phones };
}
