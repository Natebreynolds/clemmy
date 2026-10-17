import type { SettingsSnapshot } from './settings';
import { selectedOnboardingBrain } from './onboarding-models';

export interface OnboardingFinishPorts {
  isDesktop: boolean;
  readSettings: () => Promise<SettingsSnapshot>;
  complete?: (payload: { exploreWithoutModel?: boolean }) => Promise<{ ok: true }>;
}

/** No credential or role writes here. The browser checks the latest selected
 * model; the native bridge independently checks it before retaining a marker. */
export async function finishOnboarding(exploreWithoutModel: boolean, ports: OnboardingFinishPorts): Promise<void> {
  if (ports.isDesktop && !ports.complete) {
    throw new Error('This desktop shell needs an app update to save the new setup. Your connections are saved. You can return to Clem below.');
  }
  if (!exploreWithoutModel && !selectedOnboardingBrain(await ports.readSettings())) {
    throw new Error('Choose a connected main model first, or explore without one.');
  }
  if (ports.complete) {
    const result = await ports.complete(exploreWithoutModel ? { exploreWithoutModel: true } : {});
    if (result?.ok !== true) throw new Error('Setup did not finish. Your connections are saved; please try again.');
  }
}
